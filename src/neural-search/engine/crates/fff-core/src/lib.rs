//! # FFF Search — High-performance file finder core
//!
//! This crate provides the core search engine for [FFF (Fast File Finder)](https://github.com/dmtrKovalenko/fff).
//! It includes filesystem indexing with real-time watching, fuzzy matching powered
//! by [frizbee](https://docs.rs/neo_frizbee), frecency scoring backed by LMDB,
//! and multi-mode grep search.
//!
//! > [!Important performance information]  
//! > Linux x64/glibc engine using the required zlob backend (Zig 0.16.0 at build time).
//!
//! ## Architecture
//!
//! - [`file_picker::FilePicker`] — Main entry point. Indexes a directory tree in a
//!   background thread, maintains a sorted file list, watches the filesystem for
//!   changes, and performs fuzzy search with frecency-weighted scoring.
//! - [`frecency::FrecencyTracker`] — LMDB-backed database that tracks file access
//!   and modification patterns for intelligent result ranking.
//! - [`query_tracker::QueryTracker`] — Tracks search query history and provides
//!   "combo-boost" scoring for repeatedly matched files.
//! - [`grep`] — Live grep search supporting regex, plain-text, and fuzzy modes
//!   with optional constraint filtering.
//! - [`git`] — Git status caching and repository detection.
//! - [`watch`] — Background OS watcher maintaining the searchable index.
//!
//! ## Shared State
//!
//! [`SharedFilePicker`], [`SharedFrecency`], and [`SharedQueryTracker`] are
//! newtype wrappers around `Arc<RwLock<Option<T>>>` for thread-safe shared
//! access. They provide `read()` / `write()` methods with built-in error
//! conversion and convenience helpers like `wait_for_scan()`.
//!
//! ## Quick Start
//!
//! ```
//! use fff_search::file_picker::FilePicker;
//! use fff_search::frecency::FrecencyTracker;
//! use fff_search::query_tracker::QueryTracker;
//! use fff_search::{
//!     FilePickerOptions, FuzzySearchOptions, PaginationArgs, QueryParser,
//!     SharedFrecency, SharedFilePicker, SharedQueryTracker,
//! };
//!
//! let shared_picker = SharedFilePicker::default();
//! let shared_frecency = SharedFrecency::default();
//! let shared_query_tracker = SharedQueryTracker::default();
//!
//! let tmp = std::env::temp_dir().join("fff-doctest");
//! std::fs::create_dir_all(&tmp).unwrap();
//!
//! // 1. Optionally initialize frecency and query tracker databases
//! let frecency = FrecencyTracker::open(tmp.join("frecency"))?;
//! shared_frecency.init(frecency)?;
//!
//! let query_tracker = QueryTracker::open(tmp.join("queries"))?;
//! shared_query_tracker.init(query_tracker)?;
//!
//! // 2. Init the file picker (spawns background scan + watcher)
//! FilePicker::new_with_shared_state(
//!     shared_picker.clone(),
//!     shared_frecency.clone(),
//!     FilePickerOptions {
//!         base_path: ".".into(),
//!         ..Default::default()
//!     },
//! )?;
//!
//! // 3. Wait for scan
//! shared_picker.wait_for_scan(std::time::Duration::from_secs(10));
//!
//! // 4. Search: lock the picker and query tracker
//! let picker_guard = shared_picker.read()?;
//! let picker = picker_guard.as_ref().unwrap();
//! let qt_guard = shared_query_tracker.read()?;
//!
//! // 5. Parse the query and perform fuzzy search
//! let parser = QueryParser::default();
//! let query = parser.parse("lib.rs");
//!
//! let results = picker.fuzzy_search(
//!     &query,
//!     qt_guard.as_ref(),
//!     FuzzySearchOptions {
//!         max_threads: 0,
//!         current_file: None,
//!         pagination: PaginationArgs { offset: 0, limit: 50 },
//!         ..Default::default()
//!     },
//! );
//!
//! assert!(results.total_matched > 0);
//! assert!(results.items.first().unwrap().relative_path(picker).ends_with("lib.rs"));
//!
//! let _ = std::fs::remove_dir_all(&tmp);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

/// Primary entry points with thread-safe [`SharedFilePicker`](shared::FilePicker) instance
pub mod shared;
pub use shared::*;

/// Core file picker single thread: filesystem indexing, background watching, and fuzzy search.
/// See [`FilePicker`](file_picker::FilePicker) for the main entry point.
pub mod file_picker;
pub use file_picker::*;

/// Database-backed persistence: frecency, query history, LMDB plumbing.
pub mod dbs;
pub use dbs::*;

/// Git status caching and repository detection utilities.
pub mod git;

pub mod git_recency;
pub use git_recency::GitRecencyConfig;

/// Live grep search with regex, plain-text, and fuzzy matching modes.
pub mod grep;
pub use grep::*;

/// Lightweight trace helpers (uses the embedding host's subscriber).
pub mod log;

/// Various path utils might be handy for you to work with fff paths
pub mod path_utils;

/// Core data types shared across the crate.
pub mod types;
pub use types::*;

pub mod constants;

/// Watcher rescan request accounting.
pub mod rescan_stats;
pub use rescan_stats::{RESCAN_STATS_ENABLED, RescanReason, RescanStats};

mod rescan_throttle;

// ==================================
// these are public only for benchmarks, no backward compatibility guaranteed
#[doc(hidden)]
pub mod simd_string_utils;
// ==================================

mod binary_classifier;
mod error;
mod git_status_worker;
mod ignore;
mod scan;
mod score;
mod sort_buffer;

pub(crate) mod index;
pub(crate) mod parallelism;
pub(crate) mod simd_path;
pub(crate) mod stable_vec;
pub(crate) mod walk;

/// Background OS watcher maintaining the file index.
#[path = "watcher/mod.rs"]
pub mod watch;

// fff error
pub use error::{Error, Result};

pub use fff_query_parser::*;
