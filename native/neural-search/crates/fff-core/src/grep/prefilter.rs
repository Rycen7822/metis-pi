use super::types::GrepSearchOptions;
use crate::index::constraints::{ConstraintPlan, ConstraintsBuffers};
use crate::sort_buffer::sort_with_buffer;
use crate::types::FileItem;
use fff_query_parser::Constraint;

/// Single pass prefilter that doesn't involve file reading
/// allocates only amount of memory required for storing references of the FileItems have to be
/// opened for grepping unaviodably, in the worst case allocates N * <word> memory if no prefilter needed
pub(crate) fn prefilter_files<'a>(
    files: &'a [FileItem],
    constraints: &[Constraint<'_>],
    options: &GrepSearchOptions,
    arena: crate::simd_path::ArenaPtr,
    overflow_arena: crate::simd_path::ArenaPtr,
) -> (Vec<&'a FileItem>, usize) {
    let max_file_size = options.max_file_size;
    let plan = if constraints.is_empty() {
        None
    } else {
        Some(ConstraintPlan::build(
            constraints,
            files,
            arena,
            overflow_arena,
        ))
    };

    let mut scratch = ConstraintsBuffers::new();

    #[inline(always)]
    fn basic_prefilter(file: &FileItem, max: u64) -> bool {
        !file.is_deleted() && !file.is_binary() && file.size > 0 && file.size <= max
    }

    // Visit the base and overflow regions exactly once, in their existing
    // order so equal-score ties retain the same stable-sort behavior.
    let mut prefiltered: Vec<&FileItem> = Vec::new();
    for (idx, file) in files.iter().enumerate() {
        if !basic_prefilter(file, max_file_size) {
            continue;
        }
        if let Some(ref plan) = plan
            && !plan.matches(file, idx, arena, overflow_arena, &mut scratch)
        {
            continue;
        }
        prefiltered.push(file);
    }

    let total_count = prefiltered.len();

    sort_with_buffer(&mut prefiltered, |a, b| {
        b.total_frecency_score()
            .cmp(&a.total_frecency_score())
            .then(b.modified.cmp(&a.modified))
    });

    if options.file_offset > 0 && options.file_offset < total_count {
        let paginated = prefiltered.split_off(options.file_offset);
        (paginated, total_count)
    } else if options.file_offset >= total_count {
        (Vec::new(), total_count)
    } else {
        (prefiltered, total_count)
    }
}
