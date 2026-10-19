use crate::constants::MAX_OVERFLOW_FILES;
use crate::error::Error;
use crate::git_status_worker::GitStatusWorker;
use crate::rescan_stats::RescanReason;
use crate::shared::{SharedFilePicker, SharedFrecency};
use crate::sort_buffer::sort_with_buffer;
use git2::Repository;
use notify::event::{AccessKind, AccessMode, ModifyKind, RenameMode};
use notify::{Config, EventKind, EventKindMask, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, DebouncedEvent, NoCache, new_debouncer_opt};
use parking_lot::Mutex;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tracing::{Level, debug, error, info, warn};

type Debouncer = notify_debouncer_full::Debouncer<notify::RecommendedWatcher, NoCache>;

/// Owns Linux directory subscriptions and signals non-blocking shutdown from
/// `stop()` / `Drop`, including when the picker write lock is held.
pub struct BackgroundWatcher {
    // Health belongs to this instance, not the picker or a later replacement.
    healthy: Arc<AtomicBool>,
    debouncer: Arc<Mutex<Option<Debouncer>>>,
    watch_tx: Option<mpsc::Sender<WatchTask>>,
    owner_thread: Option<std::thread::JoinHandle<()>>,
}

pub(crate) enum WatchTask {
    GitMetadata,
    Rescan(RescanReason),
    Barrier(mpsc::Sender<()>),
    /// Only subscribe to a specific path, this is happening when we did rescun and have to update
    /// the watcher only
    Subscribe(PathBuf),
    /// This is requires a separate walk of the new directory copies or created within a scan
    /// window because it might contain subdirectories we have to walk, prune, and add to index
    IndexNewDir(PathBuf),
}

/// An acknowledgement belongs to the resource that accepted the subscriptions.
pub(crate) struct WatchBarrier {
    receiver: mpsc::Receiver<()>,
    healthy: Arc<AtomicBool>,
}

impl WatchBarrier {
    pub(crate) fn wait(self, cancelled: &AtomicBool) {
        while !cancelled.load(Ordering::Acquire) {
            match self.receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(()) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.healthy.store(false, Ordering::Release);
                    return;
                }
            }
        }
    }
}

const DEBOUNCE_TIMEOUT: Duration = Duration::from_millis(50);
/// Minimum seconds between frecency tracks of the same file in AI mode.
/// Prevents score inflation from rapid burst edits by AI agents.
const AI_MODE_COOLDOWN_SECS: u64 = 5 * 60;

