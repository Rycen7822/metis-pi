use super::db_healthcheck::DbHealthChecker;
use super::env_pool::SharedEnv;
use crate::error::Error;
use crate::lmdb::LmdbStore;
use heed::types::{Bytes, SerdeBincode};
use heed::{Database, Env};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Legacy query association codec. Field order/types and key hashing remain
/// unchanged even though this engine no longer writes query/history records.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueryMatchEntry {
    pub file_path: PathBuf,
    pub open_count: u32,
    pub last_opened: u64,
}

#[derive(Debug)]
pub struct QueryTracker {
    env: SharedEnv,
    query_file_db: Database<Bytes, SerdeBincode<QueryMatchEntry>>,
    // History has no active reader/writer, but preserve the named tables and
    // their original bytes. Health only counts keys, never decodes values.
    query_history_db: Database<Bytes, Bytes>,
    grep_query_history_db: Database<Bytes, Bytes>,
}

impl DbHealthChecker for QueryTracker {
    fn get_env(&self) -> &Env<heed::WithoutTls> {
        &self.env
    }
    fn is_healthy(&self) -> bool {
        self.env.health().is_healthy()
    }
    fn count_entries(&self) -> Result<Vec<(&'static str, u64)>, Error> {
        let rtxn = self.env.read_txn().map_err(Self::read_txn_error)?;
        let count_queries = self.query_file_db.len(&rtxn).map_err(Self::read_error)?;
        let count_histories = self.query_history_db.len(&rtxn).map_err(Self::read_error)?;
        let count_grep_histories = self
            .grep_query_history_db
            .len(&rtxn)
            .map_err(Self::read_error)?;
        Ok(vec![
            ("query_file_entries", count_queries),
            ("query_history_entries", count_histories),
            ("grep_query_history_entries", count_grep_histories),
        ])
    }
}

impl LmdbStore for QueryTracker {
    const LABEL: &'static str = "query";
    const MAP_SIZE: usize = 10 * 1024 * 1024;
    const MAX_DBS: u32 = 16;
    const SIZE_CAP_BYTES: u64 = Self::MAP_SIZE as u64;
    fn shared_env(&self) -> &SharedEnv {
        &self.env
    }
}

impl QueryTracker {
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, Error> {
        let env = Self::open_env(db_path.as_ref())?;
        let query_file_db = Self::open_database_safe(&env, Some("query_file_associations"))?;
        let query_history_db = Self::open_database_safe(&env, Some("query_history"))?;
        let grep_query_history_db = Self::open_database_safe(&env, Some("grep_query_history"))?;
        Ok(QueryTracker {
            env,
            query_file_db,
            query_history_db,
            grep_query_history_db,
        })
    }

    fn create_query_key(project_path: &Path, query: &str) -> Result<[u8; 32], Error> {
        let project_str = project_path
            .to_str()
            .ok_or_else(|| Error::InvalidPath(project_path.to_path_buf()))?;
        let mut hasher = blake3::Hasher::default();
        hasher.update(project_str.as_bytes());
        hasher.update(b"::");
        hasher.update(query.as_bytes());
        Ok(*hasher.finalize().as_bytes())
    }

    pub fn get_last_query_entry(
        &self,
        query: &str,
        project_path: &Path,
        min_combo_count: u32,
    ) -> Result<Option<QueryMatchEntry>, Error> {
        let query_key = Self::create_query_key(project_path, query)?;
        let rtxn = self.env.read_txn().map_err(Self::read_txn_error)?;
        let last_match = self
            .query_file_db
            .get(&rtxn, &query_key)
            .map_err(Self::read_error)?;
        Ok(last_match.filter(|entry| entry.open_count >= min_combo_count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_query_tracking() {
        // Preserve association/count protection through the production legacy
        // reader. Completion/history writing is no longer a supported API.
        let temp = tempfile::tempdir().unwrap();
        let tracker = QueryTracker::open(temp.path()).unwrap();
        let project_path = Path::new("/test/project");
        let file_path = PathBuf::from("/test/project/src/main.rs");
        let key = QueryTracker::create_query_key(project_path, "main").unwrap();
        for count in [1, 3] {
            let mut txn = tracker.env.write_txn().unwrap();
            tracker
                .query_file_db
                .put(
                    &mut txn,
                    &key,
                    &QueryMatchEntry {
                        file_path: file_path.clone(),
                        open_count: count,
                        last_opened: 123,
                    },
                )
                .unwrap();
            txn.commit().unwrap();
            let entry = tracker
                .get_last_query_entry("main", project_path, 2)
                .unwrap();
            if count == 1 {
                assert!(entry.is_none(), "first selection should not boost");
            } else {
                let entry = entry.unwrap();
                assert_eq!(entry.file_path, file_path);
                assert_eq!(entry.open_count, 3);
                assert_eq!(entry.last_opened, 123);
            }
        }
    }

    #[test]
    fn test_hashing_functions() {
        let project_path = PathBuf::from("/test/project");
        let query_key1 = QueryTracker::create_query_key(&project_path, "test").unwrap();
        let query_key2 = QueryTracker::create_query_key(&project_path, "test").unwrap();
        assert_eq!(
            query_key1, query_key2,
            "Same project+query should hash to same key"
        );
        let query_key3 = QueryTracker::create_query_key(&project_path, "different").unwrap();
        assert_ne!(
            query_key1, query_key3,
            "Different queries should hash to different keys"
        );
        let other_project = PathBuf::from("/other/project");
        let query_key4 = QueryTracker::create_query_key(&other_project, "test").unwrap();
        assert_ne!(
            query_key1, query_key4,
            "Different projects should hash to different keys"
        );
    }
}
