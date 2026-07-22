mod commands;
mod core;
mod ingest;
mod platform;
mod sync;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

/// Whether closing the window should hide to the tray (true) or quit (false).
/// Kept in sync with `settings.camera_watcher.tray_mode` by `save_settings` so the
/// window-close handler can decide without re-reading the file each time.
pub struct BackgroundMode(pub AtomicBool);

/// Shows, unminimizes, and focuses the main window — the single place we surface the
/// app from the tray/background (tray click, card insert, ingest complete, relaunch).
pub fn show_and_focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The exact target triple, re-exported by `build.rs`. Tauri sidecars carry it in
/// their filename (`ffmpeg-x86_64-pc-windows-msvc.exe`) inside `src-tauri/binaries/`.
const TARGET_TRIPLE: &str = env!("INGEST_PILOT_TARGET_TRIPLE");

#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

/// Directories to probe for bundled tools, most-authoritative first.
///
/// Packaged builds resolve via the resource dir / the app exe's own folder. `tauri dev`
/// is the awkward case: `resource_dir()` points at `target/<profile>`, never at the
/// source `resources/` folder, so nothing bundled is actually laid out yet. We therefore
/// also anchor on the crate dir (baked in at compile time) and walk up from the exe.
fn bundled_tool_roots(resource_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Some(resource_dir) = resource_dir {
        roots.push(resource_dir);
    }

    // Installed sidecars sit next to the app executable. In dev that's
    // `src-tauri/target/<profile>/`, so a few ancestors also reach `src-tauri/`.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.extend(dir.ancestors().take(4).map(Path::to_path_buf));
        }
    }

    // Dev only: the source tree that `scripts/fetch-tools.ps1` populates. Gated so a
    // release build can never reach back to a path that only existed on the build machine.
    #[cfg(debug_assertions)]
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    roots
}

/// Every place an ffmpeg we control might live, relative to each root.
fn ffmpeg_candidates(roots: &[PathBuf]) -> Vec<PathBuf> {
    let sidecar = format!("ffmpeg-{TARGET_TRIPLE}{EXE_SUFFIX}");
    let plain = format!("ffmpeg{EXE_SUFFIX}");
    let mut candidates = Vec::new();
    for root in roots {
        // Packaged: Tauri strips the triple and installs the sidecar beside the app exe.
        candidates.push(root.join(&plain));
        // Dev: the CLI stages the triple-suffixed sidecar into target/<profile>/.
        candidates.push(root.join(&sidecar));
        // Dev: the checked-out layout written by scripts/fetch-tools.ps1.
        candidates.push(root.join("binaries").join(&sidecar));
        candidates.push(root.join("binaries").join(&plain));
    }
    candidates
}

/// Every place an exiftool we control might live, relative to each root. The Windows
/// exiftool needs its `exiftool_files/` sibling, so it always ships as a folder.
fn exiftool_candidates(roots: &[PathBuf]) -> Vec<PathBuf> {
    let name = format!("exiftool{EXE_SUFFIX}");
    let mut candidates = Vec::new();
    for root in roots {
        // Packaged resources keep their src-tauri-relative path under the resource dir;
        // in dev this same shape resolves against the crate dir.
        candidates.push(
            root.join("resources")
                .join("tools")
                .join("exiftool")
                .join(&name),
        );
        candidates.push(root.join("tools").join("exiftool").join(&name));
        candidates.push(root.join(&name));
    }
    candidates
}

/// Exports `var` to the first candidate that exists, unless the caller already set it.
/// Returns the path it settled on, for logging/tests.
fn set_tool_env(var: &str, candidates: &[PathBuf]) -> Option<PathBuf> {
    // An explicitly-set override always wins — never stomp it.
    if let Some(existing) = std::env::var_os(var) {
        return Some(PathBuf::from(existing));
    }
    let found = candidates.iter().find(|path| path.is_file())?.clone();
    std::env::set_var(var, &found);
    Some(found)
}

/// If a slim ffmpeg / exiftool ships alongside the app — or sits in the dev source tree —
/// export `INGEST_PILOT_FFMPEG` / `INGEST_PILOT_EXIFTOOL` so the extractors in
/// `ingest::copier` (which are Tauri-agnostic and only read env/PATH) find them. Absent
/// binaries are simply skipped: discovery degrades to PATH and then to the placeholder
/// thumbnail tier, so this never panics and never blocks startup.
fn wire_bundled_tool_env(app: &AppHandle) {
    let roots = bundled_tool_roots(app.path().resource_dir().ok());

    let ffmpeg = set_tool_env("INGEST_PILOT_FFMPEG", &ffmpeg_candidates(&roots));
    let exiftool = set_tool_env("INGEST_PILOT_EXIFTOOL", &exiftool_candidates(&roots));

    // Surfaced in the `tauri dev` console so a missing tool is diagnosable without a
    // debugger — this is the difference between an R3D thumbnail and a placeholder card.
    #[cfg(debug_assertions)]
    {
        match &ffmpeg {
            Some(path) => eprintln!("[tools] ffmpeg:   {}", path.display()),
            None => eprintln!("[tools] ffmpeg:   not bundled (run scripts/fetch-tools.ps1); falling back to PATH"),
        }
        match &exiftool {
            Some(path) => eprintln!("[tools] exiftool: {}", path.display()),
            None => eprintln!("[tools] exiftool: not bundled (run scripts/fetch-tools.ps1); .R3D/.BRAW will use placeholders"),
        }
    }
    let _ = (ffmpeg, exiftool);
}