impl BackgroundWatcher {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        base_path: PathBuf,
        shared_picker: SharedFilePicker,
        shared_frecency: SharedFrecency,
        enable_fs_root_scanning: bool,
        enable_home_dir_scanning: bool,
        git_status_worker: Arc<GitStatusWorker>,
        trace_span: tracing::Span,
    ) -> Result<Self, Error> {
        info!(
            "Initializing background watcher for path: {}",
            base_path.display()
        );

        // by default we do not want to allow users to search their FS root, this is very error prone
        // though some consumers would specifically allow that e.g. unikernels, windows disc
        // partition or sub file systems. By default - fail, unless user permits
        let is_fs_root = base_path.parent().is_none();
        // use rust's path api for maximum reliability of the comparison
        let is_home_dir = Some(&base_path) == dirs::home_dir().as_ref();

        if (is_fs_root && !enable_fs_root_scanning) || (is_home_dir && !enable_home_dir_scanning) {
            return Err(Error::FilesystemRoot(base_path));
        }

        // inotify is non-recursive: retain one subscription per indexed directory.
        let (watch_tx, watch_rx) = mpsc::channel::<WatchTask>();
        let watch_tx_for_debouncer = watch_tx.clone();

        let owner_weak_picker = shared_picker.weaken();
        let owner_base_path = base_path.clone();
        let owner_git_worker = Arc::clone(&git_status_worker);
        let owner_frecency = shared_frecency.clone();
        let healthy = Arc::new(AtomicBool::new(true));
        let owner_health = Arc::clone(&healthy);

        let (debouncer, mut git_identity) = Self::create_debouncer(
            base_path,
            shared_picker,
            shared_frecency,
            watch_tx_for_debouncer,
            git_status_worker,
            Arc::clone(&healthy),
        )?;

        info!("Background file watcher initialized successfully");

        let debouncer = Arc::new(Mutex::new(Some(debouncer)));
        let owner_debouncer = Arc::clone(&debouncer);

        let owner_span = trace_span.clone();
        let owner_thread = std::thread::Builder::new()
            .name("fff-watcher-own".into())
            .spawn(move || {
                let _g = owner_span.enter();
                let mut pending_rescan: Option<(RescanReason, Instant)> = None;
                loop {
                    let task = if let Some((_, deadline)) = pending_rescan {
                        match watch_rx
                            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        {
                            Ok(task) => Some(task),
                            Err(mpsc::RecvTimeoutError::Timeout) => None,
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    } else {
                        match watch_rx.recv() {
                            Ok(task) => Some(task),
                            Err(_) => break,
                        }
                    };
                    let Some(strong_picker) = owner_weak_picker.upgrade() else {
                        break;
                    };

                    if let Some((reason, deadline)) = pending_rescan
                        && Instant::now() >= deadline
                    {
                        // A stopped/replaced resource must not schedule more work.
                        if owner_debouncer.lock().is_none() {
                            break;
                        }
                        let dirty = strong_picker.read().ok().is_some_and(|guard| {
                            guard.as_ref().is_some_and(|picker| {
                                picker.signals.rescan_pending.load(Ordering::Acquire)
                                    || picker.signals.reconcile_pending.load(Ordering::Acquire)
                            })
                        });
                        if reason != RescanReason::WatcherFailure && !dirty {
                            pending_rescan = None; // Another scan already consumed it.
                        } else {
                            match strong_picker
                                .trigger_full_rescan_with_reason(&owner_frecency, reason)
                            {
                                Ok(true) => pending_rescan = None,
                                Ok(false) => {
                                    pending_rescan =
                                        Some((reason, Instant::now() + Duration::from_millis(250)))
                                }
                                Err(error) => {
                                    warn!(?error, "Deferred rescan could not run");
                                    pending_rescan = None;
                                }
                            }
                        }
                    }

                    let Some(task) = task else { continue };
                    let (dir, is_new_dir) = match task {
                        WatchTask::Barrier(reply) => {
                            let _ = reply.send(());
                            continue;
                        }
                        WatchTask::Rescan(reason) => {
                            defer_local_rescan(&mut pending_rescan, reason);
                            continue;
                        }
                        WatchTask::GitMetadata => {
                            let result = {
                                let mut guard = owner_debouncer.lock();
                                let Some(debouncer) = guard.as_mut() else {
                                    break;
                                };
                                watch_git_status_paths(debouncer, &owner_base_path)
                            };
                            match result {
                                Ok(identity) => {
                                    let changed = identity.is_some() && identity != git_identity;
                                    git_identity = identity;
                                    if changed {
                                        owner_git_worker.spawn_once(
                                            strong_picker.weaken(),
                                            owner_frecency.clone(),
                                        );
                                        owner_git_worker.request_full_rescan();
                                    }
                                }
                                Err(error) => {
                                    if needs_watcher_recovery(
                                        &strong_picker,
                                        &owner_frecency,
                                        &owner_health,
                                    ) {
                                        defer_local_rescan(
                                            &mut pending_rescan,
                                            RescanReason::WatcherFailure,
                                        );
                                    }
                                    warn!(?error, "Failed to watch Git metadata");
                                }
                            }
                            continue;
                        }
                        WatchTask::Subscribe(dir) => (dir, false),
                        WatchTask::IndexNewDir(dir) => (dir, true),
                    };

                    // Recheck queued data paths before subscription, not just at admission.
                    let follow_symlinks = strong_picker
                        .read()
                        .ok()
                        .and_then(|guard| guard.as_ref().map(|picker| picker.follows_symlinks()))
                        .unwrap_or(false);
                    // Real I/O errors still go through watcher recovery below.
                    if let Ok(metadata) = entry_metadata(&dir, &owner_base_path, follow_symlinks)
                        && metadata.is_none_or(|metadata| !metadata.is_dir())
                    {
                        continue;
                    }
                    // Subscribe before walking. A per-path failure must not kill the queue.
                    if !watch_dirs_nonrecursive(&owner_debouncer, std::iter::once(dir.as_path()))
                        && needs_watcher_recovery(&strong_picker, &owner_frecency, &owner_health)
                    {
                        defer_local_rescan(&mut pending_rescan, RescanReason::WatcherFailure);
                    }

                    if is_new_dir {
                        let (subdirs, reconcile_after_subscribe) = index_new_directory(
                            &dir,
                            &strong_picker,
                            &owner_frecency,
                            &owner_git_worker,
                            &mut pending_rescan,
                        );
                        if !watch_dirs_nonrecursive(
                            &owner_debouncer,
                            subdirs.iter().map(|p| p.as_path()),
                        ) && needs_watcher_recovery(
                            &strong_picker,
                            &owner_frecency,
                            &owner_health,
                        ) {
                            defer_local_rescan(&mut pending_rescan, RescanReason::WatcherFailure);
                        }
                        if reconcile_after_subscribe {
                            if let Ok(mut guard) = strong_picker.write()
                                && let Some(picker) = guard.as_mut()
                            {
                                picker
                                    .signals
                                    .reconcile_pending
                                    .store(true, Ordering::Release);
                            }
                            defer_local_rescan(&mut pending_rescan, RescanReason::Reconcile);
                        }
                    }
                }

                tracing::info!("Background watcher is stopped");
            })
            .map_err(notify::Error::io)?;

        Ok(Self {
            healthy,
            debouncer,
            watch_tx: Some(watch_tx),
            owner_thread: Some(owner_thread),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn create_debouncer(
        base_path: PathBuf,
        shared_picker: SharedFilePicker,
        shared_frecency: SharedFrecency,
        watch_tx: mpsc::Sender<WatchTask>,
        git_status_worker: Arc<GitStatusWorker>,
        healthy: Arc<AtomicBool>,
    ) -> Result<(Debouncer, Option<GitWatchIdentity>), Error> {
        let config = Config::default()
            .with_follow_symlinks(false)
            // only the actual modification events, ignore the open syscals that we can generate by
            // our own grep calls and preview window rendering
            .with_event_kinds(EventKindMask::CORE);

        let base_path_for_handler = base_path.clone();
        let shared_picker_for_watching = shared_picker.clone();
        let file_picker = shared_picker.weaken();
        let mut debouncer = new_debouncer_opt(
            DEBOUNCE_TIMEOUT,
            Some(DEBOUNCE_TIMEOUT / 2), // tick rate for the event span
            {
                move |result: DebounceEventResult| match result {
                    Ok(events) => {
                        let Some(file_picker) = file_picker.upgrade() else {
                            return;
                        };

                        // A new inode at the same pathname does not restore a
                        // detached inotify root subscription. Retire this resource
                        // before handling any other paths from the stale batch.
                        let root_lost = events.iter().any(|event| {
                            matches!(
                                event.event.kind,
                                EventKind::Remove(_)
                                    | EventKind::Modify(ModifyKind::Name(
                                        RenameMode::From | RenameMode::Both
                                    ))
                            ) && event.event.paths.first() == Some(&base_path_for_handler)
                        });
                        if root_lost {
                            if needs_watcher_recovery(&file_picker, &shared_frecency, &healthy) {
                                let _ =
                                    watch_tx.send(WatchTask::Rescan(RescanReason::WatcherFailure));
                            }
                            return;
                        }

                        if events.iter().any(|event| event.event.need_rescan()) {
                            // Unknown event coverage invalidates same-path subscriptions too.
                            healthy.store(false, Ordering::Release);
                        }
                        let new_dirs = handle_debounced_events(
                            events,
                            &base_path_for_handler,
                            &watch_tx,
                            &file_picker,
                            &shared_frecency,
                            &git_status_worker,
                        );

                        // every new directory created has to be reflected in the picker state
                        for dir in new_dirs {
                            if let Err(e) = watch_tx.send(WatchTask::IndexNewDir(dir)) {
                                healthy.store(false, Ordering::Release);
                                error!(?e, "Failed to send directory update error");
                            }
                        }
                    }
                    Err(errors) => {
                        if let Some(picker) = file_picker.upgrade() {
                            if needs_watcher_recovery(&picker, &shared_frecency, &healthy) {
                                let _ =
                                    watch_tx.send(WatchTask::Rescan(RescanReason::WatcherFailure));
                            }
                        } else {
                            healthy.store(false, Ordering::Release);
                        }
                        error!("File watcher errors: {:?}", errors);
                    }
                }
            },
            // The picker owns file identities; do not duplicate them in a watcher cache.
            NoCache::new(),
            config,
        )?;

        {
            debouncer.watch(base_path.as_path(), RecursiveMode::NonRecursive)?;

            let mut watched = 0usize;
            let mut failure = None;
            {
                let guard = shared_picker_for_watching.read()?;
                let picker = guard.as_ref().ok_or(Error::FilePickerMissing)?;
                picker.for_each_dir(|dir| {
                    use std::ops::ControlFlow;
                    match debouncer.watch(dir, RecursiveMode::NonRecursive) {
                        Ok(()) => {
                            watched += 1;
                            ControlFlow::Continue(())
                        }
                        Err(error) if missing_path_error(&error) => ControlFlow::Continue(()),
                        Err(error) => {
                            failure = Some(error);
                            ControlFlow::Break(())
                        }
                    }
                });
            }
            if let Some(error) = failure {
                return Err(error.into());
            }

            tracing::info!(
                ?watched,
                path = ?base_path.display(),
                "File watcher initialized"
            );
        }

        // The .git directory is excluded from the file list but we still need
        // to observe changes that affect git status (staging, unstaging,
        // committing, branch switches, merges, etc)
        let identity = watch_git_status_paths(&mut debouncer, &base_path)?;

        Ok((debouncer, identity))
    }

    /// Signal the watcher to shut down without blocking on its worker
    /// threads. Safe to call from any context, including while holding
    /// the [`SharedFilePicker`] write lock.
    pub fn stop(&mut self) {
        self.healthy.store(false, Ordering::Release);
        self.watch_tx.take();
        if let Some(debouncer) = self.debouncer.lock().take() {
            debouncer.stop_nonblocking();
        }

        self.owner_thread.take();

        info!("Background file watcher stop signaled");
    }

    pub(crate) fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }

    pub(crate) fn request_reconciliation(&self) {
        self.queue(WatchTask::Rescan(RescanReason::Reconcile));
    }

    pub(crate) fn request_git_refresh(&self) {
        self.queue(WatchTask::GitMetadata);
    }

    pub(crate) fn barrier(&self) -> WatchBarrier {
        let (reply, receiver) = mpsc::channel();
        self.queue(WatchTask::Barrier(reply));
        WatchBarrier {
            receiver,
            healthy: Arc::clone(&self.healthy),
        }
    }

    pub(crate) fn request_watch_dir(&self, dir: PathBuf) {
        self.queue(WatchTask::Subscribe(dir));
    }

    fn queue(&self, task: WatchTask) {
        if !self
            .watch_tx
            .as_ref()
            .is_some_and(|tx| tx.send(task).is_ok())
        {
            self.healthy.store(false, Ordering::Release);
        }
    }
}

impl Drop for BackgroundWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tracing::instrument(name = "fs_events", skip(events, shared_picker, shared_frecency, git_status_worker), level = Level::DEBUG)]
pub(crate) fn handle_debounced_events(
    events: Vec<DebouncedEvent>,
    base_path: &Path,
    watch_tx: &mpsc::Sender<WatchTask>,
    shared_picker: &SharedFilePicker,
    shared_frecency: &SharedFrecency,
    git_status_worker: &Arc<GitStatusWorker>,
) -> Vec<PathBuf> {
    // this will be called very often, we have to minimiy the lock time for file picker
    let repo = discover_working_repository(base_path);
    // Repository identity is live, not the snapshot captured at watcher creation.
    let (indexed_git_root, walker_rules, follow_symlinks) = shared_picker
        .read()
        .ok()
        .and_then(|guard| {
            guard.as_ref().map(|picker| {
                (
                    picker.git_root().map(Path::to_path_buf),
                    picker.ignore_rules(),
                    picker.follows_symlinks(),
                )
            })
        })
        .unwrap_or_default();
    let filter = IgnoreFilter::new(base_path, walker_rules, repo.as_ref());
    let mut need_full_git_rescan = false;
    let mut batch_overflow_attempted = false;
    let mut paths_to_remove = Vec::new();
    let mut dirs_to_remove: Vec<PathBuf> = Vec::new();
    let mut paths_to_add_or_modify = Vec::new();
    let mut new_dirs_to_watch = Vec::new();
    let mut affected_paths_count = 0usize;
    let mut explicit_renames: Vec<(PathBuf, PathBuf)> = Vec::new();

    let try_trigger_full_rescan = |reason: RescanReason| -> bool {
        match shared_picker.trigger_full_rescan_with_reason(shared_frecency, reason) {
            Ok(true) => {
                warn!(%reason, "Triggering full rescan");
                true
            }
            Ok(false) => {
                // Keep policy/event-loss invalidations even if this resource is
                // replaced: the current scan drains the same dirty flag.
                if retain_deferred_reconciliation(shared_picker)
                    && watch_tx.send(WatchTask::Rescan(reason)).is_ok()
                {
                    return true;
                }
                false
            }
            Err(e) => {
                error!(%reason, "Failed to trigger full rescan: {:?}", e);
                false
            }
        }
    };

    let git_root = repo
        .as_ref()
        .and_then(|repo| repo.workdir())
        .map(Path::to_path_buf);
    if git_root != indexed_git_root {
        let _ = watch_tx.send(WatchTask::GitMetadata);
        try_trigger_full_rescan(RescanReason::Explicit);
        return Vec::new();
    }
    if events
        .iter()
        .flat_map(|event| &event.event.paths)
        .any(|path| is_git_metadata(path, repo.as_ref()))
    {
        let _ = watch_tx.send(WatchTask::GitMetadata);
    }

    for debounced_event in &events {
        // It is very important to not react to the access errors because we inevitably
        // gonna trigger the sync by our own preview or other unnecessary noise
        if matches!(
            debounced_event.event.kind,
            EventKind::Access(
                AccessKind::Read
                    | AccessKind::Open(_)
                    | AccessKind::Close(AccessMode::Read | AccessMode::Execute)
            )
        ) {
            continue;
        }

        // Kernel event loss can require rebuilding the subtree rather than
        // interpreting the partial event list as complete.
        if debounced_event.event.need_rescan() {
            // Listed paths do not establish coverage after event loss; even a
            // small or empty batch has already invalidated watcher health.
            if try_trigger_full_rescan(RescanReason::KernelEventLoss) {
                return Vec::new();
            }

            // Throttled recovery can still apply the listed paths below.
        }

        tracing::debug!(event = ?debounced_event.event, "Processing FS event");

        // Backends that pair the halves for us hand over [from, to] directly.
        // The per-path pass below still classifies both, we only note the link.
        if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = debounced_event.event.kind
            && let [from, to] = debounced_event.event.paths.as_slice()
        {
            explicit_renames.push((from.clone(), to.clone()));
        }

        for path in &debounced_event.event.paths {
            if matches!(
                path.file_name().and_then(|f| f.to_str()),
                Some(".ignore") | Some(".gitignore")
            ) {
                if path
                    .parent()
                    .is_some_and(|parent| filter.is_ignored(parent))
                {
                    continue;
                }

                info!(
                    "Detected change in ignore definition file: {}",
                    path.display()
                );

                if try_trigger_full_rescan(RescanReason::IgnoreFileChanged) {
                    return Vec::new();
                }

                // Throttled: apply the file only if scan policy admits it;
                // stale rules heal on the next admitted rescan.
            }

            if is_dotgit_change_affecting_status(path, &repo) {
                need_full_git_rescan = true;
            }

            if is_git_metadata(path, repo.as_ref()) {
                continue;
            }

            // Use a combination of event kind and filesystem state to decide
            // whether a path is an addition/modification or a removal.
            //
            // We cannot rely on `path.exists()` alone because:
            //   - A freshly created file might not be visible yet (race).
            //   - A rename event can refer to either side of a move.
            //
            // We cannot rely on event kind alone because:
            //   - Missing paths can arrive through a rename/modify event.
            let is_removal = matches!(debounced_event.event.kind, EventKind::Remove(_));

            // Directory-level remove: inotify delivers a single
            // `Remove(Folder)` event for a whole directory tree (e.g.
            // after `git reset --hard` wipes a dir full of staged-but-
            // uncommitted files).
            let is_folder_removal = matches!(
                debounced_event.event.kind,
                EventKind::Remove(notify::event::RemoveKind::Folder)
            );

            let metadata = match entry_metadata(path, base_path, follow_symlinks) {
                Ok(metadata) => metadata,
                Err(error) if is_removal || error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    warn!(
                        ?path,
                        ?error,
                        "Cannot inspect changed path; retaining index and retrying scan"
                    );
                    if try_trigger_full_rescan(RescanReason::KernelEventLoss) {
                        return Vec::new();
                    }
                    continue;
                }
            };
            let is_removed = is_folder_removal || is_removal || metadata.is_none();
            let is_dir = metadata.as_ref().is_some_and(|meta| meta.is_dir());
            let is_file = metadata.as_ref().is_some_and(|meta| meta.is_file());
            let is_ignored = is_removed || filter.is_ignored(path);

            if is_folder_removal {
                dirs_to_remove.push(path.to_path_buf());
            } else if is_removed {
                // best effort but doesn't require a stat and generally correct
                let maybe_directory = !matches!(
                    debounced_event.event.kind,
                    EventKind::Remove(notify::event::RemoveKind::File)
                );

                paths_to_remove.push((path.as_path(), maybe_directory));
            } else if is_dir {
                if !is_ignored {
                    new_dirs_to_watch.push(path.to_path_buf());
                }
            } else if !is_file {
                // A formerly indexed file may now be a FIFO/socket/device.
                paths_to_remove.push((path.as_path(), false));
            } else if !is_ignored {
                // For additions/modifications, still filter gitignored files.
                paths_to_add_or_modify.push(path.as_path());
            }
        }

        affected_paths_count += debounced_event.event.paths.len();
        if !batch_overflow_attempted && affected_paths_count > MAX_OVERFLOW_FILES * 4 {
            batch_overflow_attempted = true;
            warn!(
                ?affected_paths_count,
                max = MAX_OVERFLOW_FILES * 4,
                "Too many affected paths in a single batch, triggering full rescan",
            );

            if try_trigger_full_rescan(RescanReason::EventBatchOverflow) {
                return Vec::new();
            }
        }
    }

    // It's important to get the allocated sort
    sort_with_buffer(paths_to_add_or_modify.as_mut_slice(), |a, b| {
        a.as_os_str().cmp(b.as_os_str())
    });
    paths_to_add_or_modify.dedup_by(|a, b| a.as_os_str().eq(b.as_os_str()));

    info!(
        "Event processing summary: {} to remove, {} dirs to remove, {} to add/modify, {} new dirs",
        paths_to_remove.len(),
        dirs_to_remove.len(),
        paths_to_add_or_modify.len(),
        new_dirs_to_watch.len()
    );

    if paths_to_remove.is_empty()
        && dirs_to_remove.is_empty()
        && paths_to_add_or_modify.is_empty()
        && !need_full_git_rescan
    {
        debug!("No file index changes to apply");
        return new_dirs_to_watch;
    }

    let mut files_to_update_git_status = Vec::new();
    let mut index_update_rejected = false;
    let mut overflow_count = 0;
    // Destination -> source for every rename recognised in this batch.
    let mut renames: ahash::AHashMap<PathBuf, PathBuf> = ahash::AHashMap::new();

    if !paths_to_remove.is_empty()
        || !dirs_to_remove.is_empty()
        || !paths_to_add_or_modify.is_empty()
    {
        debug!(
            "Applying file index changes: {} to remove, {} dirs to remove, {} to add/modify",
            paths_to_remove.len(),
            dirs_to_remove.len(),
            paths_to_add_or_modify.len(),
        );

        let Ok(mut guard) = shared_picker.write() else {
            error!("Failed to acquire file picker write lock");
            return new_dirs_to_watch;
        };
        let Some(ref mut picker) = *guard else {
            error!("File picker not initialized");
            return new_dirs_to_watch;
        };

        picker.note_filesystem_change();

        // Must run before the removals below, while the vanished files still
        // carry their indexed size/mtime.
        renames.extend(detect_renames(
            picker,
            base_path,
            &paths_to_remove,
            &paths_to_add_or_modify,
            &explicit_renames,
        ));

        for (path, may_be_dir) in &paths_to_remove {
            let removed = picker.remove_file_by_path(path);

            if !removed && *may_be_dir {
                // Not an indexed file: likely a dir renamed out of the tree
                // (no Remove(Folder) is emitted), expand it per indexed file.
                dirs_to_remove.push(path.to_path_buf());
            }
        }

        // Single index scan for all dirs; misses (never-indexed paths) are free.
        dirs_to_remove.sort_unstable();
        dirs_to_remove.dedup();
        if !dirs_to_remove.is_empty() {
            let dirs = dirs_to_remove.iter().map(PathBuf::as_path);
            picker.remove_all_files_in_dirs(dirs);
        }

        files_to_update_git_status.reserve(paths_to_add_or_modify.len());
        let mut landed_renames = ahash::AHashSet::with_capacity(renames.len());
        for path in &paths_to_add_or_modify {
            if picker.get_overflow_files().len() >= MAX_OVERFLOW_FILES
                && picker.get_file_by_path(path).is_none()
            {
                index_update_rejected = true;
                break;
            }

            if picker.handle_create_or_modify(path).is_some() {
                files_to_update_git_status.push(path.to_path_buf());
                if renames.contains_key(*path) {
                    landed_renames.insert(path.to_path_buf());
                }
            } else {
                index_update_rejected = true;
            }
        }

        // Carry history only onto destinations accepted by the picker.
        renames.retain(|to, _| landed_renames.contains(to));

        overflow_count = picker.get_overflow_files().len();
    }

    info!(
        files_updated = files_to_update_git_status.len(),
        overflow_count, "File index changes applied",
    );

    if index_update_rejected {
        let reason = RescanReason::IndexUpdateRejected;

        info!(%reason, "Watcher faced limit of index overflow. Triggering rescan");
        try_trigger_full_rescan(reason);
    }

    // Carry the access history onto the new path. Copied, not moved: checking
    // out a revision where the old path exists again must still rank it.
    if !renames.is_empty() {
        let mut carried = Vec::new();
        if let Ok(frecency_guard) = shared_frecency.read()
            && let Some(ref frecency) = *frecency_guard
        {
            for (to, from) in &renames {
                match frecency.copy_history(from, to) {
                    Ok(true) => carried.push(to.clone()),
                    Ok(false) => {}
                    Err(e) => error!(
                        ?from,
                        ?to,
                        "Failed to carry frecency over a rename: {:?}",
                        e
                    ),
                }
            }
        }

        if !carried.is_empty() {
            info!(count = carried.len(), "Carried frecency across renames");
            if let Ok(mut picker_guard) = shared_picker.write()
                && let Some(ref mut picker) = *picker_guard
                && let Ok(frecency_guard) = shared_frecency.read()
                && let Some(ref frecency) = *frecency_guard
            {
                for path in &carried {
                    let _ = picker.update_single_file_frecency(path, frecency);
                }
            }
        }
    }

    // AI mode: auto-track frecency for all modified/created files.
    // Uses a 5-minute cooldown per file to prevent score inflation from rapid
    // burst edits (AI agents often edit the same file many times in minutes).
    // This runs after apply_changes so the picker write lock is released.
    if !paths_to_add_or_modify.is_empty() {
        let mut tracked_count = 0usize;
        if let Ok(frecency_guard) = shared_frecency.read()
            && let Some(ref frecency) = *frecency_guard
        {
            for path in &paths_to_add_or_modify {
                // Skip if this file was tracked less than 5 minutes ago
                let should_track = match frecency.seconds_since_last_access(path) {
                    Ok(Some(secs)) => secs >= AI_MODE_COOLDOWN_SECS,
                    Ok(None) => true, // Never tracked before
                    Err(_) => true,   // DB error, track anyway
                };
                if !should_track {
                    continue;
                }

                if let Err(e) = frecency.track_access(path) {
                    error!("Failed to track frecency for {:?}: {:?}", path, e);
                } else {
                    tracked_count += 1;
                }
            }
            if tracked_count > 0 {
                info!("AI mode: tracked frecency for {} files", tracked_count);
            }
        }

        // Update in-memory frecency scores for tracked files
        if tracked_count > 0
            && let Ok(mut picker_guard) = shared_picker.write()
            && let Some(ref mut picker) = *picker_guard
            && let Ok(frecency_guard) = shared_frecency.read()
            && let Some(ref frecency) = *frecency_guard
        {
            for path in &paths_to_add_or_modify {
                let _ = picker.update_single_file_frecency(path, frecency);
            }
        }
    }

    // do not try to update the paths if we anyway going to rescan everything from scratch
    // no repo => no consumer thread, so don't accumulate paths nobody will drain
    if !index_update_rejected && repo.is_some() {
        if need_full_git_rescan {
            // A full git rescan re-reads every tracked path (including ones that just
            // went clean after a commit), so it already subsumes the per-path update.
            git_status_worker.request_full_rescan();
        } else if !files_to_update_git_status.is_empty() {
            git_status_worker.enqueue_paths(files_to_update_git_status);
        }
    }

    new_dirs_to_watch
}

