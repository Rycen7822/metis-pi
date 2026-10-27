// Boundary algorithm from tree-sitter-language-pack 1.21.0 text_splitter.rs
// (adapted upstream from Ben Brandt's text-splitter) and intel/walk.rs, MIT.
// Metadata collection is intentionally omitted; chunk boundaries are unchanged.

use std::ops::Range;

use memchr::memchr;

pub fn split_code(
    source: &str,
    tree: &tree_sitter::Tree,
    max_chunk_size: usize,
) -> Vec<(usize, usize)> {
    if source.is_empty() || max_chunk_size == 0 {
        return Vec::new();
    }

    if source.len() <= max_chunk_size {
        return vec![(0, source.len())];
    }

    let root = tree.root_node();
    let (node_ranges, _truncated) = collect_node_ranges(&root);
    let max_depth = node_ranges.iter().map(|nr| nr.depth).max().unwrap_or(0);

    let mut split_points_by_depth: Vec<Vec<usize>> = vec![Vec::new(); max_depth + 1];
    for nr in &node_ranges {
        split_points_by_depth[nr.depth].push(nr.range.start);
    }
    for points in &mut split_points_by_depth {
        points.push(source.len());
        points.sort_unstable();
        points.dedup();
    }

    let splitter = Splitter {
        source,
        max_chunk_size,
        split_points_by_depth: &split_points_by_depth,
    };
    let mut chunks: Vec<(usize, usize)> = Vec::new();
    splitter.split_recursive(0, source.len(), 0, &mut chunks);

    chunks
}

#[derive(Debug, Clone)]
struct NodeRange {
    depth: usize,
    range: Range<usize>,
}

fn collect_node_ranges(root: &tree_sitter::Node<'_>) -> (Vec<NodeRange>, usize) {
    let mut ranges = Vec::new();
    let truncated = walk_bounded(root, |node, depth| {
        if depth > 0 {
            ranges.push(NodeRange {
                depth,
                range: node.byte_range(),
            });
        }
        Descend::Children
    });
    (ranges, truncated)
}

struct Splitter<'a> {
    source: &'a str,
    max_chunk_size: usize,
    split_points_by_depth: &'a [Vec<usize>],
}

impl Splitter<'_> {
    fn split_recursive(
        &self,
        region_start: usize,
        region_end: usize,
        current_depth: usize,
        out: &mut Vec<(usize, usize)>,
    ) {
        let region_size = region_end - region_start;

        if region_size <= self.max_chunk_size {
            if region_size > 0 {
                out.push((region_start, region_end));
            }
            return;
        }

        if current_depth < self.split_points_by_depth.len() {
            let points = &self.split_points_by_depth[current_depth];

            let relevant: Vec<usize> = points
                .iter()
                .copied()
                .filter(|&p| p > region_start && p < region_end)
                .collect();

            if !relevant.is_empty() {
                let mut boundaries = Vec::with_capacity(relevant.len() + 2);
                boundaries.push(region_start);
                boundaries.extend_from_slice(&relevant);
                boundaries.push(region_end);

                self.merge_boundaries(&boundaries, current_depth, out);
                return;
            }

            if current_depth + 1 < self.split_points_by_depth.len() {
                self.split_recursive(region_start, region_end, current_depth + 1, out);
                return;
            }
        }

        split_at_lines(
            self.source,
            region_start,
            region_end,
            self.max_chunk_size,
            out,
        );
    }

    fn merge_boundaries(
        &self,
        boundaries: &[usize],
        current_depth: usize,
        out: &mut Vec<(usize, usize)>,
    ) {
        let mut cursor = 0;
        while cursor < boundaries.len() - 1 {
            let chunk_start = boundaries[cursor];
            let mut best_end_idx = cursor + 1;
            for (j, &boundary) in boundaries.iter().enumerate().skip(cursor + 1) {
                if boundary - chunk_start <= self.max_chunk_size {
                    best_end_idx = j;
                } else {
                    break;
                }
            }

            let chunk_end = boundaries[best_end_idx];
            if chunk_end - chunk_start <= self.max_chunk_size {
                if chunk_end > chunk_start {
                    out.push((chunk_start, chunk_end));
                }
            } else {
                self.split_recursive(chunk_start, chunk_end, current_depth + 1, out);
            }
            cursor = best_end_idx;
        }
    }
}

fn split_at_lines(
    source: &str,
    region_start: usize,
    region_end: usize,
    max_chunk_size: usize,
    out: &mut Vec<(usize, usize)>,
) {
    let region = &source[region_start..region_end];

    let mut line_ends: Vec<usize> = Vec::new();
    let region_bytes = region.as_bytes();
    let mut search_start = 0;
    while let Some(rel_pos) = memchr(b'\n', &region_bytes[search_start..]) {
        let abs_pos = region_start + search_start + rel_pos + 1;
        line_ends.push(abs_pos);
        search_start += rel_pos + 1;
    }
    if line_ends.last().copied() != Some(region_end) {
        line_ends.push(region_end);
    }

    let mut chunk_start = region_start;
    let mut prev_line_end = region_start;

    for &line_end in &line_ends {
        let candidate_size = line_end - chunk_start;
        if candidate_size > max_chunk_size {
            if prev_line_end > chunk_start {
                out.push((chunk_start, prev_line_end));
                chunk_start = prev_line_end;
            }

            if line_end - chunk_start > max_chunk_size {
                split_at_bytes(source, chunk_start, line_end, max_chunk_size, out);
                chunk_start = line_end;
            }
        }
        prev_line_end = line_end;
    }

    if chunk_start < region_end {
        out.push((chunk_start, region_end));
    }
}

fn split_at_bytes(
    source: &str,
    region_start: usize,
    region_end: usize,
    max_chunk_size: usize,
    out: &mut Vec<(usize, usize)>,
) {
    let mut pos = region_start;
    while pos < region_end {
        let remaining = region_end - pos;
        if remaining <= max_chunk_size {
            out.push((pos, region_end));
            return;
        }

        let mut end = pos + max_chunk_size;
        while end > pos && !source.is_char_boundary(end) {
            end -= 1;
        }
        if end == pos {
            match source[pos..region_end].chars().next() {
                Some(ch) => end = pos + ch.len_utf8(),
                None => return,
            }
        }
        out.push((pos, end));
        pos = end;
    }
}

use tree_sitter::Node;

pub(crate) const MAX_TREE_DEPTH: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Descend {
    Children,
}

pub(crate) fn walk_bounded<'tree, F>(root: &Node<'tree>, mut visit: F) -> usize
where
    F: FnMut(&Node<'tree>, usize) -> Descend,
{
    let mut truncated = 0usize;
    let mut cursor = root.walk();
    let mut depth = 0usize;

    loop {
        let node = cursor.node();
        let wants_children = visit(&node, depth) == Descend::Children;

        if wants_children && depth >= MAX_TREE_DEPTH {
            truncated += node.descendant_count().saturating_sub(1);
        } else if wants_children && cursor.goto_first_child() {
            depth += 1;
            continue;
        }

        loop {
            if depth == 0 {
                return truncated;
            }
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return truncated;
            }
            depth -= 1;
        }
    }
}
