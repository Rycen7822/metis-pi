use super::{CODE_EMBEDDING_DIMENSION, MAX_BATCH_WINDOWS, MAX_CODE_WINDOW_TOKENS};
use crate::Result;
use half::f16;
use libloading::Library;
use std::{
    ffi::{CString, c_char, c_int, c_void},
    path::Path,
    ptr,
    sync::Arc,
};

#[repr(C)]
struct Options {
    abi_version: u32,
    manifest: *const c_char,
    threads: u32,
    temp_cap: u64,
    strict_artifact_contract: u32,
}
#[repr(C)]
struct Input {
    ids: *const u32,
    count: usize,
    role: c_int,
    mask: *const u8,
    mask_count: usize,
    request_id: u64,
}
#[repr(C)]
struct Output {
    vectors: *mut f32,
    capacity: usize,
    rows: usize,
    required: usize,
    dimensions: u32,
}
type Create = unsafe extern "C" fn(*const Options, *mut *mut c_void) -> c_int;
type Encode =
    unsafe extern "C" fn(*mut c_void, *const Input, *mut Output, *const i64, usize) -> c_int;
type Destroy = unsafe extern "C" fn(*mut c_void);
type Cancel = unsafe extern "C" fn(*mut c_void, u64) -> c_int;
type Diagnostics = unsafe extern "C" fn(*mut c_void, *mut c_char, usize, *mut usize) -> c_int;
type MaxSim = unsafe extern "C" fn(*const f32, usize, *const u16, usize, *mut f32) -> c_int;

// Shared service admission is three searches, each with at most four compute lanes.
const MAX_COMPUTING_THREADS: usize = 4;
// Must match native/include/sgrep_runtime.h and the segmented prepared graph.
const NATIVE_ABI_VERSION: u32 = 3;
// Native execution scratch only, separate from the on-disk corpus cache budget.
const NATIVE_SCRATCH_BYTES: u64 = 128 * 1024 * 1024;

pub(crate) fn computing_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().min(MAX_COMPUTING_THREADS))
        .unwrap_or(1)
}

/// Stateless scoring only: no encoder handle, request counter or ORT Run access.
/// An owned library reference keeps the entry point alive across requests.
#[derive(Clone)]
pub(super) struct ScoringKernel {
    update: MaxSim,
    _library: Arc<Library>,
}
#[derive(Debug)]
struct ScoringFailure(c_int);
impl std::fmt::Display for ScoringFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "native MaxSim status {}", self.0)
    }
}
impl std::error::Error for ScoringFailure {}
impl ScoringKernel {
    pub(super) fn update(&self, query: &[f32], document: &[f16], maxima: &mut [f32]) -> Result<()> {
        if query.is_empty()
            || document.is_empty()
            || query.len() % CODE_EMBEDDING_DIMENSION != 0
            || document.len() % CODE_EMBEDDING_DIMENSION != 0
            || maxima.len() != query.len() / CODE_EMBEDDING_DIMENSION
        {
            return Err("invalid MaxSim shape".into());
        }
        // SAFETY: validated slice geometry; the fixed native entry point is
        // stateless and writes only this task's maxima. Library remains borrowed.
        let status = unsafe {
            (self.update)(
                query.as_ptr(),
                query.len() / CODE_EMBEDDING_DIMENSION,
                document.as_ptr().cast(),
                document.len() / CODE_EMBEDDING_DIMENSION,
                maxima.as_mut_ptr(),
            )
        };
        if status != 0 {
            return Err(Box::new(ScoringFailure(status)));
        }
        Ok(())
    }
}

