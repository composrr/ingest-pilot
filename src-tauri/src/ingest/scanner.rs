use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

/// User-defined extension -> kind overrides, set from app settings. Lets the team
/// permanently classify extra file types into a role (e.g. add ".foo" to Audio) so
/// they route to that role's folder everywhere. Read on every classification.
fn custom_kinds() -> &'static RwLock<BTreeMap<String, ScanFileKind>> {
    static CELL: OnceLock<RwLock<BTreeMap<String, ScanFileKind>>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(BTreeMap::new()))
}

pub fn set_custom_kinds(entries: BTreeMap<String, ScanFileKind>) {
    if let Ok(mut guard) = custom_kinds().write() {
        *guard = entries;
    }
}

fn custom_kind_for(extension: &str) -> Option<ScanFileKind> {
    custom_kinds().read().ok().and_then(|guard| guard.get(extension).copied())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SourceScan {
    pub root_path: String,
    pub total_files: usize,
    pub total_bytes: u64,
    pub ingest_files: usize,
    pub ignored_files: usize,
    pub sidecar_files: usize,
    pub extensions: Vec<ExtensionSummary>,
    pub kinds: Vec<KindSummary>,
    pub files: Vec<ScannedFile>,
    /// Paths that could not be read during the scan (e.g. permission denied on a
    /// server share). Collected instead of aborting so the rest of the scan
    /// completes; surfaced to the user as "N items skipped (no access)".
    pub unreadable_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExtensionSummary {
    pub extension: String,
    pub count: usize,
    pub total_bytes: u64,
    pub kind: ScanFileKind,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KindSummary {
    pub kind: ScanFileKind,
    pub count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScannedFile {
    pub path: String,
    pub relative_path: String,
    pub file_name: String,
    pub stem: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub kind: ScanFileKind,
    pub sidecar_for: Option<String>,
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CameraSource {
    pub path: String,
    pub label: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ScanFileKind {
    Footage,
    Photo,
    Audio,
    Document,
    Sidecar,
    Unknown,
    Ignored,
}

#[derive(Debug, Default)]
struct ExtensionAccumulator {
    count: usize,
    total_bytes: u64,
}

#[derive(Debug, Default)]
struct KindAccumulator {
    count: usize,
    total_bytes: u64,
}

// NOTE ON THE SIZE OF THIS REPLY. `files` is unbounded, and the whole reply crosses to the
// webview as one serialized blob; an oversized one can kill the WebKit content process (two
// such crashes are on record, both while this app was walking the startup disk). It is
// deliberately NOT capped here: the ingest builds its copy list from `files`, so truncating
// it would silently copy only part of a card — a far worse failure than a crash for an
// offload tool. The pathological producer was the boot-volume walk, which `is_on_system_disk`
// and `is_system_volume_root` now prevent outright; a real card is a few MB at worst. Paging
// the list properly (one walk, cached, fetched in windows) is the correct next step, and must
// land together with the change that makes ingest read from the paged source rather than
// from `files`.
pub fn scan_source(source_path: &str) -> Result<SourceScan, String> {
    let root = PathBuf::from(source_path);
    if !root.exists() {
        return Err(format!("Source '{}' does not exist.", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("Source '{}' is not a folder.", root.display()));
    }
    // Refuse to recursively walk the ROOT of the machine's own startup disk. Scanning a
    // folder the user picked on their internal drive is legitimate and still allowed; what
    // is never legitimate is treating `/`, `$HOME`, or the `/Volumes/Macintosh HD` firmlink
    // as a card and descending the whole thing. That is what produced the TCC prompt storm
    // — the detector matched `PRIVATE` against `/private` (APFS is case-insensitive), the
    // Ingest screen auto-adopted the result, and the scan then walked Photos, Music,
    // Documents, Desktop and other apps' data in ~/Library with no user gesture at all.
    if is_system_volume_root(&root) {
        return Err(format!(
            "'{}' is this Mac's startup disk, not a camera card. Choose a card or a specific folder instead.",
            root.display()
        ));
    }

    let mut total_files = 0;
    let mut total_bytes = 0;
    let mut files = Vec::<ScannedFile>::new();
    let mut extensions = BTreeMap::<(ScanFileKind, String), ExtensionAccumulator>::new();
    let mut unreadable_paths = Vec::<String>::new();
    scan_directory(
        &root,
        &root,
        &mut total_files,
        &mut total_bytes,
        &mut extensions,
        &mut files,
        &mut unreadable_paths,
        None,
    );
    // If we couldn't read the top-level folder at all (and found nothing), that's a
    // hard error worth surfacing; partial-access scans succeed with a skipped count.
    if files.is_empty() && total_files == 0 && unreadable_paths.iter().any(|path| path == &root.to_string_lossy()) {
        return Err(format!(
            "'{}' could not be read (permission denied).",
            root.display()
        ));
    }
    pair_sidecars(&mut files);
    attach_scan_thumbnails(&mut files);

    let mut kinds = BTreeMap::<ScanFileKind, KindAccumulator>::new();
    for file in &files {
        let summary = kinds.entry(file.kind).or_default();
        summary.count += 1;
        summary.total_bytes += file.size_bytes;
    }

    let ingest_files = files
        .iter()
        .filter(|file| {
            matches!(
                file.kind,
                ScanFileKind::Footage
                    | ScanFileKind::Photo
                    | ScanFileKind::Audio
                    | ScanFileKind::Document
            )
        })
        .count();
    let ignored_files = files
        .iter()
        .filter(|file| matches!(file.kind, ScanFileKind::Ignored | ScanFileKind::Unknown))
        .count();
    let sidecar_files = files
        .iter()
        .filter(|file| matches!(file.kind, ScanFileKind::Sidecar))
        .count();

    let extensions = extensions
        .into_iter()
        .map(|((kind, extension), summary)| ExtensionSummary {
            extension,
            count: summary.count,
            total_bytes: summary.total_bytes,
            kind,
        })
        .collect();

    let kinds = kinds
        .into_iter()
        .map(|(kind, summary)| KindSummary {
            kind,
            count: summary.count,
            total_bytes: summary.total_bytes,
        })
        .collect();

    Ok(SourceScan {
        root_path: root.to_string_lossy().to_string(),
        total_files,
        total_bytes,
        ingest_files,
        ignored_files,
        sidecar_files,
        extensions,
        kinds,
        files,
        unreadable_paths,
    })
}

pub fn detect_camera_sources() -> Vec<CameraSource> {
    candidate_roots()
        .into_iter()
        .filter_map(|root| detect_camera_source_at(&root))
        .collect()
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    total_files: &mut usize,
    total_bytes: &mut u64,
    extensions: &mut BTreeMap<(ScanFileKind, String), ExtensionAccumulator>,
    files: &mut Vec<ScannedFile>,
    unreadable: &mut Vec<String>,
    forced_kind: Option<ScanFileKind>,
) {
    // A folder we can't open (permission denied, offline share, etc.) is recorded and
    // skipped rather than aborting the whole scan.
    let read_dir = match fs::read_dir(directory) {
        Ok(read_dir) => read_dir,
        Err(_) => {
            unreadable.push(directory.to_string_lossy().to_string());
            return;
        }
    };

    for entry in read_dir {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();

        // Resolve the entry type WITHOUT following symlinks, then skip symlinks
        // entirely so a scan can't escape the chosen tree or loop on a self-link.
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                unreadable.push(path.to_string_lossy().to_string());
                continue;
            }
        };
        if file_type.is_symlink() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                unreadable.push(path.to_string_lossy().to_string());
                continue;
            }
        };

        if metadata.is_dir() {
            if is_skipped_directory(&path) {
                continue;
            }
            let child_forced_kind = forced_kind.or_else(|| filtered_directory_kind(&path));
            scan_directory(
                root,
                &path,
                total_files,
                total_bytes,
                extensions,
                files,
                unreadable,
                child_forced_kind,
            );
            continue;
        }

        if !metadata.is_file() {
            continue;
        }

        let size = metadata.len();
        *total_files += 1;
        *total_bytes += size;

        let extension = normalized_extension(&path);
        let kind = forced_kind.unwrap_or_else(|| classify_file(&path, &extension));
        let summary = extensions.entry((kind, extension.clone())).or_default();
        summary.count += 1;
        summary.total_bytes += size;

        files.push(ScannedFile {
            path: path.to_string_lossy().to_string(),
            relative_path: relative_path(root, &path),
            file_name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            stem: path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            extension,
            size_bytes: size,
            modified_at: metadata.modified().ok().and_then(format_modified_time),
            kind,
            sidecar_for: None,
            thumbnail_path: None,
        });
    }
}

fn attach_scan_thumbnails(files: &mut [ScannedFile]) {
    let donors = files
        .iter()
        .filter(|file| is_thumbnail_donor(file))
        .cloned()
        .collect::<Vec<_>>();

    for file in files {
        // Tier 1 — a browser-native image is its own preview, so it needs no companion and
        // no generation. Mirrors Tier 1 of the post-copy ladder
        // (`copier::attach_cheap_thumbnail_tier`). Deliberately NOT folder-gated: this is
        // what makes a card full of `DCIM/100CANON/*.JPG` render instantly, where the old
        // donor-only rule left every tile reading "No thumbnail".
        if is_self_preview(file) {
            file.thumbnail_path = Some(file.path.clone());
            continue;
        }
        if !matches!(file.kind, ScanFileKind::Footage | ScanFileKind::Photo) {
            continue;
        }
        file.thumbnail_path =
            matching_thumbnail_source(file, &donors).map(|thumbnail| thumbnail.path.clone());
    }
}

fn matching_thumbnail_source<'a>(
    file: &ScannedFile,
    thumbnail_sources: &'a [ScannedFile],
) -> Option<&'a ScannedFile> {
    let source_stem = file.stem.to_lowercase();
    let normalized_source = normalized_match_stem(&source_stem);
    let source_digits = digits_only(&source_stem);

    thumbnail_sources.iter().find(|candidate| {
        let candidate_stem = candidate.stem.to_lowercase();
        if candidate_stem == source_stem {
            return true;
        }

        let normalized_candidate = normalized_match_stem(&candidate_stem);
        if !normalized_source.is_empty()
            && !normalized_candidate.is_empty()
            && (normalized_candidate.contains(&normalized_source)
                || normalized_source.contains(&normalized_candidate))
        {
            return true;
        }

        let candidate_digits = digits_only(&candidate_stem);
        !source_digits.is_empty()
            && !candidate_digits.is_empty()
            && (candidate_digits == source_digits
                || candidate_digits.ends_with(&source_digits)
                || source_digits.ends_with(&candidate_digits))
    })
}

/// A file the webview can render directly, so it serves as its own preview with no
/// extraction step at all. Any browser-native image qualifies regardless of where it
/// lives — see the Tier 1 note in `attach_scan_thumbnails`.
fn is_self_preview(file: &ScannedFile) -> bool {
    is_browser_image_extension(&file.extension)
}

/// A file that can DONATE its pixels as some *other* file's preview: the companion JPEG a
/// camera writes into a THMBNL/PREVIEW folder beside the real clip (Sony XDCAM, P2, Canon XF).
///
/// The folder-name gate stays deliberately: `matching_thumbnail_source` falls back to loose
/// digit/substring matching, so promoting an arbitrary `DCIM/IMG_0042.JPG` to donor would
/// happily attach it to an unrelated `A042C001.R3D`. Self-preview (above) is the unconditional
/// case; donation stays conservative.
fn is_thumbnail_donor(file: &ScannedFile) -> bool {
    matches!(file.kind, ScanFileKind::Ignored | ScanFileKind::Photo)
        && is_browser_image_extension(&file.extension)
        && file
            .relative_path
            .to_lowercase()
            .split(['/', '\\'])
            .any(|part| {
                matches!(
                    part,
                    "thumbnail"
                        | "thumbnails"
                        | "thumb"
                        | "thumbs"
                        | "thmbnl"
                        | ".thumbnails"
                        | "preview"
                        | "previews"
                )
            })
}

pub(crate) fn is_browser_image_extension(extension: &str) -> bool {
    matches!(extension, ".jpg" | ".jpeg" | ".png" | ".gif" | ".webp")
}

fn normalized_match_stem(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn digits_only(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

pub(crate) fn detect_camera_source_at(root: &Path) -> Option<CameraSource> {
    if !root.is_dir() {
        return None;
    }

    let signatures = [
        ("DCIM", "DCIM folder"),
        ("PRIVATE", "PRIVATE camera folder"),
        ("M4ROOT", "Sony M4ROOT folder"),
        ("AVCHD", "AVCHD folder"),
        ("XDROOT", "Sony XDROOT folder"),
        ("CONTENTS", "P2/Canon CONTENTS folder"),
        ("BPAV", "XDCAM BPAV folder"),
        ("MP_ROOT", "MP_ROOT folder"),
    ];

    for (folder, reason) in signatures {
        if root.join(folder).is_dir() {
            return Some(camera_source(root, reason));
        }
    }

    if root.join("PRIVATE").join("M4ROOT").is_dir() {
        return Some(camera_source(root, "Sony PRIVATE/M4ROOT folder"));
    }
    if root.join("PRIVATE").join("AVCHD").is_dir() {
        return Some(camera_source(root, "PRIVATE/AVCHD folder"));
    }

    // RED cards have no DCIM: media lives in a magazine folder named `*.RDM`
    // containing per-clip `*.RDC` folders. Detect either at the drive root.
    let has_red_structure = fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .any(|entry| {
            entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                && entry
                    .file_name()
                    .to_str()
                    .map(|name| {
                        let lower = name.to_lowercase();
                        lower.ends_with(".rdm") || lower.ends_with(".rdc")
                    })
                    .unwrap_or(false)
        });
    if has_red_structure {
        return Some(camera_source(root, "RED RDM/RDC folder"));
    }

    let has_media_at_root = fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .any(|path| path.is_file() && is_known_ingest_media(&normalized_extension(&path)));

    has_media_at_root.then(|| camera_source(root, "media files at drive root"))
}

fn candidate_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        ('D'..='Z')
            .map(|letter| PathBuf::from(format!("{letter}:\\")))
            .filter(|path| path.exists())
            .collect()
    }

    #[cfg(not(windows))]
    {
        let mut roots = Vec::new();
        for parent in ["/Volumes", "/media", "/mnt"] {
            let parent = Path::new(parent);
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.filter_map(Result::ok) {
                    let path = entry.path();
                    if is_on_system_disk(&path) {
                        continue;
                    }
                    roots.push(path);
                }
            }
        }
        roots
    }
}

