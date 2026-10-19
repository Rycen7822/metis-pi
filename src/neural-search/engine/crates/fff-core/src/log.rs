//! Trace IDs/spans use the embedding host's subscriber. No file backend or
//! process-global panic/signal hook is installed by the search engine.

pub fn generate_trace_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TRACE_COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);

    let pid = std::process::id() as u64;
    let counter = TRACE_COUNTER.fetch_add(1, Ordering::Relaxed);

    // very simple hash functions helps to distinguish trace ids visually
    let id = nanos ^ (pid.wrapping_mul(0x9E37_79B9_7F4A_7C15)) ^ (counter << 32);
    format!("{:016x}", id)
}

pub fn trace_span(trace_id: &str, label: &'static str) -> tracing::Span {
    tracing::info_span!("fff.trace", trace_id = trace_id, label = label)
}