fn index_new_directory(
    dir: &Path,
    shared_picker: &SharedFilePicker,
    shared_frecency: &SharedFrecency,
    git_status_worker: &Arc<GitStatusWorker>,
    pending_rescan: &mut Option<(RescanReason, Instant)>,
) -> (Vec<PathBuf>, bool) {
    // Prefer the walker's ignore rules; read base_path + rules from the picker.
    let (base_path, walker_rules, follow_symlinks, cancelled) =
        match shared_picker.read().ok().and_then(|g| {
            g.as_ref().map(|p| {
                (
                    p.base_path().to_path_buf(),
                    p.ignore_rules(),
                    p.follows_symlinks(),
                    Arc::clone(&p.signals.cancelled),
                )
            })
        }) {
            Some(triple) => triple,
            None => return (Vec::new(), false),
        };

    let repo = discover_working_repository(&base_path);
    let walk = match crate::walk::walk_collect_files(
        dir,
        repo.is_some(),
        follow_symlinks,
        1,
        &Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        &cancelled,
    ) {
        Ok(walk) => walk,
        Err(_) if cancelled.load(Ordering::Acquire) => return (Vec::new(), false),
        Err(e) => {
            warn!(?e, dir = %dir.display(), "Failed to walk new directory");
            // The parent subscription cannot recover pre-existing descendants.
            return (Vec::new(), true);
        }
    };

    // TODO: figure out a better optimized way for zlob to rerun the directory walk using existing
    // ignore rules, but currently we have to filter out ignored files on our own
    let filter = IgnoreFilter::new(&base_path, walker_rules, repo.as_ref());
    if filter.is_ignored(dir) {
        return (Vec::new(), false);
    }
    let join_unless_ignored = |relative_path: &str| -> Option<PathBuf> {
        let path = dir.join(relative_path);
        (!filter.is_ignored(&path)).then_some(path)
    };

    let files_to_add: Vec<PathBuf> = walk
        .pairs
        .iter()
        .filter_map(|(_, path)| join_unless_ignored(path))
        .collect();

    let subdirs: Vec<PathBuf> = walk
        .dirs
        .iter()
        .filter_map(|path| join_unless_ignored(path.trim_end_matches('/')))
        .collect();

    // Local rules are relative to this walk, not the indexed root. Rebuild
    // the root policy rather than publishing an incorrectly rebased matcher.
    // A rules handle alone is not evidence: even empty walks allocate one.
    let policy_changed = std::iter::once(dir)
        .chain(subdirs.iter().map(PathBuf::as_path))
        .any(|directory| {
            [".gitignore", ".ignore"]
                .iter()
                .any(|name| directory.join(name).try_exists().unwrap_or(true))
        });

    let mut indexed_files = Vec::with_capacity(files_to_add.len());
    let mut uncovered_descendants = false;
    let mut index_update_rejected = false;
    {
        let Ok(mut guard) = shared_picker.write() else {
            return (subdirs, false);
        };

        let Some(ref mut picker) = *guard else {
            return (subdirs, false);
        };
        picker.note_filesystem_change();

        for (index, directory) in std::iter::once(dir)
            .chain(subdirs.iter().map(PathBuf::as_path))
            .enumerate()
        {
            match picker.add_directory(directory) {
                Some(uncovered) => uncovered_descendants |= index != 0 && uncovered,
                None => {
                    index_update_rejected = true;
                    uncovered_descendants |= index != 0;
                }
            }
        }

        for path in files_to_add {
            // Match the ordinary event path's admission check before pushing:
            // StableVec asserts on exhaustion in debug builds. Existing paths
            // can still be updated without consuming an overflow slot.
            if picker.get_overflow_files().len() >= MAX_OVERFLOW_FILES
                && picker.get_file_by_path(&path).is_none()
            {
                index_update_rejected = true;
                break;
            }
            if picker.handle_create_or_modify(&path).is_some() {
                indexed_files.push(path);
            } else {
                index_update_rejected = true;
            }
        }
    }
    let added = indexed_files.len();

    // Rescanning takes picker locks: never request it from inside the write
    // guard above. Use the same admission/throttle mechanism as file events.
    let reason = if index_update_rejected {
        Some(RescanReason::IndexUpdateRejected)
    } else {
        policy_changed.then_some(RescanReason::IgnoreFileChanged)
    };
    let rescan_started = if let Some(reason) = reason {
        match shared_picker.trigger_full_rescan_with_reason(shared_frecency, reason) {
            Ok(true) => {
                debug!(%reason, dir = %dir.display(), "New directory requires root refresh");
                true
            }
            Ok(false) => {
                if retain_deferred_reconciliation(shared_picker) {
                    defer_local_rescan(pending_rescan, reason);
                }
                false
            }
            Err(e) => {
                error!(%reason, "Failed to trigger new-directory rescan: {:?}", e);
                false
            }
        }
    } else {
        false
    };

    if !rescan_started && repo.is_some() {
        git_status_worker.enqueue_paths(indexed_files);
    }

    debug!(
        "Indexed new {} files from new directory {}",
        added,
        dir.display(),
    );

    (subdirs, uncovered_descendants)
}

