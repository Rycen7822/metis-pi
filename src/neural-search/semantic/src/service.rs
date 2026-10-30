//! Same-user model service: three searches, FIFO backpressure, idle teardown.
use crate::{
    Args, Result,
    request::{self, Context, Control},
    semantic::shared::Models,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Condvar, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};
const PROTOCOL: u8 = 2;
const ACTIVE: usize = 3;
const QUEUED: usize = 32;
const REQUEST_BYTES: usize = 1 << 20;
const RESPONSE_BYTES: usize = 34 << 20;
// These affect the process-owned model/parser/acquisition environment. They may
// not silently change between clients. Corpus policy/diagnostics are per-request.
const AMBIENT: &[&str] = &[
    "HOME",
    "SGREP_RUNTIME_DIR",
    "TREE_SITTER_LANGUAGE_PACK_CACHE_DIR",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "HF_HUB_OFFLINE",
    "HF_TOKEN",
    "HF_ENDPOINT",
    "HF_HOME",
    "HF_HUB_CACHE",
    "TOKENIZERS_PARALLELISM",
    "RAYON_NUM_THREADS",
    "OMP_NUM_THREADS",
];
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    protocol: u8,
    pid: u32,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Identity {
    protocol: u8,
    binary: (u64, u64, u64, i64, i64),
    environment: BTreeMap<String, Option<String>>,
}
impl Identity {
    fn current() -> Result<Self> {
        let m = std::fs::metadata(std::env::current_exe()?)?;
        Ok(Self {
            protocol: PROTOCOL,
            binary: (m.dev(), m.ino(), m.len(), m.ctime(), m.ctime_nsec()),
            environment: AMBIENT
                .iter()
                .map(|&n| (n.to_owned(), std::env::var(n).ok()))
                .collect(),
        })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Search {
        identity: Identity,
        argv: Vec<String>,
        cwd: PathBuf,
        variables: BTreeMap<String, Option<String>>,
        timeout_ms: u64,
        idle_seconds: u64,
    },
    Status {},
    Stop {},
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    stdout: String,
    stderr: String,
    exit: u8,
    service: serde_json::Value,
}
fn error(e: impl std::fmt::Display) -> Response {
    Response {
        stderr: format!("sgrep: {e}\n"),
        exit: 2,
        ..Response::default()
    }
}
fn write_frame<T: Serialize>(stream: &mut UnixStream, value: &T, max: usize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > max {
        return Err("semantic service frame exceeds size limit".into());
    }
    stream.write_all(&(bytes.len() as u32).to_le_bytes())?;
    stream.write_all(&bytes)?;
    Ok(())
}
fn read_frame<T: serde::de::DeserializeOwned>(stream: &mut UnixStream, max: usize) -> Result<T> {
    let mut size = [0; 4];
    stream.read_exact(&mut size)?;
    let n = u32::from_le_bytes(size) as usize;
    if n == 0 || n > max {
        return Err("invalid semantic service frame size".into());
    }
    let mut bytes = vec![0; n];
    stream.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn uid() -> u32 {
    unsafe { libc::geteuid() }
}
fn peer(stream: &UnixStream) -> Result<()> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut n = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut n,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if n as usize != std::mem::size_of::<libc::ucred>() || cred.uid != uid() {
        return Err("semantic service peer must have the same UID".into());
    }
    Ok(())
}
struct Paths {
    root: PathBuf,
    socket: PathBuf,
}
impl Paths {
    fn new() -> Result<Self> {
        use sha2::{Digest, Sha256};
        use std::os::unix::ffi::OsStrExt;
        let home =
            PathBuf::from(std::env::var_os("HOME").ok_or("HOME is required for shared semantic")?)
                .canonicalize()?;
        let hash = Sha256::digest(home.as_os_str().as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let root = PathBuf::from(format!("/tmp/metis-semantic-{}-{hash}", uid()));
        match std::fs::DirBuilder::new().mode(0o700).create(&root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let m = std::fs::symlink_metadata(&root)?;
        if !m.is_dir() || m.uid() != uid() || m.mode() & 0o077 != 0 {
            return Err("unsafe shared semantic directory owner/type/permissions".into());
        }
        Ok(Self {
            socket: root.join("rpc"),
            root,
        })
    }
    fn file(&self, name: &str) -> Result<File> {
        let p = self.root.join(name);
        let f = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(p)?;
        let m = f.metadata()?;
        if !m.is_file() || m.uid() != uid() || m.mode() & 0o077 != 0 {
            return Err("unsafe semantic service control file".into());
        }
        Ok(f)
    }
}
struct Delivery {
    response: Response,
    // Dropped by the connection after transmission; until then the request
    // retains its slot, bounding serialized results and transport CPU too.
    completed: mpsc::Sender<()>,
}
struct Job {
    args: Args,
    context: Arc<Context>,
    reply: mpsc::SyncSender<Delivery>,
    submitted: Instant,
}
struct State {
    queue: VecDeque<Job>,
    active: usize,
    peak: usize,
    finished: usize,
    cancelled: usize,
    last: Instant,
    idle: Duration,
    draining: bool,
}
struct CancelOnDisconnect<'a> {
    server: &'a Server,
    control: Arc<Control>,
    finished: bool,
}
impl Drop for CancelOnDisconnect<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.server.cancel_request(&self.control);
        }
    }
}
struct Connection {
    done: Arc<std::sync::atomic::AtomicBool>,
    handle: thread::JoinHandle<()>,
}
struct ConnectionDone {
    server: Arc<Server>,
    done: Arc<std::sync::atomic::AtomicBool>,
}
impl Drop for ConnectionDone {
    fn drop(&mut self) {
        // Publish capacity even when handling the peer unwinds.
        self.done.store(true, std::sync::atomic::Ordering::Release);
        self.server.notify();
    }
}
struct Server {
    wake: UnixStream,
    state: Mutex<State>,
    changed: Condvar,
    models: Arc<Models>,
    identity: Identity,
}
impl Server {
    fn notify(&self) {
        self.changed.notify_all();
        // One byte suffices; a full nonblocking pipe already guarantees a wake.
        let mut wake = &self.wake;
        if let Err(error) = wake.write_all(&[1]) {
            if error.kind() != std::io::ErrorKind::WouldBlock {
                request::diagnostic(format_args!("sgrep: service wake failed: {error}"));
            }
        }
    }
    fn cancel_request(&self, control: &Arc<Control>) {
        control.cancel();
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let before = s.queue.len();
        s.queue
            .retain(|job| !Arc::ptr_eq(&job.context.control, control));
        let removed = before - s.queue.len();
        if removed > 0 {
            s.finished += removed;
            s.cancelled += removed;
            s.last = Instant::now();
            self.notify();
        }
    }
    fn stats(&self) -> serde_json::Value {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::json!({"protocol":PROTOCOL,"pid":std::process::id(),"active":s.active,"queued":s.queue.len(),"max_active":ACTIVE,"computing_threads_per_request":crate::semantic::computing_threads(),"peak_active":s.peak,"completed":s.finished,"cancelled":s.cancelled,"idle_timeout_seconds":s.idle.as_secs(),"draining":s.draining,"models":self.models.stats()})
    }
    fn worker(&self) {
        loop {
            let job = {
                let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if let Some(job) = s.queue.pop_front() {
                        self.notify();
                        if job.context.control.check().is_err() {
                            s.cancelled += 1;
                            s.finished += 1;
                            let (completed, _) = mpsc::channel();
                            let _ = job.reply.send(Delivery {
                                response: error("CANCELLED: queued request cancelled or expired"),
                                completed,
                            });
                            s.last = Instant::now();
                            continue;
                        }
                        s.active += 1;
                        s.peak = s.peak.max(s.active);
                        break job;
                    }
                    if s.draining {
                        return;
                    }
                    s = self.changed.wait(s).unwrap_or_else(|e| e.into_inner());
                }
            };
            let queued = job.submitted.elapsed();
            let begin = Instant::now();
            let context = job.context.clone();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                request::enter(context.clone(), || -> Result<(String, u8)> {
                    request::check()?;
                    let results = crate::search(&job.args)?;
                    request::check()?;
                    let exit = if results.is_empty() { 1 } else { 0 };
                    Ok((crate::format_results(&job.args, &results)?, exit))
                })
            }));
            let mut response = match result {
                Ok(Ok((stdout, exit))) => Response {
                    exit,
                    stdout,
                    stderr: context.control.log(),
                    service: serde_json::Value::Null,
                },
                Ok(Err(e)) => {
                    let mut r = error(e);
                    r.stderr = context.control.log() + &r.stderr;
                    r
                }
                Err(_) => error("UNVERIFIED_BACKEND: search worker panicked"),
            };
            if let Some(path) = context
                .vars
                .get("SGREP_DIAGNOSTICS_PATH")
                .and_then(Option::as_ref)
            {
                if let Err(e) = std::fs::write(path, format!("{}\n", context.control.metrics())) {
                    response = error(format!("requested shared diagnostics failed: {e}"));
                }
            }
            response.service = serde_json::json!({"pid":std::process::id(),"queue_wait_ms":queued.as_secs_f64()*1000.0,"execution_ms":begin.elapsed().as_secs_f64()*1000.0,"request":context.control.metrics(),"models":self.models.stats()});
            let (completed, delivered) = mpsc::channel();
            let _ = job.reply.send(Delivery {
                response,
                completed,
            });
            let _ = delivered.recv();
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            s.active -= 1;
            s.finished += 1;
            if context.control.check().is_err() {
                s.cancelled += 1;
            }
            s.last = Instant::now();
            self.notify();
        }
    }
    fn connection(&self, mut stream: UnixStream) -> Result<()> {
        peer(&stream)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        // A connected pathname is not proof that a crashed listener can serve.
        // Greet before accepting any search so startup retries cannot replay work.
        write_frame(
            &mut stream,
            &Ready {
                protocol: PROTOCOL,
                pid: std::process::id(),
            },
            256,
        )?;
        let message: Message = read_frame(&mut stream, REQUEST_BYTES)?;
        let mut delivery = None;
        let reply = match message {
            Message::Status {} => Response {
                service: self.stats(),
                ..Response::default()
            },
            Message::Stop {} => {
                self.state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .draining = true;
                self.notify();
                Response {
                    service: self.stats(),
                    ..Response::default()
                }
            }
            Message::Search {
                identity,
                argv,
                cwd,
                variables,
                timeout_ms,
                idle_seconds,
            } => {
                if identity != self.identity {
                    return write_frame(
                        &mut stream,
                        &error(
                            "SERVICE_VERSION_MISMATCH: drain with `sgrep --service-control stop` before changing runtime/environment; no second model process started",
                        ),
                        RESPONSE_BYTES,
                    );
                }
                if !(1..=86400).contains(&idle_seconds)
                    || timeout_ms == 0
                    || timeout_ms > 3_600_000
                    || !cwd.is_absolute()
                    || variables.len() != request::VARIABLES.len()
                    || !request::VARIABLES
                        .iter()
                        .all(|k| variables.contains_key(*k))
                {
                    return write_frame(
                        &mut stream,
                        &error("invalid shared semantic request settings"),
                        RESPONSE_BYTES,
                    );
                }
                let mut args = match Args::try_parse_from(argv) {
                    Ok(a) => a,
                    Err(e) => return write_frame(&mut stream, &error(e), RESPONSE_BYTES),
                };
                if args.stdin
                    || args.rg_json.is_some()
                    || args.fresh_assets
                    || args.cache_dir.is_some()
                {
                    return write_frame(
                        &mut stream,
                        &error(
                            "shared semantic does not accept stdin/rg-json/fresh-assets/cache-dir; use the explicit standalone CLI for those modes",
                        ),
                        RESPONSE_BYTES,
                    );
                }
                if args.path.is_relative() {
                    args.path = cwd.join(&args.path);
                }
                let control = Arc::new(Control::new(Duration::from_millis(timeout_ms)));
                let mut cancellation = CancelOnDisconnect {
                    server: self,
                    control: control.clone(),
                    finished: false,
                };
                let context = Arc::new(Context {
                    vars: variables,
                    control: control.clone(),
                    models: self.models.clone(),
                });
                // Validate the caller's fresh policy snapshot before changing idle settings.
                request::enter(context.clone(), crate::storage::policy_check)?;
                let (tx, rx) = mpsc::sync_channel(1);
                let mut job = Some(Job {
                    args,
                    context,
                    reply: tx,
                    submitted: Instant::now(),
                });
                stream.set_read_timeout(Some(Duration::from_millis(20)))?;
                loop {
                    {
                        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
                        if s.draining {
                            return write_frame(
                                &mut stream,
                                &error("semantic service is draining; retry after shutdown"),
                                RESPONSE_BYTES,
                            );
                        }
                        if s.queue.len() < QUEUED {
                            s.idle = Duration::from_secs(idle_seconds);
                            s.queue.push_back(job.take().expect("not queued"));
                            self.notify();
                            break;
                        }
                    }
                    if disconnected(&mut stream)? {
                        control.cancel();
                    }
                    control.check()?;
                }
                stream.set_nonblocking(true)?;
                let mut gone = false;
                loop {
                    control.poll();
                    match rx.recv_timeout(Duration::from_millis(10)) {
                        Ok(r) => {
                            if gone {
                                return Ok(());
                            }
                            cancellation.finished = true;
                            delivery = Some(r.completed);
                            break r.response;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            break error("semantic search executor stopped");
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    if !gone && disconnected(&mut stream)? {
                        gone = true;
                        self.cancel_request(&control);
                    } else if gone {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        };
        stream.set_nonblocking(false)?;
        let result = write_frame(&mut stream, &reply, RESPONSE_BYTES);
        drop(delivery);
        result
    }
}
fn disconnected(stream: &mut UnixStream) -> std::io::Result<bool> {
    let mut byte = [0];
    match stream.read(&mut byte) {
        Ok(_) => Ok(true),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::Interrupted
            ) =>
        {
            Ok(false)
        }
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
            ) =>
        {
            Ok(true)
        }
        Err(e) => Err(e),
    }
}
fn serve(mut startup: Option<UnixStream>) -> Result<()> {
    let paths = Paths::new()?;
    let lock = paths.file("server.lock")?;
    lock.try_lock()?;
    if let Ok(m) = std::fs::symlink_metadata(&paths.socket) {
        if !m.file_type().is_socket() || m.uid() != uid() {
            return Err("refusing to remove unknown semantic socket path".into());
        }
        std::fs::remove_file(&paths.socket)?;
    }
    let listener = UnixListener::bind(&paths.socket)?;
    std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let (wake_read, wake_write) = UnixStream::pair()?;
    wake_read.set_nonblocking(true)?;
    wake_write.set_nonblocking(true)?;
    let server = Arc::new(Server {
        wake: wake_write,
        identity: Identity::current()?,
        models: Arc::new(Models::new()?),
        changed: Condvar::new(),
        state: Mutex::new(State {
            queue: VecDeque::new(),
            active: 0,
            peak: 0,
            finished: 0,
            cancelled: 0,
            last: Instant::now(),
            idle: Duration::from_secs(300),
            draining: false,
        }),
    });
    let mut workers = Vec::new();
    for _ in 0..ACTIVE {
        let s = server.clone();
        workers.push(
            thread::Builder::new()
                .name("semantic-request".into())
                .spawn(move || s.worker())?,
        );
    }
    // The startup FD is a one-shot parent capability, not a replacement for the
    // authenticated protocol2 greeting. Models remain lazy at this boundary.
    if let Some(mut notification) = startup.take() {
        // stdout BrokenPipe is a successful CLI consumer exit, but this control
        // channel must remain a startup failure rather than using that mapping.
        notification
            .write_all(b"R")
            .map_err(|e| format!("semantic startup notification failed: {e}"))?;
    }
    let mut connections: Vec<Connection> = Vec::new();
    loop {
        {
            let mut s = server.state.lock().unwrap_or_else(|e| e.into_inner());
            if s.active == 0 && s.queue.is_empty() && (s.draining || s.last.elapsed() >= s.idle) {
                s.draining = true;
                server.notify();
                break;
            }
        }
        let mut i = 0;
        while i < connections.len() {
            if connections[i]
                .done
                .load(std::sync::atomic::Ordering::Acquire)
            {
                let connection = connections.swap_remove(i);
                let _ = connection.handle.join();
            } else {
                i += 1;
            }
        }
        if connections.len() < ACTIVE + QUEUED + 4 {
            match listener.accept() {
                Ok((stream, _)) => {
                    let s = server.clone();
                    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let finished = done.clone();
                    let handle = thread::Builder::new()
                        .name("semantic-client".into())
                        .spawn(move || {
                            let _done = ConnectionDone {
                                server: s.clone(),
                                done: finished,
                            };
                            let fallback = stream.try_clone().ok();
                            if let Err(e) = s.connection(stream) {
                                if let Some(mut f) = fallback {
                                    let _ = write_frame(&mut f, &error(e), RESPONSE_BYTES);
                                }
                            }
                        })?;
                    connections.push(Connection { done, handle });
                    continue;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.into()),
            }
        }
        let timeout = {
            let state = server.state.lock().unwrap_or_else(|e| e.into_inner());
            (state.active == 0 && state.queue.is_empty())
                .then(|| state.idle.saturating_sub(state.last.elapsed()))
        };
        let mut fds = vec![wake_read.as_raw_fd()];
        if connections.len() < ACTIVE + QUEUED + 4 {
            fds.push(listener.as_raw_fd());
        }
        crate::readiness::wait(&fds, timeout)?;
        let mut wake = &wake_read;
        let mut bytes = [0u8; 256];
        loop {
            match wake.read(&mut bytes) {
                Ok(0) => return Err("service wake pipe closed".into()),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
    for connection in connections {
        let _ = connection.handle.join();
    }
    for h in workers {
        h.join()
            .map_err(|_| "semantic executor panicked on shutdown")?;
    }
    drop(server);
    drop(listener);
    std::fs::remove_file(&paths.socket)?;
    drop(lock);
    Ok(())
}
fn ready(paths: &Paths) -> Result<UnixStream> {
    let mut stream = UnixStream::connect(&paths.socket)?;
    peer(&stream)?;
    stream.set_read_timeout(Some(Duration::from_millis(250)))?;
    let hello: Ready = read_frame(&mut stream, 256)?;
    if hello.protocol != PROTOCOL || hello.pid == 0 {
        return Err(
            "SERVICE_VERSION_MISMATCH: invalid service greeting; drain the old service".into(),
        );
    }
    Ok(stream)
}
fn connect(start: bool) -> Result<UnixStream> {
    let paths = Paths::new()?;
    if let Ok(stream) = ready(&paths) {
        return Ok(stream);
    }
    if !start {
        return Err("semantic service is not running or ready".into());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let gate = paths.file("start.lock")?;
    loop {
        match gate.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(e) => return Err(e.into()),
        }
    }
    let lifetime = paths.file("server.lock")?;
    let mut child: Option<std::process::Child> = None;
    let mut startup: Option<UnixStream> = None;
    loop {
        if let Ok(stream) = ready(&paths) {
            return Ok(stream);
        }
        if child.is_none() {
            match lifetime.try_lock() {
                Ok(()) => {
                    lifetime.unlock()?;
                    let log = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .mode(0o600)
                        .custom_flags(libc::O_NOFOLLOW)
                        .open(paths.root.join("service.log"))?;
                    let (parent_ready, child_ready) = UnixStream::pair()?;
                    parent_ready.set_nonblocking(true)?;
                    let fd = child_ready.as_raw_fd();
                    let mut command = Command::new(std::env::current_exe()?);
                    command
                        .args(["--service-control", "serve", "--notify-fd"])
                        .arg(fd.to_string())
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(log);
                    for &key in request::VARIABLES {
                        command.env_remove(key);
                    }
                    unsafe {
                        command.pre_exec(move || {
                            if libc::setsid() < 0 {
                                return Err(std::io::Error::last_os_error());
                            }
                            let flags = libc::fcntl(fd, libc::F_GETFD);
                            if flags < 0
                                || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                            {
                                return Err(std::io::Error::last_os_error());
                            }
                            Ok(())
                        });
                    }
                    child = Some(command.spawn()?);
                    drop(child_ready);
                    startup = Some(parent_ready);
                }
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(e) => return Err(e.into()),
            }
        }
        if let Some(process) = child.as_mut() {
            if let Some(status) = process.try_wait()? {
                return Err(format!(
                    "semantic service startup failed ({status}); inspect private service.log"
                )
                .into());
            }
        }
        if Instant::now() >= deadline {
            return Err("semantic service did not handshake; drain/restart an incompatible service; no second model process started".into());
        }
        if let Some(mut notification) = startup.take() {
            loop {
                crate::readiness::wait(
                    &[notification.as_raw_fd()],
                    Some(deadline.saturating_duration_since(Instant::now())),
                )?;
                if Instant::now() >= deadline {
                    return Err("semantic startup notification deadline".into());
                }
                let mut byte = [0u8; 1];
                match notification.read(&mut byte) {
                    Ok(1) if byte[0] == b'R' => break,
                    Ok(_) => return Err("semantic startup notification closed or invalid; inspect private service.log".into()),
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock) => continue,
                    Err(e) => return Err(e.into()),
                }
            }
        } else {
            // An independently started/draining owner still controls server.lock.
            // This fallback never starts another Session or resends a search.
            thread::sleep(Duration::from_millis(10));
        }
    }
}
pub(crate) fn client(args: &Args) -> Result<(String, String, u8)> {
    if args.stdin || args.rg_json.is_some() || args.fresh_assets || args.cache_dir.is_some() {
        return Err("shared semantic does not accept stdin/rg-json/fresh-assets/cache-dir".into());
    }
    let cwd = std::env::current_dir()?;
    let mut vars = BTreeMap::new();
    for &name in request::VARIABLES {
        let mut v = std::env::var(name).ok();
        if name.ends_with("_PATH") || name == "SGREP_CACHE_DIR" {
            if let Some(path) = &v {
                let p = Path::new(path);
                if p.is_relative() {
                    v = Some(
                        cwd.join(p)
                            .to_str()
                            .ok_or("shared paths must be UTF-8")?
                            .into(),
                    );
                }
            }
        }
        vars.insert(name.into(), v);
    }
    let message = Message::Search {
        identity: Identity::current()?,
        argv: std::env::args().collect(),
        cwd,
        variables: vars,
        timeout_ms: args.service_timeout_seconds * 1000,
        idle_seconds: args.idle_timeout_seconds,
    };
    let mut stream = connect(true)?;
    stream.set_read_timeout(Some(Duration::from_secs(args.service_timeout_seconds + 5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    write_frame(&mut stream, &message, REQUEST_BYTES)?;
    let reply: Response = read_frame(&mut stream, RESPONSE_BYTES)?;
    if let Some(path) = std::env::var_os("SGREP_SERVICE_INFO_PATH") {
        std::fs::write(path, format!("{}\n", reply.service))?;
    }
    Ok((reply.stdout, reply.stderr, reply.exit))
}
pub(crate) fn control() -> Result<()> {
    match std::env::args().nth(2).as_deref() {
        Some("serve") => {
            let notification = match (
                std::env::args().nth(3),
                std::env::args().nth(4),
                std::env::args().nth(5),
            ) {
                (None, None, None) => None,
                (Some(flag), Some(raw), None) if flag == "--notify-fd" => {
                    let fd: i32 = raw.parse()?;
                    if fd <= 2 {
                        return Err("invalid startup notification descriptor".into());
                    }
                    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
                    if flags < 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    let stream = unsafe { UnixStream::from_raw_fd(fd) };
                    peer(&stream)?;
                    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    Some(stream)
                }
                _ => return Err("invalid private startup notification arguments".into()),
            };
            serve(notification)
        }
        Some(command @ ("status" | "stop")) => {
            let mut stream = connect(false)?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            write_frame(
                &mut stream,
                &if command == "status" {
                    Message::Status {}
                } else {
                    Message::Stop {}
                },
                REQUEST_BYTES,
            )?;
            let r: Response = read_frame(&mut stream, RESPONSE_BYTES)?;
            if r.exit != 0 {
                return Err(r.stderr.into());
            }
            println!("{}", r.service);
            Ok(())
        }
        _ => {
            Err("usage: sgrep --service-control <status|stop> (serve is an internal entry)".into())
        }
    }
}
