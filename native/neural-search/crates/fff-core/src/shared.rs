use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak};
use std::time::{Duration, Instant};

use crate::dbs::lmdb::{LmdbStore, spawn_lmdb_gc};
use crate::error::Error;
use crate::file_picker::FilePicker;
use crate::frecency::FrecencyTracker;
use crate::git::GitStatusCache;
use crate::git_recency;
use crate::query_tracker::QueryTracker;
use crate::rescan_stats::{RescanCounters, RescanReason, RescanStats};
use crate::rescan_throttle::RescanThrottle;
use crate::scan::ScanJob;
use git2::Repository;

/// Poll `.git/index.lock` until it disappears (git write completed), giving up
/// after [`GIT_LOCK_MAX_WAIT`]. Used by [`SharedPicker::refresh_git_status`]
/// to avoid reading a half-updated index when the watcher fires mid-`git add`.
///
/// The wait is bounded and cheap: the lock file is typically cleared within
/// a few milliseconds of the git command exiting.
fn wait_for_git_index_lock_release(git_root: &Path) {
    const GIT_LOCK_POLL: Duration = Duration::from_millis(10);
    const GIT_LOCK_MAX_WAIT: Duration = Duration::from_millis(500);

    let lock = crate::git::discover_repository(git_root)
        .map(|repo| repo.path().join("index.lock"))
        .unwrap_or_else(|_| git_root.join(".git/index.lock"));
    // Fast path: no lock present.
    if !lock.exists() {
        return;
    }
    let deadline = Instant::now() + GIT_LOCK_MAX_WAIT;
    while lock.exists() && Instant::now() < deadline {
        std::thread::sleep(GIT_LOCK_POLL);
    }
    if lock.exists() {
        tracing::warn!(
            "Proceeding with git status refresh despite lingering \
             .git/index.lock at {} — will retry once it clears",
            lock.display()
        );
    }
}

/// Poll `done` every 10ms until it returns `true`, or until `timeout` elapses.
/// Returns `true` if the condition was met, `false` on timeout.
fn poll_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while !done() {
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

/// Thread-safe shared handle to the [`FilePicker`] instance.
/// This accumulates only asynchronous non-blocking operations against the
/// file picker: creating, triggering various rescans and so on.
///
/// For blocking access use internal picker via `.read()` or `.write()`
///
/// ```ignore
/// let shared_picker = SharedFilePicker::default();
///
/// if let Some(picker) = shared_picker.read()?.as_ref() {
///     let files = picker.fuzzy_search(&query, options);
///     println!("Found {} files", files.len());
/// } else {
///     println!("Picker not initialized");
/// }
/// ```
#[derive(Clone, Default)]
pub struct SharedFilePicker(pub(crate) Arc<SharedPickerInner>);

pub struct SharedPickerInner {
    picker: parking_lot::RwLock<Option<FilePicker>>,
    rescans: RescanCounters,
    rescan_throttle: RescanThrottle,
}

impl Default for SharedPickerInner {
    fn default() -> Self {
        Self {
            picker: parking_lot::RwLock::new(None),
            rescans: RescanCounters::default(),
            rescan_throttle: RescanThrottle::default(),
        }
    }
}

/// Non-owning handle to a [`SharedPicker`].
#[derive(Clone)]
pub(crate) struct WeakFilePicker(Weak<SharedPickerInner>);

impl WeakFilePicker {
    /// Try to promote the weak handle back to a strong [`SharedPicker`].
    ///
    /// Returns `None` once every strong `SharedPicker` clone has been
    /// dropped. Callers should treat that as "the picker is being
    /// torn down" and exit their current iteration cleanly.
    pub(crate) fn upgrade(&self) -> Option<SharedFilePicker> {
        self.0.upgrade().map(SharedFilePicker)
    }
}

impl std::fmt::Debug for SharedFilePicker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("SharedPicker").field(&"..").finish()
    }
}

