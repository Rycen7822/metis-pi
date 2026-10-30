//! Prepared assets only: acquisition/verification is separate from corpus quota.
//! The installed catalog is trusted like the runtime binary, never fetched from
//! the model server. A runtime/catalog identifies one immutable artifact set.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::OnceCell;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use super::Result;
mod temporary;
use temporary::Temporary;

const TEXT_REVISION: &str = "c18167b8f244c1bc6de21ce9b710bac8a29c4615";
const CODE_REVISION: &str = "4bcdf5ed93f791259eb130b577a240f753d68dd8";
const TEXT_FILES: &[&str] = &["manifest.json", "tokenizer.json", "bekko128.pack"];
const CODE_FILES: &[&str] = &[
    "manifest.json",
    "tokenizer.json",
    "embedding_preln_f16.pack",
    "backbone.ort",
];

pub struct Cache {
    models: PathBuf,
    runtime: PathBuf,
    catalog: OnceCell<Result<Catalog>>,
    resolved: [OnceCell<Result<PathBuf>>; 2],
    _temporary: Option<Temporary>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    format_version: u32,
    repository: String,
    revision: String,
    models: BTreeMap<String, ModelAssets>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelAssets {
    revision: String,
    files: BTreeMap<String, Asset>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    bytes: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize, PartialEq)]
struct Receipt {
    format_version: u32,
    files: BTreeMap<String, VerifiedFile>,
}

#[derive(Serialize, Deserialize, PartialEq)]
struct VerifiedFile {
    bytes: u64,
    sha256: String,
    device: u64,
    inode: u64,
    modified_seconds: i64,
    modified_nanos: i64,
    changed_seconds: i64,
    changed_nanos: i64,
}

pub fn offline() -> bool {
    matches!(
        std::env::var("HF_HUB_OFFLINE")
            .unwrap_or_default()
            .to_uppercase()
            .as_str(),
        "1" | "TRUE" | "YES" | "ON"
    )
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl Catalog {
    fn open(path: &Path) -> Result<Self> {
        let file = File::open(path).map_err(|e| format!(
            "ASSET_CATALOG_MISSING: approved prepared-asset catalog {}: {e}; prepare/install the CPU runtime bundle first", path.display()))?;
        if file.metadata()?.len() > 64 << 10 {
            return Err("ARTIFACT_MISMATCH: oversized asset catalog".into());
        }
        let catalog: Self = serde_json::from_reader(BufReader::new(file))?;
        let parts: Vec<_> = catalog.repository.split('/').collect();
        if catalog.format_version != 1
            || !hex(&catalog.revision, 40)
            || parts.len() != 2
            || parts
                .iter()
                .any(|p| p.is_empty() || *p == "." || *p == "..")
            || !catalog
                .repository
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
            || catalog.models.len() != 2
        {
            return Err("ARTIFACT_MISMATCH: invalid prepared-asset catalog".into());
        }
        for (name, revision, files) in [
            ("bekko128", TEXT_REVISION, TEXT_FILES),
            ("lateon-edge", CODE_REVISION, CODE_FILES),
        ] {
            let entry = catalog
                .models
                .get(name)
                .ok_or("ARTIFACT_MISMATCH: missing model catalog entry")?;
            if entry.revision != revision
                || entry.files.len() != files.len()
                || files.iter().any(|file| !entry.files.contains_key(*file))
                || entry
                    .files
                    .values()
                    .any(|a| a.bytes == 0 || a.bytes > 256 << 20 || !hex(&a.sha256, 64))
            {
                return Err("ARTIFACT_MISMATCH: unapproved model or file set".into());
            }
        }
        Ok(catalog)
    }
}

impl Cache {
    pub fn new(directory: Option<&Path>, refresh: bool) -> Result<Self> {
        if refresh && offline() {
            return Err("--fresh-assets requires downloads; unset HF_HUB_OFFLINE first".into());
        }
        let runtime = if let Some(root) = std::env::var_os("SGREP_RUNTIME_DIR") {
            PathBuf::from(root)
        } else {
            std::env::current_exe()?
                .parent()
                .and_then(Path::parent)
                .ok_or("could not locate runtime directory")?
                .to_path_buf()
        };
        // Fresh acquisition has its own model AND parser namespace and never
        // repairs or mutates the caller's normal installed/cache assets.
        let temporary = refresh
            .then(|| Temporary::new(&std::env::temp_dir(), "sgrep-refresh"))
            .transpose()?;
        let directory = temporary.as_ref().map(|t| t.path()).or(directory);
        if let Some(directory) = directory {
            tree_sitter_language_pack::configure(&tree_sitter_language_pack::PackConfig {
                cache_dir: Some(directory.to_path_buf()),
                ..Default::default()
            })?;
        }
        let models = directory
            .map(|d| d.join("models"))
            .unwrap_or_else(|| runtime.join("models"));
        Ok(Self {
            models,
            runtime,
            catalog: OnceCell::new(),
            resolved: std::array::from_fn(|_| OnceCell::new()),
            _temporary: temporary,
        })
    }

    pub fn native_library(&self) -> PathBuf {
        self.runtime.join("lib/libsgrep_cpu.so")
    }

    pub fn model_directory(&self, model: &str) -> Result<PathBuf> {
        let slot = match model {
            "bekko128" => 0,
            "lateon-edge" => 1,
            _ => return Err("ARTIFACT_MISMATCH: unknown prepared model".into()),
        };
        // One query keeps one verified immutable asset snapshot, including when
        // the index writer asks for its artifact identity after session creation.
        self.resolved[slot]
            .get_or_init(|| self.resolve(model))
            .as_ref()
            .map(Clone::clone)
            .map_err(|e| e.to_string().into())
    }

    fn resolve(&self, model: &str) -> Result<PathBuf> {
        let catalog = self
            .catalog
            .get_or_init(|| Catalog::open(&self.runtime.join("assets.json")))
            .as_ref()
            .map_err(|e| e.to_string())?;
        let assets = &catalog.models[model];
        let directory = self.models.join(model);
        Temporary::reap(&self.models, &format!("sgrep-assets-{model}"))?;
        if verified(&directory, assets)? {
            return Ok(directory.canonicalize()?);
        }
        if offline() {
            return Err(format!("ASSET_MISSING_OR_CORRUPT: prepared {model} at {} is not cached or failed integrity verification; offline acquisition is disabled", directory.display()).into());
        }
        fs::create_dir_all(&self.models)?;
        let lock = File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.models.join(format!(".{model}.assets.lock")))?;
        lock.lock()?;
        if verified(&directory, assets)? {
            return Ok(directory.canonicalize()?);
        }
        fs::create_dir_all(&directory)?;
        // A private Hub cache guarantees real fresh acquisition, avoids trusting
        // a damaged shared blob and is removed on every ordinary error path.
        let transaction = Temporary::new(&self.models, &format!("sgrep-assets-{model}"))?;
        let api = hf_hub::api::sync::ApiBuilder::from_env()
            .with_cache_dir(transaction.path().join("hub"))
            .with_progress(false)
            .build()?;
        let repository = api.repo(hf_hub::Repo::with_revision(
            catalog.repository.clone(),
            hf_hub::RepoType::Model,
            catalog.revision.clone(),
        ));
        // Each name always has the same pinned content in this runtime catalog.
        // Repair by atomic FILE replacement, never truncate a live mapped inode.
        // The manifest and verification receipt are published last.
        for name in assets
            .files
            .keys()
            .map(String::as_str)
            .filter(|n| *n != "manifest.json")
            .chain(std::iter::once("manifest.json"))
        {
            let asset = &assets.files[name];
            if file_matches(&directory.join(name), asset)? {
                continue;
            }
            let downloaded = repository.download(&format!("{model}/{name}"))?;
            publish(&downloaded, &directory.join(name), asset)?;
        }
        if !verified(&directory, assets)? {
            return Err(
                "ARTIFACT_MISMATCH: prepared assets failed integrity verification after download"
                    .into(),
            );
        }
        File::open(&directory)?.sync_all()?;
        Ok(directory.canonicalize()?)
    }
}

