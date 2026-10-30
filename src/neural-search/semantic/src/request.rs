//! Request-owned state for the shared process. Never mutate process env or cwd.
use crate::Result;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    ffi::{OsString, c_void},
    fmt::{self, Write as _},
    io::Read,
    process::{Command, Output, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

thread_local! { static CURRENT: RefCell<Option<Arc<Context>>> = const { RefCell::new(None) }; }
pub(crate) const VARIABLES: &[&str] = &[
    "SGREP_CACHE_POLICY_REQUEST",
    "SGREP_CACHE_DIR",
    "SGREP_CACHE_MAX_BYTES",
    "SGREP_STAGE_TIMINGS_PATH",
    "SGREP_RETRIEVAL_TRACE_PATH",
    "SGREP_CACHE_DIAGNOSTICS_PATH",
    "SGREP_DIAGNOSTICS_PATH",
];
pub(crate) struct Context {
    pub vars: BTreeMap<String, Option<String>>,
    pub control: Arc<Control>,
    pub models: Arc<crate::semantic::shared::Models>,
}
#[derive(Debug)]
struct Cancelled;
impl fmt::Display for Cancelled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CANCELLED: semantic request cancelled or expired")
    }
}
impl std::error::Error for Cancelled {}

type CancelFn = unsafe extern "C" fn(*mut c_void, u64) -> i32;
struct NativeCancel {
    handle: *mut c_void,
    cancel: CancelFn,
    id: u64,
}
// SAFETY: this capability can ONLY call the C ABI's synchronized cancel entry.
// It cannot encode/inspect/destroy a runtime. Registration is removed under the
// same mutex before encode returns and before the model owner can destroy it.
unsafe impl Send for NativeCancel {}
pub(crate) struct Control {
    cancelled: AtomicBool,
    deadline: Instant,
    native: Mutex<Option<NativeCancel>>,
    log: Mutex<String>,
    metrics: Mutex<serde_json::Value>,
}
impl Control {
    pub fn new(timeout: Duration) -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            deadline: Instant::now() + timeout,
            native: Mutex::new(None),
            log: Mutex::new(String::new()),
            metrics: Mutex::new(
                serde_json::json!({"query_forward_count":0,"document_forward_count":0}),
            ),
        }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(native) = self.native.lock() {
            if let Some(n) = &*native {
                // See NativeCancel's lifetime contract. Repeated cancellation also closes
                // the race where the first signal preceded native active_request setup.
                let status = unsafe { (n.cancel)(n.handle, n.id) };
                if status != 0 {
                    self.note(format_args!(
                        "sgrep: native cancellation returned status {status}"
                    ));
                }
            }
        }
    }
    pub fn check(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            self.cancel();
        }
        if self.cancelled.load(Ordering::Acquire) {
            Err(Box::new(Cancelled))
        } else {
            Ok(())
        }
    }
    pub fn poll(&self) {
        if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            self.cancel();
        }
    }
    pub fn note(&self, args: fmt::Arguments<'_>) {
        let mut text = self.log.lock().unwrap_or_else(|e| e.into_inner());
        if text.len() < 65536 {
            let _ = writeln!(text, "{args}");
            if text.len() > 65536 {
                let mut end = 65536;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
            }
        }
    }
    pub fn log(&self) -> String {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn metrics(&self) -> serde_json::Value {
        self.metrics
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn work(&self, value: serde_json::Value) {
        self.metrics.lock().unwrap_or_else(|e| e.into_inner())["work"] = value;
    }
}
pub(crate) fn current() -> Option<Arc<Context>> {
    CURRENT.with(|c| c.borrow().clone())
}
pub(crate) fn enter<T>(context: Arc<Context>, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<Arc<Context>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|c| *c.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(CURRENT.with(|c| c.replace(Some(context))));
    run()
}
pub(crate) fn check() -> Result<()> {
    if let Some(c) = current() {
        c.control.check()
    } else {
        Ok(())
    }
}
pub(crate) fn var_os(name: &str) -> Option<OsString> {
    if let Some(c) = current() {
        if let Some(v) = c.vars.get(name) {
            return v.as_ref().map(OsString::from);
        }
    }
    std::env::var_os(name)
}
pub(crate) fn var(name: &str) -> std::result::Result<String, std::env::VarError> {
    match var_os(name) {
        Some(s) => s.into_string().map_err(std::env::VarError::NotUnicode),
        None => Err(std::env::VarError::NotPresent),
    }
}
pub(crate) fn diagnostic(args: fmt::Arguments<'_>) {
    if let Some(c) = current() {
        c.control.note(args);
    } else {
        eprintln!("{args}");
    }
}
pub(crate) struct Registration {
    control: Arc<Control>,
    models: Arc<crate::semantic::shared::Models>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        *self
            .control
            .native
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        self.models.encoding_finished();
    }
}
// Only native::Runtime::encode may register, while it exclusively owns the
// runtime for the entire returned guard's lifetime.
pub(crate) unsafe fn register_native(
    handle: *mut c_void,
    cancel: CancelFn,
    id: u64,
) -> Option<Registration> {
    let c = current()?;
    *c.control.native.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(NativeCancel { handle, cancel, id });
    c.models.encoding_started();
    Some(Registration {
        control: c.control.clone(),
        models: c.models.clone(),
    })
}
pub(crate) fn encoded(query: bool) {
    if let Some(c) = current() {
        let mut m = c.control.metrics.lock().unwrap_or_else(|e| e.into_inner());
        let key = if query {
            "query_forward_count"
        } else {
            "document_forward_count"
        };
        let n = m[key].as_u64().unwrap_or(0);
        m[key] = (n + 1).into();
    }
}

