//! One user-profile ledger for every registered corpus-cache root.
//! The exclusive maintenance lock spans a writer, never an encoder worker.
//! Readers lease the immutable inode; replacement retains a hardlink until the
//! last lease is gone. Actual blocks, not logical lengths, govern admission.
use crate::{ModelChoice, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

mod policy;
pub use policy::MAX_BYTES;
const QUANTUM: u64 = 64 << 10;
const CONTROL_RESERVE: u64 = 64 << 10;
const MAX_ENTRIES: usize = 128;
const MAX_AGE: Duration = Duration::from_secs(30 * 86400);

fn unavailable(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::StorageFull, message)
}
fn regular(path: &Path) -> io::Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "cache entry is not an owned regular file",
        ));
    }
    Ok(metadata)
}
fn open(path: &Path, create: bool, write: bool) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(write)
        .create(create)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}
fn owned(name: &str) -> bool {
    let stem = name.strip_prefix("index-").unwrap_or(name);
    let index = stem
        .strip_suffix(".bin")
        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()));
    index
        || (name.starts_with("sgrep-index-") && name.ends_with(".tmp"))
        || (name.starts_with("retired-") && name.ends_with(".bin"))
        || name == ".sgrep-index.lock"
}
fn supported(file: &File) -> io::Result<()> {
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(file.as_raw_fd(), info.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let kind = unsafe { info.assume_init() }.f_type;
    if kind != 0xef53 && kind != 0x01021994 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "cache allocation reservation is qualified only on ext4/tmpfs",
        ));
    }
    Ok(())
}
fn preallocate(file: &File, start: u64, bytes: u64) -> io::Result<()> {
    supported(file)?;
    let code = unsafe { libc::posix_fallocate(file.as_raw_fd(), start as i64, bytes as i64) };
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}
fn allocated(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}
fn rounded(bytes: u64) -> io::Result<u64> {
    bytes
        .checked_add(QUANTUM - 1)
        .map(|n| n / QUANTUM * QUANTUM)
        .ok_or_else(|| unavailable("cache offset overflow"))
}

/// Exclude only reserved corpus-cache names, never unrelated user files that
/// happen to share a configured root. The private ledger is entirely reserved.
#[derive(Default)]
pub struct SourceFilter {
    roots: Vec<PathBuf>,
    ledger: Option<PathBuf>,
}
impl SourceFilter {
    pub fn excludes(&self, path: &Path) -> bool {
        if self.ledger.as_ref().is_some_and(|p| path.starts_with(p)) {
            return true;
        }
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(owned)
            && path
                .parent()
                .is_some_and(|parent| self.roots.iter().any(|root| parent == root))
    }
}

