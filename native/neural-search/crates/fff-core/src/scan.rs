use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use parking_lot::Mutex;
use tracing::{error, info};

use crate::FileSync;
use crate::error::Error;
use crate::parallelism::BACKGROUND_THREAD_POOL;
use crate::shared::{SharedFilePicker, SharedFrecency};
use crate::types::ContentCacheBudget;
use crate::watch::BackgroundWatcher;

#[derive(Clone, Default)]
pub(crate) struct ScanSignals {
    /// Set to `true` while any scan phase is running
    pub(crate) scanning: Arc<AtomicBool>,
    /// Indicates that that owning picker was requested to shut down
    pub(crate) cancelled: Arc<AtomicBool>,
    /// Used to resolve conflicts if multiple rescans were triggered in a queue
    pub(crate) rescan_pending: Arc<AtomicBool>,
    /// Set by `post_scan_snapshot`, cleared by `PostScanSnapshot::drop`.
    /// DO NOT set or clear this manually — it is managed exclusively by the
    /// PostScanSnapshot lifecycle.
    pub(crate) post_scan_active: Arc<AtomicBool>,
    /// Last walk/commit failure; cleared when another pass starts.
    pub(crate) error: Arc<Mutex<Option<String>>>,
    /// Monitoring can fail after a valid index has been committed.
    pub(crate) watcher_error: Arc<Mutex<Option<String>>>,
}

/// Which optional phases a scan should run.
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct ScanConfig {
    pub(crate) watch: bool,
    pub(crate) auto_cache_budget: bool,
    pub(crate) follow_symlinks: bool,
    pub(crate) enable_fs_root_scanning: bool,
    pub(crate) enable_home_dir_scanning: bool,
}

/// A fully-configured scan job ready to run on a background thread.
///
/// Build with [`ScanJob::new_rescan`] (reads all state from the
/// current `FilePicker`) or [`ScanJob::new_initial`] (for the bootstrap
/// scan, before the picker is published to `SharedPicker`).
pub(crate) struct ScanJob {
    shared_picker: SharedFilePicker,
    shared_frecency: SharedFrecency,
    base_path: PathBuf,
    signals: ScanSignals,
    config: ScanConfig,
    /// Owns the reservation from admission through all scan phases.
    scanning: ScanningGuard,
    /// Walker-maintained counter backing `get_scan_progress` on the UI
    /// side. Reset to 0 at scan start, incremented per-file by the
    /// walker. Shared `Arc` so the UI polls the same atomic.
    scanned_files_counter: Arc<AtomicUsize>,
    trace_span: tracing::Span,
}