fn identity(path: &Path, asset: &Asset) -> Result<Option<VerifiedFile>> {
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file() || metadata.len() != asset.bytes {
        return Ok(None);
    }
    Ok(Some(VerifiedFile {
        bytes: asset.bytes,
        sha256: asset.sha256.clone(),
        device: metadata.dev(),
        inode: metadata.ino(),
        modified_seconds: metadata.mtime(),
        modified_nanos: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanos: metadata.ctime_nsec(),
    }))
}

fn snapshot(directory: &Path, assets: &ModelAssets) -> Result<Option<Receipt>> {
    let mut files = BTreeMap::new();
    for (name, asset) in &assets.files {
        let Some(value) = identity(&directory.join(name), asset)? else {
            return Ok(None);
        };
        files.insert(name.clone(), value);
    }
    Ok(Some(Receipt {
        format_version: 1,
        files,
    }))
}

fn file_matches(path: &Path, asset: &Asset) -> Result<bool> {
    if identity(path, asset)?.is_none() {
        return Ok(false);
    }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 << 10];
    let mut bytes = 0;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > asset.bytes {
            return Ok(false);
        }
        digest.update(&buffer[..count]);
    }
    let checksum: String = digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(bytes == asset.bytes && checksum == asset.sha256)
}

fn verified(directory: &Path, assets: &ModelAssets) -> Result<bool> {
    let Some(before) = snapshot(directory, assets)? else {
        return Ok(false);
    };
    let receipt = File::open(directory.join(".verified.json"))
        .ok()
        .and_then(|file| {
            serde_json::from_reader::<_, Receipt>(BufReader::new(file.take(64 << 10))).ok()
        });
    if receipt.as_ref() == Some(&before) {
        return Ok(true);
    }
    for (name, asset) in &assets.files {
        if !file_matches(&directory.join(name), asset)? {
            return Ok(false);
        }
    }
    if snapshot(directory, assets)?.as_ref() != Some(&before) {
        return Err("ASSET_CHANGED: prepared assets changed during integrity verification".into());
    }
    // Receipt caching is optional on read-only installations. Verified bytes
    // remain usable, but missing receipts mean revalidation next invocation.
    let _ = write_receipt(directory, &before);
    Ok(true)
}

fn write_receipt(directory: &Path, receipt: &Receipt) -> Result<()> {
    let mut temporary = tempfile::Builder::new()
        .prefix(".verify-")
        .tempfile_in(directory)?;
    serde_json::to_writer(&mut temporary, receipt)?;
    temporary.as_file().sync_all()?;
    temporary.persist(directory.join(".verified.json"))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

fn publish(source: &Path, target: &Path, asset: &Asset) -> Result<()> {
    let mut input = File::open(source)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".download-")
        .tempfile_in(target.parent().ok_or("asset target has no parent")?)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 << 10];
    let mut bytes = 0;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > asset.bytes {
            return Err("ARTIFACT_MISMATCH: oversized downloaded asset".into());
        }
        digest.update(&buffer[..count]);
        temporary.write_all(&buffer[..count])?;
    }
    let checksum: String = digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if bytes != asset.bytes || checksum != asset.sha256 {
        return Err("ARTIFACT_MISMATCH: downloaded asset failed integrity verification".into());
    }
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o444))?;
    temporary.as_file().sync_all()?;
    temporary.persist(target)?;
    Ok(())
}
