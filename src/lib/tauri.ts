import { invoke } from "@tauri-apps/api/core";
import { createShippedPresets } from "./presetFactory";
import type { NamingCatalog } from "./namingCatalog";
import type {
  AppSettings,
  IconikSettings,
  ReportOutputLocation,
  FolderNode,
  MetadataPreset,
  MetadataPresetSummary,
  Preset,
  PresetSummary,
  TokenContext,
} from "./types";

const shippedPresetSeedKey = "ingest-pilot:shipped-presets-seeded";
const namingPackCleanupKey = "ingest-pilot:naming-pack-removed";

export const defaultAppSettings: AppSettings = {
  global_parameters: [],
  ingest_defaults: {
    auto_scan_sources: true,
    rename_files: true,
    delete_sidecars: false,
    destination_mode: "create_new",
    open_folder_when_done: true,
  },
  report_defaults: {
    include_thumbnails: true,
    write_html_report: true,
    open_report_when_done: false,
    notes_template: "",
    output_location: { mode: "root", subfolder: "_Admin", custom_path: "", move_mhl: false },
  },
  camera_watcher: {
    auto_detect_cards: true,
    pop_open_on_card: true,
    tray_mode: true,
    launch_at_login: false,
    pop_open_mode: "always",
  },
  file_selector: {
    default_view: "list",
    thumbnail_size: 142,
    group_by_date: true,
  },
  operator_name: "",
  custom_file_kinds: {},
  shooters: [],
  iconik: {
    base_url: "https://app.iconik.io",
    app_id: "",
    auth_token: "",
    view_id: "",
    view_name: "",
    auto_push: false,
  },
  sound: { enabled: true, volume: 80 },
  safety: {
    never_delete_source: false,
    low_space_stop_percent: 0,
    min_verified_copies: 1,
    confirm_destructive: true,
    always_write_offload_proof: false,
    safe_mode: false,
  },
  drive_nicknames: {},
  show_advanced: false,
};

export type DroppedTemplateItems = {
  folders: FolderNode[];
  files: string[];
};

export type ScaffoldResult = {
  root_path: string;
  folders_created: number;
  files_copied: number;
  created_paths: string[];
};

export type ExtensionSummary = {
  extension: string;
  count: number;
  total_bytes: number;
  kind: ScanFileKind;
};

export type ScanFileKind = "footage" | "photo" | "audio" | "document" | "sidecar" | "unknown" | "ignored";

export type KindSummary = {
  kind: ScanFileKind;
  count: number;
  total_bytes: number;
};

export type ScannedFile = {
  path: string;
  relative_path: string;
  file_name: string;
  stem: string;
  extension: string;
  size_bytes: number;
  modified_at?: string | null;
  kind: ScanFileKind;
  sidecar_for?: string | null;
  thumbnail_path?: string | null;
};

export type SourceScan = {
  root_path: string;
  total_files: number;
  total_bytes: number;
  ingest_files: number;
  ignored_files: number;
  sidecar_files: number;
  extensions: ExtensionSummary[];
  kinds: KindSummary[];
  files: ScannedFile[];
  unreadable_paths: string[];
};

export type CameraSource = {
  path: string;
  label: string;
  reason: string;
};

export type DiskSpace = {
  path: string;
  root: string;
  available_bytes: number;
  total_bytes: number;
};

export type CopiedFile = {
  source_path: string;
  destination_path: string;
  kind: ScanFileKind;
  size_bytes: number;
  thumbnail_path?: string | null;
  source_hash: string;
  destination_hash: string;
  verified: boolean;
  duration_ms?: number | null;
};

export type SkippedFile = {
  source_path: string;
  reason: string;
};

export type IngestResult = {
  root_path: string;
  files_copied: number;
  sidecars_copied: number;
  skipped_files: number;
  verified_files: number;
  verification_failed: number;
  bytes_copied: number;
  mhl_path: string;
  report_path: string;
  copied_files: CopiedFile[];
  skipped: SkippedFile[];
};

export type IngestProgress = {
  job_id: string;
  phase: string;
  current_file: string;
  files_done: number;
  total_files: number;
  bytes_done: number;
  total_bytes: number;
  verified_bytes: number;
  verified_files: number;
  elapsed_ms: number;
  bytes_per_second: number;
  remaining_ms?: number | null;
};

export type IngestHistoryJob = {
  id: string;
  preset_id?: string;
  preset_name: string;
  variable_values?: Record<string, string>;
  status: string;
  started_at: string;
  completed_at: string;
  source_paths: string[];
  destination_paths: string[];
  root_path: string;
  report_path: string;
  mhl_path: string;
  files_copied: number;
  verified_files: number;
  verification_failed: number;
  bytes_copied: number;
  sidecars_deleted?: number;
};