fn watch_dirs_nonrecursive<'a>(
    debouncer: &Mutex<Option<Debouncer>>,
    dirs: impl Iterator<Item = &'a Path>,
) -> bool {
    let mut guard = debouncer.lock();
    let Some(debouncer) = guard.as_mut() else {
        return false;
    };

    for dir in dirs {
        if let Err(e) = debouncer.watch(dir, RecursiveMode::NonRecursive) {
            if missing_path_error(&e) {
                continue;
            }
            warn!(
                ?e,
                dir = %dir.display(),
                "Failed to init watcher for new directory"
            );
            return false;
        }
    }

    true
}

fn entry_metadata(
    path: &Path,
    base_path: &Path,
    follow_symlinks: bool,
) -> std::io::Result<Option<std::fs::Metadata>> {
    if !follow_symlinks {
        let Ok(relative) = path.strip_prefix(base_path) else {
            return Ok(None);
        };
        // lstat on the leaf still follows intermediate symlinks. A queued
        // child event may outlive the directory it originally came from.
        let mut ancestor = base_path.to_path_buf();
        if let Some(parent) = relative.parent() {
            for component in parent.components() {
                ancestor.push(component);
                if std::fs::symlink_metadata(&ancestor)?.is_symlink() {
                    return Ok(None);
                }
            }
        }
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_symlink() {
        Ok(Some(metadata))
    } else if follow_symlinks {
        std::fs::metadata(path).map(Some)
    } else {
        Ok(None)
    }
}

struct IgnoreFilter<'a> {
    base_path: &'a Path,
    /// Reusable ignore rules from the last walk (zlob backend only).
    rules: Option<Arc<crate::walk::WalkIgnoreRules>>,
    /// libgit2 repo, consulted only when `rules` is `None`. Borrowed from the
    /// caller's repo (also used for git-status queries) to avoid re-opening.
    repo: Option<&'a Repository>,
}

