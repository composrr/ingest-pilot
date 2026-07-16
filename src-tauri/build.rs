fn main() {
    // Tauri sidecars are named `<name>-<target-triple><exe-suffix>` in `src-tauri/binaries/`
    // (see docs/design/BUNDLING.md). Cargo only exposes TARGET to build scripts, so re-export
    // it to the crate — `wire_bundled_tool_env()` needs it to locate the ffmpeg sidecar in dev.
    println!(
        "cargo:rustc-env=INGEST_PILOT_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("cargo sets TARGET for build scripts")
    );
    tauri_build::build()
}
