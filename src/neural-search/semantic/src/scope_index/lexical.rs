//! Request-only query frequencies. Never retain decoded records or full counts.
use crate::{Result, index::Record};
use std::collections::BTreeMap;

const SCRATCH: usize = 1 << 20;

pub(super) struct Statistics<'a> {
    pub words: &'a [String],
    pub rows: Vec<Vec<usize>>,
}
impl Statistics<'_> {
    pub fn fits(records: usize, query: &BTreeMap<String, usize>) -> bool {
        // Include coordinator slots plus twice the in-flight row slots for
        // worker Vec capacity growth; frequency buffers themselves move, not clone.
        // A wide/large geometry keeps the old two-pass bounded algorithm.
        let Some(row_bytes) = query
            .len()
            .checked_add(1)
            .and_then(|n| n.checked_mul(size_of::<usize>()))
            .and_then(|n| n.checked_add(3 * size_of::<Vec<usize>>()))
        else {
            return false;
        };
        let words = query.keys().try_fold(0usize, |sum, word| {
            sum.checked_add(word.len() + size_of::<String>() + 2 * size_of::<usize>())
        });
        records
            .checked_mul(row_bytes)
            .zip(words)
            .is_some_and(|(rows, words)| rows.checked_add(words).is_some_and(|n| n <= SCRATCH))
    }
    pub fn row(record: &Record<'_>, words: &[String]) -> Vec<usize> {
        let mut row = Vec::with_capacity(words.len() + 1);
        row.push(record.length);
        row.extend(
            words
                .iter()
                .map(|word| record.chunk.counts.get(word).copied().unwrap_or(0)),
        );
        row
    }
    pub fn finish(self, expected: usize, output: &mut [f64]) -> Result<()> {
        let mut length = 0usize;
        let mut df = vec![0usize; self.words.len()];
        for row in &self.rows {
            if row.len() != self.words.len() + 1 {
                return Err("incomplete lexical statistics".into());
            }
            length = length.checked_add(row[0]).ok_or("corpus length overflow")?;
            for (df, tf) in df.iter_mut().zip(&row[1..]) {
                *df += usize::from(*tf > 0);
            }
        }
        if length != expected {
            return Err("inconsistent corpus length".into());
        }
        let count = self.rows.len();
        let avg = (length as f64 / count.max(1) as f64).max(1.0);
        let idf: Vec<_> = df
            .into_iter()
            .map(|df| crate::inverse_document_frequency(count, df))
            .collect();
        for (result, row) in output.iter_mut().zip(self.rows) {
            // Same sorted term order and Sum<f64> identity (including -0.0).
            *result = row[1..]
                .iter()
                .zip(&idf)
                .filter(|(tf, _)| **tf > 0)
                .map(|(&tf, &idf)| crate::term_score(idf, tf, row[0], avg))
                .sum();
        }
        Ok(())
    }
}
