//! Dedicated rayon pools keep background IO separate from interactive search.

use std::sync::LazyLock;

/// Dedicated thread pool for background scanning and binary classification.
pub static BACKGROUND_THREAD_POOL: LazyLock<rayon::ThreadPool> = LazyLock::new(|| {
    let total = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(4);

    // Background work is mostly syscall-bound; halving parallelism leaves
    // cores for search/UI at negligible throughput cost.
    let bg_threads = (total / 2).max(2);
    rayon::ThreadPoolBuilder::new()
        .num_threads(bg_threads)
        .thread_name(|i| format!("fff-bg-{i}"))
        .build()
        .expect("failed to create background rayon pool")
});

/// Pool for grep content search, using available logical cores on Linux.
pub static SEARCH_THREAD_POOL: LazyLock<rayon::ThreadPool> = LazyLock::new(|| {
    let threads = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(4);

    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("fff-search-{i}"))
        .build()
        .expect("failed to create search rayon pool")
});
