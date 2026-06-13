import { invoke } from "@tauri-apps/api/core";
import { createShippedPresets } from "./presetFactory";
import type { AppSettings, FolderNode, Preset, PresetSummary, TokenContext } from "./types";

const shippedPresetSeedKey = "ingest-pilot:shipped-presets-seeded";

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
  },
  camera_watcher: {
    auto_detect_cards: true,
    prompt_on_card_detected: false,
    tray_mode: false,
  },
  file_selector: {
    default_view: "list",
    thumbnail_size: 142,
    group_by_date: true,
  },
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
  elapsed_ms: number;
  bytes_per_second: number;
  remaining_ms?: number | null;
};

export type IngestHistoryJob = {
  id: string;
  preset_name: string;
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
  const presets = await invoke<PresetSummary[]>("list_presets");
  if (presets.length > 0 || localStorage.getItem(shippedPresetSeedKey) === "true") {
    return presets;
  }

  const shippedPresets = createShippedPresets();
  await Promise.all(shippedPresets.map((preset) => invoke<PresetSummary>("save_preset", { preset })));
  localStorage.setItem(shippedPresetSeedKey, "true");
  return invoke<PresetSummary[]>("list_presets");
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
  includedRelativePaths: string[],
  useExistingRoot: boolean,
  jobId: string,
) {
  return invoke<IngestResult>("run_ingest", {
    presetId,
    sourcePath,
    variableValues,
    destinationOverride: destinationOverride || null,
    preserveSidecars,
    renameFiles,
    includedRelativePaths,
    useExistingRoot,
    jobId,
  });
}

export async function cancelIngest(jobId: string) {
  return invoke<void>("cancel_ingest", { jobId });
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
  });
}

export async function generateIngestReport(
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
  jobId: string,
) {
  return invoke<string>("generate_ingest_report", {
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
    jobId,
  });
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
    report_defaults: { ...defaultAppSettings.report_defaults, ...settings.report_defaults },
    camera_watcher: { ...defaultAppSettings.camera_watcher, ...settings.camera_watcher },
    file_selector: { ...defaultAppSettings.file_selector, ...settings.file_selector },
  };
}
