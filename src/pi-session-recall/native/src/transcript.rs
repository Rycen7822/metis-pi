//! Read-only projection of Pi session files. Root authorization and cache publication belong to the caller.
use crate::Result;
use memchr::memchr;
use serde::Deserialize;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::{self, BufRead, BufReader, Seek, SeekFrom},
    ops::Range,
    os::unix::fs::{FileExt, MetadataExt},
};

// Bound retained input even when a tool result occupies a huge single line.
const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;
const MAX_FRAGMENT_CHARS: usize = 512;

#[derive(Debug, Deserialize)]
pub struct Header {
    pub id: String,
    pub cwd: String,
}

#[derive(Debug)]
pub struct Entry {
    pub id: String,
    pub parent_id: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileId {
    pub device: u64,
    pub inode: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Line {
    pub offset: u64,
    pub len: usize,
    /// False for the snapshot's final line if it has no newline.
    pub terminated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordAnchor {
    pub file: FileId,
    pub line: Line,
    // One proof for every fragment of this line, including entry ID, parent and role.
    pub digest: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FragmentAnchor {
    pub record: RecordAnchor,
    /// String content uses block 0; arrays use the original block index.
    pub block: usize,
    /// UTF-8 byte range in the decoded block, not in the escaped JSON line.
    pub text_bytes: Range<usize>,
}

#[derive(Debug)]
pub struct Record {
    pub entry: Entry,
    pub anchor: RecordAnchor,
    visible: Option<Visible>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gap {
    OversizedRecord,
    InvalidRecord,
}

#[derive(Debug)]
pub enum Event {
    Record(Record),
    Gap { line: Line, reason: Gap },
}

#[derive(Clone, Debug)]
pub(crate) struct Prefix {
    pub end: u64,
    pub digest: [u8; 32],
}

pub struct SessionReader {
    pub header: Header,
    pub(crate) file: FileId,
    snapshot_len: u64,
    input: BufReader<File>,
    offset: u64,
    bytes: Vec<u8>,
    hash: Sha256,
    stable_hash: Sha256,
    stable_end: u64,
}

impl SessionReader {
    /// The file must already have been authorized under the caller's session root.
    pub fn open(file: File, mut check: impl FnMut() -> Result<()>) -> Result<Self> {
        let stat = file.metadata()?;
        if !stat.is_file() {
            return Err("Recall requires a regular JSONL file".into());
        }
        let mut reader = Self {
            header: Header {
                id: String::new(),
                cwd: String::new(),
            },
            file: FileId {
                device: stat.dev(),
                inode: stat.ino(),
            },
            snapshot_len: stat.len(),
            input: BufReader::new(file),
            offset: 0,
            bytes: Vec::new(),
            hash: Sha256::new(),
            stable_hash: Sha256::new(),
            stable_end: 0,
        };
        let Some((_, false)) = reader.read_line(&mut check)? else {
            return Err("Missing or oversized Pi session header".into());
        };
        let header: WireHeader =
            serde_json::from_slice(&reader.bytes).map_err(|_| "Invalid Pi session header")?;
        if header.kind != "session" || header.header.id.is_empty() || header.header.cwd.is_empty() {
            return Err("Invalid Pi session header".into());
        }
        if header.version != Some(3) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Recall requires a v3 Pi session",
            )
            .into());
        }
        reader.header = header.header;
        Ok(reader)
    }

    pub fn next_record(&mut self, mut check: impl FnMut() -> Result<()>) -> Result<Option<Event>> {
        while let Some((line, oversized)) = self.read_line(&mut check)? {
            if oversized {
                return Ok(Some(Event::Gap {
                    line,
                    reason: Gap::OversizedRecord,
                }));
            }
            if self.bytes.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let event = match decode_entry(&self.bytes) {
                Ok((entry, visible)) => Event::Record(Record {
                    entry,
                    anchor: RecordAnchor {
                        file: self.file,
                        line,
                        digest: Sha256::digest(&self.bytes).into(),
                    },
                    visible,
                }),
                Err(_) => Event::Gap {
                    line,
                    reason: Gap::InvalidRecord,
                },
            };
            return Ok(Some(event));
        }
        Ok(None)
    }

    pub(crate) fn prefix(&self) -> Prefix {
        Prefix {
            end: self.stable_end,
            digest: self.stable_hash.clone().finalize().into(),
        }
    }

    /// Verify the complete previously committed prefix before treating the change as an append.
    pub(crate) fn resume(
        &mut self,
        prefix: &Prefix,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<bool> {
        if prefix.end < self.offset || prefix.end > self.snapshot_len {
            return Ok(false);
        }
        let mut hash = Sha256::new();
        let mut offset = 0;
        let mut buffer = [0; 64 * 1024];
        while offset < prefix.end {
            check()?;
            let n = (prefix.end - offset).min(buffer.len() as u64) as usize;
            self.input
                .get_ref()
                .read_exact_at(&mut buffer[..n], offset)?;
            hash.update(&buffer[..n]);
            offset += n as u64;
        }
        if <[u8; 32]>::from(hash.clone().finalize()) != prefix.digest {
            return Ok(false);
        }
        self.input.seek(SeekFrom::Start(offset))?;
        self.offset = offset;
        self.stable_end = offset;
        self.stable_hash = hash.clone();
        self.hash = hash;
        Ok(true)
    }

    /// Reads just the anchored line via positional I/O, without changing the scan cursor.
    /// An append can leave an old anchor valid, but a replacement or changed line cannot.
    pub fn read_fragment(&self, anchor: &FragmentAnchor) -> Result<String> {
        let RecordAnchor { file, line, digest } = anchor.record;
        if self.file != file
            || line.len > MAX_RECORD_BYTES
            || line
                .offset
                .checked_add(line.len as u64)
                .is_none_or(|end| end > self.snapshot_len)
        {
            return Err("Recall fragment is outside this source snapshot".into());
        }
        let mut raw = vec![0; line.len];
        let source = self.input.get_ref();
        source.read_exact_at(&mut raw, line.offset)?;
        if <[u8; 32]>::from(Sha256::digest(&raw)) != digest {
            return Err("Recall source line changed".into());
        }
        // A valid unterminated record may later acquire a newline, but not a suffix on the same line.
        if !line.terminated && source.metadata()?.len() > line.offset + line.len as u64 {
            let mut next = [0];
            source.read_exact_at(&mut next, line.offset + line.len as u64)?;
            if next != [b'\n'] && next != [b'\r'] {
                return Err("Recall source line was extended".into());
            }
            if next == [b'\r'] {
                source.read_exact_at(&mut next, line.offset + line.len as u64 + 1)?;
                if next != [b'\n'] {
                    return Err("Recall source line was extended".into());
                }
            }
        }
        let (_, visible) = decode_entry(&raw).map_err(|_| "Invalid anchored Pi entry")?;
        visible
            .and_then(|content| {
                content
                    .blocks
                    .into_iter()
                    .find(|(index, _)| *index == anchor.block)
                    .and_then(|(_, text)| text.get(anchor.text_bytes.clone()).map(str::to_owned))
            })
            .ok_or_else(|| "Recall text span does not match the anchored line".into())
    }

    fn read_line(
        &mut self,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<Option<(Line, bool)>> {
        self.bytes.clear();
        let start = self.offset;
        let mut oversized = false;
        let terminated = loop {
            check()?;
            let remaining = self.snapshot_len - self.offset;
            if remaining == 0 {
                break false;
            }
            let buffer = self.input.fill_buf()?;
            if buffer.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Pi session was truncated",
                )
                .into());
            }
            let available = &buffer[..remaining.min(buffer.len() as u64) as usize];
            let newline = memchr(b'\n', available);
            let n = newline.map_or(available.len(), |i| i + 1);
            self.hash.update(&available[..n]);
            if !oversized && self.bytes.len() + n <= MAX_RECORD_BYTES {
                self.bytes.extend_from_slice(&available[..n]);
            } else {
                oversized = true;
                if start == 0 {
                    return Err("Oversized Pi session header".into());
                }
                self.bytes.clear();
            }
            self.input.consume(n);
            self.offset += n as u64;
            if newline.is_some() {
                self.stable_end = self.offset;
                self.stable_hash = self.hash.clone();
                break true;
            }
        };
        if self.offset == start {
            return Ok(None);
        }
        Ok(Some((
            Line {
                offset: start,
                len: (self.offset - start).try_into()?,
                terminated,
            },
            oversized,
        )))
    }
}

impl Record {
    pub fn visit_fragments(
        &self,
        mut emit: impl FnMut(Role, FragmentAnchor, &str) -> Result<()>,
    ) -> Result<()> {
        if let Some(visible) = &self.visible {
            for (block, text) in &visible.blocks {
                visit_paragraphs(text, |text_bytes| {
                    let fragment = &text[text_bytes.clone()];
                    let anchor = FragmentAnchor {
                        record: self.anchor,
                        block: *block,
                        text_bytes,
                    };
                    emit(visible.role, anchor, fragment)
                })?;
            }
        }
        Ok(())
    }
}

/// Walks from a specified leaf, never from the physically last row.
/// Lookup must reject absent entries and return None only for an actual root node.
pub fn branch(
    leaf: &str,
    mut parent: impl FnMut(&str) -> Result<Option<String>>,
) -> Result<Vec<String>> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut next = Some(leaf.to_owned());
    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            return Err("Cycle in Pi session branch".into());
        }
        next = parent(&id)?;
        chain.push(id);
    }
    chain.reverse();
    Ok(chain)
}

