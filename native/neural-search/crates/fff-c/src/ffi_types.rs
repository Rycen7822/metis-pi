// Derived from FFF 0.11.0 (MIT), copyright Dmitriy Kovalenko.
// Metis private ABI v4: expose only the projections actually used by Metis.
use std::ffi::{CString, c_char, c_void};
use std::ptr;

use fff::file_picker::FilePicker;
use fff::git::format_git_status;
use fff::types::{MixedItemRef, MixedSearchResult, SearchResult};

pub const ABI_VERSION: u32 = 4;

#[repr(C)]
pub struct CreateOptions {
    pub version: u32,
    pub base_path: *const c_char,
    pub frecency_db_path: *const c_char,
    pub history_db_path: *const c_char,
    pub enable_fs_root_scanning: bool,
    pub enable_home_dir_scanning: bool,
    pub follow_symlinks: bool,
}

pub fn string(value: &str) -> *mut c_char {
    CString::new(value).unwrap_or_default().into_raw()
}

pub unsafe fn free_string(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

fn array<T>(values: Vec<T>) -> (*mut T, u32) {
    let values = values.into_boxed_slice();
    let len = values.len() as u32;
    (Box::into_raw(values) as *mut T, len)
}

unsafe fn free_array<T>(values: *mut T, len: u32) {
    if !values.is_null() {
        drop(unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(values, len as usize)) });
    }
}

#[repr(C)]
pub struct Envelope {
    pub success: bool,
    pub error: *mut c_char,
    pub handle: *mut c_void,
    pub int_value: i64,
    // The first 32 bytes are a borrowed view; only Rust owns this tail. The
    // envelope frees its payload even if JS fails before decoding that view.
    release: Option<unsafe fn(*mut c_void)>,
}

unsafe fn drop_box<T>(value: *mut c_void) {
    drop(unsafe { Box::from_raw(value.cast::<T>()) });
}
unsafe fn drop_text(value: *mut c_void) {
    unsafe {
        free_string(value.cast());
    }
}

impl Envelope {
    fn value(handle: *mut c_void, release: Option<unsafe fn(*mut c_void)>) -> *mut Self {
        Box::into_raw(Box::new(Self {
            success: true,
            error: ptr::null_mut(),
            handle,
            int_value: 0,
            release,
        }))
    }
    pub fn boxed<T>(value: T) -> *mut Self {
        Self::value(Box::into_raw(Box::new(value)).cast(), Some(drop_box::<T>))
    }
    pub fn text(value: &str) -> *mut Self {
        Self::value(string(value).cast(), Some(drop_text))
    }
    pub fn take_handle(&mut self) -> *mut c_void {
        self.release = None;
        std::mem::replace(&mut self.handle, ptr::null_mut())
    }
    pub fn integer(value: i64) -> *mut Self {
        let result = Self::value(ptr::null_mut(), None);
        unsafe {
            (*result).int_value = value;
        }
        result
    }
    pub fn error(message: &str) -> *mut Self {
        Box::into_raw(Box::new(Self {
            success: false,
            error: string(message),
            handle: ptr::null_mut(),
            int_value: 0,
            release: None,
        }))
    }
}

impl Drop for Envelope {
    fn drop(&mut self) {
        unsafe {
            free_string(self.error);
            if let Some(release) = self.release
                && !self.handle.is_null()
            {
                release(self.handle);
            }
        }
    }
}

#[repr(C)]
pub struct FileItem {
    pub relative_path: *mut c_char,
    pub git_status: *mut c_char,
    pub total_frecency_score: i64,
}

impl FileItem {
    fn new(file: &fff::types::FileItem, picker: &FilePicker) -> Self {
        Self {
            relative_path: string(&file.relative_path(picker)),
            git_status: string(format_git_status(file.git_status)),
            total_frecency_score: file.total_frecency_score() as i64,
        }
    }
}
impl Drop for FileItem {
    fn drop(&mut self) {
        unsafe {
            free_string(self.relative_path);
            free_string(self.git_status);
        }
    }
}

#[repr(C)]
pub struct Files {
    pub items: *mut FileItem,
    pub count: u32,
    pub total_matched: u32,
    pub total_files: u32,
    pub top_score: i32,
}
impl Files {
    pub fn new(result: &SearchResult, picker: &FilePicker) -> Self {
        let (items, count) = array(
            result
                .items
                .iter()
                .map(|file| FileItem::new(file, picker))
                .collect(),
        );
        Self {
            items,
            count,
            total_matched: result.total_matched as u32,
            total_files: result.total_files as u32,
            top_score: result.scores.first().map_or(0, |score| score.total),
        }
    }
}
impl Drop for Files {
    fn drop(&mut self) {
        unsafe {
            free_array(self.items, self.count);
        }
    }
}

#[repr(C)]
pub struct MixedItem {
    pub relative_path: *mut c_char,
    pub display_name: *mut c_char,
    pub item_type: u8,
}
impl MixedItem {
    fn new(item: &MixedItemRef<'_>, picker: &FilePicker) -> Self {
        let (path, name, item_type) = match item {
            MixedItemRef::File(file) => (file.relative_path(picker), file.file_name(picker), 0),
            MixedItemRef::Dir(dir) => (dir.relative_path(picker), dir.dir_name(picker), 1),
        };
        Self {
            relative_path: string(&path),
            display_name: string(&name),
            item_type,
        }
    }
}
impl Drop for MixedItem {
    fn drop(&mut self) {
        unsafe {
            free_string(self.relative_path);
            free_string(self.display_name);
        }
    }
}

