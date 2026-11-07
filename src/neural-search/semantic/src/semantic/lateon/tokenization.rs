//! Model-lifetime workers own every filled BPE TLS cache, including queries.
//! Joining them on model replacement releases tokenizers' old cache generations.
use super::{MAX_WINDOW_TOKENS, Manifest};
use crate::{Chunk, Result, request, semantic::MAX_BATCH_WINDOWS};
use std::{
    collections::HashSet,
    path::Path,
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
};

// Scheduling only: do not multiply large-source BPE scratch across four workers.
// Larger batches retain sequential preparation, with identical source windows.
const MAX_PARALLEL_INPUT_BYTES: usize = 64 * 1024;

// This asset is BPE: retain encode_fast without ModelWrapper's JSON dispatch.
type BpeTokenizer = tokenizers::TokenizerImpl<
    tokenizers::models::bpe::BPE,
    tokenizers::normalizers::NormalizerWrapper,
    tokenizers::pre_tokenizers::PreTokenizerWrapper,
    tokenizers::processors::PostProcessorWrapper,
    tokenizers::decoders::DecoderWrapper,
>;

pub(super) struct PreparedWindow {
    pub end: usize,
    pub ids: Vec<u32>,
    pub mask: Vec<u8>,
}
struct Tokenizer {
    tokenizer: BpeTokenizer,
    query_prefix: u32,
    document_prefix: u32,
    lower_case: bool,
    skiplist: HashSet<u32>,
}
impl Tokenizer {
    fn tokenize(&self, text: &str, query: bool) -> Result<(Vec<u32>, Vec<u8>)> {
        // Fixed PyLate strips/lowercases via ST, then inserts role ID at 1.
        let text = if self.lower_case {
            text.trim().to_lowercase()
        } else {
            text.trim().to_owned()
        };
        let mut ids = self.tokenizer.encode_fast(text, true)?.get_ids().to_vec();
        if ids.len() < 2 {
            return Err("ARTIFACT_MISMATCH: missing BOS/EOS processor".into());
        }
        ids.insert(
            1,
            if query {
                self.query_prefix
            } else {
                self.document_prefix
            },
        );
        let mask = ids
            .iter()
            .map(|id| u8::from(query || !self.skiplist.contains(id)))
            .collect();
        Ok((ids, mask))
    }
    fn window(&self, chunk: &Chunk, start: usize) -> Result<PreparedWindow> {
        let prefix = format!("{}\n", chunk.path);
        let content = &chunk.content;
        let mut end = content.len();
        loop {
            request::check()?;
            let text = format!("{prefix}{}", &content[start..end]);
            let (ids, mask) = self.tokenize(&text, false)?;
            if ids.len() <= MAX_WINDOW_TOKENS {
                return Ok(PreparedWindow { end, ids, mask });
            }
            // Actual UTF-8 source ranges; no monotonic BPE-count assumption.
            let mut next = start + (end - start) / 2;
            while next > start && !content.is_char_boundary(next) {
                next -= 1;
            }
            if next == start {
                if self.tokenize(&prefix, false)?.0.len() > MAX_WINDOW_TOKENS {
                    return Err(
                        "INVALID_INPUT: path/role prefix exceeds LateOn's document budget".into(),
                    );
                }
                return Err(
                    "INVALID_INPUT: path prefix leaves no room for one source character".into(),
                );
            }
            end = next;
        }
    }
}
enum Task {
    Query {
        text: String,
        reply: SyncSender<Result<(Vec<u32>, Vec<u8>)>>,
    },
    Window {
        document: usize,
        chunk: Arc<Chunk>,
        start: usize,
        reply: SyncSender<(usize, Result<PreparedWindow>)>,
    },
}
struct Job {
    context: Option<Arc<request::Context>>,
    task: Task,
}
struct Worker {
    sender: Option<SyncSender<Job>>,
    handle: Option<JoinHandle<()>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(handle) = self.handle.take()
            && handle.join().is_err()
        {
            eprintln!("sgrep: tokenizer worker panicked during model lifetime");
        }
    }
}
pub(super) struct Tokenizers {
    workers: Vec<Worker>,
    failed: bool,
}
impl Tokenizers {
    pub fn open(model: &Path, config: Manifest) -> Result<Self> {
        let mut tokenizer = BpeTokenizer::from_file(model.join("tokenizer.json"))?;
        tokenizer.with_truncation(None)?;
        tokenizer.with_padding(None);
        let query_prefix = tokenizer
            .token_to_id(&config.query_prefix)
            .ok_or("query role token missing")?;
        let document_prefix = tokenizer
            .token_to_id(&config.document_prefix)
            .ok_or("document role token missing")?;
        let tokenizer = Arc::new(Tokenizer {
            tokenizer,
            query_prefix,
            document_prefix,
            lower_case: config.do_lower_case,
            skiplist: config.skiplist,
        });
        let mut workers = Vec::with_capacity(MAX_BATCH_WINDOWS);
        for lane in 0..MAX_BATCH_WINDOWS {
            let tokenizer = tokenizer.clone(); // Arc only; never clone the BPE/cache.
            let (sender, jobs) = mpsc::sync_channel::<Job>(1);
            let handle = thread::Builder::new()
                .name(format!("semantic-tokenize-{lane}"))
                .spawn(move || {
                    for job in jobs {
                        let run = || match job.task {
                            Task::Query { text, reply } => reply
                                .send(
                                    request::check().and_then(|()| tokenizer.tokenize(&text, true)),
                                )
                                .is_ok(),
                            Task::Window {
                                document,
                                chunk,
                                start,
                                reply,
                            } => reply
                                .send((document, tokenizer.window(&chunk, start)))
                                .is_ok(),
                        };
                        let delivered = match job.context {
                            Some(context) => request::enter(context, run),
                            None => run(),
                        };
                        if !delivered {
                            break; // Consumer vanished; do not leave an unowned worker.
                        }
                    }
                })?;
            workers.push(Worker {
                sender: Some(sender),
                handle: Some(handle),
            });
        }
        Ok(Self {
            workers,
            failed: false,
        })
    }
    fn dispatch(&mut self, lane: usize, task: Task) -> Result<()> {
        if self.failed {
            return Err("UNVERIFIED_BACKEND: tokenizer pool stopped".into());
        }
        let job = Job {
            context: request::current(),
            task,
        };
        if self.workers[lane]
            .sender
            .as_ref()
            .expect("live worker")
            .send(job)
            .is_err()
        {
            self.failed = true;
            return Err("UNVERIFIED_BACKEND: tokenizer worker stopped".into());
        }
        Ok(())
    }
    fn receive<T>(&mut self, receiver: &Receiver<T>) -> Result<T> {
        receiver.recv().map_err(|_| {
            self.failed = true;
            "UNVERIFIED_BACKEND: tokenizer worker disconnected".into()
        })
    }
    pub fn query(&mut self, text: &str) -> Result<(Vec<u32>, Vec<u8>)> {
        request::check()?;
        let (reply, done) = mpsc::sync_channel(0);
        self.dispatch(
            0,
            Task::Query {
                text: text.to_owned(),
                reply,
            },
        )?;
        self.receive(&done)?
    }
    pub fn window(
        &mut self,
        document: usize,
        chunk: Arc<Chunk>,
        start: usize,
    ) -> Result<PreparedWindow> {
        let (reply, done) = mpsc::sync_channel(0);
        self.dispatch(
            document % self.workers.len(),
            Task::Window {
                document,
                chunk,
                start,
                reply,
            },
        )?;
        let (_, result) = self.receive(&done)?;
        result
    }
    pub fn first_windows(
        &mut self,
        documents: &[Arc<Chunk>],
    ) -> Result<Vec<Result<PreparedWindow>>> {
        request::check()?;
        let bytes = documents.iter().fold(0_usize, |total, chunk| {
            total
                .saturating_add(chunk.path.len())
                .saturating_add(1)
                .saturating_add(chunk.content.len())
        });
        if documents.len() > self.workers.len() || bytes > MAX_PARALLEL_INPUT_BYTES {
            return Ok(Vec::new());
        }
        let mut prepared: Vec<_> = documents.iter().map(|_| None).collect();
        let (reply, done) = mpsc::sync_channel(MAX_BATCH_WINDOWS);
        let mut failure = None;
        let mut submitted = 0;
        for (document, chunk) in documents.iter().enumerate() {
            let task = Task::Window {
                document,
                chunk: chunk.clone(),
                start: 0,
                reply: reply.clone(),
            };
            if let Err(error) = self.dispatch(document, task) {
                failure = Some(error);
                break;
            }
            submitted += 1;
        }
        drop(reply);
        // Drain all submitted work before Native/sink, even when a worker fails.
        for _ in 0..submitted {
            let (document, result) = self.receive(&done)?;
            prepared[document] = Some(result);
        }
        if let Some(error) = failure {
            return Err(error);
        }
        // Defer tokenization errors to their original source position.
        Ok(prepared
            .into_iter()
            .map(|result| result.expect("each worker replied"))
            .collect())
    }
}