export async function listPresets() {
  let presets = await invoke<PresetSummary[]>("list_presets");

  // First-run: seed the base shipped presets.
  if (presets.length === 0 && localStorage.getItem(shippedPresetSeedKey) !== "true") {
    const shippedPresets = createShippedPresets();
    await Promise.all(shippedPresets.map((preset) => invoke<PresetSummary>("save_preset", { preset })));
    localStorage.setItem(shippedPresetSeedKey, "true");
    presets = await invoke<PresetSummary[]>("list_presets");
  }

  // One-time cleanup: an earlier build wrongly seeded every naming template as a
  // folder preset (ids `naming_*`). Naming templates live in the Naming tab, not the
  // preset library, so remove those seeded files. User-created presets (including
  // ones made via the Naming tab's "Create preset", ids `preset_*`) are untouched.
  if (localStorage.getItem(namingPackCleanupKey) !== "true") {
    const seeded = presets.filter((preset) => preset.id.startsWith("naming_"));
    if (seeded.length > 0) {
      await Promise.all(seeded.map((preset) => invoke<void>("delete_preset", { id: preset.id })));
      presets = await invoke<PresetSummary[]>("list_presets");
    }
    localStorage.setItem(namingPackCleanupKey, "true");
  }

  return presets;
}

export async function getPreset(id: string) {
  return invoke<Preset | null>("get_preset", { id });
}

export async function savePreset(preset: Preset) {
  return invoke<PresetSummary>("save_preset", { preset });
}

export async function deletePreset(id: string) {
  return invoke<void>("delete_preset", { id });
}

export async function duplicatePreset(id: string) {
  return invoke<PresetSummary>("duplicate_preset", { id });
}

export async function importPreset(filePath: string) {
  return invoke<PresetSummary>("import_preset", { filePath });
}

export async function exportPreset(id: string, targetPath: string) {
  return invoke<void>("export_preset", { id, targetPath });
}

export async function importFolderTree(folderPath: string) {
  return invoke<FolderNode[]>("import_folder_tree", { folderPath });
}

export async function inspectTemplateDrop(paths: string[]) {
  return invoke<DroppedTemplateItems>("inspect_template_drop", { paths });
}

export async function filterDirectories(paths: string[]) {
  return invoke<string[]>("filter_directories", { paths });
}

export async function listMetadataPresets() {
  return invoke<MetadataPresetSummary[]>("list_metadata_presets");
}

export async function getMetadataPreset(id: string) {
  return invoke<MetadataPreset | null>("get_metadata_preset", { id });
}

export async function saveMetadataPreset(preset: MetadataPreset) {
  return invoke<MetadataPresetSummary>("save_metadata_preset", { preset });
}

export async function deleteMetadataPreset(id: string) {
  return invoke<void>("delete_metadata_preset", { id });
}

export async function getNamingCatalog() {
  return invoke<NamingCatalog | null>("get_naming_catalog");
}

export async function saveNamingCatalog(catalog: NamingCatalog) {
  return invoke<void>("save_naming_catalog", { catalog });
}

export type FolderMetadataOverride = {
  path_prefix: string;
  preset: MetadataPreset;
};

export async function exportMetadataManifest(
  rootPath: string,
  copiedFiles: CopiedFile[],
  preset: MetadataPreset,
  values: Record<string, string>,
  folderOverrides: FolderMetadataOverride[] = [],
  outputDir?: string,
) {
  return invoke<string>("export_metadata_manifest", {
    rootPath,
    copiedFiles,
    preset,
    values,
    folderOverrides,
    outputDir: outputDir ?? null,
  });
}

export async function previewPattern(pattern: string, context: TokenContext) {
  return invoke<string>("preview_pattern", { pattern, context });
}

export async function scaffoldProject(
  presetId: string,
  variableValues: Record<string, string>,
  destinationOverride?: string,
) {
  return invoke<ScaffoldResult>("scaffold_project", {
    presetId,
    variableValues,
    destinationOverride: destinationOverride || null,
  });
}

export async function openPath(path: string) {
  return invoke<void>("open_path", { path });
}

export async function diskSpace(path: string) {
  return invoke<DiskSpace>("disk_space", { path });
}

export async function scanSource(sourcePath: string) {
  return invoke<SourceScan>("scan_source", { sourcePath });
}

export async function detectCameraSources() {
  return invoke<CameraSource[]>("detect_camera_sources");
}

