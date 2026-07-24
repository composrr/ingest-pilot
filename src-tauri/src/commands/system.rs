use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
pub struct DiskSpace {
    path: String,
    root: String,
    available_bytes: u64,
    total_bytes: u64,
}

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Welcome aboard, {name}. Ingest Pilot is ready.")
}

/// Brings the main window to the front (from tray/background) — used when a card is
/// inserted or an ingest finishes so the operator is taken straight to it.
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::show_and_focus(&app);
}

/// Enables/disables starting the app at login. Best-effort; returns an error string
/// the frontend can surface if the OS refuses.
#[tauri::command]
pub fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        return if enabled {
            manager.enable().map_err(|error| error.to_string())
        } else {
            manager.disable().map_err(|error| error.to_string())
        };
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

/// Reports whether launch-at-login is currently enabled at the OS level.
#[tauri::command]
pub fn get_launch_at_login(app: AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        return app.autolaunch().is_enabled().map_err(|error| error.to_string());
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("'{}' does not exist.", target.display()));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(&target);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(&target);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(&target);
        command
    };

    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

/// Opens one of the bundled onboarding guides (the walkthrough video or a PDF) in the
/// user's default app. Only the known guide filenames are accepted, so this can't be
/// used to open an arbitrary path.
#[tauri::command]
pub fn open_guide(app: AppHandle, name: String) -> Result<(), String> {
    use tauri::Manager;
    const GUIDES: [&str; 3] = [
        "Ingest-Pilot-Quickstart.pdf",
        "Ingest-Pilot-User-Guide.pdf",
        "Ingest-Pilot-Walkthrough.mp4",
    ];
    if !GUIDES.contains(&name.as_str()) {
        return Err(format!("Unknown guide '{name}'."));
    }
    let path = app
        .path()
        .resolve(
            format!("resources/guides/{name}"),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| error.to_string())?;
    open_path(path.to_string_lossy().into_owned())
}

/// Returns only the dropped paths that are existing directories, preserving order
/// and dropping duplicates. Used by queue-mode drag-and-drop so each dropped folder
/// becomes one card and stray files are ignored.
#[tauri::command]
pub fn filter_directories(paths: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|path| std::path::Path::new(path).is_dir())
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

/// Enumerate every mounted volume (fixed + removable) for DIT mode's "Copy From" panel.
/// Unlike `detect_camera_sources` (a camera-signature letter probe), this lists ALL
/// drives so a plain SSD with a `Footage/` folder is still visible. Nicknames are filled
/// from `settings.drive_nicknames` (keyed by volume root) — this setting's first consumer.
#[tauri::command]
pub async fn list_volumes(app: AppHandle) -> Result<Vec<crate::platform::Volume>, String> {
    // Read nicknames on the caller thread (get_settings is sync + cheap); the OS
    // enumeration itself runs off the async runtime so a slow/unready drive can't block it.
    let nicknames = crate::commands::settings::get_settings(app)
        .map(|settings| settings.drive_nicknames)
        .unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        let mut volumes = crate::platform::list_volumes();
        for volume in &mut volumes {
            if let Some(nickname) = nicknames.get(&volume.path) {
                if !nickname.trim().is_empty() {
                    volume.nickname = Some(nickname.clone());
                }
            }
        }
        volumes
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn disk_space(path: String) -> Result<DiskSpace, String> {
    tauri::async_runtime::spawn_blocking(move || disk_space_inner(path))
        .await
        .map_err(|error| error.to_string())?
}

fn disk_space_inner(path: String) -> Result<DiskSpace, String> {
    let target = if path.trim().is_empty() {
        std::env::current_dir().map_err(|error| error.to_string())?
    } else {
        std::path::PathBuf::from(&path)
    };

    #[cfg(target_os = "windows")]
    {
        let query_path = existing_space_query_path(&target);
        let (available_bytes, total_bytes) = windows_disk_space(&query_path)?;
        return Ok(DiskSpace {
            path,
            root: windows_root_label(&query_path),
            available_bytes,
            total_bytes,
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = std::process::Command::new("df")
            .args(["-k", &target.to_string_lossy()])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err("Drive space is unavailable for this path.".to_string());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text
            .lines()
            .nth(1)
            .ok_or_else(|| "Drive space output was empty.".to_string())?;
        let columns: Vec<&str> = line.split_whitespace().collect();
        let total_kb = columns
            .get(1)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let available_kb = columns
            .get(3)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        Ok(DiskSpace {
            path,
            root: columns.first().copied().unwrap_or("").to_string(),
            available_bytes: available_kb * 1024,
            total_bytes: total_kb * 1024,
        })
    }
}

#[cfg(target_os = "windows")]
fn existing_space_query_path(path: &std::path::Path) -> std::path::PathBuf {
    if path.exists() {
        return path.to_path_buf();
    }

    path.ancestors()
        .find(|ancestor| ancestor.exists())
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(target_os = "windows")]
fn windows_disk_space(path: &std::path::Path) -> Result<(u64, u64), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut available_bytes = 0_u64;
    let mut total_bytes = 0_u64;
    let mut total_free_bytes = 0_u64;
    let mut wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();

    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide_path.as_mut_ptr(),
            &mut available_bytes,
            &mut total_bytes,
            &mut total_free_bytes,
        )
    };

    if ok == 0 {
        return Err(format!(
            "Could not read drive space for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }

    Ok((available_bytes, total_bytes))
}

#[cfg(target_os = "windows")]
fn windows_root_label(path: &std::path::Path) -> String {
    use std::path::{Component, Prefix};

    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                format!("{}:\\", letter as char)
            }
            Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                format!(r"\\{}\{}", server.to_string_lossy(), share.to_string_lossy())
            }
            _ => prefix.as_os_str().to_string_lossy().to_string(),
        },
        _ => path.to_string_lossy().to_string(),
    }
}
