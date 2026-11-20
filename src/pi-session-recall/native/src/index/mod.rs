//! Rebuildable per-root SQLite index. This layer only opens original JSONL read-only.
mod hybrid;
mod search;
mod sync;
mod terms;
mod tree;

pub use hybrid::{HybridHit, HybridResult, SessionHits};
pub use search::{LexicalHit, LexicalResult, Scope};
pub use sync::{CoverageGap, RefreshReport};
use tree::Tree;

use crate::Result;
use metis_bekko::Encoder;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use rustix::fs::{Mode, OFlags, openat};
use std::{
    fs::File,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::Path,
    sync::Arc,
    time::Duration,
};

const CACHE_SCHEMA: i64 = 2;

pub struct Index {
    root: Tree,
    cache_dir: File,
    db: Connection,
    encoder: Option<Arc<Encoder>>,
}

impl Index {
    /// Cache storage must be a private, caller-owned directory dedicated to this root.
    pub fn open(root: &Path, cache_dir: &Path) -> Result<Self> {
        Self::open_inner(root, cache_dir, None)
    }

    pub fn open_hybrid(root: &Path, cache_dir: &Path, encoder: Arc<Encoder>) -> Result<Self> {
        Self::open_inner(root, cache_dir, Some(encoder))
    }

    fn open_inner(root: &Path, cache_dir: &Path, encoder: Option<Arc<Encoder>>) -> Result<Self> {
        let model = encoder.as_ref().map(|_| metis_bekko::REVISION);
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
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
        )?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let root_path = root.path.as_os_str().as_bytes();
        let device = identity.dev() as i64;
        let inode = identity.ino() as i64;
        match version {
            0 => {
                tx.execute_batch(include_str!("schema.sql"))?;
                tx.execute(
                    "INSERT INTO cache_root VALUES(1,?1,?2,?3,?4)",
                    params![root_path, device, inode, model],
                )?;
                tx.pragma_update(None, "user_version", CACHE_SCHEMA)?;
            }
            CACHE_SCHEMA => {
                let matches: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM cache_root WHERE path=?1 AND device=?2 AND inode=?3 AND model IS ?4)",
                    params![root_path, device, inode, model],
                    |row| row.get(0),
                )?;
                if !matches {
                    return Err("Recall index belongs to another session root or model".into());
                }
            }
            _ => return Err("Incompatible Recall cache version; rebuild the index".into()),
        }
        tx.commit()?;
        Ok(Self {
            root,
            cache_dir: cache,
            db,
            encoder,
        })
    }
}
