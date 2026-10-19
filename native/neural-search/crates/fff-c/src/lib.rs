//! Metis private Linux x64 ABI. Handles own picker/DB lifetimes; each result
//! envelope owns its payload until decoded, or the new instance is transferred.
//! Derived from FFF 0.11.0 (MIT); maintained by Metis, not an upstream SDK.

#[cfg(not(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")))]
compile_error!("Metis Neural Search supports Linux x64 glibc only");

use std::ffi::{CStr, c_char, c_void};
use std::path::PathBuf;
use std::ptr;

use fff::file_picker::FilePicker;
use fff::frecency::FrecencyTracker;
use fff::query_tracker::QueryTracker;
use fff::shared::SharedQueryTracker;
use fff::{
    DbHealthChecker, FuzzySearchOptions, PaginationArgs, QueryParser, SharedFilePicker,
    SharedFrecency,
};
use fff_query_parser::Constraint;

mod ffi_types;
use ffi_types::*;

struct Instance {
    picker: SharedFilePicker,
    frecency: SharedFrecency,
    query_tracker: SharedQueryTracker,
}
impl Drop for Instance {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.picker.write() {
            drop(guard.take());
        }
        if let Ok(mut guard) = self.frecency.write() {
            *guard = None;
        }
        if let Ok(mut guard) = self.query_tracker.write() {
            *guard = None;
        }
    }
}

unsafe fn text<'a>(value: *const c_char) -> Result<&'a str, &'static str> {
    if value.is_null() {
        return Err("String is null");
    }
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map_err(|_| "String is not valid UTF-8")
}
unsafe fn optional_text<'a>(value: *const c_char) -> Option<&'a str> {
    unsafe { text(value) }
        .ok()
        .filter(|value| !value.is_empty())
}
// No engine panic may unwind into Node/Bun through a non-unwinding C call.
fn guarded(action: impl FnOnce() -> *mut Envelope) -> *mut Envelope {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(action))
        .unwrap_or_else(|_| Envelope::error("Neural Search operation panicked"))
}
unsafe fn with_picker(
    handle: *mut c_void,
    action: impl FnOnce(&Instance, &FilePicker) -> *mut Envelope,
) -> *mut Envelope {
    let Some(instance) = (unsafe { handle.cast::<Instance>().as_ref() }) else {
        return Envelope::error("Neural Search instance is null");
    };
    let guard = match instance.picker.read() {
        Ok(guard) => guard,
        Err(error) => return Envelope::error(&error.to_string()),
    };
    match guard.as_ref() {
        Some(picker) => guarded(|| action(instance, picker)),
        None => Envelope::error("Neural Search instance is closed"),
    }
}
fn unsupported_type(constraints: &[Constraint<'_>]) -> bool {
    constraints.iter().any(|constraint| match constraint {
        Constraint::FileType(_) => true,
        Constraint::Not(inner) => unsupported_type(std::slice::from_ref(inner.as_ref())),
        _ => false,
    })
}
const TYPE_ERROR: &str = "Unsupported type: filter. Use an extension or glob filter instead.";
const CONTENT_CURSOR_ERROR: &str = "Content index changed; restart the query without a cursor.";
fn limit(value: u32, default: u32) -> usize {
    (if value == 0 { default } else { value }) as usize
}

#[unsafe(no_mangle)]
pub extern "C" fn metis_search_abi_version() -> u32 {
    ABI_VERSION
}

/// All pointer fields must be live UTF-8 C strings for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_create(options: *const CreateOptions) -> *mut Envelope {
    guarded(|| {
        // Read only the common version word until the ABI has been checked.
        if options.is_null() || unsafe { options.cast::<u32>().read() } != ABI_VERSION {
            return Envelope::error(
                "Neural Search ABI mismatch; reinstall the package and restart Pi",
            );
        }
        let options = unsafe { &*options };
        let base_path = match unsafe { text(options.base_path) } {
            Ok(path) if !path.is_empty() => path.to_owned(),
            _ => return Envelope::error("Base path is empty or invalid UTF-8"),
        };
        let picker = SharedFilePicker::default();
        let frecency = SharedFrecency::default();
        let query_tracker = SharedQueryTracker::default();
        if let Some(path) = unsafe { optional_text(options.frecency_db_path) } {
            match FrecencyTracker::open(path).and_then(|tracker| frecency.init(tracker)) {
                Ok(()) => {}
                Err(error) => {
                    return Envelope::error(&format!("Failed to open frecency database: {error}"));
                }
            }
        }
        if let Some(path) = unsafe { optional_text(options.history_db_path) } {
            match QueryTracker::open(path).and_then(|tracker| query_tracker.init(tracker)) {
                Ok(()) => {}
                Err(error) => {
                    return Envelope::error(&format!("Failed to open history database: {error}"));
                }
            }
        }
        if let Err(error) = FilePicker::new_with_shared_state(
            picker.clone(),
            frecency.clone(),
            fff::FilePickerOptions {
                base_path,
                watch: true,
                cache_budget: fff::ContentCacheBudget::from_overrides(0, 0, 0),
                follow_symlinks: options.follow_symlinks,
                enable_fs_root_scanning: options.enable_fs_root_scanning,
                enable_home_dir_scanning: options.enable_home_dir_scanning,
                git_recency: Default::default(),
            },
        ) {
            return Envelope::error(&error.to_string());
        }
        Envelope::boxed(Instance {
            picker,
            frecency,
            query_tracker,
        })
    })
}