export async function runIngest(
  presetId: string,
  sourcePath: string,
  variableValues: Record<string, string>,
  destinationOverride: string | undefined,
  preserveSidecars: boolean,
  renameFiles: boolean,
  cameraOverride: string | undefined,
  includedRelativePaths: string[],
  useExistingRoot: boolean,
  jobId: string,
  rootNameOverride?: string,
) {
  return invoke<IngestResult>("run_ingest", {
    presetId,
    sourcePath,
    variableValues,
    destinationOverride: destinationOverride || null,
    preserveSidecars,
    renameFiles,
    cameraOverride: cameraOverride || null,
    includedRelativePaths,
    useExistingRoot,
    jobId,
    rootNameOverride: rootNameOverride || null,
  });
}

export async function cancelIngest(jobId: string) {
  return invoke<void>("cancel_ingest", { jobId });
}

export type RetryFailedItem = {
  source_path: string;
  destination_path: string;
  kind: ScanFileKind;
  size_bytes: number;
};

export async function retryFailedCopies(items: RetryFailedItem[]) {
  return invoke<CopiedFile[]>("retry_failed_copies", { items });
}

// Resolves where generated artifacts should be written for a given project root and
// output-location config. Returns undefined for "root" (the writers default to root).
// {year}/{month}/{day} tokens in a subfolder name are resolved to today.
export function resolveReportDir(rootPath: string, loc: ReportOutputLocation): string | undefined {
  if (!loc || loc.mode === "root") {
    return undefined;
  }
  if (loc.mode === "custom") {
    return loc.custom_path.trim() || undefined;
  }
  const now = new Date();
  const sub = (loc.subfolder || "_Admin")
    .replace(/\{year\}/g, String(now.getFullYear()))
    .replace(/\{month\}/g, String(now.getMonth() + 1).padStart(2, "0"))
    .replace(/\{day\}/g, String(now.getDate()).padStart(2, "0"))
    .trim();
  if (!sub) {
    return undefined;
  }
  const sep = rootPath.includes("\\") ? "\\" : "/";
  return `${rootPath.replace(/[\\/]+$/, "")}${sep}${sub}`;
}

export async function generateOffloadProof(args: {
  rootPath: string;
  presetName: string;
  sourcePaths: string[];
  destinationPaths: string[];
  copiedFiles: CopiedFile[];
  filesCopied: number;
  verifiedFiles: number;
  verificationFailed: number;
  bytesCopied: number;
  operator: string;
  generatedAt: string;
  outputDir?: string;
}) {
  return invoke<string>("generate_offload_proof", { ...args, outputDir: args.outputDir ?? null });
}

export async function exportReelIndex(
  rootPath: string,
  copiedFiles: CopiedFile[],
  format: "csv" | "json",
  outputDir?: string,
) {
  return invoke<string>("export_reel_index", { rootPath, copiedFiles, format, outputDir: outputDir ?? null });
}

export async function listHistory() {
  return invoke<IngestHistoryJob[]>("list_history");
}

export async function saveHistoryJob(job: IngestHistoryJob) {
  return invoke<IngestHistoryJob[]>("save_history_job", { job });
}

export async function clearHistory() {
  return invoke<void>("clear_history");
}

export async function writeIngestReport(
  presetName: string,
  sourcePath: string,
  rootPath: string,
  variableValues: Record<string, string>,
  copiedFiles: CopiedFile[],
  skippedFiles: SkippedFile[],
  filesCopied: number,
  verifiedFiles: number,
  verificationFailed: number,
  bytesCopied: number,
  mhlPath: string,
  durationMs?: number,
  outputDir?: string,
) {
  return invoke<string>("write_ingest_report", {
    presetName,
    sourcePath,
    rootPath,
    variableValues,
    copiedFiles,
    skippedFiles,
    filesCopied,
    verifiedFiles,
    verificationFailed,
    bytesCopied,
    mhlPath,
    durationMs: durationMs ?? null,
    outputDir: outputDir ?? null,
  });
}

export async function generateIngestReport(
  presetName: string,
  sourcePath: string,
  rootPath: string,
  destinationRoots: string[],
  variableValues: Record<string, string>,
  copiedFiles: CopiedFile[],
  skippedFiles: SkippedFile[],
  filesCopied: number,
  verifiedFiles: number,
  verificationFailed: number,
  bytesCopied: number,
  mhlPath: string,
  jobId: string,
  durationMs?: number,
  outputDir?: string,
) {
  return invoke<string>("generate_ingest_report", {
    presetName,
    sourcePath,
    rootPath,
    destinationRoots,
    variableValues,
    copiedFiles,
    skippedFiles,
    filesCopied,
    verifiedFiles,
    verificationFailed,
    bytesCopied,
    mhlPath,
    jobId,
    durationMs: durationMs ?? null,
    outputDir: outputDir ?? null,
  });
}

