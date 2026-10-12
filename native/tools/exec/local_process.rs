use std::collections::{HashMap, VecDeque, hash_map::Entry};
use std::sync::Arc;
use std::time::Duration;

use codex_utils_pty::{ExecCommandSession, TerminalSize};
use tokio::sync::{Mutex, Notify};

use crate::protocol::{
    ExecOutputStream, ExecParams, ExecResponse, ProcessOutputChunk, ReadParams, ReadResponse,
    TerminateParams, TerminateResponse, WriteParams, WriteResponse, WriteStatus,
};
use crate::{ExecServerError, ProcessId};

const RETAINED_OUTPUT_BYTES_PER_PROCESS: usize = 8 * 1024 * 1024;
#[cfg(test)]
const EXITED_PROCESS_RETENTION: Duration = Duration::from_millis(25);
#[cfg(not(test))]
const EXITED_PROCESS_RETENTION: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct RetainedOutputChunk {
    seq: u64,
    stream: ExecOutputStream,
    chunk: Vec<u8>,
}

struct RunningProcess {
    session: ExecCommandSession,
    tty: bool,
    pipe_stdin: bool,
    output: VecDeque<RetainedOutputChunk>,
    retained_bytes: usize,
    evicted_through_seq: u64,
    next_seq: u64,
    exit_code: Option<i32>,
    output_notify: Arc<Notify>,
    open_streams: usize,
    closed: bool,
}

enum ProcessEntry {
    Starting,
    Running(Box<RunningProcess>),
}

struct Inner {
    processes: Mutex<HashMap<ProcessId, ProcessEntry>>,
}

#[derive(Clone, Default)]
pub struct LocalProcess {
    inner: Arc<Inner>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }
}

impl LocalProcess {
    pub async fn shutdown(&self) {
        let remaining = {
            let mut processes = self.inner.processes.lock().await;
            processes
                .drain()
                .filter_map(|(_, process)| match process {
                    ProcessEntry::Starting => None,
                    ProcessEntry::Running(process) => Some(process),
                })
                .collect::<Vec<_>>()
        };
        for process in remaining {
            process.session.terminate();
        }
    }

    pub async fn exec(&self, params: ExecParams) -> Result<ExecResponse, ExecServerError> {
        let process_id = params.process_id.clone();
        let (program, args) = params
            .argv
            .split_first()
            .ok_or_else(|| ExecServerError::Message("argv must not be empty".to_string()))?;
        {
            let mut process_map = self.inner.processes.lock().await;
            if process_map.contains_key(&process_id) {
                return Err(ExecServerError::Message(format!(
                    "process {process_id} already exists"
                )));
            }
            process_map.insert(process_id.clone(), ProcessEntry::Starting);
        }

        let env = params.env.clone();
        let spawned_result = if params.tty {
            codex_utils_pty::spawn_pty_process(
                program,
                args,
                params.cwd.as_path(),
                &env,
                &params.arg0,
                TerminalSize::default(),
                /*inherited_fds*/ &[],
            )
            .await
        } else if params.pipe_stdin {
            codex_utils_pty::spawn_pipe_process(
                program,
                args,
                params.cwd.as_path(),
                &env,
                &params.arg0,
                /*inherited_fds*/ &[],
            )
            .await
        } else {
            codex_utils_pty::spawn_pipe_process_no_stdin(
                program,
                args,
                params.cwd.as_path(),
                &env,
                &params.arg0,
                /*inherited_fds*/ &[],
            )
            .await
        };
        let spawned = match spawned_result {
            Ok(spawned) => spawned,
            Err(err) => {
                let mut process_map = self.inner.processes.lock().await;
                if matches!(process_map.get(&process_id), Some(ProcessEntry::Starting)) {
                    process_map.remove(&process_id);
                }
                return Err(ExecServerError::Message(err.to_string()));
            }
        };

        let output_notify = Arc::new(Notify::new());
        {
            let mut process_map = self.inner.processes.lock().await;
            process_map.insert(
                process_id.clone(),
                ProcessEntry::Running(Box::new(RunningProcess {
                    session: spawned.session,
                    tty: params.tty,
                    pipe_stdin: params.pipe_stdin,
                    output: VecDeque::new(),
                    retained_bytes: 0,
                    evicted_through_seq: 0,
                    next_seq: 1,
                    exit_code: None,
                    output_notify: Arc::clone(&output_notify),
                    open_streams: 2,
                    closed: false,
                })),
            );
        }

        tokio::spawn(stream_output(
            process_id.clone(),
            if params.tty {
                ExecOutputStream::Pty
            } else {
                ExecOutputStream::Stdout
            },
            spawned.stdout_rx,
            Arc::clone(&self.inner),
            Arc::clone(&output_notify),
        ));
        tokio::spawn(stream_output(
            process_id.clone(),
            if params.tty {
                ExecOutputStream::Pty
            } else {
                ExecOutputStream::Stderr
            },
            spawned.stderr_rx,
            Arc::clone(&self.inner),
            Arc::clone(&output_notify),
        ));
        tokio::spawn(watch_exit(
            process_id.clone(),
            spawned.exit_rx,
            Arc::clone(&self.inner),
            output_notify,
        ));
        Ok(ExecResponse { process_id })
    }

