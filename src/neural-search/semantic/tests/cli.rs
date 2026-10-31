use std::fs;
use std::process::{Command, Output};

fn search(flags: &[&str], query: &str) -> Output {
    let fixture = tempfile::tempdir().unwrap();
    for name in ["home", "scope", "tmp"] {
        fs::create_dir(fixture.path().join(name)).unwrap();
    }
    Command::new(env!("CARGO_BIN_EXE_sgrep"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("HOME", fixture.path().join("home"))
        .env("TMPDIR", fixture.path().join("tmp"))
        .env("HF_HUB_OFFLINE", "1")
        .args(flags)
        .arg("--")
        .arg(query)
        .arg(fixture.path().join("scope"))
        .output()
        .unwrap()
}

#[test]
fn empty_host_protocol_is_successful() {
    let result = search(&["--json", "--metis-protocol", "1"], "cache validation");
    assert_eq!(result.status.code(), Some(0));
    assert!(result.stderr.is_empty());
    let wire: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(wire, serde_json::json!({"protocol": 1, "results": []}));
}

#[test]
fn ordinary_cli_preserves_empty_no_match_status() {
    for flags in [vec![], vec!["--json"]] {
        let result = search(&flags, "cache validation");
        assert_eq!(result.status.code(), Some(1));
        assert!(result.stderr.is_empty());
        if flags.is_empty() {
            assert!(result.stdout.is_empty());
        } else {
            let wire: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(wire, serde_json::json!([]));
        }
    }
}

#[test]
fn host_errors_are_not_empty_success() {
    for (flags, query) in [
        (vec!["--json", "--metis-protocol", "1"], "the"),
        (vec!["--json", "--metis-protocol", "2"], "cache validation"),
    ] {
        let result = search(&flags, query);
        assert_eq!(result.status.code(), Some(2));
        assert!(result.stdout.is_empty());
        assert!(!result.stderr.is_empty());
    }
}
