fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    assert!(
        matches!(target.as_str(), "x86_64-unknown-linux-gnu" | "x86_64-pc-windows-msvc"),
        "Metis neural search supports Linux x64 glibc and Windows x64 MSVC only, not {target}"
    );

    // Preserve development diagnostics and opt-in release rescan accounting.
    println!("cargo::rustc-check-cfg=cfg(rescan_stats)");
    if std::env::var("DEBUG").is_ok_and(|debug| debug != "false")
        || std::env::var("CARGO_FEATURE_RESCAN_STATS").is_ok()
    {
        println!("cargo::rustc-cfg=rescan_stats");
    }
}