impl<'a> IgnoreFilter<'a> {
    fn new(
        base_path: &'a Path,
        rules: Option<Arc<crate::walk::WalkIgnoreRules>>,
        repo: Option<&'a Repository>,
    ) -> Self {
        Self {
            base_path,
            rules,
            repo,
        }
    }

    /// Whether `path` (absolute) is ignored.
    fn is_ignored(&self, path: &Path) -> bool {
        // Match SKIP_HIDDEN in the non-working-repository walk, including
        // hidden ancestors and roots that have collected ignore rules.
        if self.repo.is_none()
            && path.strip_prefix(self.base_path).is_ok_and(|relative| {
                relative
                    .components()
                    .any(|part| part.as_os_str().as_encoded_bytes().starts_with(b"."))
            })
        {
            return true;
        }
        if let Some(rules) = self.rules.as_ref() {
            let Ok(relative) = path.strip_prefix(self.base_path) else {
                return false;
            };
            // `IgnoreRules::is_ignored` enumerates every ancestor .gitignore
            // layer internally, so a leaf under an ignored directory (rule
            // `build/`, path `build/out.rs`) is caught in one call.
            return rules.is_ignored(relative);
        }
        match self.repo {
            Some(repo) => repo.is_path_ignored(path) == Ok(true),
            // No repo and no rules: the non-code-dir heuristic, applied to the
            // base-relative path so ancestors of the base (e.g. a temp dir
            // under AppData/Local on Windows) never match.
            None => crate::ignore::is_non_code_directory(
                path.strip_prefix(self.base_path).unwrap_or(path),
            ),
        }
    }
}