    pub async fn exec_read(&self, params: ReadParams) -> Result<ReadResponse, ExecServerError> {
        let after_seq = params.after_seq.unwrap_or(0);
        let max_bytes = params.max_bytes.unwrap_or(usize::MAX);
        let wait = Duration::from_millis(params.wait_ms.unwrap_or(0));
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let (response, output_notify) = {
                let process_map = self.inner.processes.lock().await;
                let process = process_map.get(&params.process_id).ok_or_else(|| {
                    ExecServerError::Message(format!("unknown process id {}", params.process_id))
                })?;
                let ProcessEntry::Running(process) = process else {
                    return Err(ExecServerError::Message(format!(
                        "process id {} is starting",
                        params.process_id
                    )));
                };
                let mut chunks = Vec::new();
                let mut total_bytes = 0;
                let mut next_seq = process.next_seq;
                for retained in process.output.iter().filter(|chunk| chunk.seq > after_seq) {
                    let chunk_len = retained.chunk.len();
                    if !chunks.is_empty() && total_bytes + chunk_len > max_bytes {
                        break;
                    }
                    total_bytes += chunk_len;
                    chunks.push(ProcessOutputChunk {
                        seq: retained.seq,
                        stream: retained.stream,
                        chunk: retained.chunk.clone().into(),
                    });
                    next_seq = retained.seq + 1;
                    if total_bytes >= max_bytes {
                        break;
                    }
                }
                (
                    ReadResponse {
                        chunks,
                        next_seq,
                        exited: process.exit_code.is_some(),
                        exit_code: process.exit_code,
                        closed: process.closed,
                        failure: (after_seq < process.evicted_through_seq).then(|| {
                            "Earlier output was omitted because the output retention limit was exceeded.".to_string()
                        }),
                    },
                    Arc::clone(&process.output_notify),
                )
            };
            let has_new_terminal_event =
                response.exited && after_seq < response.next_seq.saturating_sub(1);
            if !response.chunks.is_empty()
                || response.closed
                || has_new_terminal_event
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(response);
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(response);
            }
            let _ = tokio::time::timeout(remaining, output_notify.notified()).await;
        }
    }

    pub async fn exec_write(&self, params: WriteParams) -> Result<WriteResponse, ExecServerError> {
        let writer_tx = {
            let process_map = self.inner.processes.lock().await;
            let Some(process) = process_map.get(&params.process_id) else {
                return Ok(WriteResponse {
                    status: WriteStatus::UnknownProcess,
                });
            };
            let ProcessEntry::Running(process) = process else {
                return Ok(WriteResponse {
                    status: WriteStatus::Starting,
                });
            };
            if !process.tty && !process.pipe_stdin {
                return Ok(WriteResponse {
                    status: WriteStatus::StdinClosed,
                });
            }
            process.session.writer_sender()
        };
        writer_tx
            .send(params.chunk.into_inner())
            .await
            .map_err(|_| {
                ExecServerError::Message("failed to write to process stdin".to_string())
            })?;
        Ok(WriteResponse {
            status: WriteStatus::Accepted,
        })
    }

    pub async fn terminate_process(
        &self,
        params: TerminateParams,
    ) -> Result<TerminateResponse, ExecServerError> {
        let running = {
            let process_map = self.inner.processes.lock().await;
            match process_map.get(&params.process_id) {
                Some(ProcessEntry::Running(process)) => {
                    if process.exit_code.is_some() {
                        return Ok(TerminateResponse { running: false });
                    }
                    process.session.terminate();
                    true
                }
                Some(ProcessEntry::Starting) | None => false,
            }
        };
        Ok(TerminateResponse { running })
    }
}

