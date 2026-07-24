use crate::core::preset::PresetVariable;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub global_parameters: Vec<PresetVariable>,
    #[serde(default)]
    pub ingest_defaults: IngestDefaults,
    #[serde(default)]
    pub report_defaults: ReportDefaults,
    #[serde(default)]
    pub camera_watcher: CameraWatcherSettings,
    #[serde(default)]
    pub file_selector: FileSelectorSettings,
    /// Operator name printed on offload integrity proofs.
    #[serde(default)]
    pub operator_name: String,
    /// User-defined extension -> role/kind classification (e.g. ".foo" -> "audio").
    /// Applied globally so those types route to the matching role's folder.
    #[serde(default)]
    pub custom_file_kinds: std::collections::BTreeMap<String, String>,
    /// Roster of shooters/videographers, offered as the options for a "Shooter"
    /// metadata field. The field defaults to `operator_name` (this machine's user).
    /// Each has a `group` (staff / volunteer / contractor) so the ingest picker can
    /// show internal staff by default and reveal volunteers/contractors on request.
    #[serde(default)]
    pub shooters: Vec<Shooter>,
    /// iconik connection for pushing metadata to assets via the API.
    #[serde(default)]
    pub iconik: IconikSettings,
    /// Completion-sound behavior (chime on transfer finish).
    #[serde(default)]
    pub sound: SoundSettings,
    /// Data-integrity guardrails enforced on this machine.
    #[serde(default)]
    pub safety: SafetySettings,
    /// Friendly names for card readers / removable volumes, keyed by the volume root
    /// path (e.g. "E:\\" -> "CFexpress Reader #2"). Shown in Copy From / auto-detect.
    #[serde(default)]
    pub drive_nicknames: std::collections::BTreeMap<String, String>,
    /// Show advanced settings sections in the UI. Off by default so newcomers see a
    /// simpler surface.
    #[serde(default)]
    pub show_advanced: bool,
    /// Pinned destination folders for DIT mode — the "folders already set" the operator
    /// offloads to repeatedly. Persisted so they survive restarts. Absolute paths.
    #[serde(default)]
    pub dit_destinations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SoundSettings {
    /// Play a chime when a transfer finishes.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Volume 0-100.
    #[serde(default = "default_sound_volume")]
    pub volume: u8,
}

impl Default for SoundSettings {
    fn default() -> Self {
        Self { enabled: true, volume: 80 }
    }
}

fn default_sound_volume() -> u8 {
    80
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SafetySettings {
    /// Never delete source media on this machine, regardless of other options.
    #[serde(default)]
    pub never_delete_source: bool,
    /// Hard-stop an ingest if a destination has less than this percent free (0 = off).
    #[serde(default)]
    pub low_space_stop_percent: u8,
    /// Minimum number of destinations that must verify before an ingest is "done"
    /// (1 = current behavior).
    #[serde(default = "default_min_copies")]
    pub min_verified_copies: u8,
    /// Ask for confirmation before enabling destructive options (e.g. delete sidecars).
    #[serde(default = "default_true")]
    pub confirm_destructive: bool,
    /// Always write the offload-proof PDF, even when reports are otherwise off.
    #[serde(default)]
    pub always_write_offload_proof: bool,
    /// Master switch that turns on the strict guardrails as a group (UI convenience).
    #[serde(default)]
    pub safe_mode: bool,
}

fn default_min_copies() -> u8 {
    1
}

/// Where the app writes the artifacts it generates (HTML report, offload-proof PDF,
/// reel index, metadata CSV). The verified MHL manifest stays in the project root by
/// default so the delivered folder self-verifies, unless `move_mhl` is set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReportOutputLocation {
    /// "root" (project folder), "subfolder" (a folder inside the project), or "custom"
    /// (an absolute path collecting artifacts from every ingest).
    #[serde(default = "default_report_mode")]
    pub mode: String,
    /// Subfolder name used when mode == "subfolder" (tokens like {year} allowed).
    #[serde(default = "default_report_subfolder")]
    pub subfolder: String,
    /// Absolute path used when mode == "custom".
    #[serde(default)]
    pub custom_path: String,
    /// Also relocate the MHL manifest (off by default: it belongs with the media).
    #[serde(default)]
    pub move_mhl: bool,
}

impl Default for ReportOutputLocation {
    fn default() -> Self {
        Self {
            mode: default_report_mode(),
            subfolder: default_report_subfolder(),
            custom_path: String::new(),
            move_mhl: false,
        }
    }
}

