//! Discover and open sources relative to an authorized directory descriptor.
use crate::Result;
use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, openat, statat};
use std::{
    ffi::OsStr,
    fs::File,
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
};

const READ: OFlags = OFlags::RDONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::NONBLOCK);

pub(super) struct Tree {
    pub path: PathBuf,
    pub dir: File,
}

impl Tree {
    pub fn open(path: &Path) -> Result<Self> {
        let path = path.canonicalize()?;
        let dir = File::from(openat(
            rustix::fs::CWD,
            &path,
            READ | OFlags::DIRECTORY,
            Mode::empty(),
        )?);
        Ok(Self { path, dir })
    }

    pub fn file(&self, path: &Path) -> Result<File> {
        let mut dir = self.dir.try_clone()?;
        let mut components = path.components().peekable();
        while let Some(Component::Normal(name)) = components.next() {
            if components.peek().is_none() {
                let file = File::from(openat(&dir, name, READ, Mode::empty())?);
                if file.metadata()?.is_file() {
                    return Ok(file);
                }
                break;
            }
            if name.as_bytes().ends_with(b"-blobs") {
                break;
            }
            dir = open_directory(&dir, name)?;
        }
        Err("Recall source is not a regular file inside the session root".into())
    }

    // A failed enumeration is not evidence of deletion. Callers only prune on complete walks.
    pub fn files(&self, check: &mut impl FnMut() -> Result<()>) -> Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        let mut dirs = vec![(PathBuf::new(), Dir::read_from(&self.dir)?)];
        while let Some((relative, entries)) = dirs.last_mut() {
            check()?;
            let Some(entry) = entries.next() else {
                dirs.pop();
                continue;
            };
            let entry = entry?;
            let bytes = entry.file_name().to_bytes();
            if matches!(bytes, b"." | b"..") {
                continue;
            }
            let kind = match entry.file_type() {
                FileType::Unknown => FileType::from_raw_mode(
                    statat(entries.fd()?, entry.file_name(), AtFlags::SYMLINK_NOFOLLOW)?.st_mode,
                ),
                kind => kind,
            };
            let name = OsStr::from_bytes(bytes);
            let child = relative.join(name);
            if kind == FileType::Directory && !bytes.ends_with(b"-blobs") {
                let dir = open_directory(entries.fd()?, name)?;
                dirs.push((child, Dir::read_from(dir)?));
            } else if kind == FileType::RegularFile && bytes.ends_with(b".jsonl") {
                files.push(child);
            }
        }
        files.sort_unstable();
        Ok(files)
    }
}

fn open_directory(dir: impl std::os::fd::AsFd, name: &OsStr) -> Result<File> {
    Ok(openat(dir, name, READ | OFlags::DIRECTORY, Mode::empty())?.into())
}