async fn stream_output(
    process_id: ProcessId,
    stream: ExecOutputStream,
    mut receiver: tokio::sync::mpsc::Receiver<Vec<u8>>,
    inner: Arc<Inner>,
    output_notify: Arc<Notify>,
) {
    while let Some(chunk) = receiver.recv().await {
        {
            let mut processes = inner.processes.lock().await;
            let Some(ProcessEntry::Running(process)) = processes.get_mut(&process_id) else {
                break;
            };
            let seq = process.next_seq;
            process.next_seq += 1;
            process.retained_bytes += chunk.len();
            process
                .output
                .push_back(RetainedOutputChunk { seq, stream, chunk });
            while process.retained_bytes > RETAINED_OUTPUT_BYTES_PER_PROCESS {
                let Some(evicted) = process.output.pop_front() else {
                    break;
                };
                process.retained_bytes = process.retained_bytes.saturating_sub(evicted.chunk.len());
                process.evicted_through_seq = evicted.seq;
            }
        }
        output_notify.notify_waiters();
    }
    finish_output_stream(process_id, inner).await;
}

async fn watch_exit(
    process_id: ProcessId,
    exit_rx: tokio::sync::oneshot::Receiver<i32>,
    inner: Arc<Inner>,
    output_notify: Arc<Notify>,
) {
    let exit_code = exit_rx.await.unwrap_or(-1);
    {
        let mut processes = inner.processes.lock().await;
        if let Some(ProcessEntry::Running(process)) = processes.get_mut(&process_id) {
            process.next_seq += 1;
            process.exit_code = Some(exit_code);
        }
    }
    output_notify.notify_waiters();
    maybe_emit_closed(process_id, Arc::clone(&inner)).await;
}

async fn finish_output_stream(process_id: ProcessId, inner: Arc<Inner>) {
    {
        let mut processes = inner.processes.lock().await;
        let Some(ProcessEntry::Running(process)) = processes.get_mut(&process_id) else {
            return;
        };
        if process.open_streams > 0 {
            process.open_streams -= 1;
        }
    }
    maybe_emit_closed(process_id, inner).await;
}

