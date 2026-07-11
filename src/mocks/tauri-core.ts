// Design-mode mock for "@tauri-apps/api/core".
// Swapped in via a Vite alias only when DESIGN_MODE is set (see vite.config.ts).
// Lets the full real UI run in a plain browser / Claude Design with no Rust backend.
// The real desktop build never imports this file.
import { createShippedPresets } from "../lib/presetFactory";
import { createDefaultMetadataPreset } from "../lib/metadataPresetFactory";
import { defaultNamingCatalog, type NamingCatalog } from "../lib/namingCatalog";
import { designJobState } from "./designJobState";
import type {
  CameraSource,
  CopiedFile,
  DiskSpace,
  DroppedTemplateItems,
  IngestHistoryJob,
  IngestResult,
  ScaffoldResult,
  ScannedFile,
  SourceScan,
} from "../lib/tauri";
import type {
  AppSettings,
  FolderNode,
  MetadataPreset,
  MetadataPresetSummary,
  Preset,
  PresetSummary,
  TokenContext,
} from "../lib/types";

const SAMPLE_DATE = "20260628";
const SAMPLE_DATE_PARTS = { year: "2026", month: "06", day: "28" };

// Mirror the Rust {date} formatter for design-mode previews: substitute the sample
// date parts into a layout template (YYYY / YY / MM / DD), passing separators through.
function formatMockDate(format?: string | null): string {
  const fmt = (format ?? "").trim();
  if (!fmt) {
    return SAMPLE_DATE;
  }
  const { year, month, day } = SAMPLE_DATE_PARTS;
  return fmt
    .replace(/YYYY/g, year)
    .replace(/YY/g, year.slice(-2))
    .replace(/MM/g, month)
    .replace(/DD/g, day);
}

// In-memory preset store so save/delete/duplicate feel real while designing.
let presets: Preset[] = createShippedPresets();
let metadataPresets: MetadataPreset[] = [createDefaultMetadataPreset("2026-06-30T00:00:00Z")];
let namingCatalog: NamingCatalog | null = defaultNamingCatalog();

function summary(preset: Preset): PresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    color: preset.color,
    updated_at: preset.updated_at,
  };
}

// Mirrors the Rust token resolver's separator collapsing so the design-mode preview
// matches: runs of _ / - fold to one and are trimmed from the ends.
function collapseSeparators(value: string): string {
  return value.replace(/([_-])[_-]+/g, "$1").replace(/^[_\- ]+|[_\- ]+$/g, "");
}

function resolvePattern(pattern: string, ctx?: TokenContext): string {
  const values = ctx?.variable_values ?? {};
  const resolved = pattern.replace(/\{([^}]+)\}/g, (_match, raw: string) => {
    const key = raw.trim();
    switch (key) {
      case "date":
        return formatMockDate(ctx?.date_format ?? settings?.ingest_defaults?.date_format);
      case "year":
        return "2026";
      case "month":
        return "06";
      case "day":
        return "28";
      case "preset_name":
        return ctx?.preset_name ?? "Preset";
      case "camera":
        return ctx?.camera ?? "FX3";
      case "clip#": {
        const n = ctx?.clip_number ?? 1;
        const pad = ctx?.clip_number_padding ?? 3;
        return String(n).padStart(pad, "0");
      }
      case "original_name":
        return ctx?.original_name ?? "C0001";
      case "capture_date":
        return ctx?.capture_date ?? SAMPLE_DATE;
      case "ext":
        return ctx?.extension ?? ".mp4";
      case "folder_name":
        return ctx?.folder_name ?? "Footage";
      default:
        return values[key] ?? `{${key}}`;
    }
  });
  return collapseSeparators(resolved);
}

function scannedFile(
  rel: string,
  kind: ScannedFile["kind"],
  size: number,
  extra: Partial<ScannedFile> = {},
): ScannedFile {
  const fileName = rel.split("/").pop() ?? rel;
  const dot = fileName.lastIndexOf(".");
  return {
    path: `D:/A001_SONY/${rel}`,
    relative_path: rel,
    file_name: fileName,
    stem: dot > 0 ? fileName.slice(0, dot) : fileName,
    extension: dot > 0 ? fileName.slice(dot) : "",
    size_bytes: size,
    modified_at: "2026-06-28T09:14:00Z",
    kind,
    sidecar_for: null,
    thumbnail_path: null,
    ...extra,
  };
}