#[inline]
pub(crate) fn is_git_file(path: &Path) -> bool {
    // it could be in submodule
    path.components()
        .any(|component| component.as_os_str() == ".git")
}

fn is_git_metadata(path: &Path, repo: Option<&Repository>) -> bool {
    let Some(repo) = repo else {
        return is_git_file(path);
    };
    let workdir = repo.workdir();
    // A linked worktree can itself live inside the common directory. Only
    // metadata outside that data subtree (or nested beneath it) is metadata.
    let in_metadata = |directory: &Path| {
        path.starts_with(directory)
            && !workdir
                .is_some_and(|workdir| workdir.starts_with(directory) && path.starts_with(workdir))
    };
    let relative = workdir
        .and_then(|workdir| path.strip_prefix(workdir).ok())
        .unwrap_or(path);
    is_git_file(relative) || in_metadata(repo.path()) || in_metadata(repo.commondir())
}

fn is_dotgit_change_affecting_status(changed: &Path, repo: &Option<Repository>) -> bool {
    let Some(repo) = repo.as_ref() else {
        return false;
    };

    // Linked worktrees share configuration, not their private indexes/HEADs.
    if changed
        .strip_prefix(repo.commondir())
        .is_ok_and(|path| path == Path::new("config"))
    {
        return true;
    }
    let git_dir = repo.path();

    if let Ok(path_in_git_dir) = changed.strip_prefix(git_dir) {
        // Only react to changes that rewrite the worktree state: commits,
        // staging, checkouts, merges, conflicts or repository configuration
        // that changes status interpretation (e.g. core.filemode). Ref-only updates
        // under refs/ (fetch, push, tag writes, pack-refs) do not change
        // which files are modified/untracked, so we deliberately skip them
        // watching refs/ recursively would cost one inotify watch per ref
        // namespace on repos with many branches/remotes.
        if matches!(
            path_in_git_dir.to_str(),
            Some("index" | "index.lock" | "config" | "config.worktree")
        ) {
            return true;
        }

        if path_in_git_dir == Path::new("HEAD") {
            return true;
        }

        // some of the git ops are not involving nethier index nor HEAD change, or sometimes
        // index updates can arrive too late after the change - that's why we track the log
        // the actual user action, once user
        if path_in_git_dir == Path::new("logs/HEAD") {
            return true;
        }

        if let Some(fname) = path_in_git_dir.file_name().and_then(|f| f.to_str())
            && matches!(fname, "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD")
        {
            return true;
        }
    }

    false
}

// A bare repository has no working tree: its files remain ordinary indexed
// content, not an external metadata tree whose events should be suppressed.
fn discover_working_repository(base_path: &Path) -> Option<Repository> {
    crate::git::discover_repository(base_path)
        .ok()
        .filter(|repo| repo.workdir().is_some())
}

// Optional directories can disappear after a snapshot; permissions and watch
// exhaustion are not benign and must still degrade readiness.
fn missing_path_error(error: &notify::Error) -> bool {
    matches!(&error.kind, notify::ErrorKind::PathNotFound)
        || matches!(&error.kind, notify::ErrorKind::Io(error) if error.kind() == std::io::ErrorKind::NotFound)
}