async fn maybe_emit_closed(process_id: ProcessId, inner: Arc<Inner>) {
    let output_notify = {
        let mut processes = inner.processes.lock().await;
        let Some(ProcessEntry::Running(process)) = processes.get_mut(&process_id) else {
            return;
        };
        if process.closed || process.open_streams != 0 || process.exit_code.is_none() {
            return;
        }
        process.closed = true;
        process.next_seq += 1;
        Arc::clone(&process.output_notify)
    };
    output_notify.notify_waiters();
    let cleanup_process_id = process_id.clone();
    let cleanup_inner = Arc::clone(&inner);
    tokio::spawn(async move {
        tokio::time::sleep(EXITED_PROCESS_RETENTION).await;
        let mut processes = cleanup_inner.processes.lock().await;
        match processes.entry(cleanup_process_id) {
            Entry::Occupied(entry) => {
                if matches!(entry.get(), ProcessEntry::Running(process) if process.closed) {
                    entry.remove();
                }
            }
            Entry::Vacant(_) => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ByteChunk;

    #[tokio::test]
    async fn local_process_runs_and_reads_output() {
        let backend = LocalProcess::default();
        let process_id = ProcessId::from("hello");
        backend
            .exec(ExecParams {
                process_id: process_id.clone(),
                argv: vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "printf hello".to_string(),
                ],
                cwd: std::env::current_dir().unwrap(),
                env: HashMap::new(),
                tty: false,
                pipe_stdin: false,
                arg0: None,
            })
            .await
            .unwrap();

        let response = backend
            .exec_read(ReadParams {
                process_id,
                after_seq: None,
                max_bytes: None,
                wait_ms: Some(5_000),
            })
            .await
            .unwrap();
        let output = response
            .chunks
            .into_iter()
            .flat_map(|chunk| chunk.chunk.into_inner())
            .collect::<Vec<_>>();
        assert_eq!(String::from_utf8(output).unwrap(), "hello");
    }

    #[tokio::test]
    async fn pull_reads_retain_tail_after_root_exit_until_streams_close() {
        let backend = LocalProcess::default();
        let process_id = ProcessId::from("exit-before-output-close");
        backend
            .exec(ExecParams {
                process_id: process_id.clone(),
                argv: vec![
                    "sh".into(),
                    "-c".into(),
                    "exec 3<&0; (IFS= read -r line; printf '%s' \"$line\") <&3 & exit 7".into(),
                ],
                cwd: std::env::current_dir().unwrap(),
                env: HashMap::new(),
                tty: false,
                pipe_stdin: true,
                arg0: None,
            })
            .await
            .unwrap();

        // FD 3 preserves stdin across the shell's background-job /dev/null default.
        // The descendant cannot produce its tail until this test sends stdin.
        let exited = backend
            .exec_read(ReadParams {
                process_id: process_id.clone(),
                after_seq: None,
                max_bytes: None,
                wait_ms: Some(2_000),
            })
            .await
            .unwrap();
        assert!(exited.exited);
        assert_eq!(exited.exit_code, Some(7));
        assert!(!exited.closed);
        assert!(exited.chunks.is_empty());

        let write = backend
            .exec_write(WriteParams {
                process_id: process_id.clone(),
                chunk: ByteChunk(b"tail\n".to_vec()),
            })
            .await
            .unwrap();
        assert_eq!(write.status, WriteStatus::Accepted);
        let mut cursor = exited.next_seq.saturating_sub(1);
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let response = backend
                    .exec_read(ReadParams {
                        process_id: process_id.clone(),
                        after_seq: Some(cursor),
                        max_bytes: Some(8_192),
                        wait_ms: Some(20),
                    })
                    .await
                    .unwrap();
                assert!(response.exited);
                assert_eq!(response.exit_code, Some(7));
                for chunk in response.chunks {
                    assert!(chunk.seq > cursor);
                    output.extend_from_slice(&chunk.chunk.0);
                }
                cursor = response.next_seq.saturating_sub(1);
                if response.closed {
                    break;
                }
            }
        })
        .await
        .expect("output streams close after the descendant writes its tail");
        assert_eq!(output, b"tail");
        backend.shutdown().await;
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn reports_unread_output_eviction_without_changing_exit() {
        for bytes in [65_536usize, 12 * 1024 * 1024] {
            let backend = LocalProcess::default();
            let process_id = ProcessId::from(format!("retention-{bytes}"));
            backend.exec(ExecParams {
                process_id: process_id.clone(),
                argv: vec!["sh".into(), "-c".into(), format!("head -c {bytes} /dev/zero")],
                cwd: std::env::current_dir().unwrap(), env: HashMap::new(),
                tty: false, pipe_stdin: false, arg0: None,
            }).await.unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let response = backend.exec_read(ReadParams {
                        process_id: process_id.clone(), after_seq: Some(0),
                        max_bytes: Some(1), wait_ms: Some(20),
                    }).await.unwrap();
                    if response.closed { break; }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            }).await.expect("the finite producer closes its output streams");
            let response = backend.exec_read(ReadParams {
                process_id: process_id.clone(), after_seq: Some(0),
                max_bytes: None, wait_ms: None,
            }).await.unwrap();
            assert_eq!(response.exit_code, Some(0));
            assert!(response.closed);
            let captured: usize = response.chunks.iter().map(|chunk| chunk.chunk.0.len()).sum();
            if bytes == 65_536 {
                assert_eq!(captured, bytes);
                assert!(response.failure.is_none(), "fully retained output is not a capture failure");
            } else {
                assert!(captured < bytes, "the lagging cursor actually misses producer output");
                assert!(response.failure.is_some(), "omitted unread bytes must be explicitly reported");
            }
            let caught_up = backend.exec_read(ReadParams {
                process_id, after_seq: Some(response.next_seq.saturating_sub(1)),
                max_bytes: None, wait_ms: None,
            }).await.unwrap();
            assert!(caught_up.failure.is_none(), "an up-to-date cursor does not lose unread data");
            assert!(caught_up.chunks.is_empty());
            backend.shutdown().await;
        }
    }

    #[tokio::test]
    async fn local_process_accepts_stdin_when_requested() {
        let backend = LocalProcess::default();
        let process_id = ProcessId::from("stdin");
        backend
            .exec(ExecParams {
                process_id: process_id.clone(),
                argv: vec!["cat".to_string()],
                cwd: std::env::current_dir().unwrap(),
                env: HashMap::new(),
                tty: false,
                pipe_stdin: true,
                arg0: None,
            })
            .await
            .unwrap();

        let write = backend
            .exec_write(WriteParams {
                process_id: process_id.clone(),
                chunk: ByteChunk(b"ping".to_vec()),
            })
            .await
            .unwrap();
        assert_eq!(write.status, WriteStatus::Accepted);
        let response = backend
            .exec_read(ReadParams {
                process_id,
                after_seq: None,
                max_bytes: None,
                wait_ms: Some(5_000),
            })
            .await
            .unwrap();
        let output = response
            .chunks
            .into_iter()
            .flat_map(|chunk| chunk.chunk.into_inner())
            .collect::<Vec<_>>();
        assert_eq!(String::from_utf8(output).unwrap(), "ping");
        backend.shutdown().await;
    }
}