/// True when `path` lives on one of the machine's own disks rather than on attached media.
///
/// Compares device ids against the startup/System volume (`/`) and the user's home, which on
/// modern macOS is a separate Data volume. The case that matters is `/Volumes/Macintosh HD`:
/// it is a firmlink straight back to `/`, so without this check the card auto-detector treats
/// the boot volume as a candidate card and the recursive scan walks the entire home folder —
/// Photos, Music, Documents, Desktop, and other apps' data in `~/Library` — unleashing a storm
/// of macOS privacy (TCC) prompts. Windows enumerates drive letters from `D:` onwards, so it
/// was never affected; this is a no-op there.
/// True when `path` is the ROOT of one of the machine's own volumes — `/`, the user's home,
/// or a `/Volumes/*` entry that resolves onto the startup disk. Deliberately narrower than
/// [`is_on_system_disk`]: a folder the user deliberately picked on their internal drive is a
/// perfectly good ingest source, so only the volume root itself is refused.
pub(crate) fn is_system_volume_root(path: &Path) -> bool {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if canonical == Path::new("/") {
        return true;
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() && canonical == Path::new(&home) {
            return true;
        }
    }
    // A `/Volumes/*` entry that lands on the startup disk is a firmlink back to `/`.
    path.parent() == Some(Path::new("/Volumes")) && is_on_system_disk(path)
}