fn retain_deferred_reconciliation(shared_picker: &SharedFilePicker) -> bool {
    let Ok(guard) = shared_picker.write() else {
        return false;
    };
    let Some(picker) = guard.as_ref() else {
        return false;
    };
    // Not admitted yet: it must not impersonate an already-queued scan pass.
    picker
        .signals
        .reconcile_pending
        .store(true, Ordering::Release);
    true
}

/// Returns whether this resource needs a deferred retry. Only the first fault
/// requests recovery; persistent failures still obey the shared rescan cooldown.
fn needs_watcher_recovery(
    picker: &SharedFilePicker,
    frecency: &SharedFrecency,
    healthy: &AtomicBool,
) -> bool {
    healthy.swap(false, Ordering::AcqRel)
        && matches!(
            picker.trigger_full_rescan_with_reason(frecency, RescanReason::WatcherFailure),
            Ok(false)
        )
}

fn defer_local_rescan(pending: &mut Option<(RescanReason, Instant)>, reason: RescanReason) {
    let (queued, _) = pending.get_or_insert((reason, Instant::now()));
    // A consumed policy request must not cancel an outstanding resource fault.
    if reason == RescanReason::WatcherFailure {
        *queued = reason;
    }
}

#[derive(PartialEq, Eq)]
struct GitWatchIdentity {
    path: PathBuf,
    directory: (u64, u64),
    logs: Option<(u64, u64)>,
    common: Option<(PathBuf, (u64, u64))>,
}

