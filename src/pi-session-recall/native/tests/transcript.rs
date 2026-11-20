use metis_session_recall::transcript::{Event, Gap, Role, SessionReader, branch};
use serde_json::json;
use std::{
    collections::HashMap,
    fs::{self, File},
    io,
};

const HEADER: &str = r#"{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00Z","cwd":"/project"}"#;

#[test]
fn selected_branch_recovers_only_visible_text_from_its_own_jsonl_records() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("branch.jsonl");
    let escaped = "保留原文 🦀，包括 \"引号\" 和 \\路径";
    let long = "界".repeat(513);
    let records = [
        json!({"type":"message","id":"u","parentId":null,
            "timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":escaped}}),
        json!({"type":"thinking_level_change","id":"m","parentId":"u","thinkingLevel":"high"}),
        json!({"type":"message","id":"a","parentId":"m","message":{"role":"assistant","content":[
            {"type":"thinking","thinking":"not visible"},
            {"type":"text","text":format!("{long}\r\n\r\n第二段")},
            {"type":"toolCall","name":"bash","arguments":{"command":"not visible"}},
            {"type":"text","text":"同条消息的另一个文本块"}
        ]}}),
        json!({"type":"branch_summary","id":"s","parentId":"m","summary":"not visible"}),
        json!({"type":"message","id":"other","parentId":"s","message":{"role":"user","content":"sibling only"}}),
    ];
    let raw = format!(
        "{HEADER}\r\n{}",
        records
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\r\n")
    );
    fs::write(&path, &raw).unwrap();
    let mut reader = SessionReader::open(File::open(&path).unwrap(), || Ok(())).unwrap();
    assert_eq!(
        (&*reader.header.id, &*reader.header.cwd),
        ("test-session", "/project")
    );
    let mut parents = HashMap::new();
    let mut fragments = Vec::new();
    while let Some(event) = reader.next_record(|| Ok(())).unwrap() {
        let Event::Record(record) = event else {
            panic!("unexpected coverage gap: {event:?}")
        };
        record
            .visit_fragments(|role, anchor, text| {
                fragments.push((record.entry.id.clone(), role, anchor, text.to_owned()));
                Ok(())
            })
            .unwrap();
        parents.insert(record.entry.id, record.entry.parent_id);
    }
    let lineage = branch("a", |id| {
        parents.get(id).cloned().ok_or("entry not found".into())
    })
    .unwrap();
    assert_eq!(lineage, ["u", "m", "a"]);
    let selected: Vec<_> = fragments
        .iter()
        .filter(|(id, _, _, _)| lineage.contains(id))
        .collect();
    assert_eq!(selected.len(), 5);
    let expected = [
        (Role::User, escaped.to_owned()),
        (Role::Assistant, "界".repeat(512)),
        (Role::Assistant, "界".to_owned()),
        (Role::Assistant, "第二段".to_owned()),
        (Role::Assistant, "同条消息的另一个文本块".to_owned()),
    ];
    for ((id, role, anchor, text), (expected_role, expected_text)) in
        selected.into_iter().zip(expected)
    {
        assert_eq!(*role, expected_role);
        assert_eq!(text, &expected_text);
        assert_eq!(reader.read_fragment(anchor).unwrap(), expected_text);
        let line = anchor.record.line;
        let offset = usize::try_from(line.offset).unwrap();
        let entry: serde_json::Value =
            serde_json::from_slice(&raw.as_bytes()[offset..offset + line.len]).unwrap();
        assert_eq!(entry["id"], id.as_str());
    }
}

#[test]
fn overlong_line_reports_gap_and_preserves_next_record() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("limit.jsonl");
    let huge = "x".repeat(5 * 1024 * 1024);
    let tail = r#"{"type":"message","id":"tail","parentId":"oversized","message":{"role":"user","content":"still readable"}}"#;
    let raw = format!("{HEADER}\n{{\"id\":\"oversized\",\"payload\":\"{huge}\"}}\n{tail}");
    fs::write(&path, &raw).unwrap();
    let mut reader = SessionReader::open(File::open(&path).unwrap(), || Ok(())).unwrap();
    assert!(matches!(
        reader.next_record(|| Ok(())).unwrap(),
        Some(Event::Gap {
            reason: Gap::OversizedRecord,
            ..
        })
    ));
    let Some(Event::Record(next)) = reader.next_record(|| Ok(())).unwrap() else {
        panic!("lost the next record")
    };
    assert!(!next.anchor.line.terminated);
    assert_eq!(
        next.anchor.line.offset,
        u64::try_from(raw.len() - tail.len()).unwrap()
    );
    assert_eq!(next.entry.id, "tail");
    assert!(reader.next_record(|| Ok(())).unwrap().is_none());
}

#[test]
fn changed_line_cannot_be_read_back_using_old_anchor() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("changed.jsonl");
    let line =
        r#"{"type":"message","id":"m","parentId":null,"message":{"role":"user","content":"keep"}}"#;
    let raw = format!("{HEADER}\n{line}\n");
    fs::write(&path, &raw).unwrap();
    let mut reader = SessionReader::open(File::open(&path).unwrap(), || Ok(())).unwrap();
    let Some(Event::Record(record)) = reader.next_record(|| Ok(())).unwrap() else {
        panic!("invalid fixture")
    };
    let mut anchor = None;
    record
        .visit_fragments(|_, found, _| {
            anchor = Some(found);
            Ok(())
        })
        .unwrap();
    let anchor = anchor.unwrap();
    assert_eq!(reader.read_fragment(&anchor).unwrap(), "keep");

    fs::write(&path, raw.replace("keep", "drop")).unwrap();

    assert!(reader.read_fragment(&anchor).is_err());
}

#[test]
fn unsupported_logs_and_cyclic_or_missing_branches_are_not_silently_widened() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("v2.jsonl");
    fs::write(&path, HEADER.replace("\"version\":3", "\"version\":2")).unwrap();
    let Err(error) = SessionReader::open(File::open(&path).unwrap(), || Ok(())) else {
        panic!("accepted v2")
    };
    assert_eq!(
        error.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::Unsupported
    );
    assert!(branch("present", |_| Ok(Some("present".into()))).is_err());
    assert!(branch("absent", |_| Err("entry not found".into())).is_err());
}
