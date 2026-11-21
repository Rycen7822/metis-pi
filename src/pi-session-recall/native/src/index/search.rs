use super::{Index, IndexState, sync::stamp, terms};
use crate::{
    Result,
    transcript::{FileId, FragmentAnchor, Line, RecordAnchor, Role, SessionReader, branch},
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::{
    ffi::OsString,
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Copy)]
pub enum Scope<'a> {
    All,
    Project(&'a str),
    Session(&'a Path),
    Branch { path: &'a Path, leaf: &'a str },
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LexicalHit {
    pub chunk_id: i64,
    pub path: PathBuf,
    pub session_id: String,
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub role: Role,
    pub bm25: f64,
    pub text: String,
}

#[derive(Debug, Default)]
pub struct LexicalResult {
    pub hits: Vec<LexicalHit>,
    pub stale_candidates: usize,
}

impl Index {
    /// Scope paths are relative to this index's authorized root.
    pub fn search(
        &self,
        query: &str,
        scope: Scope<'_>,
        limit: usize,
        mut check: impl FnMut() -> Result<()>,
    ) -> Result<LexicalResult> {
        check()?;
        if query.len() > 8192 || !(1..=200).contains(&limit) {
            return Err("Recall lexical query or result limit exceeds its budget".into());
        }
        let expression = terms::query(query);
        let tx = self.db.unchecked_transaction()?;
        let (project, source, ancestors) = resolve_scope(&tx, scope, &mut check)?;
        if expression.is_empty() {
            return Ok(LexicalResult::default());
        }
        let mut select = tx.prepare(
            "SELECT c.id, s.path, s.session_id, s.cwd, e.id, e.parent, c.role, -bm25(chunks_fts),
                    s.device, s.inode, e.byte_offset, e.byte_len, e.terminated,
                    e.line_digest, c.block, c.text_start, c.text_end, s.observed
             FROM chunks_fts
             JOIN chunks c ON c.id=chunks_fts.rowid
             JOIN sources s ON s.id=c.source
             JOIN entries e ON e.source=c.source AND e.id=c.entry
             WHERE chunks_fts MATCH ?1 AND (?2 IS NULL OR s.cwd=?2)
               AND (?3 IS NULL OR s.id=?3)
               AND (?4 IS NULL OR e.id IN (SELECT value FROM json_each(?4)))
             ORDER BY bm25(chunks_fts), c.id
             LIMIT ?5",
        )?;
        let candidates = select.query_map(
            params![expression, project, source, ancestors, limit],
            Candidate::from_row,
        )?;
        let mut result = LexicalResult::default();
        for candidate in candidates {
            check()?;
            let mut hit = candidate?;
            let text = self.read_candidate(&hit, ancestors.is_some());
            match text {
                Ok(text) => {
                    hit.hit.text = text;
                    result.hits.push(hit.hit);
                }
                Err(_) => result.stale_candidates += 1,
            }
        }
        check()?;
        Ok(result)
    }

    pub(super) fn read_candidate(&self, hit: &Candidate, branch: bool) -> Result<String> {
        let file = self.root.file(&hit.hit.path)?;
        if branch && stamp(&file.metadata()?) != hit.stamp {
            return Err("Recall branch changed since indexing".into());
        }
        let reader = SessionReader::open(file, || Ok(()))?;
        if reader.header.id != hit.hit.session_id || reader.header.cwd != hit.cwd {
            return Err("Recall source header changed".into());
        }
        reader.read_fragment(&hit.anchor)
    }
}

pub(super) type Filter<'a> = (Option<&'a str>, Option<i64>, Option<String>);

pub(super) fn resolve_scope<'a>(
    db: &Connection,
    scope: Scope<'a>,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Filter<'a>> {
    let source = |path: &Path| -> Result<i64> {
        db.query_row(
            "SELECT id FROM sources WHERE path=?1",
            [path.as_os_str().as_bytes()],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| IndexState::SourceMissing.into())
    };
    match scope {
        Scope::All => Ok((None, None, None)),
        Scope::Project(cwd) => Ok((Some(cwd), None, None)),
        Scope::Session(path) => Ok((None, Some(source(path)?), None)),
        Scope::Branch { path, leaf } => {
            let id = source(path)?;
            let mut statement =
                db.prepare("SELECT parent FROM entries WHERE source=?1 AND id=?2")?;
            let ancestors = branch(leaf, |entry| {
                check()?;
                statement
                    .query_row(params![id, entry], |row| row.get(0))
                    .optional()?
                    .ok_or_else(|| "Missing entry in indexed Pi branch".into())
            })?;
            Ok((None, Some(id), Some(serde_json::to_string(&ancestors)?)))
        }
    }
}

pub(super) struct Candidate {
    pub hit: LexicalHit,
    cwd: String,
    pub(super) anchor: FragmentAnchor,
    pub(super) stamp: [u8; 56],
}

impl Candidate {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let role: String = row.get(6)?;
        Ok(Self {
            hit: LexicalHit {
                chunk_id: row.get(0)?,
                path: OsString::from_vec(row.get(1)?).into(),
                session_id: row.get(2)?,
                entry_id: row.get(4)?,
                parent_id: row.get(5)?,
                role: if role == "user" {
                    Role::User
                } else {
                    Role::Assistant
                },
                bm25: row.get(7)?,
                text: String::new(),
            },
            cwd: row.get(3)?,
            anchor: FragmentAnchor {
                record: RecordAnchor {
                    file: FileId {
                        device: row.get::<_, i64>(8)? as u64,
                        inode: row.get::<_, i64>(9)? as u64,
                    },
                    line: Line {
                        offset: row.get(10)?,
                        len: row.get(11)?,
                        terminated: row.get(12)?,
                    },
                    digest: row.get(13)?,
                },
                block: row.get(14)?,
                text_bytes: row.get(15)?..row.get(16)?,
            },
            stamp: row.get(17)?,
        })
    }
}
