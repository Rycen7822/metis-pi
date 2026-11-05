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
fn runtime_check_distinguishes_local_reinstall_from_remote_offline_acquisition() {
    for (version, directory, expected) in [
        (1, None, "offline acquisition is disabled"),
        (2, None, "reinstall the prepared runtime"),
        (2, Some("absolute"), "reinstall the prepared runtime"),
        (2, Some("relative"), "unapproved model or file set"),
        (1, Some("absolute"), "unapproved model or file set"),
    ] {
        let fixture = tempfile::tempdir().unwrap();
        let mut models = serde_json::Map::new();
        for (name, revision, files) in [
            (
                "bekko128",
                "c18167b8f244c1bc6de21ce9b710bac8a29c4615",
                vec!["manifest.json", "tokenizer.json", "bekko128.pack"],
            ),
            (
                "lateon-edge",
                "4bcdf5ed93f791259eb130b577a240f753d68dd8",
                vec![
                    "manifest.json",
                    "tokenizer.json",
                    "embedding_preln_f16.pack",
                    "backbone.ort",
                ],
            ),
        ] {
            let files: serde_json::Map<String, serde_json::Value> = files
                .into_iter()
                .map(|name| {
                    (
                        name.into(),
                        serde_json::json!({"bytes": 1, "sha256": "0".repeat(64)}),
                    )
                })
                .collect();
            models.insert(
                name.into(),
                serde_json::json!({"revision": revision, "files": files}),
            );
        }
        if let Some(directory) = directory {
            let directory = if directory == "absolute" {
                fixture.path().join("shared-model")
            } else {
                "relative-model".into()
            };
            models.get_mut("bekko128").unwrap()["directory"] =
                directory.to_string_lossy().into_owned().into();
        }
        let mut catalog = serde_json::json!({"format_version": version, "models": models});
        if version == 1 {
            catalog["repository"] = "fixture/prepared".into();
            catalog["revision"] = "1".repeat(40).into();
        }
        fs::write(fixture.path().join("assets.json"), catalog.to_string()).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_sgrep"))
            .env("SGREP_RUNTIME_DIR", fixture.path())
            .env("HF_HUB_OFFLINE", "1")
            .arg("--check-runtime")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains(expected));
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