/// Admission may wait for this user's writer; eviction probes must NOT use it.
pub(crate) fn lock_exclusive(file: &std::fs::File) -> Result<()> {
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) if current().is_some() => {
                check()?;
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Cancellable owned discovery, without killing the shared process or peers.
pub(crate) fn output(command: &mut Command) -> std::io::Result<Output> {
    if current().is_none() {
        return command.output();
    }
    use std::os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::process::CommandExt,
    };
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                unsafe {
                    libc::kill(-(self.0.id() as i32), libc::SIGKILL);
                };
                let _ = self.0.wait();
            }
        }
    }
    let mut child = Child(
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()?,
    );
    let mut stdout = child.0.stdout.take().expect("piped stdout");
    let mut stderr = child.0.stderr.take().expect("piped stderr");
    for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    // A child may close both pipes before exiting. pidfd avoids spinning on
    // their EOF or adding a timer tick to the common short-lived rg path.
    // SAFETY: pid is our live/reapable child; the returned fd is owned here.
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.0.id(), 0) };
    let pidfd = if pidfd >= 0 {
        Some(unsafe { OwnedFd::from_raw_fd(pidfd as i32) })
    } else {
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ENOSYS | libc::EINVAL | libc::EPERM) => None,
            _ => return Err(error),
        }
    };
    let mut a = Vec::new();
    let mut b = Vec::new();
    let mut closed = [false; 2];
    let mut status = None;
    loop {
        check().map_err(std::io::Error::other)?;
        for (i, stream, out) in [
            (0, &mut stdout as &mut dyn Read, &mut a),
            (1, &mut stderr as &mut dyn Read, &mut b),
        ] {
            if closed[i] {
                continue;
            }
            let mut buf = [0; 65536];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) => {
                        closed[i] = true;
                        break;
                    }
                    Ok(n) => {
                        out.extend_from_slice(&buf[..n]);
                        if out.len() > 64 << 20 {
                            return Err(std::io::Error::other(
                                "RAM_BUDGET: source discovery output exceeds64MiB",
                            ));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e),
                }
            }
        }
        if status.is_none() {
            status = child.0.try_wait()?;
        }
        if let Some(status) = status {
            if closed.iter().all(|v| *v) {
                return Ok(Output {
                    status,
                    stdout: a,
                    stderr: b,
                });
            }
        }
        let mut fds = Vec::with_capacity(3);
        for (closed, fd) in closed.iter().zip([stdout.as_raw_fd(), stderr.as_raw_fd()]) {
            if !closed {
                fds.push(fd);
            }
        }
        if status.is_none() {
            if let Some(fd) = &pidfd {
                fds.push(fd.as_raw_fd());
            }
        }
        // Cancellation still has the old at-most5ms observation interval. If
        // pidfd is unavailable, this also bounds waiting after both pipe EOFs.
        crate::readiness::wait(&fds, Some(Duration::from_millis(5)))?;
    }
}
