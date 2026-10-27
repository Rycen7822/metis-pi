use crate::{Chunk, Result, filename, make_chunk};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    data: Value,
}

fn bytes(value: &Value) -> Result<Vec<u8>> {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        Ok(text.as_bytes().to_vec())
    } else if let Some(encoded) = value.get("bytes").and_then(Value::as_str) {
        Ok(STANDARD.decode(encoded)?)
    } else {
        Err("rg JSON requires a text or base64 bytes field".into())
    }
}

struct Group {
    absolute: PathBuf,
    digest: [u8; 32],
    path: String,
    start: usize,
    end: usize,
    content: String,
}

pub fn visit(
    input: &Path,
    scope: &Path,
    mut consume: impl FnMut(PathBuf, [u8; 32], Chunk) -> Result<()>,
) -> Result<()> {
    let reader: Box<dyn BufRead> = if input == Path::new("-") {
        Box::new(io::stdin().lock())
    } else {
        Box::new(io::BufReader::new(std::fs::File::open(input)?))
    };
    let root = if scope.is_dir() {
        scope
    } else {
        scope.parent().unwrap()
    };
    let mut pending: Option<Group> = None;
    let mut source: Option<(PathBuf, crate::corpus::Source)> = None;
    let mut path_cache: Option<(Vec<u8>, PathBuf)> = None;
    for line in reader.lines() {
        let event: Event = serde_json::from_str(&line?)?;
        match event.kind.as_str() {
            "begin" | "end" | "summary" => continue,
            "match" | "context" => {}
            _ => return Err("unrecognized rg JSON event".into()),
        }
        let raw_path = bytes(&event.data["path"])?;
        let path = if let Some((raw, path)) = &path_cache
            && raw == &raw_path
        {
            path.clone()
        } else {
            let path = filename(&raw_path).canonicalize()?;
            path_cache = Some((raw_path, path.clone()));
            path
        };
        if !path.starts_with(root) || (scope.is_file() && path != scope) {
            return Err("rg JSON path is outside the search scope".into());
        }
        let relative = path.strip_prefix(root)?.to_string_lossy().into_owned();
        let start = event.data["line_number"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|&n| n > 0)
            .ok_or("rg JSON requires a positive line_number")?;
        let content = String::from_utf8_lossy(&bytes(&event.data["lines"])?)
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        let count = content.split_inclusive('\n').count();
        let end = start
            .checked_add(count)
            .and_then(|n| n.checked_sub(1))
            .filter(|_| count > 0)
            .ok_or("invalid rg JSON line range")?;
        let adjacent = pending
            .as_ref()
            .is_some_and(|g| g.path == relative && g.end.checked_add(1) == Some(start));
        if !adjacent && let Some(group) = pending.take() {
            consume(
                group.absolute,
                group.digest,
                make_chunk(group.path, group.start, group.end, group.content),
            )?;
        }
        if !source.as_ref().is_some_and(|(p, _)| p == &path) {
            drop(source.take());
            source = Some((path.clone(), crate::corpus::Source::read(&path)?));
        }
        let view = &source.as_ref().unwrap().1;
        if view.binary {
            return Err("rg JSON refers to a binary file".into());
        }
        if end > view.lines() || view.part(start, end)? != content {
            return Err("rg JSON does not match current source; rerun ripgrep".into());
        }
        if adjacent {
            let group = pending.as_mut().unwrap();
            group.end = end;
            group.content.push_str(&content);
        } else {
            pending = Some(Group {
                absolute: path,
                digest: view.digest,
                path: relative,
                start,
                end,
                content,
            });
        }
    }
    if let Some(group) = pending {
        consume(
            group.absolute,
            group.digest,
            make_chunk(group.path, group.start, group.end, group.content),
        )?;
    }
    Ok(())
}