fn default_report_mode() -> String {
    "root".to_string()
}

fn default_report_subfolder() -> String {
    "_Admin".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Shooter {
    pub name: String,
    /// "staff" (shown by default), "volunteer", or "contractor" (revealed on request).
    #[serde(default = "default_shooter_group")]
    pub group: String,
}

fn default_shooter_group() -> String {
    "staff".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IconikSettings {
    #[serde(default = "default_iconik_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub auth_token: String,
    /// The metadata view assets are tagged against.
    #[serde(default)]
    pub view_id: String,
    #[serde(default)]
    pub view_name: String,
    /// Push metadata to iconik automatically after an ingest completes.
    #[serde(default)]
    pub auto_push: bool,
}

impl Default for IconikSettings {
    fn default() -> Self {
        Self {
            base_url: default_iconik_base_url(),
            app_id: String::new(),
            auth_token: String::new(),
            view_id: String::new(),
            view_name: String::new(),
            auto_push: false,
        }
    }
}

fn default_iconik_base_url() -> String {
    "https://app.iconik.io".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IngestDefaults {
    #[serde(default = "default_true")]
    pub auto_scan_sources: bool,
    #[serde(default = "default_true")]
    pub rename_files: bool,
    #[serde(default)]
    pub delete_sidecars: bool,
    #[serde(default = "default_copy_mode")]
    pub destination_mode: String,
    #[serde(default = "default_true")]
    pub open_folder_when_done: bool,
    /// Layout for the `{date}` token in naming patterns (e.g. "YYYY-MM-DD"). Applied
    /// globally so every preset's `{date}` renders the operator's preferred format.
    #[serde(default = "default_date_format")]
    pub date_format: String,
}

impl Default for IngestDefaults {
    fn default() -> Self {
        Self {
            auto_scan_sources: true,
            rename_files: true,
            delete_sidecars: false,
            destination_mode: default_copy_mode(),
            open_folder_when_done: true,
            date_format: default_date_format(),
        }
    }
}

fn default_date_format() -> String {
    crate::core::token::DEFAULT_DATE_FORMAT.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReportDefaults {
    #[serde(default = "default_true")]
    pub include_thumbnails: bool,
    #[serde(default = "default_true")]
    pub write_html_report: bool,
    #[serde(default)]
    pub open_report_when_done: bool,
    #[serde(default)]
    pub notes_template: String,
    /// Where generated artifacts land (root / subfolder / custom path).
    #[serde(default)]
    pub output_location: ReportOutputLocation,
    /// Longest edge (px) of generated report thumbnails.
    #[serde(default = "default_thumbnail_max_edge")]
    pub thumbnail_max_edge: u32,
    /// JPEG quality (1–100) for generated report thumbnails.
    #[serde(default = "default_thumbnail_jpeg_quality")]
    pub thumbnail_jpeg_quality: u8,
}

impl Default for ReportDefaults {
    fn default() -> Self {
        Self {
            include_thumbnails: true,
            write_html_report: true,
            open_report_when_done: false,
            notes_template: String::new(),
            output_location: ReportOutputLocation::default(),
            thumbnail_max_edge: default_thumbnail_max_edge(),
            thumbnail_jpeg_quality: default_thumbnail_jpeg_quality(),
        }
    }
}

fn default_thumbnail_max_edge() -> u32 {
    480
}

fn default_thumbnail_jpeg_quality() -> u8 {
    80
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CameraWatcherSettings {
    #[serde(default = "default_true")]
    pub auto_detect_cards: bool,
    /// When a new card is inserted, raise/focus the window and jump to the ingest
    /// screen with that card pre-selected.
    #[serde(default = "default_true")]
    pub pop_open_on_card: bool,
    /// Keep the app running in the background (close to tray) instead of quitting
    /// when the window is closed, so the card watcher stays alive.
    #[serde(default = "default_true")]
    pub tray_mode: bool,
    /// Start the app automatically at login (so it can be watching before a card
    /// is inserted). Applied to the OS on save.
    #[serde(default)]
    pub launch_at_login: bool,
    /// How aggressively to surface the window when a card is inserted:
    /// "always" (raise + focus), "if_frontmost" (only if the app is already in front),
    /// or "notify" (don't steal focus). Applies when pop_open_on_card is on.
    #[serde(default = "default_pop_open_mode")]
    pub pop_open_mode: String,
}

impl Default for CameraWatcherSettings {
    fn default() -> Self {
        Self {
            auto_detect_cards: true,
            pop_open_on_card: true,
            tray_mode: true,
            launch_at_login: false,
            pop_open_mode: default_pop_open_mode(),
        }
    }
}

fn default_pop_open_mode() -> String {
    "always".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileSelectorSettings {
    #[serde(default = "default_selector_view")]
    pub default_view: String,
    #[serde(default = "default_thumbnail_size")]
    pub thumbnail_size: u16,
    #[serde(default = "default_true")]
    pub group_by_date: bool,
}

impl Default for FileSelectorSettings {
    fn default() -> Self {
        Self {
            default_view: default_selector_view(),
            thumbnail_size: default_thumbnail_size(),
            group_by_date: true,
        }
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let json = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let settings: AppSettings =
        serde_json::from_str(&json).map_err(|error| format!("{}: {error}", path.display()))?;
    apply_custom_file_kinds(&settings);
    apply_date_format(&settings);
    Ok(settings)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    validate_settings(&settings)?;
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let json = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())?;
    apply_custom_file_kinds(&settings);
    apply_date_format(&settings);
    apply_background_and_autostart(&app, &settings);

    Ok(settings)
}

/// Keep the process-wide `{date}` layout in sync with the saved setting, so the
/// ingest pipeline renders dates in the operator's chosen format.
fn apply_date_format(settings: &AppSettings) {
    crate::core::token::set_default_date_format(&settings.ingest_defaults.date_format);
}

/// Keeps the OS-level behaviors in sync with the saved settings: the "close to
/// background" flag the window-close handler reads, and the launch-at-login state.
/// Both are best-effort — a failure here never blocks saving settings.
fn apply_background_and_autostart(app: &AppHandle, settings: &AppSettings) {
    use std::sync::atomic::Ordering;
    if let Some(state) = app.try_state::<crate::BackgroundMode>() {
        state.0.store(settings.camera_watcher.tray_mode, Ordering::Relaxed);
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        let _ = if settings.camera_watcher.launch_at_login {
            manager.enable()
        } else {
            manager.disable()
        };
    }
}

/// Pushes the user's extension->kind overrides into the scanner so scans and ingests
/// classify them into the chosen role. Called whenever settings are read or written.
fn apply_custom_file_kinds(settings: &AppSettings) {
    use crate::ingest::scanner::ScanFileKind;
    let parsed = settings
        .custom_file_kinds
        .iter()
        .filter_map(|(extension, kind)| {
            let extension = extension.trim().to_lowercase();
            let extension = if extension.starts_with('.') {
                extension
            } else {
                format!(".{extension}")
            };
            let kind = match kind.trim().to_lowercase().as_str() {
                "footage" => ScanFileKind::Footage,
                "photo" | "photos" => ScanFileKind::Photo,
                "audio" => ScanFileKind::Audio,
                "document" | "documents" => ScanFileKind::Document,
                _ => return None,
            };
            Some((extension, kind))
        })
        .collect();
    crate::ingest::scanner::set_custom_kinds(parsed);
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    let mut ids = HashSet::new();
    for parameter in &settings.global_parameters {
        if parameter.id.trim().is_empty() {
            return Err(format!(
                "Global parameter '{}' needs a token id.",
                parameter.name
            ));
        }
        if parameter.name.trim().is_empty() {
            return Err(format!("Global parameter '{}' needs a name.", parameter.id));
        }
        if !ids.insert(parameter.id.as_str()) {
            return Err(format!("Duplicate global token '{{{}}}'.", parameter.id));
        }
    }

    if !matches!(
        settings.ingest_defaults.destination_mode.as_str(),
        "create_new" | "existing_root"
    ) {
        return Err("Default destination mode must be create_new or existing_root.".to_string());
    }
    if !matches!(
        settings.file_selector.default_view.as_str(),
        "list" | "thumbs"
    ) {
        return Err("Default file selector view must be list or thumbs.".to_string());
    }
    if !(80..=260).contains(&settings.file_selector.thumbnail_size) {
        return Err("Default thumbnail size must be between 80 and 260.".to_string());
    }

    Ok(())
}

fn default_true() -> bool {
    true
}

fn default_copy_mode() -> String {
    "create_new".to_string()
}

fn default_selector_view() -> String {
    "list".to_string()
}

fn default_thumbnail_size() -> u16 {
    142
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::core::storage::app_data_root(app)?.join("settings.json"))
}
