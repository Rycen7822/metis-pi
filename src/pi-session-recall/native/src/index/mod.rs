//! Rebuildable per-root SQLite index. This layer only opens original JSONL read-only.
mod graph;
mod hybrid;
mod search;
mod sync;
mod terms;
mod tree;

pub use graph::{GraphPolicy, GraphReport};
pub use hybrid::{
    EnhancedCenter, EnhancedResult, EnhancedSelection, HybridHit, HybridResult, SessionHits,
};
pub use search::{LexicalHit, LexicalResult, Scope};
pub use sync::{Coverage, CoverageGap, RefreshReport};
use tree::Tree;

use crate::Result;
use metis_bekko::Encoder;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use rustix::fs::{Mode, OFlags, openat};
use std::{
    fs::File,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub const CACHE_SCHEMA: i64 = 4;

#[derive(Debug, PartialEq, Eq)]
pub enum IndexState {
    SourceChanged,
    SourceMissing,
}

impl std::fmt::Display for IndexState {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::SourceChanged => {
                "Pi session changed during Recall refresh; retry from the committed cursor"
            }
            Self::SourceMissing => "Session is not in this Recall index",
        })
    }
}

impl std::error::Error for IndexState {}

pub struct Index {
    root: Tree,
    cache_dir: File,
    cache_path: PathBuf,
    db: Connection,
    encoder: Option<Arc<Encoder>>,
    graph_only: bool,
}

impl Index {
    /// Cache storage must be a private, caller-owned directory dedicated to this root.
    pub fn open(root: &Path, cache_dir: &Path) -> Result<Self> {
        Self::open_inner(root, cache_dir, None, None)
    }

    pub fn open_hybrid(root: &Path, cache_dir: &Path, encoder: Arc<Encoder>) -> Result<Self> {
        Self::open_inner(root, cache_dir, Some(metis_bekko::REVISION), Some(encoder))
    }

    pub fn open_graph_cache(root: &Path, cache_dir: &Path) -> Result<Self> {
        Self::open_inner(root, cache_dir, Some(metis_bekko::REVISION), None)
    }

    fn open_inner(
        root: &Path,
        cache_dir: &Path,
        model: Option<&str>,
        encoder: Option<Arc<Encoder>>,
    ) -> Result<Self> {
        let root = Tree::open(root)?;
        let identity = root.dir.metadata()?;
        let cache = File::from(openat(
            rustix::fs::CWD,
            cache_dir,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?);
        if cache.metadata()?.mode() & 0o077 != 0 {
            return Err("Recall cache directory must be private".into());
        }
        let flags = OpenFlags::default() | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let mut db = Connection::open_with_flags(cache_dir.join("index.sqlite3"), flags)?;
        db.busy_timeout(Duration::from_millis(100))?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192;",
        )?;
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let root_path = root.path.as_os_str().as_bytes();
        let device = identity.dev() as i64;
        let inode = identity.ino() as i64;
        match version {
            0 => {
                db.pragma_update(None, "journal_mode", "WAL")?;
                let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                // Recheck after acquiring the writer lock: another process may have opened the new cache.
                let initialized: i64 =
                    tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
                if initialized == 0 {
                    tx.execute_batch(include_str!("schema.sql"))?;
                    tx.execute(
                        "INSERT INTO cache_root VALUES(1,?1,?2,?3,?4)",
                        params![root_path, device, inode, model],
                    )?;
                    tx.pragma_update(None, "user_version", CACHE_SCHEMA)?;
                }
                tx.commit()?;
            }
            CACHE_SCHEMA => {}
            _ => return Err("Incompatible Recall cache version; rebuild the index".into()),
        }
        let matches: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM cache_root WHERE path=?1 AND device=?2 AND inode=?3 AND model IS ?4)",
            params![root_path, device, inode, model],
            |row| row.get(0),
        )?;
        if !matches {
            return Err("Recall index belongs to another session root or model".into());
        }
        Ok(Self {
            root,
            cache_dir: cache,
            cache_path: cache_dir.to_path_buf(),
            db,
            graph_only: model.is_some() && encoder.is_none(),
            encoder,
        })
    }

    /// Bound SQLite's data-page growth. WAL and graph growth are accounted separately
    /// by the worker that owns the aggregate cache admission lock.
    pub fn limit_growth(&self, extra_bytes: u64) -> Result<()> {
        let pages: u64 = self
            .db
            .pragma_query_value(None, "page_count", |row| row.get(0))?;
        let page_size: u64 = self
            .db
            .pragma_query_value(None, "page_size", |row| row.get(0))?;
        self.db
            .pragma_update(None, "max_page_count", pages + extra_bytes / page_size)?;
        Ok(())
    }
}