pub(crate) fn is_on_system_disk(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let _ = path;
        false
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::MetadataExt;
        let Ok(target) = fs::metadata(path) else {
            return false;
        };
        ["/".to_string(), std::env::var("HOME").unwrap_or_default()]
            .iter()
            .filter(|anchor| !anchor.is_empty())
            .filter_map(|anchor| fs::metadata(anchor).ok())
            .any(|anchor| anchor.dev() == target.dev())
    }
}

fn camera_source(root: &Path, reason: &str) -> CameraSource {
    let path = root.to_string_lossy().to_string();
    CameraSource {
        label: path.clone(),
        path,
        reason: reason.to_string(),
    }
}

fn normalized_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_else(|| "(none)".to_string())
}

pub(crate) fn classify_file(path: &Path, extension: &str) -> ScanFileKind {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    if is_ignored_file(file_name) {
        return ScanFileKind::Ignored;
    }

    // A user-configured extension override wins over the built-in classification.
    if let Some(kind) = custom_kind_for(extension) {
        return kind;
    }

    match extension {
        ".mp4" | ".mov" | ".mxf" | ".avi" | ".m4v" | ".mts" | ".m2ts" | ".braw" | ".r3d"
        | ".crm" | ".cine" => ScanFileKind::Footage,
        ".jpg" | ".jpeg" | ".png" | ".heic" | ".tif" | ".tiff" | ".cr2" | ".cr3" | ".nef"
        | ".arw" | ".dng" | ".raw" | ".orf" | ".rw2" => ScanFileKind::Photo,
        ".wav" | ".mp3" | ".aif" | ".aiff" | ".m4a" | ".flac" => ScanFileKind::Audio,
        ".pdf" | ".txt" | ".doc" | ".docx" | ".csv" | ".xlsx" | ".xls" | ".rtf" => {
            ScanFileKind::Document
        }
        ".xml" | ".xmp" | ".thm" | ".cpf" => ScanFileKind::Sidecar,
        ".bin" | ".bnp" | ".ind" | ".inp" | ".int" | ".dat" | ".cpi" | ".mpl" | ".mpls"
        | ".bdm" | ".bdmv" | ".cont" | ".pmpd" | ".tid" | ".tmb" => ScanFileKind::Ignored,
        _ => ScanFileKind::Unknown,
    }
}

