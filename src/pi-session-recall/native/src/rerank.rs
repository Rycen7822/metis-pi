use crate::Result;
use metis_session_recall::index::{EnhancedCenter, EnhancedSelection};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reranker {
    pub potion_dir: PathBuf,
    pub model_dir: PathBuf,
    pub python: PathBuf,
    pub script: PathBuf,
}

#[derive(Debug)]
pub struct InputLimit;
impl std::error::Error for InputLimit {}
impl std::fmt::Display for InputLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Recall reranker input exceeds 1024 tokens")
    }
}

#[derive(Serialize)]
struct Request<'a> {
    query: &'a str,
    reference: &'a [&'a EnhancedCenter],
    wide: &'a [&'a EnhancedCenter],
}

impl Reranker {
    pub fn rank(
        &self,
        query: &str,
        reference: &[&EnhancedCenter],
        wide: &[&EnhancedCenter],
    ) -> Result<EnhancedSelection> {
        let mut request = serde_json::to_vec(&Request {
            query,
            reference,
            wide,
        })?;
        const WIRE_LIMIT: usize = 1024 * 1024;
        if request.len() >= WIRE_LIMIT {
            return Err("Recall reranker wire limit exceeded".into());
        }
        request.push(b'\n');
        if ![
            &self.python,
            &self.script,
            &self.model_dir,
            &self.potion_dir,
        ]
        .iter()
        .all(|p| p.is_absolute())
        {
            return Err("Recall local scorer requires absolute paths".into());
        }
        let mut command = Command::new(&self.python);
        command
            .args(["-I", "-B"])
            .arg(&self.script)
            .arg(&self.model_dir)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("TOKENIZERS_PARALLELISM", "false")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let parent = rustix::process::getpid();
        // Use only async-signal-safe process operations between fork and exec.
        unsafe {
            command.pre_exec(move || {
                rustix::process::set_parent_process_death_signal(Some(
                    rustix::process::Signal::KILL,
                ))?;
                if rustix::process::getppid() != Some(parent) {
                    return Err(rustix::io::Errno::SRCH.into());
                }
                Ok(())
            });
        }
        let mut process = Scorer(command.spawn()?);
        process
            .0
            .stdin
            .take()
            .ok_or("Missing scorer input")?
            .write_all(&request)?;
        let mut reply = Vec::new();
        process
            .0
            .stdout
            .take()
            .ok_or("Missing scorer output")?
            .take(4097)
            .read_to_end(&mut reply)?;
        if reply.len() > 4096 {
            return Err("Recall scorer reply exceeds wire limit".into());
        }
        let status = process.0.wait()?;
        if status.code() == Some(12) {
            return Err(InputLimit.into());
        }
        if !status.success() {
            return Err("Local Recall scorer failed".into());
        }
        Ok(serde_json::from_slice(&reply)?)
    }
}

struct Scorer(Child);
impl Drop for Scorer {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