fn watch_git_directory(
    debouncer: &mut Debouncer,
    path: &Path,
) -> notify::Result<Option<(u64, u64)>> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => metadata,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(notify::Error::io(error)),
    };
    match debouncer.watch(path, RecursiveMode::NonRecursive) {
        Ok(()) => Ok(Some((metadata.dev(), metadata.ino()))),
        Err(error) if missing_path_error(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn watch_git_status_paths(
    debouncer: &mut Debouncer,
    base_path: &Path,
) -> notify::Result<Option<GitWatchIdentity>> {
    // Re-register idempotently, including bootstrap init and same-path
    // recreation. Do not shadow the kernel's current subscription state.
    let repo = discover_working_repository(base_path);
    let mut dirs = vec![base_path.join(".git")];
    if let Some(repo) = &repo
        && !dirs.iter().any(|dir| dir == repo.path())
    {
        dirs.push(repo.path().to_path_buf());
    }
    let common = if let Some(repo) = &repo
        && repo.commondir() != repo.path()
    {
        let path = repo.commondir().to_path_buf();
        watch_git_directory(debouncer, &path)?.map(|identity| (path, identity))
    } else {
        None
    };
    let mut identity = None;
    for git_dir in dirs {
        let Some(directory) = watch_git_directory(debouncer, &git_dir)? else {
            continue;
        };
        let logs = watch_git_directory(debouncer, &git_dir.join("logs"))?;
        if repo.as_ref().is_some_and(|repo| repo.path() == git_dir) {
            // Directory identity, not mtime: ordinary Git writes do not
            // justify another full worktree status pass.
            identity = Some(GitWatchIdentity {
                path: git_dir,
                directory,
                logs,
                common: common.clone(),
            });
        }
    }
    Ok(identity)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct FileIdentity {
    size: u64,
    mtime: u64,
}

// Returns destination -> source. Explicit pairs from the OS win outright; the
// rest is inferred from files that kept their exact size and mtime. Call while
// the removed paths are still indexed — that is the only source of their
// metadata once they are gone from disk.
fn detect_renames(
    picker: &crate::file_picker::FilePicker,
    base_path: &Path,
    paths_to_remove: &[(&Path, bool)],
    paths_to_add_or_modify: &[&Path],
    explicit: &[(PathBuf, PathBuf)],
) -> ahash::AHashMap<PathBuf, PathBuf> {
    // Subscribers only ever see paths relative to the base, so a move that
    // crosses the boundary stays a plain removal or creation.
    let mut renames: ahash::AHashMap<PathBuf, PathBuf> = explicit
        .iter()
        .filter(|(from, to)| from != to && from.starts_with(base_path) && to.starts_with(base_path))
        .map(|(from, to)| (to.clone(), from.clone()))
        .collect();

    if paths_to_remove.is_empty() || paths_to_add_or_modify.is_empty() {
        return renames;
    }

    let explicit_sources: ahash::AHashSet<&Path> = renames.values().map(PathBuf::as_path).collect();
    let removed: Vec<(PathBuf, FileIdentity)> = paths_to_remove
        .iter()
        .filter(|(path, _)| !explicit_sources.contains(path))
        .filter_map(|(path, _)| {
            let file = picker.get_file_by_path(path)?;
            Some((
                path.to_path_buf(),
                FileIdentity {
                    size: file.size,
                    mtime: file.modified,
                },
            ))
        })
        .collect();

    let added: Vec<(PathBuf, FileIdentity)> = paths_to_add_or_modify
        .iter()
        .filter(|path| !renames.contains_key(**path))
        // A path already live in the index was edited, not moved into place.
        .filter(|path| {
            picker
                .get_file_by_path(path)
                .is_none_or(|file| file.is_deleted())
        })
        .filter_map(|path| {
            let meta = std::fs::metadata(path).ok()?;
            let mtime = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs();
            Some((
                path.to_path_buf(),
                FileIdentity {
                    size: meta.len(),
                    mtime,
                },
            ))
        })
        .collect();

    for (from, to) in pair_renames_by_identity(&removed, &added) {
        renames.insert(to, from);
    }

    renames
}

// Pair a removed with an added path when they are the only two files in the
// batch sharing a (size, mtime) — a rename preserves both exactly. Uniqueness
// on both sides is what stops bulk operations from cross-wiring histories.
fn pair_renames_by_identity(
    removed: &[(PathBuf, FileIdentity)],
    added: &[(PathBuf, FileIdentity)],
) -> Vec<(PathBuf, PathBuf)> {
    if removed.is_empty() || added.is_empty() {
        return Vec::new();
    }

    // `None` marks an identity claimed by more than one distinct path. The OS
    // repeats a path within a batch (FSEvents does routinely), and a repeat is
    // still one candidate, not a collision.
    fn index_by_identity(
        entries: &[(PathBuf, FileIdentity)],
    ) -> ahash::AHashMap<FileIdentity, Option<&Path>> {
        let mut by_identity: ahash::AHashMap<FileIdentity, Option<&Path>> =
            ahash::AHashMap::default();
        for (path, identity) in entries {
            by_identity
                .entry(*identity)
                .and_modify(|slot| {
                    if *slot != Some(path.as_path()) {
                        *slot = None;
                    }
                })
                .or_insert(Some(path.as_path()));
        }
        by_identity
    }

    let sources = index_by_identity(removed);
    let targets = index_by_identity(added);

    targets
        .into_iter()
        .filter_map(|(identity, target)| {
            let target = target?;
            let source = (*sources.get(&identity)?)?;
            Some((source.to_path_buf(), target.to_path_buf()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_picker::{FilePicker, FilePickerOptions};
    use notify::Event;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind};
    use std::time::Instant;

    #[test]
    fn replacement_batch_keeps_one_current_index_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let base = crate::path_utils::canonicalize(tmp.path()).unwrap();
        let path = base.join("file.txt");
        std::fs::write(&path, "before").unwrap();

        let shared_picker = SharedFilePicker::default();
        let shared_frecency = SharedFrecency::noop();
        let mut picker = FilePicker::new(FilePickerOptions {
            base_path: base.to_string_lossy().into_owned(),
            watch: false,
            ..Default::default()
        })
        .unwrap();
        picker.collect_files().unwrap();
        *shared_picker.write().unwrap() = Some(picker);

        std::fs::write(&path, "after").unwrap();
        let now = Instant::now();
        let events = vec![
            DebouncedEvent::new(
                Event::new(EventKind::Remove(RemoveKind::File)).add_path(path.clone()),
                now,
            ),
            DebouncedEvent::new(
                Event::new(EventKind::Create(CreateKind::File)).add_path(path.clone()),
                now,
            ),
            DebouncedEvent::new(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(path.clone()),
                now,
            ),
        ];

        handle_debounced_events(
            events,
            &base,
            &mpsc::channel().0,
            &shared_picker,
            &shared_frecency,
            &GitStatusWorker::new(),
        );

        let guard = shared_picker.read().unwrap();
        let picker = guard.as_ref().unwrap();
        assert_eq!(picker.live_file_count(), 1);
        assert_eq!(picker.get_file_by_path(&path).unwrap().size, 5);
        let found = picker.grep_pattern("after", &[], &Default::default());
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].line_content, "after");
    }

    fn identity(size: u64, mtime: u64) -> FileIdentity {
        FileIdentity { size, mtime }
    }

    fn entry(path: &str, size: u64, mtime: u64) -> (PathBuf, FileIdentity) {
        (PathBuf::from(path), identity(size, mtime))
    }

    #[test]
    fn unique_size_and_mtime_pairs_as_a_rename() {
        let pairs = pair_renames_by_identity(
            &[entry("/w/old.rs", 120, 1_700_000_000)],
            &[entry("/w/new.rs", 120, 1_700_000_000)],
        );

        assert_eq!(
            pairs,
            vec![(PathBuf::from("/w/old.rs"), PathBuf::from("/w/new.rs"))]
        );
    }

    #[test]
    fn ambiguous_identities_are_never_paired() {
        let two_removed = pair_renames_by_identity(
            &[entry("/w/a.rs", 10, 5), entry("/w/b.rs", 10, 5)],
            &[entry("/w/c.rs", 10, 5)],
        );
        assert!(
            two_removed.is_empty(),
            "two removed files sharing an identity are ambiguous: {two_removed:?}"
        );

        let two_added = pair_renames_by_identity(
            &[entry("/w/a.rs", 10, 5)],
            &[entry("/w/b.rs", 10, 5), entry("/w/c.rs", 10, 5)],
        );
        assert!(
            two_added.is_empty(),
            "two added files sharing an identity are ambiguous: {two_added:?}"
        );
    }

    #[test]
    fn a_repeated_path_is_one_candidate_not_a_collision() {
        // FSEvents routinely reports the same path several times per batch.
        let pairs = pair_renames_by_identity(
            &[entry("/w/old.rs", 15, 99), entry("/w/old.rs", 15, 99)],
            &[entry("/w/new.rs", 15, 99), entry("/w/new.rs", 15, 99)],
        );

        assert_eq!(
            pairs,
            vec![(PathBuf::from("/w/old.rs"), PathBuf::from("/w/new.rs"))]
        );
    }

    #[test]
    fn empty_files_are_paired_only_when_unambiguous() {
        let unique = pair_renames_by_identity(&[entry("/w/a", 0, 7)], &[entry("/w/b", 0, 7)]);
        assert_eq!(
            unique,
            vec![(PathBuf::from("/w/a"), PathBuf::from("/w/b"))],
            "a lone empty file still has a usable identity"
        );

        let colliding = pair_renames_by_identity(
            &[entry("/w/a", 0, 7), entry("/w/b", 0, 7)],
            &[entry("/w/c", 0, 7), entry("/w/d", 0, 7)],
        );
        assert!(colliding.is_empty(), "{colliding:?}");
    }

    #[test]
    fn differing_metadata_is_not_a_rename() {
        // git checkout rewrites mtime, so branch switches must never pair.
        let fresh_mtime = pair_renames_by_identity(
            &[entry("/w/old.rs", 120, 1_700_000_000)],
            &[entry("/w/new.rs", 120, 1_700_000_900)],
        );
        assert!(fresh_mtime.is_empty(), "{fresh_mtime:?}");

        let other_size = pair_renames_by_identity(
            &[entry("/w/old.rs", 120, 1_700_000_000)],
            &[entry("/w/new.rs", 121, 1_700_000_000)],
        );
        assert!(other_size.is_empty(), "{other_size:?}");
    }

    #[test]
    fn independent_identities_pair_side_by_side() {
        let pairs = pair_renames_by_identity(
            &[entry("/w/a.rs", 10, 1), entry("/w/b.rs", 20, 2)],
            &[entry("/w/y.rs", 20, 2), entry("/w/x.rs", 10, 1)],
        );

        let mut pairs = pairs;
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                (PathBuf::from("/w/a.rs"), PathBuf::from("/w/x.rs")),
                (PathBuf::from("/w/b.rs"), PathBuf::from("/w/y.rs")),
            ]
        );
    }

    #[test]
    fn dotgit_status_filter_matches_worktree_state_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        let git_dir = repo.path().to_path_buf();
        let repo = Some(repo);

        let affecting = [
            "index",
            "index.lock",
            "HEAD",
            "logs/HEAD",
            "MERGE_HEAD",
            "config",
            "config.worktree",
        ];
        for p in affecting {
            assert!(
                is_dotgit_change_affecting_status(&git_dir.join(p), &repo),
                "{p} must trigger a git status rescan"
            );
        }

        // Ref-only updates (fetch/push/tags) and commit scratch files must not.
        let non_affecting = [
            "refs/heads/main",
            "refs/heads/main.lock",
            "logs/refs/remotes/origin/main",
            "COMMIT_EDITMSG",
            "packed-refs",
            "config.lock",
        ];
        for p in non_affecting {
            assert!(
                !is_dotgit_change_affecting_status(&git_dir.join(p), &repo),
                "{p} must NOT trigger a git status rescan"
            );
        }

        // Worktree paths outside .git never match.
        assert!(!is_dotgit_change_affecting_status(
            &tmp.path().join("src/main.rs"),
            &repo
        ));
        assert!(!is_dotgit_change_affecting_status(
            &git_dir.join("index"),
            &None
        ));
    }
}
