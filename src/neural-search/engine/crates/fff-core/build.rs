fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    assert_eq!(
        target, "x86_64-unknown-linux-gnu",
        "Metis neural search supports Linux x64 glibc only"
    );

    // Preserve development diagnostics and opt-in release rescan accounting.
    println!("cargo::rustc-check-cfg=cfg(rescan_stats)");
    if std::env::var("DEBUG").is_ok_and(|debug| debug != "false")
        || std::env::var("CARGO_FEATURE_RESCAN_STATS").is_ok()
    {
        println!("cargo::rustc-cfg=rescan_stats");
    }
}
