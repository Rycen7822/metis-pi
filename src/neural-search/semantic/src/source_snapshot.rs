//! Raw-byte source identity and request-owned, complete filesystem snapshots.
//! Persistence stores this proof; source reconstruction does not depend on cache records.
use crate::{Result, paths::path_from_bytes, request, storage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::Command,
};

// One bounded 64KiB read buffer per lane; never retain file contents here.
const DIGEST_IO_BUFFER_BYTES: usize = 64 * 1024;
// Small scopes stay serial to avoid scoped-thread startup overhead.
const PARALLEL_FILE_THRESHOLD: usize = 128;

pub(crate) fn file_sha256(path: &Path) -> Result<[u8; 32]> {
    file_sha256_with_buffer(path, &mut [0u8; DIGEST_IO_BUFFER_BYTES])
}

fn file_sha256_with_buffer(
    path: &Path,
    block: &mut [u8; DIGEST_IO_BUFFER_BYTES],
) -> Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    loop {
        crate::request::check()?;
        let read = file.read(block)?;
        if read == 0 {
            break;
        }
        digest.update(&block[..read]);
    }
    Ok(digest.finalize().into())
}

#[derive(Debug)]
pub struct SourceChanged;
impl std::fmt::Display for SourceChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SOURCE_CHANGED: source changed during search")
    }
}
impl std::error::Error for SourceChanged {}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceFileDigest {
    // Filesystem identity stays raw; SHA-256 has a fixed 32-byte output.
    pub path: Vec<u8>,
    pub digest: [u8; 32],
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceSnapshot {
    pub scope: Vec<u8>,
    pub files: Vec<SourceFileDigest>,
}
fn capture_partition(root: &Path, files: &[PathBuf]) -> Result<Vec<SourceFileDigest>> {
    let mut stamps = Vec::with_capacity(files.len());
    // Reuse I/O scratch only; each file still has its own fresh digest.
    let mut block = [0u8; DIGEST_IO_BUFFER_BYTES];
    for path in files {
        crate::request::check()?;
        let digest = file_sha256_with_buffer(&root.join(path), &mut block)?;
        stamps.push(SourceFileDigest {
            path: path.as_os_str().as_bytes().to_vec(),
            digest,
        });
    }
    Ok(stamps)
}

fn capture_parallel(root: &Path, files: &[PathBuf]) -> Result<Vec<SourceFileDigest>> {
    let workers = crate::semantic::computing_threads().min(files.len()).max(1);
    if workers == 1 {
        return capture_partition(root, files);
    }
    let parts: Vec<_> = files.chunks(files.len().div_ceil(workers)).collect();
    let context = crate::request::current();
    std::thread::scope(|scope| {
        let jobs: Vec<_> = parts[1..]
            .iter()
            .map(|part| {
                let context = context.clone();
                std::thread::Builder::new()
                    .name("semantic-source".into())
                    .spawn_scoped(scope, move || match context {
                        Some(context) => {
                            crate::request::enter(context, || capture_partition(root, part))
                        }
                        None => capture_partition(root, part),
                    })
            })
            .collect();
        let mut result = capture_partition(root, parts[0]);
        for job in jobs {
            // Join every started worker even if the caller or another worker failed.
            let part = match job {
                Ok(job) => job
                    .join()
                    .unwrap_or_else(|_| Err("source digest worker panicked".into())),
                Err(error) => Err(error.into()),
            };
            result = match (result, part) {
                (Ok(mut stamps), Ok(mut more)) => {
                    stamps.append(&mut more);
                    Ok(stamps)
                }
                (Err(error), _) => Err(error),
                (_, Err(error)) => Err(error),
            };
        }
        result
    })
}

impl SourceSnapshot {
    pub fn capture(scope: &Path, filter: &crate::storage::SourceFilter) -> Result<Self> {
        let (root, files) = discover_files(scope, filter)?;
        // Amortize scoped thread startup without adding a persistent I/O pool.
        let stamps = if files.len() < PARALLEL_FILE_THRESHOLD {
            capture_partition(root, &files)?
        } else {
            capture_parallel(root, &files)?
        };
        Ok(Self {
            scope: scope.as_os_str().as_bytes().to_vec(),
            files: stamps,
        })
    }
    pub fn verify(&self, scope: &Path, filter: &crate::storage::SourceFilter) -> Result<()> {
        crate::request::check()?;
        match Self::capture(scope, filter) {
            Ok(now) if now == *self => Ok(()),
            Ok(_) => Err(SourceChanged.into()),
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|e| e.kind() == io::ErrorKind::NotFound) =>
            {
                Err(SourceChanged.into())
            }
            Err(error) => Err(error),
        }
    }
}

pub(crate) fn discover_files<'a>(
    path: &'a Path,
    filter: &storage::SourceFilter,
) -> Result<(&'a Path, Vec<PathBuf>)> {
    let root = if path.is_dir() {
        path
    } else {
        path.parent().unwrap()
    };
    let mut command = Command::new("rg");
    // File discovery must not create a second CPU pool. The caller also reads
    // stdout, and an existing native pool is asleep during final verification.
    command.args(["--no-config", "--threads", "1", "--files", "-0"]);
    let target = if path.is_dir() {
        Path::new(".")
    } else {
        Path::new(path.file_name().unwrap())
    };
    let result = request::output(command.arg("--").arg(target).current_dir(root))
        .map_err(|e| format!("ripgrep is required: {e}"))?;
    if !matches!(result.status.code(), Some(0 | 1)) {
        return Err(String::from_utf8_lossy(&result.stderr).into_owned().into());
    }
    let mut files: Vec<_> = result
        .stdout
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(path_from_bytes)
        .collect();
    files.retain(|name| !filter.excludes(&root.join(name)));
    files.sort_unstable_by(|a, b| {
        a.as_os_str()
            .as_encoded_bytes()
            .cmp(b.as_os_str().as_encoded_bytes())
    });
    Ok((root, files))
}