function sampleScan(rootPath: string): SourceScan {
  const files: ScannedFile[] = [
    scannedFile("PRIVATE/M4ROOT/CLIP/FX3_6713.MP4", "footage", 4_823_749_012),
    scannedFile("PRIVATE/M4ROOT/CLIP/FX3_6714.MP4", "footage", 3_104_882_330),
    scannedFile("PRIVATE/M4ROOT/CLIP/FX3_6715.MP4", "footage", 5_902_114_771),
    scannedFile("PRIVATE/M4ROOT/CLIP/FX3_6713M01.XML", "sidecar", 12_044, {
      sidecar_for: "PRIVATE/M4ROOT/CLIP/FX3_6713.MP4",
    }),
    // A RED clip: spanned .R3D segments inside a .RDC folder (collapse into one row).
    scannedFile("A009_0629G2.RDM/A009_C011_0701HB.RDC/A009_C011_0701HB_001.R3D", "footage", 2_018_000_000),
    scannedFile("A009_0629G2.RDM/A009_C011_0701HB.RDC/A009_C011_0701HB_002.R3D", "footage", 2_018_000_000),
    scannedFile("A009_0629G2.RDM/A009_C011_0701HB.RDC/A009_C011_0701HB_003.R3D", "footage", 2_018_000_000),
    scannedFile("A009_0629G2.RDM/A009_C011_0701HB.RDC/A009_C011_0701HB_004.R3D", "footage", 524_100_000),
    scannedFile("AUDIO/ZOOM0007.WAV", "audio", 188_220_004),
    scannedFile("AUDIO/ZOOM0008.WAV", "audio", 142_553_120),
    scannedFile("DCIM/100MSDCF/DSC00412.JPG", "photo", 9_220_114),
    scannedFile("DCIM/100MSDCF/DSC00413.JPG", "photo", 8_904_551),
    scannedFile("DOCS/shotlist.pdf", "document", 244_180),
    scannedFile("PRIVATE/M4ROOT/THMBNL/FX3_6713.JPG", "ignored", 44_120),
  ];
  const ingest = files.filter((f) => f.kind !== "ignored" && f.kind !== "sidecar");
  const totalBytes = files.reduce((sum, f) => sum + f.size_bytes, 0);
  return {
    root_path: rootPath,
    total_files: files.length,
    total_bytes: totalBytes,
    ingest_files: ingest.length,
    ignored_files: files.filter((f) => f.kind === "ignored").length,
    sidecar_files: files.filter((f) => f.kind === "sidecar").length,
    extensions: [
      { extension: ".mp4", count: 3, total_bytes: 13_830_746_113, kind: "footage" },
      { extension: ".wav", count: 2, total_bytes: 330_773_124, kind: "audio" },
      { extension: ".jpg", count: 2, total_bytes: 18_124_665, kind: "photo" },
      { extension: ".xml", count: 1, total_bytes: 12_044, kind: "sidecar" },
      { extension: ".pdf", count: 1, total_bytes: 244_180, kind: "document" },
    ],
    kinds: [
      { kind: "footage", count: 3, total_bytes: 13_830_746_113 },
      { kind: "audio", count: 2, total_bytes: 330_773_124 },
      { kind: "photo", count: 2, total_bytes: 18_124_665 },
      { kind: "document", count: 1, total_bytes: 244_180 },
    ],
    files,
    unreadable_paths: [],
  };
}

function sampleCopiedFiles(): CopiedFile[] {
  const scan = sampleScan("D:/A001_SONY");
  return scan.files
    .filter((f) => f.kind !== "ignored" && f.kind !== "sidecar")
    .map((f, i) => ({
      source_path: f.path,
      destination_path: `E:/MediaServer/20260628_BaptismStory_Johnson/Footage/${f.file_name}`,
      kind: f.kind,
      size_bytes: f.size_bytes,
      thumbnail_path: null,
      source_hash: `xxh3:${(i + 1).toString(16).padStart(16, "0")}`,
      destination_hash: `xxh3:${(i + 1).toString(16).padStart(16, "0")}`,
      verified: true,
    }));
}

function sampleHistory(): IngestHistoryJob[] {
  return [
    {
      id: "job_20260628_johnson",
      preset_id: presets[0]?.id ?? "",
      preset_name: "Video Team Standard",
      variable_values: { event: "Baptism", talent: "Johnson" },
      status: "complete",
      started_at: "2026-06-28T09:20:00Z",
      completed_at: "2026-06-28T09:41:00Z",
      source_paths: ["D:/A001_SONY"],
      destination_paths: ["E:/MediaServer/20260628_BaptismStory_Johnson"],
      root_path: "E:/MediaServer/20260628_BaptismStory_Johnson",
      report_path: "E:/MediaServer/20260628_BaptismStory_Johnson/IngestPilot_Report.html",
      mhl_path: "E:/MediaServer/20260628_BaptismStory_Johnson/IngestPilot.mhl",
      files_copied: 8,
      verified_files: 8,
      verification_failed: 0,
      bytes_copied: 14_179_887_082,
      sidecars_deleted: 0,
    },
    {
      id: "job_20260621_easter",
      preset_id: presets[1]?.id ?? presets[0]?.id ?? "",
      preset_name: "Drone + B-Roll",
      variable_values: { event: "Coastline", talent: "Aerial Unit" },
      status: "complete",
      started_at: "2026-06-21T14:02:00Z",
      completed_at: "2026-06-21T14:19:00Z",
      source_paths: ["F:/DJI_001"],
      destination_paths: ["E:/MediaServer/20260621_Coastline_Drone"],
      root_path: "E:/MediaServer/20260621_Coastline_Drone",
      report_path: "E:/MediaServer/20260621_Coastline_Drone/IngestPilot_Report.html",
      mhl_path: "E:/MediaServer/20260621_Coastline_Drone/IngestPilot.mhl",
      files_copied: 24,
      verified_files: 24,
      verification_failed: 0,
      bytes_copied: 31_882_551_904,
      sidecars_deleted: 2,
    },
  ];
}