#[repr(C)]
pub struct Mixed {
    pub items: *mut MixedItem,
    pub count: u32,
}
impl Mixed {
    pub fn new(result: &MixedSearchResult, picker: &FilePicker) -> Self {
        let (items, count) = array(
            result
                .items
                .iter()
                .map(|item| MixedItem::new(item, picker))
                .collect(),
        );
        Self { items, count }
    }
}
impl Drop for Mixed {
    fn drop(&mut self) {
        unsafe {
            free_array(self.items, self.count);
        }
    }
}

#[repr(C)]
pub struct GrepMatch {
    pub relative_path: *mut c_char,
    pub git_status: *mut c_char,
    pub line_content: *mut c_char,
    pub context_before: *mut *mut c_char,
    pub context_after: *mut *mut c_char,
    pub line_number: u64,
    pub total_frecency_score: i64,
    pub context_before_count: u32,
    pub context_after_count: u32,
}
impl GrepMatch {
    fn new(line: &fff::GrepMatch, file: &fff::types::FileItem, picker: &FilePicker) -> Self {
        let (context_before, context_before_count) = array(
            line.context_before
                .iter()
                .map(|line| string(line))
                .collect(),
        );
        let (context_after, context_after_count) =
            array(line.context_after.iter().map(|line| string(line)).collect());
        Self {
            relative_path: string(&file.relative_path(picker)),
            git_status: string(format_git_status(file.git_status)),
            line_content: string(&line.line_content),
            context_before,
            context_after,
            line_number: line.line_number,
            total_frecency_score: file.total_frecency_score() as i64,
            context_before_count,
            context_after_count,
        }
    }
}
impl Drop for GrepMatch {
    fn drop(&mut self) {
        unsafe {
            free_string(self.relative_path);
            free_string(self.git_status);
            free_string(self.line_content);
            for (values, count) in [
                (self.context_before, self.context_before_count),
                (self.context_after, self.context_after_count),
            ] {
                for index in 0..count as usize {
                    free_string(*values.add(index));
                }
                free_array(values, count);
            }
        }
    }
}

#[repr(C)]
pub struct Grep {
    pub items: *mut GrepMatch,
    pub count: u32,
    pub total_files_searched: u32,
    pub total_files: u32,
    pub filtered_file_count: u32,
    pub next_file_offset: u32,
    pub regex_fallback_error: *mut c_char,
}
impl Grep {
    pub fn new(result: &fff::GrepResult<'_>, picker: &FilePicker) -> Self {
        let (items, count) = array(
            result
                .matches
                .iter()
                .map(|line| GrepMatch::new(line, result.files[line.file_index], picker))
                .collect(),
        );
        Self {
            items,
            count,
            total_files_searched: result.total_files_searched as u32,
            total_files: result.total_files as u32,
            filtered_file_count: result.filtered_file_count as u32,
            next_file_offset: result.next_file_offset as u32,
            regex_fallback_error: result
                .regex_fallback_error
                .as_deref()
                .map_or(ptr::null_mut(), string),
        }
    }
}
impl Drop for Grep {
    fn drop(&mut self) {
        unsafe {
            free_array(self.items, self.count);
            free_string(self.regex_fallback_error);
        }
    }
}

#[repr(C)]
pub struct Progress {
    pub scanned_files_count: u64,
    pub is_scanning: bool,
    pub is_watcher_ready: bool,
    pub is_ready: bool,
    pub index_version: u64,
    pub scan_error: *mut c_char,
    pub git_status_error: *mut c_char,
}
impl From<fff::file_picker::ScanProgress> for Progress {
    fn from(value: fff::file_picker::ScanProgress) -> Self {
        Self {
            scanned_files_count: value.scanned_files_count as u64,
            is_scanning: value.is_scanning,
            is_watcher_ready: value.is_watcher_ready,
            is_ready: value.is_ready,
            index_version: value.index_version,
            scan_error: value.scan_error.as_deref().map_or(ptr::null_mut(), string),
            git_status_error: value
                .git_status_error
                .as_deref()
                .map_or(ptr::null_mut(), string),
        }
    }
}
impl Drop for Progress {
    fn drop(&mut self) {
        unsafe {
            free_string(self.scan_error);
            free_string(self.git_status_error);
        }
    }
}

// Linux x64 ABI guards: a changed projection requires a coordinated ABI bump,
// header, ffi-rs layout and process cache key, not a compatibility fallback.
const _: () = {
    use std::mem::{offset_of, size_of};
    assert!(size_of::<CreateOptions>() == 40 && offset_of!(CreateOptions, base_path) == 8);
    assert!(
        size_of::<Envelope>() == 40
            && offset_of!(Envelope, handle) == 16
            && offset_of!(Envelope, release) == 32
    );
    assert!(size_of::<FileItem>() == 24 && size_of::<Files>() == 24);
    assert!(offset_of!(Files, top_score) == 20);
    assert!(size_of::<MixedItem>() == 24 && offset_of!(MixedItem, item_type) == 16);
    assert!(size_of::<Mixed>() == 16);
    assert!(size_of::<GrepMatch>() == 64 && offset_of!(GrepMatch, line_number) == 40);
    assert!(size_of::<Grep>() == 40 && offset_of!(Grep, regex_fallback_error) == 32);
    assert!(size_of::<Progress>() == 40 && offset_of!(Progress, index_version) == 16);
    assert!(offset_of!(Progress, scan_error) == 24 && offset_of!(Progress, git_status_error) == 32);
};