fn is_known_ingest_media(extension: &str) -> bool {
    matches!(
        extension,
        ".mp4"
            | ".mov"
            | ".mxf"
            | ".avi"
            | ".m4v"
            | ".mts"
            | ".m2ts"
            | ".braw"
            | ".r3d"
            | ".crm"
            | ".cine"
            | ".jpg"
            | ".jpeg"
            | ".png"
            | ".heic"
            | ".tif"
            | ".tiff"
            | ".cr2"
            | ".cr3"
            | ".nef"
            | ".arw"
            | ".dng"
            | ".raw"
            | ".orf"
            | ".rw2"
            | ".wav"
            | ".mp3"
            | ".aif"
            | ".aiff"
            | ".m4a"
            | ".flac"
    )
}

fn pair_sidecars(files: &mut [ScannedFile]) {
    let media_paths = files
        .iter()
        .filter(|file| {
            matches!(
                file.kind,
                ScanFileKind::Footage
                    | ScanFileKind::Photo
                    | ScanFileKind::Audio
                    | ScanFileKind::Document
            )
        })
        .map(|file| {
            (
                sidecar_pair_key(&file.relative_path, &file.stem),
                file.relative_path.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();

    for file in files {
        if !matches!(file.kind, ScanFileKind::Sidecar) {
            continue;
        }
        let key = sidecar_pair_key(&file.relative_path, &file.stem);
        file.sidecar_for = media_paths.get(&key).cloned();
    }
}

fn sidecar_pair_key(relative_path: &str, stem: &str) -> String {
    let parent = Path::new(relative_path)
        .parent()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    format!("{parent}/{stem}")
}

fn is_skipped_directory(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();

    // Junk / metadata folders that never hold ingestable media.
    if matches!(
        name.as_str(),
        "__macosx"
            | ".spotlight-v100"
            | ".trashes"
            | ".fseventsd"
            | ".temporaryitems"
            | ".documentrevisions-v100"
    ) {
        return true;
    }

    // macOS media-library bundles (Photos, Music/iTunes, TV, iMovie, Aperture, Final Cut).
    // These are package directories the user never wants ingested as loose files, and
    // descending into one triggers a macOS privacy (TCC) prompt for that library — a
    // primary source of the "allow access" prompt storm during a broad scan.
    const PROTECTED_LIBRARY_SUFFIXES: [&str; 7] = [
        ".photoslibrary",
        ".photolibrary",
        ".musiclibrary",
        ".tvlibrary",
        ".imovielibrary",
        ".aplibrary",
        ".fcpbundle",
    ];
    if name == "photo booth library"
        || PROTECTED_LIBRARY_SUFFIXES
            .iter()
            .any(|suffix| name.ends_with(suffix))
    {
        return true;
    }

    is_protected_system_dir(path)
}

/// Operating-system directories that hold no camera media but are privacy-gated or
/// enormous. Matched by absolute path (not just leaf name) so a user's own folder that
/// happens to share a name — a `Library` folder on a card, say — is still scanned.
#[cfg(target_os = "macos")]
fn is_protected_system_dir(path: &Path) -> bool {
    const SYSTEM_ROOTS: [&str; 6] = ["/System", "/Library", "/private", "/Network", "/usr", "/bin"];
    if SYSTEM_ROOTS.iter().any(|root| path == Path::new(root)) {
        return true;
    }
    // ~/Library — app data and caches, never camera media. Reading another app's folder
    // in here is what raises the "would like to access data from other apps" prompt.
    if let Ok(home) = std::env::var("HOME") {
        if path == Path::new(&home).join("Library") {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
fn is_protected_system_dir(_path: &Path) -> bool {
    false
}

fn filtered_directory_kind(path: &Path) -> Option<ScanFileKind> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let compact = name.replace([' ', '-', '_'], "");

    matches!(
        compact.as_str(),
        "thumbnail"
            | "thumbnails"
            | "thumb"
            | "thumbs"
            | "thmbnl"
            | ".thumbnails"
            | "preview"
            | "previews"
    )
    .then_some(ScanFileKind::Ignored)
}

fn is_ignored_file(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    lower == ".ds_store"
        || lower == "thumbs.db"
        || lower == "desktop.ini"
        || lower == "ehthumbs.db"
        || lower.starts_with("._")
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn format_modified_time(time: std::time::SystemTime) -> Option<String> {
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn skips_macos_protected_libraries_but_not_normal_folders() {
        // Apple media-library bundles are skipped so a scan never dives into them, and so
        // never trips the per-library macOS privacy prompt.
        assert!(is_skipped_directory(Path::new(
            "/Volumes/Card/Pictures/My Shoot.photoslibrary"
        )));
        assert!(is_skipped_directory(Path::new(
            "/Users/x/Music/Music Library.musiclibrary"
        )));
        assert!(is_skipped_directory(Path::new("/Users/x/Movies/Edit.fcpbundle")));
        assert!(is_skipped_directory(Path::new(
            "/Users/x/Pictures/Photo Booth Library"
        )));

        // Real camera folders — and a user folder that merely shares a system name — are
        // still scanned.
        assert!(!is_skipped_directory(Path::new("/Volumes/Card/DCIM")));
        assert!(!is_skipped_directory(Path::new("/Volumes/Card/Library")));
        assert!(!is_skipped_directory(Path::new("/Volumes/Card/DCIM/100CANON")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_to_scan_the_startup_disk_root_but_allows_folders_on_it() {
        // The exact regression: the boot volume matched the "PRIVATE camera folder"
        // signature (APFS is case-insensitive, so PRIVATE resolves to /private), got
        // auto-adopted as a card, and was then walked in full.
        assert!(scan_source("/").is_err());
        let home = std::env::var("HOME").expect("HOME");
        assert!(scan_source(&home).is_err());
        if Path::new("/Volumes/Macintosh HD").exists() {
            assert!(scan_source("/Volumes/Macintosh HD").is_err());
        }

        // A real folder the user picked on the internal drive is still scannable.
        let workspace = unique_temp_dir("ingest_pilot_system_root_test");
        fs::create_dir_all(&workspace).expect("mkdir");
        assert!(scan_source(&workspace.to_string_lossy()).is_ok());
        let _ = fs::remove_dir_all(&workspace);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn treats_the_startup_disk_as_a_system_disk() {
        // The regression this guards: `/Volumes/Macintosh HD` is a firmlink to `/`, so the
        // card detector used to offer the boot volume as a card and then walk the whole home
        // folder, raising a storm of TCC prompts.
        assert!(is_on_system_disk(Path::new("/")));
        let home = std::env::var("HOME").expect("HOME");
        assert!(is_on_system_disk(Path::new(&home)));

        // A path that does not exist is not claimed to be on the system disk.
        assert!(!is_on_system_disk(Path::new(
            "/Volumes/definitely-not-mounted-ingest-pilot-test"
        )));
    }

    #[test]
    fn scans_source_folder_extensions_and_size() {
        let workspace = unique_temp_dir("ingest_pilot_scan_test");
        fs::create_dir_all(workspace.join("Nested")).expect("nested dir");
        fs::create_dir_all(workspace.join("DCIM").join("THUMBNAIL")).expect("thumbnail dir");
        fs::write(workspace.join("A.MP4"), vec![0; 10]).expect("mp4");
        fs::write(workspace.join("Nested").join("B.wav"), vec![0; 5]).expect("wav");
        fs::write(workspace.join("A.XML"), vec![0; 3]).expect("xml");
        fs::write(workspace.join("Nested").join("Real.JPG"), vec![0; 6]).expect("jpg");
        fs::write(
            workspace.join("DCIM").join("THUMBNAIL").join("A.JPG"),
            vec![0; 1],
        )
        .expect("thumbnail jpg");
        fs::write(workspace.join("README"), vec![0; 2]).expect("none");
        fs::write(workspace.join(".DS_Store"), vec![0; 4]).expect("ignored");

        let scan = scan_source(&workspace.to_string_lossy()).expect("scan succeeds");

        assert_eq!(scan.total_files, 7);
        assert_eq!(scan.total_bytes, 31);
        assert_eq!(scan.ingest_files, 3);
        assert_eq!(scan.sidecar_files, 1);
        assert_eq!(scan.ignored_files, 3);
        assert!(scan.extensions.iter().any(|item| item.extension == ".mp4"
            && item.count == 1
            && item.kind == ScanFileKind::Footage));
        assert!(scan.extensions.iter().any(|item| item.extension == ".wav"
            && item.count == 1
            && item.kind == ScanFileKind::Audio));
        assert!(scan.extensions.iter().any(|item| item.extension == ".jpg"
            && item.count == 1
            && item.kind == ScanFileKind::Photo));
        assert!(scan.extensions.iter().any(|item| item.extension == ".jpg"
            && item.count == 1
            && item.kind == ScanFileKind::Ignored));
        assert!(scan.extensions.iter().any(|item| item.extension == "(none)"
            && item.count == 1
            && item.kind == ScanFileKind::Unknown));
        assert!(scan.extensions.iter().any(|item| item.extension == "(none)"
            && item.count == 1
            && item.kind == ScanFileKind::Ignored));
        assert!(scan.files.iter().any(|item| {
            item.relative_path == "A.XML" && item.sidecar_for.as_deref() == Some("A.MP4")
        }));

        let _ = fs::remove_dir_all(workspace);
    }

    /// The regression this rule exists for: a card that is nothing but `DCIM/100CANON/*.JPG`.
    /// Under the old donor-only rule none of these lived in a THMBNL/PREVIEW folder, so every
    /// tile in the picker read "No thumbnail" — on the one file type that needs no work at all.
    #[test]
    fn plain_dcim_jpegs_are_their_own_preview() {
        let workspace = unique_temp_dir("ingest_pilot_self_preview_test");
        let dcim = workspace.join("DCIM").join("100CANON");
        fs::create_dir_all(&dcim).expect("dcim dir");
        fs::write(dcim.join("IMG_0001.JPG"), vec![0; 8]).expect("jpg");
        fs::write(dcim.join("IMG_0002.PNG"), vec![0; 8]).expect("png");

        let scan = scan_source(&workspace.to_string_lossy()).expect("scan succeeds");
        for name in ["IMG_0001.JPG", "IMG_0002.PNG"] {
            let file = scan
                .files
                .iter()
                .find(|file| file.file_name == name)
                .unwrap_or_else(|| panic!("{name} scanned"));
            assert_eq!(
                file.thumbnail_path.as_deref(),
                Some(file.path.as_str()),
                "{name} must point at its own pixels"
            );
        }

        let _ = fs::remove_dir_all(workspace);
    }

    /// Self-preview must not cannibalise the donor path: a RAW/clip with a companion JPEG in a
    /// THMBNL folder still gets the companion, and the companion is still a valid donor.
    #[test]
    fn companion_donor_still_wins_for_non_browser_media() {
        let workspace = unique_temp_dir("ingest_pilot_donor_test");
        fs::create_dir_all(workspace.join("CLIP").join("THMBNL")).expect("thmbnl dir");
        fs::write(workspace.join("CLIP").join("C0001.MP4"), vec![0; 8]).expect("mp4");
        let donor = workspace.join("CLIP").join("THMBNL").join("C0001.JPG");
        fs::write(&donor, vec![0; 4]).expect("donor jpg");

        let scan = scan_source(&workspace.to_string_lossy()).expect("scan succeeds");
        let clip = scan
            .files
            .iter()
            .find(|file| file.file_name == "C0001.MP4")
            .expect("clip scanned");
        assert_eq!(
            clip.thumbnail_path.as_deref(),
            Some(donor.to_string_lossy().as_ref()),
            "clip must still resolve to its THMBNL companion"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    /// The donor rule stays folder-gated on purpose. `matching_thumbnail_source` falls back to
    /// loose digit matching, so an arbitrary DCIM still must NOT be promoted to donor — it
    /// would attach itself to an unrelated clip that happens to share digits.
    #[test]
    fn arbitrary_dcim_jpeg_is_not_a_donor() {
        let workspace = unique_temp_dir("ingest_pilot_donor_gate_test");
        let dcim = workspace.join("DCIM").join("100CANON");
        fs::create_dir_all(&dcim).expect("dcim dir");
        fs::write(dcim.join("IMG_0001.JPG"), vec![0; 8]).expect("jpg");
        fs::write(dcim.join("IMG_0001.CR3"), vec![0; 8]).expect("cr3");

        let scan = scan_source(&workspace.to_string_lossy()).expect("scan succeeds");
        let raw = scan
            .files
            .iter()
            .find(|file| file.file_name == "IMG_0001.CR3")
            .expect("cr3 scanned");
        assert!(
            raw.thumbnail_path.is_none(),
            "a loose DCIM JPEG must not be donated; the CR3's preview is generated from its own \
             embedded JPEG by the extractor ladder instead"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn normal_scan_reports_no_unreadable_paths() {
        let workspace = unique_temp_dir("ingest_pilot_scan_clean");
        fs::create_dir_all(&workspace).expect("dir");
        fs::write(workspace.join("A.MP4"), vec![0; 4]).expect("mp4");

        let scan = scan_source(&workspace.to_string_lossy()).expect("scan succeeds");
        assert!(scan.unreadable_paths.is_empty());

        let _ = fs::remove_dir_all(workspace);
    }

    // A folder we can't open must be skipped and recorded, not abort the whole scan.
    // Only meaningful where permission bits are enforced (Unix); Windows CI skips it.
    #[cfg(unix)]
    #[test]
    fn skips_and_records_unreadable_directory() {
        use std::os::unix::fs::PermissionsExt;

        let workspace = unique_temp_dir("ingest_pilot_scan_denied");
        fs::create_dir_all(&workspace).expect("root");
        fs::write(workspace.join("Readable.MP4"), vec![0; 8]).expect("mp4");
        let locked = workspace.join("NoAccess");
        fs::create_dir_all(&locked).expect("locked dir");
        fs::write(locked.join("Secret.MP4"), vec![0; 16]).expect("secret");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod");

        let scan = scan_source(&workspace.to_string_lossy()).expect("scan still succeeds");

        // The readable file is found; the locked folder is skipped + recorded.
        assert!(scan.files.iter().any(|file| file.relative_path == "Readable.MP4"));
        assert!(scan.files.iter().all(|file| file.relative_path != "NoAccess/Secret.MP4"));
        assert!(scan
            .unreadable_paths
            .iter()
            .any(|path| path.ends_with("NoAccess")));

        // Restore perms so cleanup can remove the tree.
        let _ = fs::set_permissions(&locked, fs::Permissions::from_mode(0o755));
        let _ = fs::remove_dir_all(workspace);
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        std::env::temp_dir().join(format!("{prefix}_{suffix}"))
    }
}