impl SharedFilePicker {
    pub fn read(&self) -> Result<parking_lot::RwLockReadGuard<'_, Option<FilePicker>>, Error> {
        Ok(self.0.picker.read())
    }

    pub fn write(&self) -> Result<parking_lot::RwLockWriteGuard<'_, Option<FilePicker>>, Error> {
        let mut guard = self.0.picker.write();
        if let Some(picker) = guard.as_mut() {
            picker.advance_index_version();
        }
        Ok(guard)
    }

    /// Signal the background scan to cancel. Non-blocking: post-scan
    /// threads check this flag and bail out at their next cancellation point.
    pub fn cancel(&self) {
        if let Ok(guard) = self.read()
            && let Some(picker) = guard.as_ref()
        {
            picker.cancel();
        }
    }

    /// Produce a non-owning handle to the same inner picker.
    /// Use it if you don't need to block internal threads from dropping while owning this ref
    pub(crate) fn weaken(&self) -> WeakFilePicker {
        WeakFilePicker(Arc::downgrade(&self.0))
    }

    /// Block until the background filesystem scan finishes.
    /// Returns `true` if scan completed, `false` on timeout.
    pub fn wait_for_scan(&self, timeout: Duration) -> bool {
        let signal = {
            let guard = self.0.picker.read();
            match &*guard {
                Some(picker) => Arc::clone(&picker.signals.scanning),
                None => return true,
            }
        };

        poll_until(timeout, || {
            !signal.load(std::sync::atomic::Ordering::Acquire)
        })
    }

    /// Block until the background file watcher is ready.
    /// Returns `true` if watcher ready, `false` on timeout.
    pub fn wait_for_watcher(&self, timeout: Duration) -> bool {
        poll_until(timeout, || {
            self.0
                .picker
                .read()
                .as_ref()
                .is_none_or(|picker| picker.is_watcher_ready())
        })
    }

    /// Wait for the filesystem walk and its post-scan classification. Future
    /// watcher jobs do not extend this startup/rescan completion boundary.
    pub fn wait_for_indexing_complete(&self, timeout: Duration) -> bool {
        let (scanning, post_scan_active) = {
            let guard = self.0.picker.read();
            match &*guard {
                Some(picker) => (
                    Arc::clone(&picker.signals.scanning),
                    Arc::clone(&picker.signals.post_scan_active),
                ),
                None => return true,
            }
        };

        poll_until(timeout, || {
            !scanning.load(std::sync::atomic::Ordering::Acquire)
                && !post_scan_active.load(std::sync::atomic::Ordering::Acquire)
        })
    }

    /// Trigger a full filesystem rescan without blocking the caller.
    /// Performs a safe async rescan. Guarantees only single active rescan per picker.
    /// If many rescans requested the last one guaranteed to be finished.
    pub fn trigger_full_rescan_async(&self, shared_frecency: &SharedFrecency) -> Result<(), Error> {
        self.trigger_full_rescan_with_reason(shared_frecency, RescanReason::Explicit)
            .map(|_| ())
    }

    /// Returns admitted and throttled rescan requests by reason.
    /// Counters start at picker creation or the last reset.
    pub fn rescan_stats(&self) -> RescanStats {
        self.0.rescans.snapshot()
    }

    pub fn reset_rescan_stats(&self) {
        self.0.rescans.reset();
    }

    /// Returns `Ok(true)` when a rescan was started (or queued behind an
    /// active scan) and `Ok(false)` when the request was throttled — the
    /// caller must retain any invalidation that incremental processing cannot cover.
    pub(crate) fn trigger_full_rescan_with_reason(
        &self,
        shared_frecency: &SharedFrecency,
        reason: RescanReason,
    ) -> Result<bool, Error> {
        // for giant folders we have no other choice other than throttling rescans
        // if user is running application in millions of files with a ton of rescan events
        // Throttle admission; watcher owners retain deferred invalidations.
        if reason == RescanReason::Explicit {
            self.0.rescan_throttle.note_explicit_scan();
        } else if !self.check_rescan_throttle(reason) {
            return Ok(false);
        }

        self.0.rescans.record(reason);

        // Admission also coalesces busy requests while holding its state lock.
        if let Some(job) =
            ScanJob::new_rescan(self, shared_frecency, reason == RescanReason::Reconcile)?
        {
            job.spawn();
        }
        Ok(true)
    }

    fn check_rescan_throttle(&self, reason: RescanReason) -> bool {
        let (live_files, has_git) = self
            .read()
            .ok()
            .and_then(|guard| {
                guard
                    .as_ref()
                    .map(|picker| (picker.live_file_count(), picker.has_git_repo()))
            })
            .unwrap_or((0, false));

        if self.0.rescan_throttle.admit(live_files, has_git) {
            return true;
        }

        self.0.rescans.record_throttled(reason);
        tracing::debug!(%reason, live_files, "Rescan throttled, skipping");
        false
    }

    /// Refresh git statuses for all indexed files
    #[tracing::instrument(level = "info", skip_all)]
    pub fn refresh_git_status(&self, shared_frecency: &SharedFrecency) -> Result<usize, Error> {
        let (git_root, recency_config, base_path, picker_id) = {
            // we do the libgit2 off lock cause it might take quite some time on very large repos
            let guard = self.read()?;
            let Some(ref picker) = *guard else {
                return Err(Error::FilePickerMissing);
            };
            (
                picker.git_root().map(|p| p.to_path_buf()),
                picker.git_recency_config(),
                picker.base_path().to_path_buf(),
                picker.trace_id().to_owned(),
            )
        };

        let repo = git_root
            .as_deref()
            .map(|root| {
                wait_for_git_index_lock_release(root);
                Repository::open(root)
            })
            .transpose()?;
        let git_status = repo
            .as_ref()
            .map(|repo| {
                GitStatusCache::read_status(repo, &mut crate::git::default_status_options())
            })
            .transpose()?;

        let recency = repo
            .as_ref()
            .and_then(|repo| git_recency::compute_git_recency(repo, &recency_config, &base_path));

        let mut guard = self.write()?;
        let picker = guard.as_mut().ok_or(Error::FilePickerMissing)?;

        // ensure consistency
        if picker.trace_id() != picker_id {
            return Ok(0);
        }

        let statuses_count = if let Some(git_status) = git_status {
            let count = git_status.statuses_len();
            picker.update_git_statuses(git_status, shared_frecency)?;
            count
        } else {
            0
        };

        picker.apply_git_recency(recency.as_ref());

        Ok(statuses_count)
    }

    /// Recompute and apply git status for a specific set of paths.
    pub fn update_git_status_for_paths(
        &self,
        paths: &[PathBuf],
        shared_frecency: &SharedFrecency,
    ) -> Result<(), Error> {
        if paths.is_empty() {
            return Ok(());
        }

        let git_root = {
            let guard = self.read()?;
            let Some(ref picker) = *guard else {
                return Err(Error::FilePickerMissing);
            };
            picker.git_root().map(|p| p.to_path_buf())
        };
        let Some(git_root) = git_root else {
            return Ok(());
        };

        wait_for_git_index_lock_release(&git_root);

        let repo = Repository::open(&git_root)?;
        let status = GitStatusCache::git_status_for_paths(&repo, paths)?;

        let mut guard = self.write()?;
        let picker = guard.as_mut().ok_or(Error::FilePickerMissing)?;
        picker.update_git_statuses(status, shared_frecency)
    }
}

