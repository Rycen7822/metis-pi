use super::db_healthcheck::DbHealthChecker;
use super::env_pool::SharedEnv;
use crate::error::{Error, Result};
use crate::git::is_modified_status;
use crate::lmdb::{LmdbStore, is_map_full};
use heed::Database;
use heed::types::{Bytes, SerdeBincode};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{collections::VecDeque, path::Path};

const SECONDS_PER_DAY: f64 = 86400.0;
const MAX_HISTORY_DAYS: f64 = 30.0; // Only consider accesses within 30 days
const MAX_TIMESTAMPS_PER_FILE: usize = 128;

// AI mode: faster decay since AI sessions are shorter and more intense
const AI_DECAY_CONSTANT: f64 = 0.231; // ln(2)/3 for 3-day half-life
const AI_MAX_HISTORY_DAYS: f64 = 7.0; // Only consider accesses within 7 days

#[derive(Debug)]
pub struct FrecencyTracker {
    env: SharedEnv,
    db: Database<Bytes, SerdeBincode<VecDeque<u64>>>,
}

// AI mode: compressed thresholds since AI edits happen in rapid bursts
const AI_MODIFICATION_THRESHOLDS: [(i64, u64); 5] = [
    (16, 30),         // 30 seconds
    (8, 60 * 5),      // 5 minutes
    (4, 60 * 15),     // 15 minutes
    (2, 60 * 60),     // 1 hour
    (1, 60 * 60 * 4), // 4 hours
];

impl DbHealthChecker for FrecencyTracker {
    fn get_env(&self) -> &heed::Env<heed::WithoutTls> {
        &self.env
    }

    fn is_healthy(&self) -> bool {
        self.env.health().is_healthy()
    }

    fn count_entries(&self) -> Result<Vec<(&'static str, u64)>> {
        let rtxn = self.env.read_txn().map_err(Self::read_txn_error)?;
        let count = self.db.len(&rtxn).map_err(Self::read_error)?;

        Ok(vec![("absolute_frecency_entries", count)])
    }
}

impl LmdbStore for FrecencyTracker {
    const LABEL: &'static str = "frecency";
    // 10 MiB hard ceiling. Owner's db after years of use is ~560 KiB, so this
    // leaves ~18× headroom while capping runaway growth (see GH issue #437).
    const MAP_SIZE: usize = 10 * 1024 * 1024;
    const MAX_DBS: u32 = 0;
    // Refuse new opens above this on-disk cap; never erase existing history.
    // This is an open-time guard, not a recovery mechanism for MDB_MAP_FULL.
    const SIZE_CAP_BYTES: u64 = 12 * 1024 * 1024;

    fn shared_env(&self) -> &SharedEnv {
        &self.env
    }

    fn purge_stale_data(env: &SharedEnv) -> Result<()> {
        let (deleted, pruned) = Self::purge_stale_entries(env)?;
        if deleted > 0 || pruned > 0 {
            tracing::info!(deleted, pruned, "Frecency GC purged entries");
        }

        Ok(())
    }
}

impl FrecencyTracker {
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self> {
        let db_path = db_path.as_ref();
        let env = Self::open_env(db_path)?;

        let db = Self::open_database_safe(&env, None)?;
        Ok(FrecencyTracker { db, env })
    }

    /// Removes entries where all timestamps are older than MAX_HISTORY_DAYS,
    /// and prunes stale timestamps from entries that still have recent ones.
    /// Returns (deleted_count, pruned_count).
    fn purge_stale_entries(env: &SharedEnv) -> Result<(usize, usize)> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let cutoff_time = now.saturating_sub((MAX_HISTORY_DAYS * SECONDS_PER_DAY) as u64);

        let db: Database<Bytes, SerdeBincode<VecDeque<u64>>> = Self::open_database_safe(env, None)?;

        let rtxn = env.read_txn().map_err(Self::read_txn_error)?;
        let mut stale_keys: Vec<Vec<u8>> = Vec::new();

        let iter = db.iter(&rtxn).map_err(Self::read_error)?;
        for result in iter {
            let (key, accesses) = result.map_err(Self::read_error)?;

            // This snapshot selects candidates only, never replacement values.
            if accesses.front().is_none_or(|&ts| ts < cutoff_time) {
                stale_keys.push(key.to_vec());
            }
        }
        drop(rtxn);

        if stale_keys.is_empty() {
            return Ok((0, 0));
        }

        let mut wtxn = env.write_txn().map_err(|source| Error::DbStartWriteTxn {
            db: Self::LABEL,
            source,
        })?;

        let (mut deleted, mut pruned) = (0, 0);
        for key in &stale_keys {
            // A watcher/other process may have committed an access after the
            // read snapshot. Re-decide under LMDB's single-writer transaction.
            let Some(mut accesses) = db.get(&wtxn, key).map_err(Self::read_error)? else {
                continue;
            };
            match accesses.iter().position(|&ts| ts >= cutoff_time) {
                None => {
                    db.delete(&mut wtxn, key).map_err(|source| Error::DbWrite {
                        db: Self::LABEL,
                        source,
                    })?;
                    deleted += 1;
                }
                Some(0) => {}
                Some(start) => {
                    accesses.drain(..start);
                    db.put(&mut wtxn, key, &accesses)
                        .map_err(|source| Error::DbWrite {
                            db: Self::LABEL,
                            source,
                        })?;
                    pruned += 1;
                }
            }
        }
        wtxn.commit().map_err(|source| Error::DbCommit {
            db: Self::LABEL,
            source,
        })?;