/// Grant the webview read access to one directory of GENERATED thumbnails.
///
/// # What this model actually guarantees
///
/// The static scope in `tauri.conf.json` is empty and stays empty: we never allowlist `**`,
/// and we never allowlist a source volume. The scope is widened only at runtime, one
/// directory at a time, to directories that hold thumbnails this app generated.
///
/// The guarantee is therefore narrower than "the webview can't see your media", and it is
/// worth stating exactly, because the weaker claim is the one that's true:
///
///   * The webview can NOT read raw bytes of any file — not the media on a card, not an
///     arbitrary file on disk. It cannot `convertFileSrc` its way to `C:\Users\…\id_rsa`.
///   * The webview CAN obtain a downscaled JPEG re-encode of any media file it can name, by
///     asking `generate_source_thumbnails` for it. That is the point of the feature — the
///     picker has to show previews of files the user pointed us at — but it does mean the
///     boundary is "no raw file reads", not "no access to media content".
///   * Grants last for the process lifetime and are not persisted; a restart starts empty.
///
/// This is not a meaningful escalation in practice: a webview compromised enough to call
/// `generate_source_thumbnails` can already call `run_ingest` and copy the media anywhere.
/// The scope exists to keep an *ordinary* bug or a stray URL from turning into a file read,
/// not to defend against our own frontend.
///
/// Absent directories are skipped rather than created: this runs on paths that may live on a
/// drive that isn't mounted, and (like `wire_bundled_tool_env`) it must never panic or block.
fn allow_thumbnail_dir(app: &AppHandle, dir: &Path) {
    if !dir.is_dir() {
        return;
    }
    // `true` = recursive: the report writer nests assets one level down (`.../thumbs/`).
    if let Err(error) = app.asset_protocol_scope().allow_directory(dir, true) {
        // Non-fatal by design — the cost is placeholder tiles, not a broken app.
        #[cfg(debug_assertions)]
        eprintln!("[assets] could not allow {}: {error}", dir.display());
        let _ = error;
    }
}

/// Widen the asset scope to a finished ingest's report assets, so the completion grid can
/// render the thumbnails that were just written there.
///
/// The completion grid reads from the *destination root*, not the cache, so the startup grant
/// cannot cover it — the destination isn't known until a run happens, and there may be several.
/// There is no "let the webview read this path" command, deliberately; the grant is made here,
/// in Rust, after `generate_ingest_report` has written assets under this root.
///
/// Honest about the limits, since only the SUFFIX is ours:
///
///   * The `<root>` base originates from the caller (`generate_ingest_report`'s
///     `destination_roots` crosses the IPC boundary). We constrain it to roots the write loop
///     reported success for, so it names a directory this run really did populate — but a
///     caller that asks for a report at a base of its choosing will get that base granted.
///   * The suffix is always [`copier::REPORT_ASSET_DIR`], the same constant the writer uses,
///     so the grant covers `<root>/IngestPilot_Report_Assets` and never the root itself or the
///     media beside it. Contents are ours except in the pathological case where a directory of
///     that exact name already existed at that base with foreign content in it.
///   * The grant is recursive (assets nest one level, under `thumbs/`) and lasts for the
///     process lifetime only.
///
/// See [`allow_thumbnail_dir`] for the boundary this is part of.
pub fn allow_report_asset_dir(app: &AppHandle, root_path: &Path) {
    allow_thumbnail_dir(app, &root_path.join(crate::ingest::copier::REPORT_ASSET_DIR));
}

