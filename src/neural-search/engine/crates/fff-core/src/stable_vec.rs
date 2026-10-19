/// Uniquely owned vector with a fixed append capacity.
///
/// Off-lock work must copy its inputs under the picker lock, never clone a
/// shared backing allocation. This makes mutable element access ordinary Rust
/// borrowing while preserving the watcher's capacity-exhaustion contract.
#[derive(Debug, Clone)]
pub(crate) struct StableVec<T> {
    inner: Vec<T>,
}

impl<T> StableVec<T> {
    pub fn from_vec_with_reserve(mut vec: Vec<T>, extra: usize) -> Self {
        vec.reserve(extra);
        Self { inner: vec }
    }

    /// Append without reallocating. Returns `false` if capacity is exhausted.
    #[inline]
    pub fn push(&mut self, item: T) -> bool {
        let len = self.inner.len();
        let cap = self.inner.capacity();
        if len >= cap {
            debug_assert!(
                false,
                "StableVec: push would exceed capacity ({len} at capacity {cap})"
            );
            tracing::error!(
                len,
                capacity = cap,
                "StableVec: capacity exhausted — dropping item to prevent reallocation"
            );
            return false;
        }
        self.inner.push(item);
        true
    }
}

impl<T> std::ops::Deref for StableVec<T> {
    type Target = [T];

    #[inline]
    fn deref(&self) -> &[T] {
        &self.inner
    }
}

impl<T> std::ops::DerefMut for StableVec<T> {
    #[inline]
    fn deref_mut(&mut self) -> &mut [T] {
        &mut self.inner
    }
}
