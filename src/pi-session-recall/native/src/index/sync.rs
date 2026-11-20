use super::{Index, IndexState, terms, tree::Tree};
use crate::{
    Result,
    transcript::{
        Entry, Event, FileId, FragmentAnchor, Prefix, Record, RecordAnchor, Role, SessionReader,
    },
};
use jiff::Timestamp;
use metis_bekko::{DOCUMENT_BYTES, Document, Encoder};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use rustix::fs::{FlockOperation, Mode, OFlags, flock, openat};
use std::{
    collections::HashSet,
    fs::Metadata,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
};

const BATCH_RECORDS: usize = 128;
const BATCH_SOURCE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Default)]
pub struct RefreshReport {
    pub files: usize,
    pub gaps: Vec<(PathBuf, CoverageGap)>,
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub indexed_sources: usize,
    pub pending_sources: usize,
    pub incomplete_sources: usize,
    pub complete: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CoverageGap {
    Unavailable,
    UnsupportedHeader,
    SkippedRecords(usize),
}

impl Index {
    pub fn refresh(&mut self, mut check: impl FnMut() -> Result<()>) -> Result<RefreshReport> {
        if self.graph_only {
            return Err("A graph-maintenance handle cannot index session text".into());
        }
        check()?;
        // Lock the cache directory on a fresh open-file description. Reads never take this lock.
        let guard = openat(
            &self.cache_dir,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        flock(&guard, FlockOperation::NonBlockingLockExclusive)?;
        // A failed walk must not leave a previous "complete" claim or prune its unseen files.
        self.db.execute("DELETE FROM refresh_state", [])?;
        let files = self.root.files(&mut check)?;
        self.db
            .execute("INSERT INTO refresh_state VALUES(1,?1,0,0)", [files.len()])?;
        self.remove_missing(&files, &mut check)?;
        let mut report = RefreshReport {
            files: files.len(),
            gaps: Vec::new(),
        };
        for path in files {
            check()?;
            let gap = self.refresh_file(&path, &mut check)?;
            self.db.execute(
                "UPDATE refresh_state SET processed=processed+1,incomplete=incomplete+?1",
                [gap.is_some()],
            )?;
            if let Some(gap) = gap {
                report.gaps.push((path, gap));
            }
        }
        Ok(report)
    }

    pub fn coverage(&self) -> Result<Coverage> {
        Self::read_coverage(&self.db)
    }

    pub(super) fn read_coverage(db: &Connection) -> Result<Coverage> {
        Ok(db
            .query_row(
                "SELECT total,processed,incomplete FROM refresh_state",
                [],
                |row| {
                    let total: usize = row.get(0)?;
                    let processed: usize = row.get(1)?;
                    let incomplete_sources: usize = row.get(2)?;
                    let pending_sources = total.saturating_sub(processed);
                    Ok(Coverage {
                        indexed_sources: processed.saturating_sub(incomplete_sources),
                        pending_sources,
                        incomplete_sources,
                        complete: pending_sources == 0 && incomplete_sources == 0,
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }

    fn remove_missing(
        &mut self,
        files: &[PathBuf],
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let present: HashSet<_> = files.iter().map(|p| p.as_os_str().as_bytes()).collect();
        let mut select = self.db.prepare("SELECT id, path FROM sources")?;
        let rows = select.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut missing = Vec::new();
        for row in rows {
            check()?;
            let (id, path) = row?;
            if !present.contains(path.as_slice()) {
                missing.push(id);
            }
        }
        drop(select);
        for batch in missing.chunks(BATCH_RECORDS) {
            let tx = self
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            for id in batch {
                check()?;
                tx.execute("DELETE FROM sources WHERE id=?1", [id])?;
            }
            tx.commit()?;
        }
        Ok(())
    }

    fn refresh_file(
        &mut self,
        path: &Path,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<Option<CoverageGap>> {
        let path_key = path.as_os_str().as_bytes();
        let file = match self.root.file(path) {
            Ok(file) => file,
            Err(_) => {
                self.db
                    .execute("DELETE FROM sources WHERE path=?1", [path_key])?;
                return Ok(Some(CoverageGap::Unavailable));
            }
        };
        let stamp = stamp(&file.metadata()?);
        let previous = previous(&self.db, path_key)?;
        if let Some(state) = &previous
            && state.finished
            && state.observed.as_slice() == stamp
        {
            return Ok((state.gaps + state.tail_gap > 0)
                .then_some(CoverageGap::SkippedRecords(state.gaps + state.tail_gap)));
        }
        // Header parsing reads at most one bounded record; check cancellation separately
        // so a cancelled request is not classified as an invalid file.
        let mut reader = match SessionReader::open(file, || Ok(())) {
            Ok(reader) => reader,
            Err(_) => {
                check()?;
                verify_stamp(&self.root, path, &stamp)?;
                self.db
                    .execute("DELETE FROM sources WHERE path=?1", [path_key])?;
                return Ok(Some(CoverageGap::UnsupportedHeader));
            }
        };
        let mut scan = Scan {
            path,
            stamp,
            reader: &mut reader,
            source: None,
            clear_tail: false,
            gaps: 0,
            tail_gap: 0,
        };
        if let Some(state) = previous
            && scan.reader.file == state.file
            && scan.reader.resume(&state.prefix, check)?
        {
            scan.source = Some(state.id);
            scan.clear_tail = true;
            scan.gaps = state.gaps;
        }
        loop {
            let mut records = Vec::new();
            let mut bytes = 0usize;
            let mut finished = false;
            for _ in 0..BATCH_RECORDS {
                match scan.reader.next_record(&mut *check)? {
                    Some(Event::Record(record)) => {
                        bytes = bytes.saturating_add(record.anchor.line.len);
                        records.push(Prepared::new(record, self.encoder.as_deref(), check)?);
                    }
                    Some(Event::Gap { line, .. }) => {
                        if line.terminated {
                            scan.gaps += 1;
                        } else {
                            scan.tail_gap = 1;
                        }
                        bytes = bytes.saturating_add(line.len);
                    }
                    None => {
                        finished = true;
                        break;
                    }
                }
                if bytes >= BATCH_SOURCE_BYTES {
                    break;
                }
            }
            scan.publish(&self.root, &mut self.db, records, finished, check)?;
            if finished {
                let skipped = scan.gaps + scan.tail_gap;
                return Ok((skipped > 0).then_some(CoverageGap::SkippedRecords(skipped)));
            }
        }
    }
}

struct SourceState {
    id: i64,
    file: FileId,
    prefix: Prefix,
    gaps: usize,
    tail_gap: usize,
    observed: [u8; 56],
    finished: bool,
}

fn previous(db: &Connection, path: &[u8]) -> Result<Option<SourceState>> {
    Ok(db.query_row(
        "SELECT id, device, inode, cursor, prefix_digest, gaps, tail_gap, observed, finished FROM sources WHERE path=?1",
        [path],
        |row| Ok(SourceState {
            id: row.get(0)?,
            file: FileId { device: row.get::<_, i64>(1)? as u64, inode: row.get::<_, i64>(2)? as u64 },
            prefix: Prefix { end: row.get(3)?, digest: row.get(4)? },
            gaps: row.get(5)?,
            tail_gap: row.get(6)?,
            observed: row.get(7)?,
            finished: row.get(8)?,
        }),
    ).optional()?)
}

pub(super) fn stamp(stat: &Metadata) -> [u8; 56] {
    let values = [
        stat.dev(),
        stat.ino(),
        stat.len(),
        stat.mtime() as u64,
        stat.mtime_nsec() as u64,
        stat.ctime() as u64,
        stat.ctime_nsec() as u64,
    ];
    let mut bytes = [0; 56];
    for (to, value) in bytes.chunks_exact_mut(8).zip(values) {
        to.copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn verify_stamp(root: &Tree, path: &Path, expected: &[u8; 56]) -> Result<()> {
    let current = root
        .file(path)
        .and_then(|file| Ok(stamp(&file.metadata()?)));
    if !current.is_ok_and(|value| &value == expected) {
        return Err(IndexState::SourceChanged.into());
    }
    Ok(())
}

struct Scan<'a> {
    path: &'a Path,
    stamp: [u8; 56],
    reader: &'a mut SessionReader,
    source: Option<i64>,
    clear_tail: bool,
    gaps: usize,
    tail_gap: usize,
}

impl Scan<'_> {
    fn publish(
        &mut self,
        root: &Tree,
        db: &mut Connection,
        records: Vec<Prepared>,
        finished: bool,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        check()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prefix = self.reader.prefix();
        let source = if let Some(id) = self.source {
            if self.clear_tail {
                // The prior snapshot could index a valid final record without a newline.
                // Replace it from its original offset without moving the durable prefix past it.
                tx.execute(
                    "DELETE FROM entries WHERE source=?1 AND byte_offset >= (SELECT cursor FROM sources WHERE id=?1)",
                    [id],
                )?;
            }
            id
        } else {
            let path = self.path.as_os_str().as_bytes();
            let FileId { device, inode } = self.reader.file;
            tx.execute("DELETE FROM sources WHERE path=?1", [path])?;
            tx.execute(
                "INSERT INTO sources(path,session_id,cwd,device,inode,cursor,prefix_digest,gaps,observed,finished)
                 VALUES(?,?,?,?,?,?,?,?,?,0)",
                params![path, self.reader.header.id, self.reader.header.cwd, device as i64, inode as i64,
                    prefix.end, prefix.digest.as_slice(), self.gaps, self.stamp.as_slice()],
            )?;
            tx.last_insert_rowid()
        };
        let indexed_at = Timestamp::now().as_second();
        for record in records {
            check()?;
            record.insert(&tx, source, indexed_at, check)?;
        }
        tx.execute(
            "UPDATE sources SET cursor=?,prefix_digest=?,gaps=?,tail_gap=?,observed=?,finished=? WHERE id=?",
            params![prefix.end, prefix.digest.as_slice(), self.gaps, self.tail_gap, self.stamp.as_slice(), finished, source],
        )?;
        check()?;
        verify_stamp(root, self.path, &self.stamp)?;
        tx.commit()?;
        self.source = Some(source);
        self.clear_tail = false;
        Ok(())
    }
}

struct Prepared {
    entry: Entry,
    anchor: RecordAnchor,
    chunks: Vec<PreparedChunk>,
}

struct PreparedChunk {
    role: Role,
    anchor: FragmentAnchor,
    terms: String,
    vector: Option<[u8; DOCUMENT_BYTES]>,
}

impl Prepared {
    fn new(
        record: Record,
        encoder: Option<&Encoder>,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<Self> {
        let mut chunks = Vec::new();
        record.visit_fragments(|role, anchor, text| {
            check()?;
            let vector = match encoder {
                Some(encoder) => {
                    Some(Document::from_normalized(&encoder.encode(text)?.0).to_bytes())
                }
                None => None,
            };
            chunks.push(PreparedChunk {
                role,
                anchor,
                terms: terms::index(text),
                vector,
            });
            Ok(())
        })?;
        Ok(Self {
            entry: record.entry,
            anchor: record.anchor,
            chunks,
        })
    }

    fn insert(
        self,
        tx: &Connection,
        source: i64,
        indexed_at: i64,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let day = self
            .entry
            .timestamp
            .as_deref()
            .and_then(|text| text.parse::<Timestamp>().ok())
            .map(|timestamp| timestamp.as_second())
            .filter(|at| *at <= indexed_at)
            .map(|at| at.div_euclid(86_400));
        let line = self.anchor.line;
        tx.prepare_cached("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?)")?
            .execute(params![
                source,
                self.entry.id,
                self.entry.parent_id,
                self.entry.timestamp,
                line.offset,
                line.len,
                line.terminated,
                self.anchor.digest.as_slice(),
            ])?;
        let mut insert_chunk = tx.prepare_cached(
            "INSERT INTO chunks(source,entry,role,block,text_start,text_end) VALUES(?,?,?,?,?,?)",
        )?;
        let mut insert_terms =
            tx.prepare_cached("INSERT INTO chunks_fts(rowid,terms) VALUES(?,?)")?;
        let mut insert_vector =
            tx.prepare_cached("INSERT INTO vectors(chunk,payload,indexed_at,day) VALUES(?,?,?,?)")?;
        for PreparedChunk {
            role,
            anchor,
            terms,
            vector,
        } in self.chunks
        {
            check()?;
            let role = match role {
                Role::User => "user",
                Role::Assistant => "assistant",
            };
            insert_chunk.execute(params![
                source,
                self.entry.id,
                role,
                anchor.block,
                anchor.text_bytes.start,
                anchor.text_bytes.end,
            ])?;
            let id = tx.last_insert_rowid();
            insert_terms.execute(params![id, terms])?;
            if let Some(vector) = vector {
                insert_vector.execute(params![id, vector.as_slice(), indexed_at, day])?;
            }
        }
        Ok(())
    }
}
