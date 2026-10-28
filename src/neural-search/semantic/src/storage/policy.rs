//! A short policy lock is separate from the long corpus-writer lock. A new
//! configuration can therefore request a downgrade while a writer is encoding;
//! that writer must observe it before its next allocation or publication.
use super::*;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BYTES: u64 = 512 << 20;
pub const MAX_BYTES: u64 = 1024 << 20;
const MAX_POLICY: u64 = 8192;

fn bytes(mib: u16) -> Result<u64> {
    match mib {
        256 | 512 | 1024 => Ok(u64::from(mib) << 20),
        _ => Err("cache budget must be one of 256, 512, 1024 MiB".into()),
    }
}

/// An exact metadata snapshot from Metis's existing configuration owner. Strings
/// preserve Node bigint precision; the core never reparses the user's TOML.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigStamp {
    pub device: String,
    pub inode: String,
    pub length: String,
    pub modified_ns: String,
    pub changed_ns: String,
}
impl ConfigStamp {
    pub fn capture(path: &Path) -> io::Result<Option<Self>> {
        let m = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if !m.is_file() {
            return Err(io::Error::other("cache configuration source is not a file"));
        }
        Ok(Some(Self {
            device: m.dev().to_string(),
            inode: m.ino().to_string(),
            length: m.len().to_string(),
            modified_ns: (i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()))
                .to_string(),
            changed_ns: (i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec()))
                .to_string(),
        }))
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub budget_mib: u16,
    pub source: PathBuf,
    pub stamp: Option<ConfigStamp>,
}
impl Selection {
    pub fn from_env() -> Result<Option<Self>> {
        let Some(raw) = std::env::var_os("SGREP_CACHE_POLICY_REQUEST") else {
            return Ok(None);
        };
        let raw = raw
            .into_string()
            .map_err(|_| "SGREP_CACHE_POLICY_REQUEST must be UTF-8 JSON")?;
        if raw.len() as u64 > MAX_POLICY {
            return Err("cache policy request is too large".into());
        }
        let value: Self = serde_json::from_str(&raw)?;
        bytes(value.budget_mib)?;
        if !value.source.is_absolute() {
            return Err("cache configuration source must be absolute".into());
        }
        Ok(Some(value))
    }
    fn validate(&self) -> Result<()> {
        bytes(self.budget_mib)?;
        if !self.source.is_absolute() || ConfigStamp::capture(&self.source)? != self.stamp {
            return Err(
                "cache configuration snapshot changed; reload the effective Metis setting".into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub version: u8,
    pub generation: u64,
    pub active_mib: u16,
    pub target_mib: u16,
    pub selection: Option<Selection>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            generation: 0,
            active_mib: (DEFAULT_BYTES >> 20) as u16,
            target_mib: (DEFAULT_BYTES >> 20) as u16,
            selection: None,
        }
    }
}
impl State {
    pub fn pending(&self) -> bool {
        self.active_mib != self.target_mib
    }
    pub fn limit(&self, local: u64) -> Result<u64> {
        if self.pending() {
            return Err(unavailable(
                "cache budget downgrade pending: active readers or writer reservations remain",
            )
            .into());
        }
        Ok(bytes(self.active_mib)?.min(local))
    }
}

pub struct Locked {
    _lock: File,
    ledger: PathBuf,
    pub state: State,
}
impl Locked {
    pub fn open(ledger: &Path) -> Result<Self> {
        std::fs::create_dir_all(ledger)?;
        let lock = open(&ledger.join("policy.lock"), true, true)?;
        lock.try_lock()?;
        supported(&lock)?;
        // SIGKILL skips NamedTempFile::drop. This namespace is private and all
        // budget transactions share policy.lock, so a regular budget-*.tmp
        // remaining after we acquire it cannot belong to a live transaction.
        for entry in std::fs::read_dir(ledger)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("budget-") && name.ends_with(".tmp") && entry.file_type()?.is_file()
            {
                regular(&entry.path())?;
                std::fs::remove_file(entry.path())?;
            }
        }
        let path = ledger.join("budget.json");
        let state = if path.exists() {
            if regular(&path)?.len() > MAX_POLICY {
                return Err("cache policy is too large".into());
            }
            serde_json::from_reader(open(&path, false, false)?)?
        } else {
            State::default()
        };
        let value = Self {
            _lock: lock,
            ledger: ledger.to_path_buf(),
            state,
        };
        if value.state.version != 1
            || bytes(value.state.active_mib)? < bytes(value.state.target_mib)?
        {
            return Err("invalid cache policy state".into());
        }
        if let Some(selection) = &value.state.selection {
            if selection.budget_mib != value.state.target_mib {
                return Err("inconsistent cache policy target".into());
            }
        }
        Ok(value)
    }
    pub fn select(&mut self, requested: Option<&Selection>) -> Result<()> {
        if let Some(next) = requested {
            next.validate()?;
            if let Some(previous) = &self.state.selection {
                if previous.source != next.source {
                    if self.state.target_mib != next.budget_mib {
                        return Err(
                            "cache configuration source conflict; no separate quota is granted"
                                .into(),
                        );
                    }
                    return Ok(());
                }
                if previous.stamp == next.stamp && previous.budget_mib != next.budget_mib {
                    return Err(
                        "conflicting cache budgets for the same configuration snapshot".into(),
                    );
                }
            }
            if self.state.selection.as_ref() != Some(next) {
                self.state.generation = self
                    .state
                    .generation
                    .checked_add(1)
                    .ok_or("cache policy generation overflow")?;
                self.state.target_mib = next.budget_mib;
                self.state.active_mib = self.state.active_mib.max(next.budget_mib);
                self.state.selection = Some(next.clone());
                self.save()?;
            }
        }
        if !self.ledger.join("budget.json").exists() {
            self.save()?;
        }
        Ok(())
    }
    /// Caller holds quota.lock. A pending decrease may evict any unused complete
    /// index; the writer's unpublished .tmp is never an LRU candidate.
    pub fn settle(&mut self, roots: &[PathBuf]) -> Result<()> {
        if self.state.pending() {
            let target = bytes(self.state.target_mib)?.saturating_sub(CONTROL_RESERVE);
            prune(roots, &self.ledger, Path::new(""), target)?;
            if measure(roots, &self.ledger)? <= target {
                self.state.active_mib = self.state.target_mib;
                self.save()?;
            }
        }
        Ok(())
    }
    fn save(&self) -> Result<()> {
        let data = serde_json::to_vec(&self.state)?;
        if data.len() as u64 > MAX_POLICY {
            return Err("cache policy is too large".into());
        }
        let mut file = tempfile::Builder::new()
            .prefix("budget-")
            .suffix(".tmp")
            .tempfile_in(&self.ledger)?;
        file.write_all(&data)?;
        file.as_file().sync_all()?;
        file.persist(self.ledger.join("budget.json"))?;
        File::open(&self.ledger)?.sync_all()?;
        Ok(())
    }
}

pub fn into_io(error: Box<dyn std::error::Error + Send + Sync>) -> io::Error {
    match error.downcast::<io::Error>() {
        Ok(e) => *e,
        Err(e) => io::Error::other(e.to_string()),
    }
}
