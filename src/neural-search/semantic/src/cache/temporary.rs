//! Process-owned asset temporaries. RAII handles ordinary exits; a later caller
//! reaps marked directories only after their exact Linux process instance exits.
//! PID/start-time in the name closes the create-before-marker race without a
//! global registry or a lock file left in the caller's temporary directory.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

const MARKER: &str = ".sgrep-asset-owner.json";

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Owner {
    format_version: u8,
    prefix: String,
    pid: u32,
    start: u64,
}

pub(super) struct Temporary(tempfile::TempDir);

// None means absent/zombie; unreadable or malformed proc state is uncertainty,
// never permission to remove another process's files.
fn process(name: &str) -> Result<Option<(u32, u64)>> {
    let text = match fs::read_to_string(format!("/proc/{name}/stat")) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let (pid, _) = text.split_once(' ').ok_or("invalid proc PID")?;
    let (_, fields) = text.rsplit_once(')').ok_or("invalid proc name")?;
    let fields: Vec<_> = fields.split_whitespace().collect();
    if matches!(fields.first(), Some(&"Z" | &"X")) {
        return Ok(None);
    }
    let start = fields.get(19).ok_or("missing proc start time")?.parse()?;
    Ok(Some((pid.parse()?, start)))
}

impl Temporary {
    pub fn new(parent: &Path, prefix: &str) -> Result<Self> {
        Self::reap(parent, prefix)?;
        let (pid, start) = process("self")?.ok_or("ASSET_STATE: current process is unavailable")?;
        let owner = Owner {
            format_version: 1,
            prefix: prefix.into(),
            pid,
            start,
        };
        let directory = tempfile::Builder::new()
            .prefix(&format!("{prefix}-{pid}-{start}-"))
            .tempdir_in(parent)?;
        let marker = directory.path().join(MARKER);
        fs::write(&marker, serde_json::to_vec(&owner)?)?;
        File::open(marker)?.sync_all()?;
        Ok(Self(directory))
    }

    pub fn path(&self) -> &Path {
        self.0.path()
    }

    pub fn reap(parent: &Path, prefix: &str) -> Result<()> {
        let entries = match fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                return Ok(());
            }
            Err(e) => return Err(e.into()),
        };
        let tag = format!("{prefix}-");
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let Some(rest) = name.to_str().and_then(|name| name.strip_prefix(&tag)) else {
                continue;
            };
            let fields: Vec<_> = rest.split('-').collect();
            if fields.len() != 3
                || fields[2].len() < 6
                || fields[2].len() > 32
                || !fields[2].bytes().all(|b| b.is_ascii_alphanumeric())
            {
                continue;
            }
            let (Ok(pid), Ok(start)) = (fields[0].parse::<u32>(), fields[1].parse::<u64>()) else {
                continue;
            };
            match process(&pid.to_string()) {
                Ok(Some(current)) if current != (pid, start) => {}
                Ok(None) => {}
                _ => continue,
            }
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(value) => value,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
                continue;
            }
            let expected = Owner {
                format_version: 1,
                prefix: prefix.into(),
                pid,
                start,
            };
            let marker_path = path.join(MARKER);
            let marked = fs::symlink_metadata(&marker_path)
                .ok()
                .filter(|m| m.is_file() && m.len() <= 512 && m.uid() == metadata.uid())
                .and_then(|_| File::open(&marker_path).ok())
                .and_then(|file| serde_json::from_reader::<_, Owner>(file.take(512)).ok())
                .is_some_and(|owner| owner == expected);
            let removal = if marked {
                fs::remove_dir_all(&path)
            } else {
                // Interrupted construction can leave an empty directory. Never
                // recursively delete unmarked payload or legacy unknown names.
                fs::remove_dir(&path)
            };
            if let Err(error) = removal {
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::DirectoryNotEmpty
                        | std::io::ErrorKind::PermissionDenied
                ) {
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }
}