/// Only a successful create envelope may transfer its instance to the caller.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_take_instance(result: *mut Envelope) -> *mut c_void {
    match unsafe { result.as_mut() } {
        Some(result) if result.success => result.take_handle(),
        _ => ptr::null_mut(),
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_destroy(handle: *mut c_void) {
    if !handle.is_null() {
        drop(unsafe { Box::from_raw(handle.cast::<Instance>()) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_files(
    handle: *mut c_void,
    query: *const c_char,
    item_offset: u32,
    page_size: u32,
) -> *mut Envelope {
    let query = match unsafe { text(query) } {
        Ok(query) => QueryParser::default().parse(query),
        Err(error) => return Envelope::error(error),
    };
    if unsupported_type(&query.constraints) {
        return Envelope::error(TYPE_ERROR);
    }
    unsafe {
        with_picker(handle, |instance, picker| {
            let tracker = match instance.query_tracker.read() {
                Ok(guard) => guard,
                Err(error) => return Envelope::error(&error.to_string()),
            };
            let options = FuzzySearchOptions {
                max_threads: 0,
                current_file: None,
                project_path: Some(picker.base_path()),
                combo_boost_score_multiplier: 100,
                min_combo_count: 3,
                pagination: PaginationArgs {
                    offset: item_offset as usize,
                    limit: limit(page_size, 100),
                },
            };
            Envelope::boxed(Files::new(
                &picker.fuzzy_search(&query, tracker.as_ref(), options),
                picker,
            ))
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_mixed(
    handle: *mut c_void,
    query: *const c_char,
    page_size: u32,
) -> *mut Envelope {
    let query = match unsafe { text(query) } {
        Ok(query) => QueryParser::new(fff_query_parser::MixedSearchConfig).parse(query),
        Err(error) => return Envelope::error(error),
    };
    if unsupported_type(&query.constraints) {
        return Envelope::error(TYPE_ERROR);
    }
    unsafe {
        with_picker(handle, |instance, picker| {
            let tracker = match instance.query_tracker.read() {
                Ok(guard) => guard,
                Err(error) => return Envelope::error(&error.to_string()),
            };
            let options = FuzzySearchOptions {
                max_threads: 0,
                current_file: None,
                project_path: Some(picker.base_path()),
                combo_boost_score_multiplier: 100,
                min_combo_count: 3,
                pagination: PaginationArgs {
                    offset: 0,
                    limit: limit(page_size, 100),
                },
            };
            Envelope::boxed(Mixed::new(
                &picker.fuzzy_search_mixed(&query, tracker.as_ref(), options),
                picker,
            ))
        })
    }
}

// Pattern and filters are separate: no filename guessing, raw-query retry or
// transport decoding may reinterpret a caller's literal/regex/fuzzy needle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_grep(
    handle: *mut c_void,
    pattern: *const c_char,
    filters: *const c_char,
    mode: u8,
    max_file_size: u64,
    max_matches_per_file: u32,
    smart_case: bool,
    file_offset: u32,
    page_limit: u32,
    time_budget_ms: u64,
    enforce_time_budget: bool,
    before_context: u32,
    after_context: u32,
    expected_index_version: u64,
) -> *mut Envelope {
    let pattern = match unsafe { text(pattern) } {
        Ok(pattern) => pattern,
        Err(error) => return Envelope::error(error),
    };
    let filters = match unsafe { text(filters) } {
        Ok(filters) => filters,
        Err(error) => return Envelope::error(error),
    };
    let constraints = QueryParser::new(fff_query_parser::AiGrepConfig).parse_constraints(filters);
    if unsupported_type(&constraints) {
        return Envelope::error(TYPE_ERROR);
    }
    let options = fff::GrepSearchOptions {
        max_file_size: if max_file_size == 0 {
            10 * 1024 * 1024
        } else {
            max_file_size
        },
        max_matches_per_file: max_matches_per_file as usize,
        smart_case,
        file_offset: file_offset as usize,
        page_limit: limit(page_limit, 50),
        mode: match mode {
            1 => fff::GrepMode::Regex,
            2 => fff::GrepMode::Fuzzy,
            _ => fff::GrepMode::PlainText,
        },
        time_budget_ms,
        enforce_time_budget,
        before_context: before_context as usize,
        after_context: after_context as usize,
        ..Default::default()
    };
    unsafe {
        with_picker(handle, |_, picker| {
            if (file_offset != 0 || expected_index_version != 0)
                && expected_index_version != picker.index_version()
            {
                return Envelope::error(CONTENT_CURSOR_ERROR);
            }
            Envelope::boxed(Grep::new(
                &picker.grep_pattern(pattern, &constraints, &options),
                picker,
            ))
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_multi_grep(
    handle: *mut c_void,
    patterns: *const c_char,
    filters: *const c_char,
    max_file_size: u64,
    max_matches_per_file: u32,
    smart_case: bool,
    file_offset: u32,
    page_limit: u32,
    time_budget_ms: u64,
    enforce_time_budget: bool,
    before_context: u32,
    after_context: u32,
    expected_index_version: u64,
) -> *mut Envelope {
    let patterns = match unsafe { text(patterns) } {
        Ok(patterns) if !patterns.is_empty() => patterns.split('\n').collect::<Vec<_>>(),
        _ => return Envelope::error("Patterns must not be empty"),
    };
    let filters = match unsafe { text(filters) } {
        Ok(filters) => filters,
        Err(error) => return Envelope::error(error),
    };
    let constraints = QueryParser::new(fff_query_parser::AiGrepConfig).parse_constraints(filters);
    if unsupported_type(&constraints) {
        return Envelope::error(TYPE_ERROR);
    }
    let options = fff::GrepSearchOptions {
        max_file_size: if max_file_size == 0 {
            10 * 1024 * 1024
        } else {
            max_file_size
        },
        max_matches_per_file: max_matches_per_file as usize,
        smart_case,
        file_offset: file_offset as usize,
        page_limit: limit(page_limit, 50),
        time_budget_ms,
        enforce_time_budget,
        before_context: before_context as usize,
        after_context: after_context as usize,
        ..Default::default()
    };
    unsafe {
        with_picker(handle, |_, picker| {
            if (file_offset != 0 || expected_index_version != 0)
                && expected_index_version != picker.index_version()
            {
                return Envelope::error(CONTENT_CURSOR_ERROR);
            }
            match picker.multi_grep(&patterns, &constraints, &options) {
                Ok(result) => Envelope::boxed(Grep::new(&result, picker)),
                Err(error) => Envelope::error(&format!("Failed to build search patterns: {error}")),
            }
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_scan(handle: *mut c_void) -> *mut Envelope {
    guarded(|| {
        if handle.is_null() {
            return Envelope::error("Neural Search instance is null");
        }
        let instance = unsafe { &*handle.cast::<Instance>() };
        match instance
            .picker
            .trigger_full_rescan_async(&instance.frecency)
        {
            Ok(()) => Envelope::integer(0),
            Err(error) => Envelope::error(&error.to_string()),
        }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_is_scanning(handle: *mut c_void) -> *mut Envelope {
    unsafe {
        with_picker(handle, |_, picker| {
            Envelope::integer(i64::from(picker.is_scan_active()))
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_progress(handle: *mut c_void) -> *mut Envelope {
    unsafe {
        with_picker(handle, |_, picker| {
            Envelope::boxed(Progress::from(picker.get_scan_progress()))
        })
    }
}

fn database_health<T: DbHealthChecker>(database: Option<&T>) -> serde_json::Value {
    match database {
        None => serde_json::json!({ "initialized": false }),
        Some(database) => match database.get_health() {
            Ok(health) => {
                serde_json::json!({ "initialized": true, "dbHealthcheck": { "path": health.path, "diskSize": health.disk_size, "healthy": health.healthy } })
            }
            Err(error) => serde_json::json!({ "initialized": true, "error": error.to_string() }),
        },
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_health(
    handle: *mut c_void,
    path: *const c_char,
) -> *mut Envelope {
    let path = unsafe { optional_text(path) }
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    unsafe {
        with_picker(handle, |instance, picker| {
            let version = git2::Version::get().libgit2_version();
            let git = match git2::Repository::discover(&path) {
                Ok(repo) => {
                    let mut info =
                        serde_json::json!({ "available": true, "repositoryFound": true });
                    if let Some(path) = repo.workdir() {
                        info["workdir"] = path.to_string_lossy().into_owned().into();
                    }
                    info
                }
                Err(error) => {
                    serde_json::json!({ "available": true, "repositoryFound": false, "error": error.message() })
                }
            };
            let mut git = git;
            git["libgit2Version"] = format!("{}.{}.{}", version.0, version.1, version.2).into();
            let frecency = match instance.frecency.read() {
                Ok(guard) => database_health(guard.as_ref()),
                Err(error) => serde_json::json!({ "error": error.to_string() }),
            };
            let history = match instance.query_tracker.read() {
                Ok(guard) => database_health(guard.as_ref()),
                Err(error) => serde_json::json!({ "error": error.to_string() }),
            };
            let mut health = serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "git": git,
            "filePicker": { "initialized": true, "basePath": picker.base_path(), "isScanning": picker.is_scan_active(), "indexedFiles": picker.live_file_count() },
            "frecency": frecency, "queryTracker": history });
            if let Some(error) = picker.scan_error() {
                health["filePicker"]["error"] = error.into();
            }
            Envelope::text(&health.to_string())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_free_result(value: *mut Envelope) {
    if !value.is_null() {
        drop(unsafe { Box::from_raw(value) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_get_file(
    result: *const Files,
    index: u32,
) -> *const FileItem {
    match unsafe { result.as_ref() } {
        Some(result) if index < result.count => unsafe { result.items.add(index as usize) },
        _ => ptr::null(),
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_get_mixed(
    result: *const Mixed,
    index: u32,
) -> *const MixedItem {
    match unsafe { result.as_ref() } {
        Some(result) if index < result.count => unsafe { result.items.add(index as usize) },
        _ => ptr::null(),
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_get_match(
    result: *const Grep,
    index: u32,
) -> *const GrepMatch {
    match unsafe { result.as_ref() } {
        Some(result) if index < result.count => unsafe { result.items.add(index as usize) },
        _ => ptr::null(),
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn metis_search_pointer_offset(
    base: *const c_void,
    bytes: u64,
) -> *const c_void {
    if base.is_null() {
        ptr::null()
    } else {
        unsafe { base.cast::<u8>().add(bytes as usize).cast() }
    }
}