        Ok((deleted, pruned))
    }

    fn get_accesses(&self, path: &Path) -> Result<Option<VecDeque<u64>>> {
        let key_hash = Self::path_to_hash_bytes(path)?;

        let rtxn = self.env.read_txn().map_err(Self::read_txn_error)?;
        let result = self.db.get(&rtxn, &key_hash).map_err(Self::read_error)?;
        rtxn.commit().map_err(|source| Error::DbCommit {
            db: Self::LABEL,
            source,
        })?;

        Ok(result)
    }

    fn get_now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn path_to_hash_bytes(path: &Path) -> Result<[u8; 32]> {
        let Some(key) = path.to_str() else {
            return Err(Error::InvalidPath(path.to_path_buf()));
        };

        Ok(*blake3::hash(key.as_bytes()).as_bytes())
    }

    /// Returns seconds since the most recent tracked access, or `None` if the
    /// file has never been tracked.
    pub fn seconds_since_last_access(&self, path: &Path) -> Result<Option<u64>> {
        let accesses = self.get_accesses(path)?;
        let last = accesses.and_then(|a| a.back().copied());
        Ok(last.map(|ts| self.get_now().saturating_sub(ts)))
    }

    // Observe real persisted writes in watcher fixtures without restoring a
    // general SDK inspection API in the shipped library.
    #[cfg(test)]
    pub(crate) fn access_count(&self, path: &Path) -> Result<usize> {
        Ok(self
            .get_accesses(path)?
            .map_or(0, |accesses| accesses.len()))
    }

    pub fn track_access(&self, path: &Path) -> Result<()> {
        let key_hash = Self::path_to_hash_bytes(path)?;
        let mut wtxn = self
            .env
            .write_txn()
            .map_err(|source| Error::DbStartWriteTxn {
                db: Self::LABEL,
                source,
            })?;
        let mut accesses = self
            .db
            .get(&wtxn, &key_hash)
            .map_err(Self::read_error)?
            .unwrap_or_default();

        let now = self.get_now();
        let cutoff_time = now.saturating_sub((MAX_HISTORY_DAYS * SECONDS_PER_DAY) as u64);

        // Drop stale timestamps from the front while also enforcing the
        // per-file cap. Reserves one slot for the `push_back` below.
        while let Some(&front_time) = accesses.front() {
            if front_time < cutoff_time || accesses.len() >= MAX_TIMESTAMPS_PER_FILE {
                accesses.pop_front();
            } else {
                break;
            }
        }

        accesses.push_back(now);
        tracing::debug!(?path, accesses = accesses.len(), "Tracking access");
        if let Err(e) = self.db.put(&mut wtxn, &key_hash, &accesses) {
            if is_map_full(&e) {
                self.env.health().mark_unhealthy("MDB_MAP_FULL on put");
                tracing::error!(
                    ?path,
                    "Frecency DB hit MDB_MAP_FULL; dropping write — existing history is preserved"
                );
                return Ok(());
            }

            return Err(Error::DbWrite {
                db: Self::LABEL,
                source: e,
            });
        }

        wtxn.commit()
            .inspect_err(|e| {
                if is_map_full(e) {
                    self.env.health().mark_unhealthy("MDB_MAP_FULL on commit");
                    tracing::error!(
                        ?path,
                        "Frecency DB hit MDB_MAP_FULL on commit; dropping write"
                    );
                }
            })
            .map_err(|source| Error::DbCommit {
                db: Self::LABEL,
                source,
            })
    }

    pub fn copy_history(&self, from: &Path, to: &Path) -> Result<bool> {
        if from == to {
            return Ok(false);
        }

        let source_key = Self::path_to_hash_bytes(from)?;
        let target_key = Self::path_to_hash_bytes(to)?;
        let mut wtxn = self
            .env
            .write_txn()
            .map_err(|source| Error::DbStartWriteTxn {
                db: Self::LABEL,
                source,
            })?;
        let source = self.db.get(&wtxn, &source_key).map_err(Self::read_error)?;
        let Some(source) = source.filter(|accesses| !accesses.is_empty()) else {
            return Ok(false);
        };
        let target = self.db.get(&wtxn, &target_key).map_err(Self::read_error)?;
        if target.as_ref() == Some(&source) {
            return Ok(false);
        }

        tracing::debug!(
            ?from,
            ?to,
            accesses = source.len(),
            "Copying frecency history"
        );

        if let Err(e) = self.db.put(&mut wtxn, &target_key, &source) {
            if is_map_full(&e) {
                self.env.health().mark_unhealthy("MDB_MAP_FULL");
                tracing::error!(?to, "Frecency DB is full on commit");
                return Ok(false);
            }
            return Err(Error::DbWrite {
                db: Self::LABEL,
                source: e,
            });
        }

        if let Err(e) = wtxn.commit() {
            if is_map_full(&e) {
                self.env.health().mark_unhealthy("MDB_MAP_FULL on commit");
                tracing::error!(?to, "Frecency DB is full on commit");
                return Ok(false);
            }
            return Err(Error::DbCommit {
                db: Self::LABEL,
                source: e,
            });
        }

        Ok(true)
    }

    pub fn get_access_score(&self, file_path: &Path) -> i64 {
        let accesses = self
            .get_accesses(file_path)
            .ok()
            .flatten()
            .unwrap_or_default();

        if accesses.is_empty() {
            return 0;
        }

        let now = self.get_now();
        let mut total_frecency = 0.0;

        let cutoff_time = now.saturating_sub((AI_MAX_HISTORY_DAYS * SECONDS_PER_DAY) as u64);

        for &access_time in accesses.iter().rev() {
            if access_time < cutoff_time {
                break; // All remaining entries are older, stop processing
            }

            let days_ago = (now.saturating_sub(access_time) as f64) / SECONDS_PER_DAY;
            let decay_factor = (-AI_DECAY_CONSTANT * days_ago).exp();
            total_frecency += decay_factor;
        }

        let normalized_frecency = if total_frecency <= 10.0 {
            total_frecency
        } else {
            10.0 + (total_frecency - 10.0).sqrt() // Diminishing: >10 accesses grow slowly
        };

        normalized_frecency.round() as i64
    }

    /// Calculating modification score but only if the file is modified in the current git dir
    pub fn get_modification_score(
        &self,
        modified_time: u64,
        git_status: Option<git2::Status>,
    ) -> i64 {
        let is_modified_git_status = git_status.is_some_and(is_modified_status);
        if !is_modified_git_status {
            return 0;
        }

        let thresholds = &AI_MODIFICATION_THRESHOLDS;

        let now = self.get_now();
        let duration_since = now.saturating_sub(modified_time);

        for i in 0..thresholds.len() {
            let (current_points, current_threshold) = thresholds[i];

            if duration_since <= current_threshold {
                if i == 0 || duration_since == current_threshold {
                    return current_points;
                }

                let (prev_points, prev_threshold) = thresholds[i - 1];

                let time_range = current_threshold - prev_threshold;
                let time_offset = duration_since - prev_threshold;
                let points_diff = prev_points - current_points;

                let interpolated_score =
                    prev_points - (points_diff * time_offset as i64) / time_range as i64;

                return interpolated_score;
            }
        }

        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Hashing is lexical and must not require an existing file, so watcher
    // delete events and raced files never drop their frecency operation.
    #[test]
    fn hashes_nonexistent_path_without_error() {
        let missing = Path::new("/this/path/definitely/does/not/exist/frecency_test_xyz");
        assert!(FrecencyTracker::path_to_hash_bytes(missing).is_ok());
    }

    #[test]
    fn test_frecency_calculation() {
        // Exercise the actual database-backed AI scorer, not the old copied
        // Neovim calculation (which even had a different normalization cap).
        let temp = tempfile::tempdir().unwrap();
        let tracker = FrecencyTracker::open(temp.path()).unwrap();
        let path = temp.path().join("file.rs");
        let key = FrecencyTracker::path_to_hash_bytes(&path).unwrap();
        let now = tracker.get_now();
        let score = |accesses: VecDeque<u64>| {
            let mut txn = tracker.env.write_txn().unwrap();
            tracker.db.put(&mut txn, &key, &accesses).unwrap();
            txn.commit().unwrap();
            tracker.get_access_score(&path)
        };
        assert_eq!(score(VecDeque::new()), 0);
        assert_eq!(score(VecDeque::from([now])), 1);
        let recent = score(VecDeque::from([now - 2 * 86400, now - 86400, now]));
        assert_eq!(recent, 2);
        assert_eq!(score(VecDeque::from([now - 8 * 86400])), 0);
        assert!(recent > score(VecDeque::from([now - 4 * 86400])));
        assert_eq!(score(VecDeque::from(vec![now; 20])), 13);
    }

    #[test]
    fn test_modification_score_interpolation() {
        let temp = tempfile::tempdir().unwrap();
        let tracker = FrecencyTracker::open(temp.path()).unwrap();
        let now = tracker.get_now();
        let git_status = Some(git2::Status::WT_MODIFIED);
        // Same interpolation/truncation contract, fixed to the shipped AI
        // thresholds: 30s, 5m, 15m, 1h, 4h.
        for (age, expected) in [
            (30, 16),
            (90, 15),
            (300, 8),
            (600, 6),
            (900, 4),
            (2700, 3),
            (3600, 2),
            (14300, 2),
            (18000, 0),
        ] {
            assert_eq!(
                tracker.get_modification_score(now - age, git_status),
                expected,
                "age {age}s"
            );
        }
        assert_eq!(tracker.get_modification_score(now - 90, None), 0);
    }
}