// Brings the app window to the front from the tray/background (card insert, ingest
// complete). Best-effort and safe to call when already visible; swallows the error in
// design mode where the command isn't present.
export async function showMainWindow() {
  try {
    await invoke("show_main_window");
  } catch {
    // no-op in design mode / non-desktop
  }
}

export async function setLaunchAtLogin(enabled: boolean) {
  return invoke<void>("set_launch_at_login", { enabled });
}

export async function getLaunchAtLogin() {
  try {
    return await invoke<boolean>("get_launch_at_login");
  } catch {
    return false;
  }
}

// Exports the full config (settings, presets, metadata presets, naming catalog,
// shooters) to a file the user picks. iconik credentials are omitted. Returns the
// written path, or null if the user cancelled the save dialog.
export async function exportConfigBundle() {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: "Ingest Pilot Config.ingestpilot.json",
    filters: [{ name: "Ingest Pilot Config", extensions: ["json"] }],
  });
  if (!path) {
    return null;
  }
  await invoke("export_config_bundle", { path });
  return path;
}

// Imports a config bundle the user picks, replacing local config. Returns true if a
// file was imported, false if cancelled.
export async function importConfigBundle() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    filters: [{ name: "Ingest Pilot Config", extensions: ["json"] }],
  });
  if (!selected || Array.isArray(selected)) {
    return false;
  }
  await invoke("import_config_bundle", { path: selected });
  return true;
}

export async function getSettings() {
  const settings = await invoke<Partial<AppSettings>>("get_settings");
  return normalizeSettings(settings);
}

export async function saveSettings(settings: AppSettings) {
  const saved = await invoke<Partial<AppSettings>>("save_settings", { settings });
  return normalizeSettings(saved);
}

function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  return {
    ...defaultAppSettings,
    ...settings,
    global_parameters: settings.global_parameters ?? [],
    ingest_defaults: { ...defaultAppSettings.ingest_defaults, ...settings.ingest_defaults },
    camera_watcher: { ...defaultAppSettings.camera_watcher, ...settings.camera_watcher },
    file_selector: { ...defaultAppSettings.file_selector, ...settings.file_selector },
    shooters: settings.shooters ?? [],
    iconik: { ...defaultAppSettings.iconik, ...settings.iconik },
    sound: { ...defaultAppSettings.sound, ...settings.sound },
    safety: { ...defaultAppSettings.safety, ...settings.safety },
    drive_nicknames: settings.drive_nicknames ?? {},
    show_advanced: settings.show_advanced ?? false,
    report_defaults: {
      ...defaultAppSettings.report_defaults,
      ...settings.report_defaults,
      output_location: {
        ...defaultAppSettings.report_defaults.output_location,
        ...settings.report_defaults?.output_location,
      },
    },
  };
}

// --- iconik metadata API -------------------------------------------------

export type IconikView = { id: string; name: string };
export type IconikField = {
  name: string;
  label: string;
  field_type: string;
  options: string[];
  multi: boolean;
  required: boolean;
};
export type IconikPushItem = { title: string; values: Record<string, string[]> };
export type IconikPushResult = {
  title: string;
  status: "updated" | "not_found" | "error";
  detail?: string | null;
};

type IconikConfig = { base_url: string; app_id: string; auth_token: string };

function iconikConfig(settings: IconikSettings): IconikConfig {
  return {
    base_url: settings.base_url,
    app_id: settings.app_id,
    auth_token: settings.auth_token,
  };
}

/** Lists the metadata views on the connected iconik instance (also a connection test). */
export async function iconikListViews(settings: IconikSettings) {
  return invoke<IconikView[]>("iconik_list_views", { config: iconikConfig(settings) });
}

/** Returns the fields (name/label/type) of a specific iconik metadata view. */
export async function iconikViewFields(settings: IconikSettings, viewId: string) {
  return invoke<IconikField[]>("iconik_view_fields", {
    config: iconikConfig(settings),
    viewId,
  });
}

/** Writes metadata onto iconik assets, matching each item to an asset by title. */
export async function iconikPushMetadata(
  settings: IconikSettings,
  viewId: string,
  items: IconikPushItem[],
) {
  return invoke<IconikPushResult[]>("iconik_push_metadata", {
    config: iconikConfig(settings),
    viewId,
    items,
  });
}