pub struct Runtime {
    handle: *mut c_void,
    encode_fn: Encode,
    destroy_fn: Destroy,
    cancel_fn: Cancel,
    diagnostics_fn: Diagnostics,
    maxsim_fn: MaxSim,
    next_request: u64,
    // Function pointers and the native handle must never outlive this library.
    _library: Arc<Library>,
}
impl Runtime {
    pub fn open(library: &Path, manifest: &Path) -> Result<Self> {
        if !library.is_file() {
            return Err(format!(
                "ASSET_MISSING: CPU adapter not found at {}",
                library.display()
            )
            .into());
        }
        let library = Arc::new(unsafe { Library::new(library)? });
        let create: Create = unsafe { *library.get(b"sgrep_runtime_create\0")? };
        let encode_fn = unsafe { *library.get(b"sgrep_runtime_encode_segments\0")? };
        let destroy_fn = unsafe { *library.get(b"sgrep_runtime_destroy\0")? };
        let cancel_fn = unsafe { *library.get(b"sgrep_runtime_cancel\0")? };
        let diagnostics_fn = unsafe { *library.get(b"sgrep_runtime_diagnostics\0")? };
        let maxsim_fn = unsafe { *library.get(b"sgrep_maxsim_update\0")? };
        let mut runtime = Self {
            handle: ptr::null_mut(),
            encode_fn,
            destroy_fn,
            cancel_fn,
            diagnostics_fn,
            maxsim_fn,
            next_request: 1,
            _library: library,
        };
        let manifest = CString::new(
            manifest
                .to_str()
                .ok_or("model manifest path must be UTF-8")?,
        )?;
        let threads = computing_threads();
        let options = Options {
            abi_version: NATIVE_ABI_VERSION,
            manifest: manifest.as_ptr(),
            threads: threads as u32,
            temp_cap: NATIVE_SCRATCH_BYTES,
            strict_artifact_contract: 1,
        };
        let status = unsafe { create(&options, &mut runtime.handle) };
        if status != 0 {
            return Err(runtime.failure(status));
        }
        if runtime.handle.is_null() {
            return Err("UNVERIFIED_BACKEND: native create returned a null handle".into());
        }
        if let Some(context) = crate::request::current() {
            context.models.runtime_created();
        }
        Ok(runtime)
    }
    pub fn encode(&mut self, ids: &[u32], mask: &[u8], query: bool) -> Result<Vec<f32>> {
        self.encode_segments(ids, mask, query, &[0, ids.len() as i64])
    }
    pub fn encode_documents(&mut self, windows: &[(&[u32], &[u8])]) -> Result<Vec<f32>> {
        if windows.is_empty() || windows.len() > MAX_BATCH_WINDOWS {
            return Err("invalid native document batch size".into());
        }
        if windows.len() == 1 {
            return self.encode(windows[0].0, windows[0].1, false);
        }
        let count: usize = windows.iter().map(|(ids, _)| ids.len()).sum();
        if count > MAX_CODE_WINDOW_TOKENS {
            return Err("native document batch exceeds token budget".into());
        }
        let mut ids = Vec::with_capacity(count);
        let mut mask = Vec::with_capacity(count);
        let mut offsets = Vec::with_capacity(windows.len() + 1);
        offsets.push(0);
        for (tokens, selected) in windows {
            if tokens.len() != selected.len() {
                return Err("invalid native window mask length".into());
            }
            ids.extend_from_slice(tokens);
            mask.extend_from_slice(selected);
            offsets.push(ids.len() as i64);
        }
        self.encode_segments(&ids, &mask, false, &offsets)
    }
    fn encode_segments(
        &mut self,
        ids: &[u32],
        mask: &[u8],
        query: bool,
        offsets: &[i64],
    ) -> Result<Vec<f32>> {
        if ids.len() != mask.len() || mask.iter().any(|m| *m > 1) {
            return Err("invalid encoder IDs/output mask".into());
        }
        let rows = mask.iter().filter(|m| **m != 0).count();
        let mut vectors = vec![0.0; rows * CODE_EMBEDDING_DIMENSION];
        let input = Input {
            ids: ids.as_ptr(),
            count: ids.len(),
            role: if query { 0 } else { 1 },
            mask: mask.as_ptr(),
            mask_count: mask.len(),
            request_id: self.next_request,
        };
        self.next_request = self
            .next_request
            .checked_add(1)
            .ok_or("request counter exhausted")?;
        let mut output = Output {
            vectors: vectors.as_mut_ptr(),
            capacity: vectors.len(),
            rows: 0,
            required: 0,
            dimensions: 0,
        };
        crate::request::check()?;
        // The guard clears the cancellation capability before this mutable
        // runtime borrow ends. Only synchronized native cancellation is shared.
        let _registration = unsafe {
            crate::request::register_native(self.handle, self.cancel_fn, input.request_id)
        };
        let status = unsafe {
            (self.encode_fn)(
                self.handle,
                &input,
                &mut output,
                offsets.as_ptr(),
                offsets.len(),
            )
        };
        if status == 0 {
            crate::request::encoded(query, offsets.len() - 1);
        }
        crate::request::check()?;
        if status != 0 {
            return Err(self.failure(status));
        }
        if output.rows != rows
            || output.dimensions != CODE_EMBEDDING_DIMENSION as u32
            || output.required != vectors.len()
            || vectors.iter().any(|v| !v.is_finite())
        {
            return Err("UNVERIFIED_BACKEND: inconsistent native encoder output".into());
        }
        Ok(vectors)
    }
    pub(super) fn scoring_kernel(&self) -> ScoringKernel {
        ScoringKernel {
            update: self.maxsim_fn,
            _library: self._library.clone(),
        }
    }
    pub(super) fn scoring_error(
        &self,
        error: Box<dyn std::error::Error + Send + Sync>,
    ) -> Box<dyn std::error::Error + Send + Sync> {
        match error.downcast_ref::<ScoringFailure>() {
            Some(failure) => self.failure(failure.0),
            None => error,
        }
    }
    pub fn update_maxima(&self, query: &[f32], document: &[f16], maxima: &mut [f32]) -> Result<()> {
        self.scoring_kernel()
            .update(query, document, maxima)
            .map_err(|error| self.scoring_error(error))
    }
    pub(super) fn diagnostics(&self) -> Result<String> {
        let mut required = 0;
        let status =
            unsafe { (self.diagnostics_fn)(self.handle, ptr::null_mut(), 0, &mut required) };
        if status != 2 || !(1..=65536).contains(&required) {
            return Err("invalid native diagnostics size".into());
        }
        let mut bytes = vec![0; required];
        let status = unsafe {
            (self.diagnostics_fn)(
                self.handle,
                bytes.as_mut_ptr().cast(),
                bytes.len(),
                &mut required,
            )
        };
        if status != 0 {
            return Err("native diagnostics failed".into());
        }
        bytes.pop();
        Ok(String::from_utf8(bytes)?)
    }
    fn failure(&self, status: c_int) -> Box<dyn std::error::Error + Send + Sync> {
        let code = match status {
            1 => "INVALID_INPUT",
            2 => "BUFFER_TOO_SMALL",
            3 => "CANCELLED",
            4 => "ARTIFACT_MISMATCH",
            5 => "RAM_BUDGET_EXCEEDED",
            _ => "UNVERIFIED_BACKEND",
        };
        format!(
            "{code}: {}",
            self.diagnostics().unwrap_or_else(|e| e.to_string())
        )
        .into()
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { (self.destroy_fn)(self.handle) };
        }
    }
}
