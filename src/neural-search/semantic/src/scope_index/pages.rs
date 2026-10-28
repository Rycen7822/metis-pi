//! Bounded resident views over a leased, immutable corpus-index inode.
//! These calls release this mapping's PTEs, not the shared file cache or another
//! reader's view. This is not host page-cache eviction or a cold-page claim.
use crate::Result;
use memmap2::{Mmap, UncheckedAdvice};

const WINDOW: usize = 8 << 20;

/// Call after all byte slices/records from the consumed range have been dropped.
pub(super) fn release(map: &Mmap, start: usize, end: usize) -> Result<()> {
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page <= 0 {
        return Err("cannot determine cache page geometry".into());
    }
    let page = page as usize;
    let start = start / page * page;
    let end = end / page * page;
    if end > start {
        // SAFETY: a read-only file mapping with a durable immutable-inode
        // lease. No borrowed bytes survive this call; future faults reload
        // identical bytes. Never used on anonymous or model/allocator mappings.
        unsafe {
            map.unchecked_advise_range(UncheckedAdvice::DontNeed, start, end - start)?;
        }
    }
    Ok(())
}
pub(super) fn consumed(map: &Mmap, cursor: &mut usize, end: usize) -> Result<()> {
    if end.saturating_sub(*cursor) >= WINDOW {
        release(map, *cursor, end)?;
        *cursor = end;
    }
    Ok(())
}
pub(super) fn checksum(map: &Mmap, end: usize) -> Result<u32> {
    let mut checksum = crc32fast::Hasher::new();
    for start in (0..end).step_by(WINDOW) {
        let next = (start + WINDOW).min(end);
        checksum.update(&map[start..next]);
        // No slice/chunks iterator remains live across the release.
        release(map, start, next)?;
    }
    Ok(checksum.finalize())
}