#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItemBuilder::with_id("show", "Open Ingest Pilot").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Ingest Pilot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_and_focus(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_and_focus(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be registered first so a relaunch focuses the
        // already-running (possibly tray-only) instance instead of starting a second.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_and_focus(app);
        }))
        .manage(commands::ingest::IngestJobs::default())
        .manage(BackgroundMode(AtomicBool::new(true)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Point the thumbnail extractors at any ffmpeg/exiftool bundled in the app's
            // resource dir (see docs/design/BUNDLING.md). No-op when the binaries aren't
            // present — discovery then falls back to PATH and finally the placeholder tier,
            // so this never breaks a build that ships without them.
            wire_bundled_tool_env(app.handle());

            // Open the asset protocol onto the source-thumbnail cache — and nothing else.
            // `tauri.conf.json` ships an EMPTY static scope on purpose, so at this point the
            // webview can read no file at all; this single grant is what makes
            // `convertFileSrc` work for generated previews while leaving the user's cards and
            // media unreachable. Destination report assets are granted per-run, once we've
            // actually written them (see `allow_report_asset_dir`).
            match crate::core::storage::source_thumbnail_cache_dir(app.handle()) {
                Ok(cache_dir) => allow_thumbnail_dir(app.handle(), &cache_dir),
                // No cache dir means no source previews — placeholders, not a failed launch.
                Err(error) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[assets] no thumbnail cache dir: {error}");
                    let _ = error;
                }
            }

            // The auto-updater is desktop-only. Registered here (rather than in the
            // builder chain) so it can be `#[cfg(desktop)]`-gated cleanly.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                build_tray(app.handle())?;
                // Seed the background-mode flag from saved settings so the very first
                // window close behaves per the user's preference.
                if let Ok(settings) = commands::settings::get_settings(app.handle().clone()) {
                    app.state::<BackgroundMode>()
                        .0
                        .store(settings.camera_watcher.tray_mode, Ordering::Relaxed);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: when background mode is on, hide the window instead of
            // quitting so the card watcher keeps running.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<BackgroundMode>() {
                    if state.0.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::greet,
            commands::system::open_path,
            commands::system::open_guide,
            commands::system::disk_space,
            commands::system::filter_directories,
            commands::system::show_main_window,
            commands::system::set_launch_at_login,
            commands::system::get_launch_at_login,
            commands::history::list_history,
            commands::history::save_history_job,
            commands::history::clear_history,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::presets::list_presets,
            commands::presets::get_preset,
            commands::presets::save_preset,
            commands::presets::delete_preset,
            commands::presets::import_preset,
            commands::presets::export_preset,
            commands::presets::duplicate_preset,
            commands::presets::import_folder_tree,
            commands::presets::inspect_template_drop,
            commands::metadata_presets::list_metadata_presets,
            commands::metadata_presets::get_metadata_preset,
            commands::metadata_presets::save_metadata_preset,
            commands::metadata_presets::delete_metadata_preset,
            commands::naming_catalog::get_naming_catalog,
            commands::naming_catalog::save_naming_catalog,
            commands::iconik::iconik_list_views,
            commands::iconik::iconik_view_fields,
            commands::iconik::iconik_push_metadata,
            commands::config_bundle::export_config_bundle,
            commands::config_bundle::import_config_bundle,
            commands::ingest::scaffold_project,
            commands::ingest::run_ingest,
            commands::ingest::run_ingest_multi,
            commands::ingest::retry_failed_copies,
            commands::ingest::generate_offload_proof,
            commands::ingest::export_reel_index,
            commands::ingest::export_metadata_manifest,
            commands::ingest::cancel_ingest,
            commands::ingest::write_ingest_report,
            commands::ingest::generate_ingest_report,
            commands::scan::scan_source,
            commands::scan::detect_camera_sources,
            commands::thumbnails::generate_source_thumbnails,
            commands::tokens::preview_pattern
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ingest Pilot");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}_{suffix}"))
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, b"stub").expect("write");
    }

    fn resolve(candidates: &[PathBuf]) -> Option<PathBuf> {
        candidates.iter().find(|path| path.is_file()).cloned()
    }

    /// The dev source layout `scripts/fetch-tools.ps1` writes must be discoverable —
    /// this is what makes R3D thumbnails work under `tauri dev`, where the resource dir
    /// points at target/<profile> and nothing is bundled yet.
    #[test]
    fn finds_tools_in_dev_source_layout() {
        let root = unique_temp_dir("ingest_pilot_dev_tools");
        let ffmpeg = root
            .join("binaries")
            .join(format!("ffmpeg-{TARGET_TRIPLE}{EXE_SUFFIX}"));
        let exiftool = root
            .join("resources")
            .join("tools")
            .join("exiftool")
            .join(format!("exiftool{EXE_SUFFIX}"));
        touch(&ffmpeg);
        touch(&exiftool);

        let roots = vec![root.clone()];
        assert_eq!(resolve(&ffmpeg_candidates(&roots)).as_ref(), Some(&ffmpeg));
        assert_eq!(
            resolve(&exiftool_candidates(&roots)).as_ref(),
            Some(&exiftool)
        );

        let _ = fs::remove_dir_all(root);
    }

    /// The packaged layout: Tauri strips the sidecar's triple and installs it beside the
    /// app exe, and bundled resources keep their src-tauri-relative path.
    #[test]
    fn finds_tools_in_packaged_layout() {
        let root = unique_temp_dir("ingest_pilot_packaged_tools");
        let ffmpeg = root.join(format!("ffmpeg{EXE_SUFFIX}"));
        let exiftool = root
            .join("resources")
            .join("tools")
            .join("exiftool")
            .join(format!("exiftool{EXE_SUFFIX}"));
        touch(&ffmpeg);
        touch(&exiftool);

        let roots = vec![root.clone()];
        assert_eq!(resolve(&ffmpeg_candidates(&roots)).as_ref(), Some(&ffmpeg));
        assert_eq!(
            resolve(&exiftool_candidates(&roots)).as_ref(),
            Some(&exiftool)
        );

        let _ = fs::remove_dir_all(root);
    }

    /// Missing tools are a no-op, never a panic — a build that ships without them still runs.
    #[test]
    fn missing_tools_resolve_to_none() {
        let roots = vec![unique_temp_dir("ingest_pilot_absent_tools")];
        assert!(resolve(&ffmpeg_candidates(&roots)).is_none());
        assert!(resolve(&exiftool_candidates(&roots)).is_none());
    }

    /// An operator-set override must win over anything we discover.
    #[test]
    fn existing_env_override_is_not_stomped() {
        let var = "INGEST_PILOT_TEST_OVERRIDE_FFMPEG";
        let root = unique_temp_dir("ingest_pilot_override_tools");
        let discovered = root.join(format!("ffmpeg{EXE_SUFFIX}"));
        touch(&discovered);

        std::env::set_var(var, "C:\\custom\\ffmpeg.exe");
        let chosen = set_tool_env(var, &ffmpeg_candidates(&[root.clone()]));
        assert_eq!(chosen, Some(PathBuf::from("C:\\custom\\ffmpeg.exe")));
        std::env::remove_var(var);

        let _ = fs::remove_dir_all(root);
    }

    /// In dev the crate dir must be among the probed roots — without it, `tauri dev`
    /// would never find the fetched tools.
    #[test]
    fn dev_roots_include_crate_dir() {
        let roots = bundled_tool_roots(None);
        assert!(
            roots.contains(&PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
            "crate dir must be probed in dev builds; roots were {roots:?}"
        );
    }

    /// Integration-ish: when the tools have actually been fetched into this checkout,
    /// dev discovery must resolve them. Skips (rather than fails) on a fresh clone or in
    /// CI before `scripts/fetch-tools.ps1` has run.
    #[test]
    fn finds_really_fetched_tools_when_present() {
        let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let roots = bundled_tool_roots(None);

        // Two legitimate dev locations, and either is correct: the source sidecar written
        // by fetch-tools.ps1, and the byte-identical copy `tauri-build` stages next to the
        // dev exe (triple stripped) once `externalBin` is configured. The staged copy wins
        // because it mirrors where the sidecar lands in a packaged install.
        let source_sidecar = crate_dir
            .join("binaries")
            .join(format!("ffmpeg-{TARGET_TRIPLE}{EXE_SUFFIX}"));
        if source_sidecar.is_file() {
            let found = resolve(&ffmpeg_candidates(&roots)).expect("ffmpeg should be discovered in dev");
            assert!(found.is_file(), "resolved ffmpeg must exist: {}", found.display());
            assert!(
                found.file_stem().and_then(|s| s.to_str()).unwrap_or_default().starts_with("ffmpeg"),
                "resolved ffmpeg looks wrong: {}",
                found.display()
            );
        } else {
            eprintln!("skipping: no fetched ffmpeg at {}", source_sidecar.display());
        }

        // Same story for exiftool: `tauri-build` stages declared `resources` into
        // target/<profile>/resources/, so dev may resolve either that staged tree or the
        // source one. Whichever wins must be a *working* install — the Windows exiftool
        // is inert without its exiftool_files/ Perl runtime beside it.
        let source_exiftool = crate_dir
            .join("resources")
            .join("tools")
            .join("exiftool")
            .join(format!("exiftool{EXE_SUFFIX}"));
        if source_exiftool.is_file() {
            let found = resolve(&exiftool_candidates(&roots)).expect("exiftool should be discovered in dev");
            assert!(found.is_file(), "resolved exiftool must exist: {}", found.display());
            assert!(
                found.parent().expect("parent").join("exiftool_files").is_dir(),
                "exiftool.exe needs its exiftool_files/ sibling to run: {}",
                found.display()
            );
        } else {
            eprintln!(
                "skipping: no fetched exiftool at {}",
                source_exiftool.display()
            );
        }
    }
}
