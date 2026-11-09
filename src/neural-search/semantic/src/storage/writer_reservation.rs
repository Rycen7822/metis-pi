//! Durable writer charges. A stable control lock survives atomic JSON replacement.
use super::*;

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct WriterRecord {
    #[serde(flatten)]
    pub charge: InodeCharge,
    pub temp: Vec<u8>,
    pub target: Vec<u8>,
}
pub(super) struct WriterReservation {
    path: PathBuf,
    pub record: WriterRecord,
    pub durable: bool,
    _owner: File,
}
impl WriterReservation {
    pub fn new(
        ledger: &Path,
        temp: &Path,
        target: &Path,
        metadata: &std::fs::Metadata,
    ) -> Result<Self> {
        let process = std::process::id();
        let start_time = process_state(process)?.1;
        let path = ledger.join(format!("writer-{}-{}.json", metadata.dev(), metadata.ino()));
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => return Err("writer reservation already exists".into()),
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path.with_extension("lock"))?;
        lock.try_lock()?;
        Ok(Self {
            path,
            _owner: lock,
            durable: false,
            record: WriterRecord {
                charge: InodeCharge {
                    device: metadata.dev(),
                    inode: metadata.ino(),
                    bytes: 0,
                    process,
                    start_time,
                },
                temp: temp.as_os_str().as_encoded_bytes().to_vec(),
                target: target.as_os_str().as_encoded_bytes().to_vec(),
            },
        })
    }
    pub fn update(&mut self, bytes: u64) -> Result<()> {
        // Build proposed JSON without committing its charge before rename succeeds.
        let previous = self.record.charge.bytes;
        self.record.charge.bytes = bytes;
        let raw = serde_json::to_vec(&self.record);
        self.record.charge.bytes = previous;
        let raw = raw?;
        if raw.len() as u64 > MAX_CHARGE_RECORD {
            return Err("writer reservation record exceeds its bound".into());
        }
        let prefix = format!(
            ".writer-v2-{}-{}-",
            self.record.charge.process, self.record.charge.start_time
        );
        let mut stage = tempfile::Builder::new()
            .prefix(&prefix)
            .rand_bytes(16)
            .suffix(".tmp")
            .tempfile_in(self.path.parent().unwrap())?;
        stage.write_all(&raw)?;
        stage.as_file().sync_all()?;
        stage.persist(&self.path)?;
        // A renamed but unsynced charge is visible, yet cannot fund further allocation.
        self.record.charge.bytes = bytes;
        self.durable = false;
        File::open(self.path.parent().unwrap())?.sync_all()?;
        self.durable = true;
        Ok(())
    }
    pub fn release(&self) -> io::Result<()> {
        for path in [&self.path, &self.path.with_extension("lock")] {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}
pub(super) fn read_record(path: &Path) -> io::Result<WriterRecord> {
    if regular(path)?.len() > MAX_CHARGE_RECORD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid writer reservation record",
        ));
    }
    serde_json::from_reader(open(path, false, false)?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
pub(super) fn protected_targets(roots: &[PathBuf], ledger: &Path) -> Result<Vec<PathBuf>> {
    let mut targets = Vec::new();
    for entry in std::fs::read_dir(ledger)? {
        let entry = entry?;
        let name = entry.file_name();
        if !name.as_encoded_bytes().starts_with(b"writer-")
            || !name.as_encoded_bytes().ends_with(b".json")
        {
            continue;
        }
        let record = match read_record(&entry.path()) {
            Ok(record) => record,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let target = crate::paths::path_from_bytes(&record.target);
        if !roots
            .iter()
            .any(|root| target.parent() == Some(root.as_path()))
        {
            return Err("unregistered writer target".into());
        }
        targets.push(target);
    }
    Ok(targets)
}
pub(super) fn recover(roots: &[PathBuf], ledger: &Path) -> Result<()> {
    for entry in std::fs::read_dir(ledger)? {
        let entry = entry?;
        let name = entry.file_name();
        let path = entry.path();
        let Some(identity) = name
            .to_str()
            .and_then(|s| s.strip_prefix("writer-"))
            .and_then(|s| s.split('.').next())
            .and_then(|s| s.split_once('-'))
        else {
            continue;
        };
        let (Ok(device), Ok(inode)) = (identity.0.parse::<u64>(), identity.1.parse::<u64>()) else {
            continue;
        };
        if name != format!("writer-{device}-{inode}.lock").as_str()
            && name != format!("writer-{device}-{inode}.json").as_str()
        {
            continue;
        }
        if path.extension().is_some_and(|s| s == "lock") {
            if path.with_extension("json").exists() {
                continue;
            }
            let metadata = match regular(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if metadata.len() != 0 || metadata.nlink() != 1 {
                continue;
            }
            let file = open(&path, false, true)?;
            match file.try_lock() {
                Ok(()) => std::fs::remove_file(path)?,
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(error) => return Err(error.into()),
            }
            continue;
        }
        let owner_path = path.with_extension("lock");
        let owner_meta = match regular(&owner_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound && !path.exists() => {
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        if owner_meta.len() != 0 || owner_meta.nlink() != 1 {
            return Err("invalid writer owner lock".into());
        }
        let owner = open(&owner_path, false, true)?;
        match owner.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => continue,
            Err(error) => return Err(error.into()),
        }
        let record = read_record(&path)?;
        if (device, inode) != (record.charge.device, record.charge.inode) {
            return Err("writer identity mismatch".into());
        }
        let temp = crate::paths::path_from_bytes(&record.temp);
        if !temp.file_name().is_some_and(|s| {
            s.as_encoded_bytes().starts_with(b"sgrep-index-")
                && s.as_encoded_bytes().ends_with(b".tmp")
        }) {
            return Err("invalid writer temporary path".into());
        }
        if !roots
            .iter()
            .any(|root| temp.parent() == Some(root.as_path()))
        {
            return Err("unregistered writer temporary root".into());
        }
        let abandoned = match regular(&temp) {
            Ok(metadata) if (metadata.dev(), metadata.ino()) == (device, inode) => {
                let file = open(&temp, false, true)?;
                file.try_lock()?;
                Some(file)
            }
            Ok(_) => None,
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        // The stable owner lock proves the transaction ended, even after target replacement.
        std::fs::remove_file(&path)?;
        std::fs::remove_file(&owner_path)?;
        if abandoned.is_some() {
            drop(abandoned);
            std::fs::remove_file(temp)?;
        }
    }
    Ok(())
}