/// Thread-safe shared handle to an LMDB-backed store. A disabled (`noop`)
/// instance silently ignores writes. See the [`SharedFrecency`] and
/// [`SharedQueryTracker`] aliases.
///
/// `LmdbStore` is intentionally crate-private, so the store type is sealed:
/// only `FrecencyTracker` / `QueryTracker` can ever instantiate this.
#[allow(private_bounds)]
pub struct SharedDb<T: LmdbStore> {
    inner: Arc<RwLock<Option<T>>>,
    enabled: bool,
}

// Hand-written to avoid a spurious `T: Clone` bound — `Arc` is always `Clone`.
impl<T: LmdbStore> Clone for SharedDb<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            enabled: self.enabled,
        }
    }
}

impl<T: LmdbStore> Default for SharedDb<T> {
    fn default() -> Self {
        Self {
            inner: Arc::new(RwLock::new(None)),
            enabled: true,
        }
    }
}

impl<T: LmdbStore> std::fmt::Debug for SharedDb<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("SharedDb").field(&T::LABEL).finish()
    }
}

#[allow(private_bounds)]
impl<T: LmdbStore> SharedDb<T> {
    /// Creates a disabled instance that silently ignores all writes.
    pub fn noop() -> Self {
        Self {
            inner: Arc::new(RwLock::new(None)),
            enabled: false,
        }
    }

    pub fn read(&self) -> Result<RwLockReadGuard<'_, Option<T>>, Error> {
        self.inner.read().map_err(|_| Error::AcquireFrecencyLock)
    }

    pub fn write(&self) -> Result<RwLockWriteGuard<'_, Option<T>>, Error> {
        self.inner.write().map_err(|_| Error::AcquireFrecencyLock)
    }

    /// Initialize the store + spawn GC in the background. No-op when disabled.
    pub fn init(&self, tracker: T) -> Result<(), Error> {
        if !self.enabled {
            return Ok(());
        }

        {
            let mut guard = self.write()?;
            *guard = Some(tracker);
        }

        // GC holds a read guard on this lock, so re-init/close cannot race it.
        spawn_lmdb_gc(self.inner.clone());
        Ok(())
    }
}

/// Thread-safe shared handle to the [`FrecencyTracker`] instance.
pub type SharedFrecency = SharedDb<FrecencyTracker>;

/// Thread-safe shared handle to the [`QueryTracker`] instance.
pub type SharedQueryTracker = SharedDb<QueryTracker>;
