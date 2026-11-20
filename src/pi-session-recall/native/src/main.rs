//! Private per-request worker for the Pi Recall extension. No stdout diagnostics.
use metis_bekko::Encoder;
use metis_session_recall::index::{
    CACHE_SCHEMA, Coverage, GraphPolicy, GraphReport, HybridResult, Index, IndexState, Scope,
};
use rustix::fs::{FlockOperation, Mode, OFlags, flock, openat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder},
    io::{self, BufRead, Read},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, MetadataExt},
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const PROTOCOL: u32 = 1;
const CACHE_BUDGET: u64 = 512 * 1024 * 1024;
const EXACT_HEADROOM: u64 = 16 * 1024 * 1024;
const MAX_REQUEST: u64 = 64 * 1024;
const DB_FILE: &str = "index.sqlite3";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol: u32,
    root: PathBuf,
    cache_base: PathBuf,
    model_dir: Option<PathBuf>,
    graph: Option<GraphSettings>,
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    Search {
        query: String,
        scope: RequestScope,
        #[serde(rename = "refreshMillis")]
        refresh_millis: u64,
    },
    Refresh,
    Maintain {
        config: Option<ConfigProof>,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GraphSettings {
    retention_days: u32,
    min_nodes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigProof {
    file: PathBuf,
    sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum RequestScope {
    All,
    Project { cwd: String },
    Session { path: PathBuf },
    Branch { path: PathBuf, leaf: String },
}

impl RequestScope {
    fn resolve(&self) -> Scope<'_> {
        match self {
            Self::All => Scope::All,
            Self::Project { cwd } => Scope::Project(cwd),
            Self::Session { path } => Scope::Session(path),
            Self::Branch { path, leaf } => Scope::Branch { path, leaf },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    protocol: u32,
    coverage: Coverage,
    results: Option<HybridResult>,
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    graph: Option<GraphReport>,
}

#[derive(Debug)]
struct Deadline;
impl std::error::Error for Deadline {}
impl std::fmt::Display for Deadline {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("Recall indexing budget expired")
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--protocol") {
        println!("{PROTOCOL}");
        return;
    }
    let result = run().and_then(|value| Ok(serde_json::to_string(&value)?));
    match result {
        Ok(wire) => println!("{wire}"),
        Err(error) => {
            eprintln!("Recall worker: {error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<Response> {
    let parent = rustix::process::getppid();
    rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL))?;
    if rustix::process::getppid() != parent {
        return Err("Recall parent exited".into());
    }
    let mut input = String::new();
    io::stdin()
        .lock()
        .take(MAX_REQUEST + 1)
        .read_line(&mut input)?;
    if input.len() as u64 > MAX_REQUEST {
        return Err("Recall request exceeds wire size limit".into());
    }
    let request: Request = serde_json::from_str(&input).map_err(|_| "Malformed Recall request")?;
    if request.protocol != PROTOCOL {
        return Err("Unsupported Recall protocol".into());
    }
    let root = request.root.canonicalize()?;
    let stat = fs::metadata(&root)?;
    if !stat.is_dir() || !request.cache_base.is_absolute() {
        return Err("Recall requires a session directory and an absolute cache directory".into());
    }
    let mut key = Sha256::new();
    key.update(root.as_os_str().as_bytes());
    key.update(stat.dev().to_le_bytes());
    key.update(stat.ino().to_le_bytes());
    let key = hex(&key.finalize());
    let cache = request.cache_base.join(format!("v{CACHE_SCHEMA}-{key}"));
    let now = jiff::Timestamp::now().as_second();
    let graph = request.graph.unwrap_or(GraphSettings {
        retention_days: 15,
        min_nodes: None,
    });
    if graph.retention_days == 0 || graph.min_nodes == Some(0) {
        return Err("Invalid Recall graph policy".into());
    }
    let policy = GraphPolicy {
        now,
        retention_days: graph.retention_days,
        min_nodes: graph.min_nodes,
    };
    if !matches!(request.operation, Operation::Search { .. }) {
        // A separate, low-priority process leaves foreground queries outside maintenance leases.
        rustix::process::nice(10)?;
    }
    if let Operation::Maintain { config } = &request.operation {
        return maintain(&request.cache_base, &root, &cache, policy, config.as_ref());
    }
    let millis = match request.operation {
        Operation::Search { refresh_millis, .. } => refresh_millis.min(750),
        Operation::Refresh => 5_000,
        Operation::Maintain { .. } => unreachable!("maintenance handled above"),
    };
    let mut reason = None;
    let admission = if millis == 0 {
        None
    } else {
        private_dir(&request.cache_base)?;
        let fd = openat(
            rustix::fs::CWD,
            &request.cache_base,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?;
        match flock(&fd, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => {
                let mut remaining = CACHE_BUDGET.saturating_sub(disk_bytes(&request.cache_base)?);
                if remaining < EXACT_HEADROOM && cache.join(DB_FILE).is_file() {
                    Index::open_graph_cache(&root, &cache)?.reclaim_graphs()?;
                    remaining = CACHE_BUDGET.saturating_sub(disk_bytes(&request.cache_base)?);
                }
                if remaining < 1024 * 1024 {
                    reason = Some("disk_budget");
                    None
                } else {
                    private_dir(&cache)?;
                    Some((fd, remaining))
                }
            }
            Err(rustix::io::Errno::WOULDBLOCK) => {
                reason = Some("index_busy");
                None
            }
            Err(error) => return Err(error.into()),
        }
    };
    if admission.is_none() && !cache.join(DB_FILE).is_file() {
        return Ok(Response {
            protocol: PROTOCOL,
            coverage: Coverage::default(),
            results: None,
            reason: Some(reason.unwrap_or("index_not_ready")),
            graph: None,
        });
    }

    let model = request
        .model_dir
        .as_deref()
        .ok_or("Missing Recall model path")?;
    let encoder = Arc::new(Encoder::open(model)?);
    let mut index = Index::open_hybrid(&root, &cache, encoder)?;
    if let Some((_lease, remaining)) = admission {
        index.limit_growth(remaining / 2)?;
        let deadline = Instant::now() + Duration::from_millis(millis);
        if let Err(error) = index.refresh(|| {
            if Instant::now() >= deadline {
                return Err(Deadline.into());
            }
            Ok(())
        }) {
            reason = Some(if error.is::<Deadline>() {
                "index_pending"
            } else if error.downcast_ref::<IndexState>() == Some(&IndexState::SourceChanged) {
                "source_changed"
            } else if error
                .downcast_ref::<rusqlite::Error>()
                .is_some_and(|e| e.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull))
            {
                "disk_budget"
            } else {
                return Err(error);
            });
        }
    }
    let mut coverage = index.coverage()?;
    coverage.complete &= reason.is_none();
    if !coverage.complete && reason.is_none() {
        reason = Some("index_incomplete");
    }
    let results = match request.operation {
        Operation::Search { query, scope, .. } => {
            match index.hybrid_with_graph(&query, scope.resolve(), Some(policy), || Ok(())) {
                Ok(hits) => Some(hits),
                Err(error)
                    if !coverage.complete
                        && error.downcast_ref::<IndexState>()
                            == Some(&IndexState::SourceMissing) =>
                {
                    None
                }
                Err(error) => return Err(error),
            }
        }
        Operation::Refresh | Operation::Maintain { .. } => None,
    };
    if let Some(result) = &results {
        coverage = result.coverage;
        if result.stale_candidates != 0 {
            reason = Some("source_changed");
        }
        coverage.complete &= reason.is_none();
        if !coverage.complete && reason.is_none() {
            reason = Some("index_incomplete");
        }
    }
    Ok(Response {
        protocol: PROTOCOL,
        results,
        coverage,
        reason,
        graph: None,
    })
}

fn maintain(
    base: &Path,
    root: &Path,
    cache: &Path,
    policy: GraphPolicy,
    config: Option<&ConfigProof>,
) -> Result<Response> {
    let mut response = Response {
        protocol: PROTOCOL,
        coverage: Coverage::default(),
        results: None,
        reason: None,
        graph: None,
    };
    if !cache.join(DB_FILE).is_file() {
        response.reason = Some("index_not_ready");
        return Ok(response);
    }
    let lease = openat(
        rustix::fs::CWD,
        base,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    if let Err(error) = flock(&lease, FlockOperation::NonBlockingLockExclusive) {
        if error != rustix::io::Errno::WOULDBLOCK {
            return Err(error.into());
        }
        response.reason = Some("index_busy");
        return Ok(response);
    }
    let mut index = Index::open_graph_cache(root, cache)?;
    let budget = CACHE_BUDGET
        .saturating_sub(disk_bytes(base)?)
        .saturating_sub(EXACT_HEADROOM);
    // Larger daily partitions may take tens of seconds even at low priority.
    let deadline = Instant::now() + Duration::from_secs(60);
    let check = || {
        if Instant::now() >= deadline {
            Err(Deadline.into())
        } else {
            Ok(())
        }
    };
    let verify = || {
        if let Some(proof) = config {
            let observed = match fs::read(&proof.file) {
                Ok(bytes) => Some(hex(&Sha256::digest(bytes))),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if observed != proof.sha256 {
                return Err("Recall graph settings changed during maintenance".into());
            }
        }
        Ok(())
    };
    match index.maintain_graphs(policy, budget, check, verify) {
        Ok(value) => response.graph = Some(value),
        Err(error) if error.is::<Deadline>() => response.reason = Some("graph_pending"),
        Err(error) => return Err(error),
    }
    response.coverage = index.coverage()?;
    Ok(response)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn private_dir(path: &Path) -> Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    let stat = fs::symlink_metadata(path)?;
    if !stat.is_dir() || stat.mode() & 0o077 != 0 {
        return Err("Recall cache directory is not private".into());
    }
    Ok(())
}

fn disk_bytes(dir: &Path) -> Result<u64> {
    let mut dirs = vec![dir.to_path_buf()];
    let mut bytes: u64 = 0;
    while let Some(dir) = dirs.pop() {
        for item in fs::read_dir(dir)? {
            let item = item?;
            let stat = item.path().symlink_metadata()?;
            if stat.is_dir() {
                dirs.push(item.path());
            } else if stat.is_file() {
                bytes = bytes.saturating_add(stat.blocks().saturating_mul(512));
            }
        }
    }
    Ok(bytes)
}