let history: IngestHistoryJob[] = sampleHistory();
let settings: AppSettings | null = null;

// 1x1 transparent-ish gray placeholder for thumbnails in design mode.
const PLACEHOLDER_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#e8e6ef"/><text x="80" y="50" font-family="sans-serif" font-size="11" fill="#9b97ab" text-anchor="middle">preview</text></svg>',
  );

export function convertFileSrc(path: string): string {
  if (/\.(jpe?g|png|gif|webp)$/i.test(path)) {
    return PLACEHOLDER_THUMB;
  }
  return path;
}

export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Small delay so loading states are visible while designing.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const a = (args ?? {}) as Record<string, any>;

  switch (command) {
    case "greet":
      return `Hello, ${a.name ?? "designer"} (design mode)` as T;

    case "list_presets":
      return presets.map(summary) as T;
    case "get_preset":
      return (presets.find((p) => p.id === a.id) ?? null) as T;
    case "save_preset": {
      const preset = a.preset as Preset;
      const idx = presets.findIndex((p) => p.id === preset.id);
      const next = { ...preset, updated_at: new Date().toISOString() };
      if (idx >= 0) presets[idx] = next;
      else presets = [...presets, next];
      return summary(next) as T;
    }
    case "delete_preset":
      presets = presets.filter((p) => p.id !== a.id);
      return undefined as T;

    case "list_metadata_presets":
      return metadataPresets.map(
        (preset): MetadataPresetSummary => ({
          id: preset.id,
          name: preset.name,
          description: preset.description ?? null,
          field_count: preset.categories.reduce((sum, category) => sum + category.fields.length, 0),
        }),
      ) as T;
    case "get_metadata_preset":
      return (metadataPresets.find((p) => p.id === a.id) ?? null) as T;
    case "save_metadata_preset": {
      const preset = a.preset as MetadataPreset;
      const idx = metadataPresets.findIndex((p) => p.id === preset.id);
      const next = { ...preset, updated_at: new Date().toISOString() };
      if (idx >= 0) metadataPresets[idx] = next;
      else metadataPresets = [...metadataPresets, next];
      return { id: next.id, name: next.name, description: next.description ?? null, field_count: 0 } as T;
    }
    case "delete_metadata_preset":
      metadataPresets = metadataPresets.filter((p) => p.id !== a.id);
      return undefined as T;

    case "get_naming_catalog":
      return (namingCatalog ?? null) as T;
    case "save_naming_catalog":
      namingCatalog = a.catalog ?? null;
      return undefined as T;
    case "export_metadata_manifest":
      return "E:/PROJECTS/2026-06-30_Project/2026-06-30_Project_Metadata.csv" as T;

    case "iconik_list_views":
      return [
        { id: "view-general", name: "General" },
        { id: "view-story", name: "People / Story" },
        { id: "view-admin", name: "Admin" },
      ] as T;
    case "iconik_view_fields":
      return [
        { name: "campus", label: "Campus", field_type: "drop_down", multi: false, required: true, options: ["Keller", "Haslet", "McKinney", "Online"] },
        { name: "ministry", label: "Ministry", field_type: "drop_down", multi: false, required: false, options: ["Central", "Weekends", "Youth", "Missions"] },
        { name: "video_type", label: "Video Type", field_type: "drop_down", multi: false, required: false, options: ["ARoll", "BRoll", "Interview", "Event"] },
        { name: "keywords", label: "Keywords", field_type: "drop_down", multi: true, required: false, options: ["baptism", "worship", "testimony", "kids"] },
        { name: "notes", label: "Notes", field_type: "text", multi: false, required: false, options: [] },
      ] as T;
    case "iconik_push_metadata":
      return ((a.items as { title: string }[]) ?? []).map((item, index) => ({
        title: item.title,
        status: index === 0 ? "not_found" : "updated",
        detail: index === 0 ? "No matching asset in iconik yet." : null,
      })) as T;
    case "duplicate_preset": {
      const original = presets.find((p) => p.id === a.id);
      if (!original) throw new Error("Preset not found");
      const copy: Preset = {
        ...original,
        id: `${original.id}_copy_${Math.floor(performance.now())}`,
        name: `${original.name} Copy`,
        updated_at: new Date().toISOString(),
      };
      presets = [...presets, copy];
      return summary(copy) as T;
    }
    case "import_preset": {
      const imported = createShippedPresets()[0];
      const copy = { ...imported, id: `imported_${Math.floor(performance.now())}`, name: "Imported Preset" };
      presets = [...presets, copy];
      return summary(copy) as T;
    }
    case "export_preset":
      return undefined as T;

    case "import_folder_tree":
      return [] as unknown as FolderNode[] as T;
    case "inspect_template_drop":
      return { folders: [], files: [] } as DroppedTemplateItems as T;

    case "preview_pattern":
      return resolvePattern(a.pattern ?? "", a.context as TokenContext) as T;

    case "scaffold_project": {
      const result: ScaffoldResult = {
        root_path: "E:/MediaServer/20260628_NewProject",
        folders_created: 9,
        files_copied: 2,
        created_paths: [
          "E:/MediaServer/20260628_NewProject/Footage",
          "E:/MediaServer/20260628_NewProject/Audio",
          "E:/MediaServer/20260628_NewProject/Project Files",
        ],
      };
      return result as T;
    }

    case "open_path":
      return undefined as T;
    case "open_guide":
      // Design/mock mode: no bundled resources to open — just no-op.
      return undefined as T;
    case "filter_directories":
      return ((a.paths as string[]) ?? []) as T;
    case "disk_space":
      return {
        path: a.path ?? "E:/",
        root: "E:/",
        available_bytes: 4_210_000_000_000,
        total_bytes: 8_000_000_000_000,
      } as DiskSpace as T;

    case "scan_source":
      return sampleScan(a.sourcePath ?? "D:/A001_SONY") as T;
    case "detect_camera_sources":
      return [
        { path: "D:/A001_SONY", label: "A001_SONY (Sony FX3)", reason: "PRIVATE/M4ROOT detected" },
      ] as CameraSource[] as T;

    case "run_ingest": {
      // Share the run's job_id so the simulated progress events (tauri-event.ts) match.
      designJobState.id = (a.jobId as string) ?? "";
      // Keep the run screen up long enough to watch the real speed chart scroll.
      await new Promise((resolve) => setTimeout(resolve, 20000));
      const copied = sampleCopiedFiles();
      const result: IngestResult = {
        root_path: "E:/MediaServer/20260628_BaptismStory_Johnson",
        files_copied: copied.length,
        sidecars_copied: 1,
        skipped_files: 0,
        verified_files: copied.length,
        verification_failed: 0,
        bytes_copied: copied.reduce((s, f) => s + f.size_bytes, 0),
        mhl_path: "E:/MediaServer/20260628_BaptismStory_Johnson/IngestPilot.mhl",
        report_path: "E:/MediaServer/20260628_BaptismStory_Johnson/IngestPilot_Report.html",
        copied_files: copied,
        skipped: [],
      };
      return result as T;
    }
    case "cancel_ingest":
      return undefined as T;

    case "retry_failed_copies":
      // Pretend every retried copy now verifies.
      return ((a.items as any[]) ?? []).map((item) => ({
        source_path: item.source_path,
        destination_path: item.destination_path,
        kind: item.kind,
        size_bytes: item.size_bytes,
        thumbnail_path: null,
        source_hash: "xxh3:retry",
        destination_hash: "xxh3:retry",
        verified: true,
        duration_ms: null,
      })) as T;

    case "generate_offload_proof":
      return `${a.rootPath ?? "E:/MediaServer/Project"}/Project_OffloadProof.pdf` as T;

    case "export_reel_index":
      return `${a.rootPath ?? "E:/MediaServer/Project"}/Project_ReelIndex.${a.format === "json" ? "json" : "csv"}` as T;

    case "list_history":
      return history as T;
    case "save_history_job":
      history = [a.job as IngestHistoryJob, ...history];
      return history as T;
    case "clear_history":
      history = [];
      return undefined as T;

    case "write_ingest_report":
    case "generate_ingest_report":
      return "E:/MediaServer/20260628_BaptismStory_Johnson/IngestPilot_Report.html" as T;

    case "get_settings":
      return (settings ?? {}) as T;
    case "save_settings":
      settings = a.settings as AppSettings;
      return settings as T;

    case "export_config_bundle":
      return undefined as T;
    case "import_config_bundle":
      return undefined as T;

    case "show_main_window":
      return undefined as T;
    case "set_launch_at_login":
      return undefined as T;
    case "get_launch_at_login":
      return false as T;

    default:
      console.warn(`[design-mock] unhandled command: ${command}`);
      return undefined as T;
  }
}