pub struct IndexCache {
    pub directory: PathBuf,
    ledger: PathBuf,
    pub max_bytes: u64,
    selection: Option<policy::Selection>,
}
impl IndexCache {
    /// The ledger is fixed under HOME, not --cache-dir, SGREP_CACHE_DIR or XDG.
    /// Tests use a disposable HOME; changing corpus roots never creates credits.
    pub fn new(directory: Option<&Path>) -> Result<Option<Self>> {
        let max_bytes = std::env::var("SGREP_CACHE_MAX_BYTES")
            .ok()
            .map(|v| v.parse::<u64>())
            .transpose()
            .map_err(|_| "SGREP_CACHE_MAX_BYTES must be a non-negative integer")?
            .unwrap_or(MAX_BYTES);
        if max_bytes > MAX_BYTES {
            return Err("SGREP_CACHE_MAX_BYTES must not exceed 1073741824 (1024MiB)".into());
        }
        let selection = policy::Selection::from_env()?;
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return Ok(None);
        };
        let directory = directory
            .map(|p| p.join("index"))
            .or_else(|| std::env::var_os("SGREP_CACHE_DIR").map(PathBuf::from))
            .or_else(|| std::env::var_os("XDG_CACHE_HOME").map(|p| PathBuf::from(p).join("sgrep")))
            .unwrap_or_else(|| home.join(".cache/sgrep"));
        Ok(Some(Self {
            directory,
            ledger: home.join(".cache/sgrep-cpu-quota"),
            max_bytes,
            selection,
        }))
    }
    fn select_policy(&self) -> Result<()> {
        policy::Locked::open(&self.ledger)?.select(self.selection.as_ref())
    }
    pub fn source_filter(&self) -> SourceFilter {
        let mut roots = read_roots(&self.ledger).unwrap_or_default();
        roots.push(self.directory.clone());
        let normalize = |p: &Path| {
            p.canonicalize()
                .or_else(|_| std::path::absolute(p))
                .unwrap_or_else(|_| p.to_path_buf())
        };
        roots = roots.iter().map(|p| normalize(p)).collect();
        roots.sort();
        roots.dedup();
        SourceFilter {
            roots,
            ledger: Some(normalize(&self.ledger)),
        }
    }
    pub fn target(&self, scope: &Path, choice: ModelChoice) -> PathBuf {
        let mut digest = Sha256::new();
        digest.update(scope.as_os_str().as_bytes());
        digest.update([match choice {
            ModelChoice::Auto => 0,
            ModelChoice::Text => 1,
            ModelChoice::Code => 2,
        }]);
        let id = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.directory.join(format!("index-{id}.bin"))
    }
    pub fn read(&self, target: &Path) -> Result<IndexLease> {
        if self.max_bytes < CONTROL_RESERVE {
            return Err(unavailable("budget too small for reader/policy metadata").into());
        }
        self.select_policy()?;
        // Brief exclusive admission registers a durable reader lease. There is
        // no need to inspect unrelated same-UID services or their private FDs.
        let maintenance = open(&self.ledger.join("quota.lock"), false, true)?;
        maintenance.try_lock()?;
        supported(&maintenance)?;
        cleanup_reader_stages(&self.ledger)?;
        let roots = read_roots(&self.ledger)?;
        let mut policy = policy::Locked::open(&self.ledger)?;
        policy.settle(&roots)?;
        let cap = policy.state.limit(self.max_bytes)?;
        let directory = self.directory.canonicalize()?;
        if !roots.contains(&directory) {
            return Err("unregistered cache root".into());
        }
        regular(target)?;
        let file = open(target, false, false)?;
        supported(&file)?;
        file.try_lock_shared()?;
        // LRU means last leased, not merely last written. Payload bytes and
        // the immutable inode stay unchanged while its access age is refreshed.
        file.set_modified(SystemTime::now())?;
        let metadata = file.metadata()?;
        if measure(&roots, &self.ledger)? > cap.saturating_sub(CONTROL_RESERVE) {
            return Err(unavailable("reader lease metadata does not fit the shared budget").into());
        }
        let process = std::process::id();
        let start_time = process_state(process)?.1;
        // An interrupted serialization must never appear as a published lease:
        // its missing owner/debt would otherwise poison every registered root.
        let mut lease = tempfile::Builder::new()
            .prefix(&format!(".reader-v1-{process}-{start_time}-"))
            .suffix(".tmp")
            .rand_bytes(16)
            .tempfile_in(&self.ledger)?;
        lease.as_file().try_lock()?;
        // Fixed integer fields bound this buffer; avoid one syscall per JSON
        // fragment without changing the locked staging/sync/publish boundary.
        let charge = serde_json::to_vec(&ReaderCharge {
            device: metadata.dev(),
            inode: metadata.ino(),
            bytes: allocated(&metadata),
            process,
            start_time,
        })?;
        lease.write_all(&charge)?;
        lease.as_file().sync_all()?;
        let stem = lease
            .path()
            .file_stem()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix('.'))
            .ok_or("invalid reader staging filename")?;
        let path = self.ledger.join(format!("lease-{stem}.json"));
        // persist retains the locked descriptor across the atomic rename.
        let control = lease.persist_noclobber(&path)?;
        drop(maintenance);
        Ok(IndexLease {
            file: Some(file),
            control: Some(control),
            path,
        })
    }
    pub fn begin(&self, target: &Path) -> Result<BudgetFile> {
        if self.max_bytes < CONTROL_RESERVE {
            return Err(unavailable("budget too small for transaction metadata").into());
        }
        self.select_policy()?;
        let maintenance = open(&self.ledger.join("quota.lock"), true, true)?;
        maintenance.try_lock()?;
        supported(&maintenance)?;
        cleanup_reader_stages(&self.ledger)?;
        let registry = self.ledger.join("roots.json");
        let mut roots: Vec<PathBuf> = if registry.exists() {
            regular(&registry)?;
            let mut bytes = Vec::new();
            open(&registry, false, false)?
                .take((1 << 20) + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 1 << 20 {
                return Err(unavailable("cache-root registry too large").into());
            }
            serde_json::from_slice::<Vec<Vec<u8>>>(&bytes)?
                .iter()
                .map(|p| crate::filename(p))
                .collect()
        } else {
            Vec::new()
        };
        // Missing roots remain registered: an old reader can still hold one of
        // their deleted inodes, which durable reader leases must still charge.
        std::fs::create_dir_all(&self.directory)?;
        let directory = self.directory.canonicalize()?;
        supported(&File::open(&directory)?)?;
        let target = directory.join(target.file_name().ok_or("missing cache filename")?);
        let added = !roots.contains(&directory);
        if added {
            roots.push(directory.clone());
        }
        let data = serde_json::to_vec(
            &roots
                .iter()
                .map(|p| p.as_os_str().as_bytes())
                .collect::<Vec<_>>(),
        )?;
        if data.len() > 1 << 20 {
            return Err(unavailable("cache-root registry too large").into());
        }
        let registry_reserve = if added {
            rounded(data.len() as u64)? * 2 + CONTROL_RESERVE
        } else {
            CONTROL_RESERVE
        };
        cleanup(&roots, &target)?;
        let mut policy = policy::Locked::open(&self.ledger)?;
        policy.settle(&roots)?;
        let cap = policy.state.limit(self.max_bytes)?;
        prune(
            &roots,
            &self.ledger,
            &target,
            cap.saturating_sub(registry_reserve),
        )?;
        let before = measure(&roots, &self.ledger)?;
        if before > cap.saturating_sub(registry_reserve) {
            return Err(
                unavailable("unreclaimable readers leave no safe transaction reserve").into(),
            );
        }
        let mut actual_peak = before;
        let mut reservation_peak = before;
        if added {
            reservation_peak = before + registry_reserve;
            let mut temporary = tempfile::Builder::new()
                .prefix("roots-")
                .suffix(".tmp")
                .tempfile_in(&self.ledger)?;
            let amount = rounded(data.len() as u64)?;
            preallocate(temporary.as_file(), 0, amount)?;
            actual_peak = actual_peak.max(measure(&roots, &self.ledger)?);
            temporary.write_all(&data)?;
            temporary.as_file().set_len(data.len() as u64)?;
            temporary.as_file().sync_all()?;
            temporary.persist(&registry)?;
            File::open(&self.ledger)?.sync_all()?;
        }
        let base = measure(&roots, &self.ledger)?;
        let temporary = tempfile::Builder::new()
            .prefix("sgrep-index-")
            .suffix(".tmp")
            .tempfile_in(&directory)?;
        supported(temporary.as_file())?;
        let (file, temp) = temporary.keep()?;
        Ok(BudgetFile {
            file: Some(file),
            temp,
            target,
            _maintenance: maintenance,
            roots,
            ledger: self.ledger.clone(),
            cap,
            local_limit: self.max_bytes,
            base,
            reserved_end: 0,
            logical_end: 0,
            published: false,
            peak: actual_peak.max(base),
            reservation_peak: reservation_peak.max(base),
            reason: None,
        })
    }
}