impl ScanJob {
    pub fn new_rescan(
        shared_picker: &SharedFilePicker,
        shared_frecency: &SharedFrecency,
    ) -> Result<Option<Self>, Error> {
        // Admission and completion use the same lock: a busy request is queued
        // before the current job can drain pending work and release its slot.
        let guard = shared_picker.write()?;
        let picker = guard.as_ref().ok_or(Error::FilePickerMissing)?;
        let signals = picker.scan_signals();
        if signals.cancelled.load(Ordering::Acquire) {
            return Ok(None);
        }
        if picker.is_scan_active() || signals.post_scan_active.load(Ordering::Acquire) {
            signals.rescan_pending.store(true, Ordering::Release);
            return Ok(None);
        }
        signals.rescan_pending.store(false, Ordering::Release);
        let scanning = ScanningGuard::new(&signals);
        let scanned_files_counter = picker.scanned_files_counter();
        let base_path = picker.base_path().to_path_buf();
        let trace_span = picker.trace_span();

        let new_scan_config = ScanConfig {
            watch: picker.watch_enabled(),
            auto_cache_budget: !picker.has_explicit_cache_budget(),
            follow_symlinks: picker.follows_symlinks(),
            enable_fs_root_scanning: picker.fs_root_scanning_enabled(),
            enable_home_dir_scanning: picker.home_dir_scanning_enabled(),
        };

        drop(guard); // just a sanity check

        Ok(Some(Self {
            scanning,
            signals,
            base_path,
            scanned_files_counter,
            config: new_scan_config,
            shared_picker: shared_picker.clone(),
            shared_frecency: shared_frecency.clone(),
            trace_span,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_initial(
        shared_picker: SharedFilePicker,
        shared_frecency: SharedFrecency,
        base_path: PathBuf,
        signals: ScanSignals,
        scanned_files_counter: Arc<AtomicUsize>,
        trace_span: tracing::Span,
        config: ScanConfig,
    ) -> Self {
        Self {
            scanning: ScanningGuard::new(&signals),
            shared_picker,
            shared_frecency,
            base_path,
            signals,
            scanned_files_counter,
            config,
            trace_span,
        }
    }

    /// Run the job on `BACKGROUND_THREAD_POOL`. Returns immediately.
    ///
    /// Reuses the bounded background pool for the walk and classification.
    pub fn spawn(self) {
        let span = self.trace_span.clone();
        BACKGROUND_THREAD_POOL.spawn(move || {
            let _g = span.enter();
            self.run();
        });
    }

    fn run(self) {
        loop {
            if !self.signals.cancelled.load(Ordering::Acquire) {
                self.run_phases();
            }
            // Keep the same reservation across queued passes, including an
            // error retry. Readiness cannot observe an idle handoff gap.
            let _guard = self.shared_picker.write();
            let pending = self.signals.rescan_pending.swap(false, Ordering::AcqRel);
            if self.signals.cancelled.load(Ordering::Acquire) || !pending {
                drop(self.scanning);
                return;
            }
        }
    }

    fn run_phases(&self) {
        let Self {
            shared_picker,
            shared_frecency,
            base_path,
            signals,
            scanned_files_counter,
            config,
            ..
        } = self;
        *signals.error.lock() = None;
        *signals.watcher_error.lock() = None;
        scanned_files_counter.store(0, Ordering::Relaxed);

        // 1. Walk the file system and collect the list of files
        let git_workdir = FileSync::discover_git_workdir(&base_path);
        let sync = match FileSync::walk_filesystem(
            &base_path,
            git_workdir.clone(),
            &scanned_files_counter,
            &shared_frecency,
            config.follow_symlinks,
        ) {
            Ok(sync) => sync,
            Err(e) => {
                *signals.error.lock() = Some(e.to_string());
                // The root may have disappeared, invalidating inotify watches.
                // A later successful retry must construct fresh subscriptions.
                if let Ok(mut guard) = shared_picker.write()
                    && let Some(picker) = guard.as_mut()
                {
                    picker.stop_background_monitor();
                }
                error!(?e, "scan walk failed");
                return;
            }
        };

        // 2. Populate the file list
        let git_status_worker;
        if let Ok(mut guard) = shared_picker.write()
            && let Some(picker) = guard.as_mut()
        {
            if signals.cancelled.load(Ordering::Acquire) {
                info!("scan cancelled between walk and commit, discarding");
                return;
            }

            let live_count = sync.live_count;
            picker.commit_new_sync(sync);
            git_status_worker = Arc::clone(&picker.git_status_worker);

            if config.auto_cache_budget && !picker.has_explicit_cache_budget() {
                picker.set_cache_budget(ContentCacheBudget::new_for_repo(live_count));
            }
        } else {
            *signals.error.lock() = Some("Failed to install scan results into picker".into());
            error!("failed to install scan results into picker");
            return;
        }

        // The scan reservation stays active through classification and watcher
        // installation; no second job may publish a competing snapshot.
        let snapshot = if !signals.cancelled.load(Ordering::Acquire) {
            shared_picker.read().ok().and_then(|guard| {
                guard
                    .as_ref()
                    .and_then(|picker| picker.post_scan_snapshot())
            })
        } else {
            None
        };

        // Registration and classification overlap, but readiness includes both.
        let subscriptions = if config.watch && !signals.cancelled.load(Ordering::Acquire) {
            resubscribe_watcher_post_scan(shared_picker)
        } else {
            None
        };

        // 3. Classify off-lock.
        if !signals.cancelled.load(Ordering::Acquire)
            && let Some(snap) = snapshot.as_ref()
        {
            Self::run_post_scan(&shared_picker, &signals, snap);
        }

        drop(snapshot); // SNAPSHOT SHOULD NOT BE USED AFTER THIS POINT

        if let Some(barrier) = subscriptions {
            barrier.wait(&signals.cancelled);
        }

        // Health may change after admission or while registering directories.
        let needs_watcher = shared_picker.read().ok().is_some_and(|guard| {
            guard
                .as_ref()
                .is_some_and(|picker| !picker.is_watcher_ready())
        });
        if needs_watcher && config.watch && !signals.cancelled.load(Ordering::Acquire) {
            if let Ok(mut guard) = shared_picker.write()
                && let Some(picker) = guard.as_mut()
            {
                // Release failed/partial subscriptions before a retry.
                picker.background_watcher.take();
            }
            let shared_picker: &SharedFilePicker = &shared_picker;
            let shared_frecency: &SharedFrecency = &shared_frecency;
            let base_path: &std::path::Path = &base_path;

            match BackgroundWatcher::new(
                base_path.to_path_buf(),
                shared_picker.clone(),
                shared_frecency.clone(),
                config.enable_fs_root_scanning,
                config.enable_home_dir_scanning,
                Arc::clone(&git_status_worker),
                tracing::Span::current(),
            ) {
                Ok(watcher) => {
                    if let Ok(mut guard) = shared_picker.write()
                        && let Some(picker) = guard.as_mut()
                        && picker.base_path() == base_path
                        && !signals.cancelled.load(Ordering::Acquire)
                    {
                        picker.background_watcher = Some(watcher);
                    }
                }
                Err(e) => {
                    *signals.watcher_error.lock() =
                        Some(format!("Watcher initialization failed: {e}"));
                    error!(?e, "failed to initialize background watcher");
                }
            };
        }

        // Subscribe first. Completion includes status and recency publication,
        // not just admission to the detached Git worker's mailbox.
        if git_workdir.is_some()
            && !signals.cancelled.load(Ordering::Acquire)
            && git_status_worker.spawn_once(shared_picker.weaken(), shared_frecency.clone())
        {
            let refreshed = git_status_worker.request_full_rescan_and_ack();
            while !signals.cancelled.load(Ordering::Acquire) {
                match refreshed.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(()) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        git_status_worker.set_error(Some(
                            "Git worker stopped before initial refresh completed".into(),
                        ));
                        break;
                    }
                }
            }
        }
    }

    /// Copy bounded classifier inputs under a short read lock, do content IO
    /// off-lock, then validate identity/revision under a short write lock.
    /// The job reservation keeps readiness false through classification.
    #[tracing::instrument(skip_all)]
    fn run_post_scan(
        shared_picker: &SharedFilePicker,
        signals: &ScanSignals,
        snapshot: &crate::file_picker::PostScanSnapshot,
    ) {
        if signals.cancelled.load(Ordering::Acquire) {
            return;
        }

        const BATCH_SIZE: usize = 64;
        for start in (0..snapshot.base_count).step_by(BATCH_SIZE) {
            if signals.cancelled.load(Ordering::Acquire) {
                return;
            }
            let batch = shared_picker.read().ok().and_then(|guard| {
                guard.as_ref().map(|picker| {
                    picker.binary_batch(
                        snapshot,
                        start..(start + BATCH_SIZE).min(snapshot.base_count),
                    )
                })
            });
            let Some(batch) = batch else { return };
            let classified: Vec<_> = batch
                .into_iter()
                .map(|task| task.run(&signals.cancelled))
                .collect();
            if signals.cancelled.load(Ordering::Acquire) {
                return;
            }
            if let Ok(mut guard) = shared_picker.write()
                && let Some(picker) = guard.as_mut()
            {
                for result in classified {
                    picker.apply_classification(result);
                }
            }
        }
    }
}

// Queued, failed, cancelled and completed jobs all release the same reservation.
struct ScanningGuard(Arc<AtomicBool>);

impl ScanningGuard {
    fn new(signals: &ScanSignals) -> Self {
        signals.scanning.store(true, Ordering::Release);
        Self(Arc::clone(&signals.scanning))
    }
}

impl Drop for ScanningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// If the scan encounters new directories created we have to add them to the watch list
/// this is fine because the watcher does deduplicate the entries and doesn't add a lot of
/// garbage notify watchers / fs events streams
#[tracing::instrument(skip_all)]
fn resubscribe_watcher_post_scan(
    shared_picker: &SharedFilePicker,
) -> Option<crate::watch::WatchBarrier> {
    let guard = shared_picker.read().ok()?;
    let picker = guard.as_ref()?;
    let watcher = picker.background_watcher.as_ref()?;

    watcher.request_git_refresh();
    picker.for_each_dir(|dir: &std::path::Path| {
        watcher.request_watch_dir(dir.to_path_buf());
        std::ops::ControlFlow::Continue(())
    });
    Some(watcher.barrier())
}
