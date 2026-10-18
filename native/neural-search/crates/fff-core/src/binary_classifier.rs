//! Binary classification over owned, immutable inputs. Never borrow a live
//! FileItem or hold the picker lock while reading file contents.

use std::io::{Read, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::constants::MAX_FFFILE_SIZE;
use crate::file_picker::is_known_binary_extension;
use crate::types::{BINARY_CLASSIFICATION_CHUNK_SIZE, detect_binary_content};

pub(crate) struct BinaryInput {
    pub(crate) path: PathBuf,
    size: u64,
    known_binary: bool,
}

impl BinaryInput {
    pub(crate) fn new(path: PathBuf, size: u64) -> Self {
        let known_binary = is_known_binary_extension(&path);
        Self {
            path,
            size,
            known_binary,
        }
    }

    /// None means ineligible, cancelled, or unreadable: preserve the old flag.
    pub(crate) fn classify(&self, cancelled: &AtomicBool, chunk: &mut [u8]) -> Option<bool> {
        if cancelled.load(Ordering::Acquire) {
            return None;
        }
        if self.known_binary {
            return Some(true);
        }
        if self.size > MAX_FFFILE_SIZE {
            return None;
        }
        let result = classify_path(&self.path, cancelled, chunk);
        match result {
            Ok(binary) => binary,
            Err(error) => {
                tracing::debug!(path = ?self.path, ?error, "Failed to classify file");
                None
            }
        }
    }
}

fn classify_path(path: &Path, cancelled: &AtomicBool, chunk: &mut [u8]) -> Result<Option<bool>> {
    // Bound growth during the read too, not just the captured indexed size.
    let file = std::fs::File::open(path)?;
    let mut reader = file.take(MAX_FFFILE_SIZE + 1);
    let mut total = 0u64;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Ok(None);
        }
        let n = match reader.read(chunk) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if n == 0 {
            return Ok(Some(false));
        }
        if detect_binary_content(&chunk[..n]) {
            return Ok(Some(true)); // A known answer needs no more IO.
        }
        total += n as u64;
        if total > MAX_FFFILE_SIZE {
            return Ok(None);
        }
    }
}

pub(crate) fn scratch() -> [u8; BINARY_CLASSIFICATION_CHUNK_SIZE] {
    [0; BINARY_CLASSIFICATION_CHUNK_SIZE]
}