fn reclaim(path: &Path) -> bool {
    let Ok(file) = open(path, false, true) else {
        return false;
    };
    if file.try_lock().is_err() {
        return false;
    }
    std::fs::remove_file(path).is_ok()
}
fn entries(roots: &[PathBuf]) -> Result<Vec<(SystemTime, PathBuf, u64)>> {
    let mut result = Vec::new();
    for root in roots {
        let directory = match std::fs::read_dir(root) {
            Ok(d) => d,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        supported(&File::open(root)?)?;
        for entry in directory {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !owned(&name) || !entry.file_type()?.is_file() {
                continue;
            }
            let metadata = regular(&entry.path())?;
            result.push((metadata.modified()?, entry.path(), allocated(&metadata)));
        }
    }
    result.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(result)
}
fn cleanup(roots: &[PathBuf], replacing: &Path) -> Result<()> {
    for (modified, path, _) in entries(roots)? {
        if path == replacing {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy();
        if name.starts_with("retired-")
            || name.ends_with(".tmp")
            || SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default()
                > MAX_AGE
        {
            reclaim(&path);
        }
    }
    Ok(())
}
fn prune(roots: &[PathBuf], ledger: &Path, replacing: &Path, limit: u64) -> Result<()> {
    let files = entries(roots)?;
    let mut count = files
        .iter()
        .filter(|(_, p, _)| p.extension().is_some_and(|x| x == "bin"))
        .count();
    for (_, path, _) in files {
        if measure(roots, ledger)? <= limit && count < MAX_ENTRIES {
            break;
        }
        if path != replacing && path.extension().is_some_and(|x| x == "bin") && reclaim(&path) {
            count = count.saturating_sub(1);
        }
    }
    Ok(())
}
fn measure(roots: &[PathBuf], ledger: &Path) -> Result<u64> {
    measure_except(roots, ledger, None)
}
fn measure_except(roots: &[PathBuf], ledger: &Path, exclude: Option<(u64, u64)>) -> Result<u64> {
    let mut seen = HashSet::new();
    if let Some(inode) = exclude {
        seen.insert(inode);
    }
    let mut total = 0u64;
    let mut charge = |metadata: std::fs::Metadata| -> Result<()> {
        if seen.insert((metadata.dev(), metadata.ino())) {
            total = total
                .checked_add(allocated(&metadata))
                .ok_or("cache allocation overflow")?;
        }
        Ok(())
    };
    charge(std::fs::metadata(ledger)?)?;
    for root in roots {
        match std::fs::metadata(root) {
            Ok(metadata) => charge(metadata)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    for (_, path, _) in entries(roots)? {
        charge(regular(&path)?)?;
    }
    for entry in std::fs::read_dir(ledger)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            charge(regular(&entry.path())?)?;
        }
    }
    // Explicit, kernel-locked reader records survive target unlink/replace or
    // even removal of a cache root. Each record contains the immutable inode's
    // actual allocation, deduplicated against its live paths and other readers.
    for entry in std::fs::read_dir(ledger)? {
        let entry = entry?;
        let name = entry.file_name();
        if !name.as_encoded_bytes().starts_with(b"lease-") {
            continue;
        }
        let control = open(&entry.path(), false, true)?;
        let unlocked = control.try_lock().is_ok();
        let metadata = regular(&entry.path())?;
        if metadata.len() > 4096 {
            return Err("invalid reader lease record".into());
        }
        let record: ReaderCharge = serde_json::from_reader(&control)?;
        // Unlocking one descriptor does not prove that every data FD/mmap has
        // gone. Normal Drop removes its record only after data closes. Orphans
        // are reclaimable only once this exact process incarnation has exited.
        if unlocked && record.owner_gone() {
            drop(control);
            std::fs::remove_file(entry.path())?;
        } else if seen.insert((record.device, record.inode)) {
            total = total
                .checked_add(record.bytes)
                .ok_or("reader allocation overflow")?;
        }
    }
    Ok(total)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ReaderCharge {
    device: u64,
    inode: u64,
    bytes: u64,
    process: u32,
    start_time: u64,
}
impl ReaderCharge {
    fn owner_gone(&self) -> bool {
        process_gone(self.process, self.start_time)
    }
}
fn process_gone(process: u32, start_time: u64) -> bool {
    match process_state(process) {
        Ok((state, start)) => start != start_time || matches!(state, b'Z' | b'X'),
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
}
fn process_state(pid: u32) -> io::Result<(u8, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    // comm can contain spaces and ')'; fields after its last ')' are stable.
    let (_, tail) = stat
        .rsplit_once(')')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid process identity"))?;
    let mut fields = tail.split_whitespace();
    let state = fields
        .next()
        .and_then(|s| s.bytes().next())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing process state"))?;
    let start = fields
        .nth(18)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing process start time"))?;
    Ok((state, start))
}

// Called only under quota.lock. A live creator holds that same lock until its
// complete lease is published. All staging bytes, including unknown records,
// remain in measure(); recovery never invents credit for deleted data inodes.
fn cleanup_reader_stages(ledger: &Path) -> Result<()> {
    let owner = std::fs::metadata(ledger)?.uid();
    for entry in std::fs::read_dir(ledger)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue; // In particular, never follow a staging-name symlink.
        }
        let name = entry.file_name();
        let Some(identity) = name
            .to_str()
            .and_then(|s| s.strip_prefix(".reader-v1-"))
            .and_then(|s| s.strip_suffix(".tmp"))
        else {
            continue;
        };
        let fields: Vec<_> = identity.split('-').collect();
        if fields.len() != 3
            || fields[2].len() != 16
            || !fields[2].bytes().all(|b| b.is_ascii_alphanumeric())
        {
            continue;
        }
        let (Ok(process), Ok(start)) = (fields[0].parse::<u32>(), fields[1].parse::<u64>()) else {
            continue;
        };
        if process == 0 || start == 0 || !process_gone(process, start) {
            continue;
        }
        let metadata = regular(&entry.path())?;
        if metadata.uid() != owner || metadata.nlink() != 1 || metadata.len() > 4096 {
            continue;
        }
        let control = open(&entry.path(), false, true)?;
        match control.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => continue,
            Err(error) => return Err(error.into()),
        }
        let mut bytes = Vec::new();
        (&control).take(4097).read_to_end(&mut bytes)?;
        let owned = match serde_json::from_slice::<ReaderCharge>(&bytes) {
            Ok(record) => record.process == process && record.start_time == start,
            Err(error) if error.is_eof() => {
                b"{\"device\":".starts_with(&bytes) || bytes.starts_with(b"{\"device\":")
            }
            Err(_) => false,
        };
        if owned {
            drop(control);
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn read_roots(ledger: &Path) -> Result<Vec<PathBuf>> {
    let path = ledger.join("roots.json");
    regular(&path)?;
    let mut bytes = Vec::new();
    open(&path, false, false)?
        .take((1 << 20) + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1 << 20 {
        return Err("cache root registry exceeds its bound".into());
    }
    Ok(serde_json::from_slice::<Vec<Vec<u8>>>(&bytes)?
        .iter()
        .map(|p| crate::filename(p))
        .collect())
}

/// The mmap owner drops its mapping before this lease. Data closes before the
/// small control record is removed, so deleted data remains charged until safe.
pub struct IndexLease {
    file: Option<File>,
    control: Option<File>,
    path: PathBuf,
}
impl std::ops::Deref for IndexLease {
    type Target = File;
    fn deref(&self) -> &File {
        self.file.as_ref().unwrap()
    }
}
impl Drop for IndexLease {
    fn drop(&mut self) {
        drop(self.file.take());
        drop(self.control.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

pub struct BudgetFile {
    file: Option<File>,
    temp: PathBuf,
    target: PathBuf,
    _maintenance: File,
    roots: Vec<PathBuf>,
    ledger: PathBuf,
    cap: u64,
    local_limit: u64,
    base: u64,
    reserved_end: u64,
    logical_end: u64,
    published: bool,
    peak: u64,
    reservation_peak: u64,
    reason: Option<String>,
}
impl BudgetFile {
    fn ensure(&mut self, end: u64) -> io::Result<()> {
        if end <= self.reserved_end {
            return Ok(());
        }
        // Keep this guard until fallocate finishes: a configuration change may
        // not slip between checking the current policy and acquiring blocks.
        let policy = policy::Locked::open(&self.ledger).map_err(policy::into_io)?;
        self.cap = policy
            .state
            .limit(self.local_limit)
            .map_err(policy::into_io)?;
        let metadata = self.file.as_ref().unwrap().metadata()?;
        self.base = measure_except(
            &self.roots,
            &self.ledger,
            Some((metadata.dev(), metadata.ino())),
        )
        .map_err(policy::into_io)?;
        let next = rounded(end)?;
        let growth = next - self.reserved_end;
        let current = allocated(&metadata);
        // Conservative transient charge for new data blocks and extent metadata.
        // Release unused reservation only after fstat establishes actual blocks.
        let reserve = growth
            .checked_mul(2)
            .and_then(|n| n.checked_add(CONTROL_RESERVE))
            .ok_or_else(|| unavailable("cache reservation overflow"))?;
        let ceiling = self
            .cap
            .checked_sub(reserve)
            .ok_or_else(|| unavailable("complete index/update peak exceeds shared cache budget"))?;
        // The transaction-start prune only reserves control space. As the
        // payload grows, reclaim idle complete indexes under the same policy
        // and maintenance guards before giving up on caching this scope.
        if self.base.saturating_add(current) > ceiling && current <= ceiling {
            prune(&self.roots, &self.ledger, &self.target, ceiling).map_err(policy::into_io)?;
            self.base = measure_except(
                &self.roots,
                &self.ledger,
                Some((metadata.dev(), metadata.ino())),
            )
            .map_err(policy::into_io)?;
        }
        let upper = self
            .base
            .checked_add(current)
            .and_then(|n| n.checked_add(reserve))
            .ok_or_else(|| unavailable("cache reservation overflow"))?;
        if upper > self.cap {
            return Err(unavailable(
                "complete index/update peak exceeds shared cache budget",
            ));
        }
        self.reservation_peak = self.reservation_peak.max(upper);
        preallocate(self.file.as_ref().unwrap(), self.reserved_end, growth)?;
        let actual = self.base + allocated(&self.file.as_ref().unwrap().metadata()?);
        self.peak = self.peak.max(actual);
        if actual > self.cap {
            return Err(unavailable(
                "filesystem allocation exceeded its reserved bound",
            ));
        }
        self.reserved_end = next;
        Ok(())
    }
    pub fn file(&self) -> &File {
        self.file.as_ref().unwrap()
    }
    pub fn truncate(&mut self, bytes: u64) -> Result<()> {
        self.file().set_len(bytes)?;
        self.logical_end = bytes;
        Ok(())
    }
    pub fn publish(mut self) -> Result<()> {
        let policy = policy::Locked::open(&self.ledger)?;
        self.cap = policy.state.limit(self.local_limit)?;
        if measure(&self.roots, &self.ledger)? > self.cap.saturating_sub(CONTROL_RESERVE) {
            return Err(unavailable(
                "complete index/update peak exceeds the current shared budget",
            )
            .into());
        }
        self.file().sync_all()?;
        let directory = self.target.parent().unwrap();
        // Keep old readers charged through an owned hardlink after replace.
        let retired = directory.join(format!(
            "retired-{}.bin",
            self.temp.file_name().unwrap().to_string_lossy()
        ));
        if self.target.exists() {
            regular(&self.target)?;
            std::fs::hard_link(&self.target, &retired)?;
            File::open(directory)?.sync_all()?;
        }
        std::fs::rename(&self.temp, &self.target)?;
        self.published = true;
        File::open(directory)?.sync_all()?;
        if retired.exists() {
            reclaim(&retired);
        }
        self.peak = self.peak.max(measure(&self.roots, &self.ledger)?);
        Ok(())
    }
    pub fn failure(&mut self, error: &dyn std::fmt::Display) {
        self.reason = Some(error.to_string());
    }
}
impl Write for BudgetFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let start = self.file.as_mut().unwrap().stream_position()?;
        self.ensure(
            start
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| unavailable("cache offset overflow"))?,
        )?;
        let count = self.file.as_mut().unwrap().write(bytes)?;
        self.logical_end = self.logical_end.max(start + count as u64);
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().unwrap().flush()
    }
}
impl Seek for BudgetFile {
    fn seek(&mut self, at: SeekFrom) -> io::Result<u64> {
        self.file.as_mut().unwrap().seek(at)
    }
}
impl Read for BudgetFile {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.file.as_mut().unwrap().read(bytes)
    }
}
impl Drop for BudgetFile {
    fn drop(&mut self) {
        drop(self.file.take()); // close before unlink: no uncharged deleted FD
        if !self.published {
            let _ = std::fs::remove_file(&self.temp);
        }
        if let Some(path) = std::env::var_os("SGREP_CACHE_DIAGNOSTICS_PATH") {
            let state = policy::Locked::open(&self.ledger)
                .ok()
                .map(|p| p.state.clone());
            let data = serde_json::json!({"kind":"actual_cache_writer_blocks_and_reservation","published":self.published,
                "allocated_peak_bytes":self.peak,"reservation_peak_bytes":self.reservation_peak,
                "cap_bytes":self.cap,"roots":self.roots.len(),"reason":self.reason,
                "cache_budget_mib":state.as_ref().map(|p|p.active_mib),
                "cache_target_budget_mib":state.as_ref().map(|p|p.target_mib),
                "cache_budget_pending":state.as_ref().map(|p|p.pending()),
                "cache_budget_generation":state.as_ref().map(|p|p.generation)});
            if let Err(error) = std::fs::write(path, format!("{data}\n")) {
                eprintln!("sgrep: requested cache diagnostics failed: {error}");
            }
        }
    }
}