#[derive(Deserialize)]
struct WireHeader {
    #[serde(rename = "type")]
    kind: String,
    version: Option<u32>,
    #[serde(flatten)]
    header: Header,
}

#[derive(Deserialize)]
struct WireEntry<'a> {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    // Missing and explicit null are different: only null denotes a root.
    #[serde(rename = "parentId", deserialize_with = "Deserialize::deserialize")]
    parent_id: Option<String>,
    #[serde(borrow)]
    timestamp: Option<&'a RawValue>,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Message<'a> {
    role: String,
    #[serde(borrow)]
    content: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Block<'a> {
    #[serde(rename = "type")]
    kind: String,
    #[serde(borrow)]
    text: Option<&'a RawValue>,
}

#[derive(Debug)]
struct Visible {
    role: Role,
    blocks: Vec<(usize, String)>,
}

fn decode_entry(bytes: &[u8]) -> Result<(Entry, Option<Visible>)> {
    let wire: WireEntry<'_> = serde_json::from_slice(bytes)?;
    if wire.id.is_empty() || wire.parent_id.as_deref() == Some("") || wire.kind == "session" {
        return Err("Invalid Pi session tree entry".into());
    }
    let entry = Entry {
        id: wire.id,
        parent_id: wire.parent_id,
        timestamp: wire
            .timestamp
            .and_then(|raw| serde_json::from_str(raw.get()).ok()),
    };
    if wire.kind != "message" {
        return Ok((entry, None));
    }
    let message: Message<'_> =
        serde_json::from_str(wire.message.ok_or("Missing Pi message")?.get())?;
    let role = match message.role.as_str() {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        _ => return Ok((entry, None)),
    };
    let content = message.content.ok_or("Missing Pi message content")?.get();
    let blocks = if content.starts_with('"') {
        vec![(0, serde_json::from_str(content)?)]
    } else {
        let wire: Vec<Block<'_>> = serde_json::from_str(content)?;
        let mut visible = Vec::new();
        for (index, block) in wire.into_iter().enumerate() {
            if block.kind == "text" {
                let text = block.text.ok_or("Missing Pi text block")?;
                visible.push((index, serde_json::from_str(text.get())?));
            }
        }
        visible
    };
    Ok((entry, Some(Visible { role, blocks })))
}

fn visit_paragraphs(text: &str, mut emit: impl FnMut(Range<usize>) -> Result<()>) -> Result<()> {
    let mut paragraph_start = 0;
    let mut line_start = 0;
    for line in text.split_inclusive('\n') {
        if line.trim().is_empty() {
            visit_paragraph(text, paragraph_start..line_start, &mut emit)?;
            paragraph_start = line_start + line.len();
        }
        line_start += line.len();
    }
    visit_paragraph(text, paragraph_start..text.len(), &mut emit)
}

fn visit_paragraph(
    text: &str,
    range: Range<usize>,
    emit: &mut impl FnMut(Range<usize>) -> Result<()>,
) -> Result<()> {
    let mut rest = text[range.clone()].trim_end_matches(['\r', '\n']);
    let mut start = range.start;
    while !rest.is_empty() {
        let n = rest
            .char_indices()
            .nth(MAX_FRAGMENT_CHARS)
            .map_or(rest.len(), |(i, _)| i);
        emit(start..start + n)?;
        start += n;
        rest = &rest[n..];
    }
    Ok(())
}
