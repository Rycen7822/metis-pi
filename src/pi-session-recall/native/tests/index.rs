use metis_session_recall::index::{CoverageGap, Index, LexicalHit, Scope};
use rusqlite::Connection;
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    cache: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let cache = temp.path().join("index");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&cache).unwrap();
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
        Self { temp, root, cache }
    }

    fn index(&self) -> Index {
        Index::open(&self.root, &self.cache).unwrap()
    }

    fn write(&self, path: &str, cwd: &str, lines: &[String]) -> PathBuf {
        let dest = self.root.join(path);
        let head = json!({"type":"session","version":3,"id":path,"cwd":cwd});
        fs::write(&dest, format!("{head}\n{}", lines.join("\n"))).unwrap();
        dest
    }
}

fn msg(id: &str, parent: Option<&str>, content: &str) -> String {
    json!({
        "type":"message","id":id,"parentId":parent,"timestamp":"2026-07-01T00:00:00Z",
        "message":{"role":"user","content":content},
    })
    .to_string()
}

fn append(path: &Path, text: &str) {
    OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

fn hits(index: &Index, query: &str, scope: Scope<'_>) -> Vec<LexicalHit> {
    let result = index.search(query, scope, 20, || Ok(())).unwrap();
    assert_eq!(
        result.stale_candidates, 0,
        "verify current durable text for each hit"
    );
    result.hits
}

#[test]
fn bm25_scopes_candidates_before_limiting_and_can_read_chinese_and_identifiers() {
    let f = Fixture::new();
    let leaf = msg("leaf", Some("label"), "中文搜索：bake_texture + buildCache");
    f.write(
        "fork.jsonl",
        "/project",
        &[
            msg("main", None, "earlier context"),
            json!({"type":"label","id":"label","parentId":"main","targetId":"main","label":"t"})
                .to_string(),
            leaf,
            msg(
                "other",
                Some("label"),
                "bake_texture bake_texture bake_texture sibling marker",
            ),
        ],
    );
    f.write(
        "excluded.jsonl",
        "/other",
        &[msg("leaf", None, "bake_texture foreign")],
    );
    let mut index = f.index();
    assert!(index.refresh(|| Ok(())).unwrap().gaps.is_empty());
    let branch = || Scope::Branch {
        path: Path::new("fork.jsonl"),
        leaf: "leaf",
    };

    let one = index
        .search("bake_texture", branch(), 1, || Ok(()))
        .unwrap();
    assert_eq!(one.hits.len(), 1);
    assert_eq!(one.hits[0].entry_id, "leaf");
    assert_eq!(one.hits[0].parent_id.as_deref(), Some("label"));
    assert_eq!(one.hits[0].text, "中文搜索：bake_texture + buildCache");
    assert!(one.hits[0].bm25 > 0.0);
    assert!(hits(&index, "sibling marker", branch()).is_empty());
    assert_eq!(hits(&index, "文搜", branch()).len(), 1);
    assert_eq!(hits(&index, "索", branch()).len(), 1);
    assert_eq!(hits(&index, "texture", branch()).len(), 1);
    assert_eq!(hits(&index, "build", branch()).len(), 1);
    assert_eq!(
        hits(&index, "bake_texture", Scope::Project("/project")).len(),
        2
    );
    assert_eq!(
        hits(
            &index,
            "bake_texture",
            Scope::Session(Path::new("excluded.jsonl"))
        )
        .len(),
        1
    );
}

#[test]
fn incremental_scan_revisits_partial_tail_and_matches_clean_rebuild() {
    let f = Fixture::new();
    let path = f.write("a.jsonl", "/project", &[msg("u", None, "kernel base")]);
    let mut index = f.index();
    assert!(index.refresh(|| Ok(())).unwrap().gaps.is_empty());
    let first = hits(&index, "kernel", Scope::All);
    assert_eq!(first.len(), 1);

    // Commit a complete newline-terminated record, then leave an incomplete final JSON object.
    let tail = msg("tail", Some("u"), "kernel recovered");
    let split = tail.len() / 2;
    append(&path, &format!("\n{}", &tail[..split]));
    let pending = index.refresh(|| Ok(())).unwrap();
    assert_eq!(
        pending.gaps,
        [(PathBuf::from("a.jsonl"), CoverageGap::SkippedRecords(1))]
    );
    let anchor_id = hits(&index, "kernel", Scope::All)[0].chunk_id;
    append(&path, &tail[split..]);
    assert!(index.refresh(|| Ok(())).unwrap().gaps.is_empty());
    append(&path, "\n");
    assert!(index.refresh(|| Ok(())).unwrap().gaps.is_empty());
    assert!(index.refresh(|| Ok(())).unwrap().gaps.is_empty());

    let other_cache = f.temp.path().join("fresh-cache");
    fs::create_dir(&other_cache).unwrap();
    fs::set_permissions(&other_cache, fs::Permissions::from_mode(0o700)).unwrap();
    let mut fresh = Index::open(&f.root, &other_cache).unwrap();
    fresh.refresh(|| Ok(())).unwrap();
    let final_hits = hits(&index, "kernel", Scope::All);
    assert_eq!(final_hits.len(), 2);
    assert!(
        final_hits
            .iter()
            .any(|hit| hit.entry_id == "u" && hit.chunk_id == anchor_id)
    );
    let sorted_texts = |rows: Vec<LexicalHit>| {
        let mut texts: Vec<_> = rows.into_iter().map(|hit| hit.text).collect();
        texts.sort();
        texts
    };
    let expected = vec!["kernel base", "kernel recovered"];
    assert_eq!(sorted_texts(final_hits), expected);
    assert_eq!(sorted_texts(hits(&fresh, "kernel", Scope::All)), expected);
}

#[test]
fn rewrites_and_deletions_retire_obsolete_postings_and_never_reuse_chunk_ids() {
    let f = Fixture::new();
    let path = f.write(
        "rewrite.jsonl",
        "/project",
        &[msg("a", None, "oldstamp"), "".into()],
    );
    let mut index = f.index();
    index.refresh(|| Ok(())).unwrap();
    let first = hits(&index, "oldstamp", Scope::All).pop().unwrap();
    let before = fs::read_to_string(&path).unwrap();

    // Same path, inode and byte length. A raw-text recheck must reject the old candidate before refresh.
    fs::write(&path, before.replace("oldstamp", "midstamp")).unwrap();
    let stale = index.search("oldstamp", Scope::All, 5, || Ok(())).unwrap();
    assert!(stale.hits.is_empty());
    assert_eq!(stale.stale_candidates, 1);
    index.refresh(|| Ok(())).unwrap();
    assert!(hits(&index, "oldstamp", Scope::All).is_empty());
    let middle = hits(&index, "midstamp", Scope::All).pop().unwrap();
    assert!(middle.chunk_id > first.chunk_id);

    // Rewrite the indexed prefix and grow the file. Size-only append detection leaks "midstamp".
    let edited = before.replace("oldstamp", "newstamp");
    fs::write(
        &path,
        format!("{}{}\n", edited, msg("b", Some("a"), "anotherrecord")),
    )
    .unwrap();
    index.refresh(|| Ok(())).unwrap();
    assert!(hits(&index, "midstamp", Scope::All).is_empty());
    assert!(hits(&index, "newstamp", Scope::All)[0].chunk_id > middle.chunk_id);
    assert_eq!(hits(&index, "anotherrecord", Scope::All).len(), 1);

    fs::remove_file(&path).unwrap();
    assert_eq!(index.refresh(|| Ok(())).unwrap().files, 0);
    assert!(hits(&index, "anotherrecord newstamp", Scope::All).is_empty());
}

#[test]
fn failed_sqlite_batch_does_not_publish_postings_or_advance_past_rolled_back_rows() {
    let f = Fixture::new();
    let path = f.write(
        "batch.jsonl",
        "/project",
        &[msg("seed", None, "stable"), "".into()],
    );
    let mut index = f.index();
    index.refresh(|| Ok(())).unwrap();
    append(
        &path,
        &format!(
            "{}\n{}\n",
            msg("valid", Some("seed"), "transactional first"),
            msg("fail", Some("valid"), "transactional second")
        ),
    );
    let fault = Connection::open(f.cache.join("index.sqlite3")).unwrap();
    fault
        .execute_batch(
            "CREATE TRIGGER fail_sqlite_write BEFORE INSERT ON entries WHEN NEW.id='fail'
         BEGIN SELECT RAISE(ABORT, 'test aborts the second row of the batch'); END;",
        )
        .unwrap();

    let error = index.refresh(|| Ok(())).unwrap_err();
    assert!(error.to_string().contains("test aborts the second row"));
    assert!(hits(&index, "transactional", Scope::All).is_empty());
    assert_eq!(hits(&index, "stable", Scope::All).len(), 1);
    drop(index);
    fault
        .execute_batch("DROP TRIGGER fail_sqlite_write")
        .unwrap();

    let mut reopened = f.index();
    assert!(reopened.refresh(|| Ok(())).unwrap().gaps.is_empty());
    let found = hits(&reopened, "transactional", Scope::All);
    assert_eq!(found.len(), 2);
    assert!(found.iter().any(|hit| hit.entry_id == "valid"));
    assert!(found.iter().any(|hit| hit.entry_id == "fail"));
}

#[test]
fn source_mutation_during_a_write_is_retried_from_the_unadvanced_cursor() {
    let f = Fixture::new();
    let path = f.write(
        "race.jsonl",
        "/project",
        &[msg("seed", None, "stable"), "".into()],
    );
    let mut index = f.index();
    index.refresh(|| Ok(())).unwrap();
    append(
        &path,
        &format!("{}\n", msg("pending", Some("seed"), "newbatch before")),
    );
    let probe = Connection::open(f.cache.join("index.sqlite3")).unwrap();
    probe.busy_timeout(std::time::Duration::ZERO).unwrap();
    let mut changed = false;

    let cause = index
        .refresh(|| {
            if !changed {
                // The real SQLite writer lock identifies a publish attempt without timing or callback counts.
                match probe.execute_batch("BEGIN IMMEDIATE") {
                    Ok(()) => probe.execute_batch("ROLLBACK")?,
                    Err(rusqlite::Error::SqliteFailure(error, _))
                        if error.code == rusqlite::ErrorCode::DatabaseBusy =>
                    {
                        append(
                            &path,
                            &format!("{}\n", msg("later", Some("pending"), "newbatch added")),
                        );
                        changed = true;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(())
        })
        .unwrap_err();

    assert!(changed);
    assert!(
        cause
            .to_string()
            .contains("session changed during Recall refresh")
    );
    assert!(hits(&index, "newbatch", Scope::All).is_empty());
    index.refresh(|| Ok(())).unwrap();
    assert_eq!(hits(&index, "newbatch", Scope::All).len(), 2);
}

#[test]
#[ignore = "requires verified local Bekko128 assets; set RECALL_TEST_BEKKO_DIR"]
fn real_bekko_finds_a_paraphrase_without_lexical_overlap_and_limits_repetition() {
    use std::sync::Arc;

    let f = Fixture::new();
    let model =
        PathBuf::from(std::env::var_os("RECALL_TEST_BEKKO_DIR").expect("local model assets"));
    let encoder = Arc::new(metis_bekko::Encoder::open(&model).unwrap());
    let relevant = "Preserve the originals before building an index.";
    let repetitions: Vec<_> = (0..220)
        .map(|i| msg(&i.to_string(), None, relevant))
        .collect();
    f.write("a-long.jsonl", "/project", &repetitions);
    f.write(
        "b-target.jsonl",
        "/project",
        &[msg("target", None, relevant)],
    );
    f.write(
        "c-noise.jsonl",
        "/project",
        &[msg("noise", None, "A whale swims under the coral reef.")],
    );
    let mut index = Index::open_hybrid(&f.root, &f.cache, encoder.clone()).unwrap();
    let db = Connection::open(f.cache.join("index.sqlite3")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER fail_vector BEFORE INSERT ON vectors
         BEGIN SELECT RAISE(ABORT, 'test vector write failure'); END;",
    )
    .unwrap();
    assert!(
        index
            .refresh(|| Ok(()))
            .unwrap_err()
            .to_string()
            .contains("test vector write failure")
    );
    assert!(hits(&index, "originals", Scope::All).is_empty());
    drop(index);
    db.execute_batch("DROP TRIGGER fail_vector").unwrap();

    let mut index = Index::open_hybrid(&f.root, &f.cache, encoder).unwrap();
    assert!(index.refresh(|| Ok(())).unwrap().gaps.is_empty());
    let query = "retain source history";
    assert!(hits(&index, query, Scope::All).is_empty());
    let response = index.hybrid(query, Scope::All, || Ok(())).unwrap();
    let top = &response.sessions[..2];
    assert!(
        top.iter()
            .any(|session| session.session_path.ends_with("b-target.jsonl"))
    );
    assert!(
        top.iter()
            .all(|session| session.hits[0].evidence.text == relevant)
    );
    assert_eq!(response.stale_candidates, 0);
}

#[test]
fn root_isolation_excludes_archives_and_rejects_rebinding_or_out_of_scope_paths() {
    let f = Fixture::new();
    let outside = f.temp.path().join("another-root");
    fs::create_dir(&outside).unwrap();
    let real = f.write(
        "allowed.jsonl",
        "/project",
        &[msg("m", None, "allowedsession")],
    );
    let not_allowed = outside.join("outside.jsonl");
    fs::write(
        &not_allowed,
        fs::read_to_string(real)
            .unwrap()
            .replace("allowedsession", "rejected"),
    )
    .unwrap();
    fs::create_dir(f.root.join("allowed-blobs")).unwrap();
    fs::copy(&not_allowed, f.root.join("allowed-blobs/archive.jsonl")).unwrap();

    let mut index = f.index();
    assert_eq!(index.refresh(|| Ok(())).unwrap().files, 1);
    assert!(hits(&index, "rejected", Scope::All).is_empty());
    assert_eq!(hits(&index, "allowedsession", Scope::All).len(), 1);
    let escaped = Scope::Session(Path::new("../another-root/outside.jsonl"));
    assert!(index.search("rejected", escaped, 5, || Ok(())).is_err());
    assert!(Index::open(&outside, &f.cache).is_err());
}
