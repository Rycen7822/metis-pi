use crate::shared::{SharedFrecency, WeakFilePicker};
use ahash::AHashSet;
use parking_lot::{Condvar, Mutex};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

// we don't really need a queue here
#[derive(Default)]
struct Pending {
    paths: AHashSet<PathBuf>,
    full_rescan: bool,
    full_waiters: Vec<mpsc::Sender<()>>,
    shutdown: bool,
}

impl Pending {
    fn has_work(&self) -> bool {
        self.full_rescan || !self.paths.is_empty()
    }
}

/// Condvar based queue that is used for batch processing events
pub(crate) struct GitStatusWorker {
    state: Mutex<Pending>,
    cv: Condvar,
    consumer_spawned: AtomicBool,
    error: Mutex<Option<String>>,
}

impl GitStatusWorker {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(Pending::default()),
            cv: Condvar::new(),
            consumer_spawned: AtomicBool::new(false),
            error: Mutex::new(None),
        })
    }

    pub(crate) fn spawn_once(
        self: &Arc<Self>,
        weak_picker: WeakFilePicker,
        frecency: SharedFrecency,
    ) -> bool {
        if self
            .consumer_spawned
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            if let Err(error) = Self::spawn_consumer(Arc::clone(self), weak_picker, frecency) {
                self.consumer_spawned.store(false, Ordering::Release);
                self.set_error(Some(error.to_string()));
                tracing::error!(?error, "Failed to spawn git status worker");
            }
        }
        self.consumer_spawned.load(Ordering::Acquire)
    }

    pub(crate) fn error(&self) -> Option<String> {
        self.error.lock().clone()
    }

    pub(crate) fn set_error(&self, error: Option<String>) {
        *self.error.lock() = error;
    }

    pub(crate) fn enqueue_paths<I>(&self, paths: I)
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let mut guard = self.state.lock();
        guard.paths.extend(paths);
        drop(guard);
        self.cv.notify_one();
    }

    pub(crate) fn request_full_rescan(&self) {
        let mut guard = self.state.lock();
        guard.full_rescan = true;
        drop(guard);
        self.cv.notify_one();
    }

    pub(crate) fn request_full_rescan_and_ack(&self) -> mpsc::Receiver<()> {
        let (reply, receiver) = mpsc::channel();
        let mut guard = self.state.lock();
        if !guard.shutdown {
            guard.full_rescan = true;
            guard.full_waiters.push(reply);
        }
        drop(guard);
        self.cv.notify_one();
        receiver
    }

    pub(crate) fn signal_shutdown(&self) {
        let mut guard = self.state.lock();
        guard.shutdown = true;
        guard.full_waiters.clear();
        drop(guard);
        self.cv.notify_one();
    }

    fn wait_and_take(&self) -> Option<Pending> {
        let mut guard = self.state.lock();
        while !guard.shutdown && !guard.has_work() {
            self.cv.wait(&mut guard);
        }
        if guard.shutdown {
            return None;
        }
        Some(std::mem::take(&mut *guard))
    }

    // the problem: git status update can take a lot of time especially on big repositories
    // and there is unpredictable wait time on the lock file if huge commit is going so we have to
    // spawn a separate thread to guartee that notify handler is unlocked even if git update takes a
    // lot of time on every event burst (pretty cheap as this thread is going to sleep 99.9% of time)
    fn spawn_consumer(
        mailbox: Arc<GitStatusWorker>,
        weak_picker: WeakFilePicker,
        frecency: SharedFrecency,
    ) -> std::io::Result<()> {
        std::thread::Builder::new()
            .name("fff-git-status".into())
            .spawn(move || {
                while let Some(work) = mailbox.wait_and_take() {
                    let Some(picker) = weak_picker.upgrade() else {
                        break;
                    };

                    let result = if work.full_rescan {
                        picker.refresh_git_status(&frecency).map(|_| ())
                    } else {
                        let paths: Vec<PathBuf> = work.paths.into_iter().collect();
                        picker.update_git_status_for_paths(&paths, &frecency)
                    };
                    if let Err(error) = &result {
                        tracing::error!(?error, "Git status update failed");
                    }
                    // Partial success cannot establish recovery from earlier failures.
                    if work.full_rescan || result.is_err() {
                        mailbox.set_error(result.err().map(|error| error.to_string()));
                    }
                    // Acknowledge only after the metadata write guard and health
                    // publication. Requests received mid-pass wait for the next pass.
                    for reply in work.full_waiters {
                        let _ = reply.send(());
                    }
                }

                tracing::info!("git-status worker stopped");
            })
            .map(|_| ())
    }
}
