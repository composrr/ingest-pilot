import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Activity, Check, ChevronDown, ChevronUp, Clock, Film, FolderOpen, HardDrive, Image, Layers, List, Plus, RefreshCw, Search, ShieldCheck, Users, Wand2, X } from "lucide-react";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultsForParameters,
  medianHistoricalBytesPerSecond,
  mergeGlobalAndPresetParameters,
  recentValuesByVariable,
} from "../lib/parameters";
import { FloatingHelp } from "../components/FloatingHelp";
import { RecentIngestsCarousel } from "../components/RecentIngestsCarousel";
import { SelectMenu } from "../components/SelectMenu";
import { TokenSuggestInput } from "../components/TokenSuggest";
import { getTokenDefinitions } from "../lib/tokens";
import {
  defaultAppSettings,
  getPreset,
  getSettings,
  saveSettings,
  listHistory,
  listPresets,
  openPath,
  previewPattern,
  cancelIngest,
  diskSpace,
  exportMetadataManifest,
  exportReelIndex,
  filterDirectories,
  generateIngestReport,
  generateSourceThumbnails,
  getMetadataPreset,
  listMetadataPresets,
  saveMetadataPreset,
  generateOffloadProof,
  runIngestMulti,
  retryFailedCopies,
  saveHistoryJob,
  getNamingCatalog,
  iconikPushMetadata,
  iconikViewFields,
  resolveReportDir,
  showMainWindow,
  scanSource,
  detectCameraSources,
  type CameraSource,
  type CopiedFile,
  type DestinationFailure,
  type DestinationProgress,
  type FileVerified,
  type MultiIngestResult,
  type DiskSpace,
  type FolderMetadataOverride,
  type IconikField,
  type IconikPushItem,
  type IconikPushResult,
  type IngestHistoryJob,
  type IngestProgress,
  type IngestResult,
  type ScanFileKind,
  type ScannedFile,
  type SourceScan,
} from "../lib/tauri";
import type {
  AppSettings,
  FolderNode,
  MetadataPreset,
  MetadataPresetSummary,
  Preset,
  PresetSummary,
  PresetVariable,
  Shooter,
} from "../lib/types";
import { useAppStore } from "../stores/appStore";
import { playCompletionSound } from "../lib/sound";
import {
  defaultNamingCatalog,
  mergeNamingCatalog,
  previewNamingResult,
  type NamingDeliverable,
} from "../lib/namingCatalog";
import { createDefaultMetadataPreset } from "../lib/metadataPresetFactory";

// True if any folder in the tree carries its own metadata preset, so we still write
// the manifest (from folder defaults) even when no shoot-wide values were entered.
function folderTreeHasMetadata(nodes: FolderNode[]): boolean {
  return nodes.some((node) => Boolean(node.metadata_preset_id) || folderTreeHasMetadata(node.children ?? []));
}

type IconikPushState = {
  status: "idle" | "pushing" | "done" | "error";
  results: IconikPushResult[];
  error?: string;
};

// Normalizes a field name/label so our metadata fields line up with iconik's field
// names regardless of case, spaces, or punctuation ("Video Type" ~ "video_type").
function normalizeFieldKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// The delivered filename without its extension — iconik stores asset titles without
// the extension, so this is what we match assets on.
function fileStem(destinationPath: string): string {
  const name = destinationPath.replace(/\\/g, "/").split("/").pop() ?? destinationPath;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// Picks the deepest folder metadata override a clip landed inside (longest matching
// path prefix), mirroring the Rust manifest writer so API pushes and CSV agree.
function deepestOverride(
  overrides: FolderMetadataOverride[],
  destinationPath: string,
): FolderMetadataOverride | null {
  const normalized = destinationPath.replace(/\\/g, "/");
  let best: FolderMetadataOverride | null = null;
  for (const entry of overrides) {
    const prefix = entry.path_prefix.replace(/\\/g, "/");
    if (prefix && normalized.startsWith(prefix)) {
      if (!best || entry.path_prefix.length > best.path_prefix.length) {
        best = entry;
      }
    }
  }
  return best;
}

// Builds one iconik push item per copied clip: title = delivered filename (no ext),
// values = our metadata resolved for that clip (shoot-wide overlaid with its campus
// folder override) and re-keyed to the exact iconik field names in the chosen view.
// Clips whose resolved values are all empty are dropped so we don't clear tags.
function buildIconikItems(
  copiedFiles: CopiedFile[],
  preset: MetadataPreset,
  shootValues: Record<string, string>,
  overrides: FolderMetadataOverride[],
  iconikFields: IconikField[],
): IconikPushItem[] {
  // Map each of our field ids to the iconik field name it should be written to, and
  // remember which fields are multi-value so we can split comma lists into arrays.
  const iconikByKey = new Map<string, string>();
  for (const field of iconikFields) {
    iconikByKey.set(normalizeFieldKey(field.name), field.name);
    iconikByKey.set(normalizeFieldKey(field.label), field.name);
  }
  const fieldToIconik = new Map<string, string>();
  const multiValueFields = new Set<string>();
  const registerField = (id: string, label: string, isMulti: boolean) => {
    const target = iconikByKey.get(normalizeFieldKey(id)) ?? iconikByKey.get(normalizeFieldKey(label));
    if (target) {
      fieldToIconik.set(id, target);
      if (isMulti) {
        multiValueFields.add(id);
      }
    }
  };
  const collectFields = (schema: MetadataPreset) => {
    for (const category of schema.categories) {
      for (const field of category.fields) {
        registerField(field.id, field.label, field.field_type === "multi_select");
      }
    }
  };
  collectFields(preset);
  overrides.forEach((entry) => collectFields(entry.preset));

  const items: IconikPushItem[] = [];
  for (const file of copiedFiles) {
    if (file.kind === "sidecar") {
      continue;
    }
    const resolved: Record<string, string> = { ...shootValues };
    const override = deepestOverride(overrides, file.destination_path);
    if (override) {
      for (const category of override.preset.categories) {
        for (const field of category.fields) {
          if (field.default && field.default.trim()) {
            resolved[field.id] = field.default;
          }
        }
      }
    }
    const values: Record<string, string[]> = {};
    for (const [fieldId, raw] of Object.entries(resolved)) {
      const iconikName = fieldToIconik.get(fieldId);
      if (!iconikName || !raw.trim()) {
        continue;
      }
      values[iconikName] = multiValueFields.has(fieldId)
        ? raw.split(",").map((part) => part.trim()).filter(Boolean)
        : [raw.trim()];
    }
    if (Object.keys(values).length > 0) {
      items.push({ title: fileStem(file.destination_path), values });
    }
  }
  return items;
}

// Overlays fresh push results onto prior ones (keyed by title) so a retry updates the
// affected rows without dropping the clips we did not re-push.
function mergePushResults(
  prior: IconikPushResult[],
  fresh: IconikPushResult[],
): IconikPushResult[] {
  const byTitle = new Map(prior.map((row) => [row.title, row]));
  for (const row of fresh) {
    byTitle.set(row.title, row);
  }
  return Array.from(byTitle.values());
}

// Queue mode: a sequential pipeline of source cards. Each card is scanned in the
// background (scan-ahead) while an earlier card copies, then copied in order into
// the shared destination(s) under one job. Cards can be added while the queue runs.
type QueueCardStatus = "pending" | "scanning" | "ready" | "copying" | "done" | "error";
type QueueCard = {
  id: string;
  sourcePath: string;
  cameraAlias: string;
  status: QueueCardStatus;
  scan: SourceScan | null;
  fileCount: number;
  byteCount: number;
  result: IngestResult | null;
  error: string | null;
};

type RunSource = {
  sourcePath: string;
  scan: SourceScan;
  includedRelativePaths: string[];
  cameraAlias?: string;
};

// Maps an OS drag-drop position to the marked drop zone under it, if any. Tauri
// reports positions in CSS pixels in this setup (same as FolderTreeEditor), so they
// can be passed straight to elementFromPoint.
type DropZone = "queue" | "destinations" | "sources";

// Canonical identity key for a destination, mirroring the realistic cases the Rust
// `run_ingest_multi` collapses before spawning per-destination copy threads: it trims
// whitespace, strips trailing path separators, and lowercases (Windows-case-insensitive).
// Deduping the destination list with this key keeps the list we pass 1:1 with Rust's
// post-dedup list (so roots/failures index alignment holds) and makes the safety gate +
// Destinations count reflect real distinct drives rather than trailing-slash/case variants.
function canonicalDestinationKey(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").toLowerCase();
}

// Parent folder of a path (handles both / and \ separators); null if at a root.
function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index > 0 ? trimmed.slice(0, index) : null;
}

function dropZoneFromPoint(x: number, y: number): DropZone | null {
  const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-zone]");
  const name = zone?.dataset.dropZone;
  return name === "queue" || name === "destinations" || name === "sources" ? name : null;
}

export function IngestPage() {
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [globalParameters, setGlobalParameters] = useState<PresetVariable[]>([]);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [sourcePaths, setSourcePaths] = useState<string[]>([]);
  const [sourceScans, setSourceScans] = useState<SourceScanEntry[]>([]);
  const [destinationPath, setDestinationPath] = useState("");
  const [secondaryDestinationPaths, setSecondaryDestinationPaths] = useState<string[]>([]);
  const [destinationMode, setDestinationMode] = useState<"create_new" | "existing_root">("create_new");
  const [detectedSources, setDetectedSources] = useState<CameraSource[]>([]);
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanWarning, setScanWarning] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isIngesting, setIsIngesting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [deleteSidecars, setDeleteSidecars] = useState(false);
  const [renameFiles, setRenameFiles] = useState(true);
  // Per-ingest file-name pattern, seeded from the selected preset. Editing it here
  // overrides the preset's file_rename_pattern for this run only (the preset file is
  // untouched); blank falls back to the preset's own pattern in the backend.
  const [fileRenamePattern, setFileRenamePattern] = useState("");
  const [showFileNameEditor, setShowFileNameEditor] = useState(false);
  const [showFilteredItems, setShowFilteredItems] = useState(false);
  const [outputPreview, setOutputPreview] = useState<IngestOutputPreview | null>(null);
  const [selectedRelativePaths, setSelectedRelativePaths] = useState<Set<string>>(new Set());
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [speedSeries, setSpeedSeries] = useState<SpeedPoint[]>([]);
  const [instantaneousBps, setInstantaneousBps] = useState(0);
  const [reportBuild, setReportBuild] = useState<ReportBuildState>({ status: "idle", progress: null });
  const [isFileSelectorOpen, setIsFileSelectorOpen] = useState(false);
  // File-picker view state, lifted to the page so it survives the modal unmounting on
  // close (the dialog itself remounts fresh each open). Seeded from settings the first
  // time the picker opens, then persisted for the rest of the session.
  const [filePickerUi, setFilePickerUi] = useState<FilePickerUiState>(() => ({
    viewMode: defaultAppSettings.file_selector.default_view,
    thumbnailSize: defaultAppSettings.file_selector.thumbnail_size,
    sortMode: "date",
    sortDirection: "desc",
    search: "",
    kindFilter: new Set<ScanFileKind>(),
    groupByDate: defaultAppSettings.file_selector.group_by_date,
  }));
  const pickerSeededRef = useRef(false);
  const openFileSelector = useCallback(() => {
    // Seed the picker's view/size/grouping from the user's real settings on first open
    // (settings load async, so the initial state above uses the built-in defaults).
    if (!pickerSeededRef.current) {
      setFilePickerUi((current) => ({
        ...current,
        viewMode: appSettings.file_selector.default_view,
        thumbnailSize: appSettings.file_selector.thumbnail_size,
        groupByDate: appSettings.file_selector.group_by_date,
      }));
      pickerSeededRef.current = true;
    }
    setIsFileSelectorOpen(true);
  }, [
    appSettings.file_selector.default_view,
    appSettings.file_selector.group_by_date,
    appSettings.file_selector.thumbnail_size,
  ]);
  // Search + kind filter are transient query state, not preferences: a new scan (different
  // card) must not inherit the previous card's filters, or a footage filter left over from
  // the last card makes a photos-only card read as "No files match your filters". View mode,
  // thumbnail size, and grouping are real preferences and stay put.
  useEffect(() => {
    setFilePickerUi((current) =>
      current.search === "" && current.kindFilter.size === 0
        ? current
        : { ...current, search: "", kindFilter: new Set() },
    );
  }, [sourceScans]);
  const [spaceByPath, setSpaceByPath] = useState<Record<string, DiskSpace | null>>({});
  // Per-destination progress rows for the concurrent multi-destination copy. Sampled
  // from `ingest-progress`'s `destinations[]` alongside the aggregate speed chart.
  const [destinationProgress, setDestinationProgress] = useState<DestinationProgress[]>([]);
  // Live per-file integrity feed (newest first, capped) driven by `file-verified`. Each
  // entry carries a stable monotonic id so prepending a new batch doesn't re-key the list.
  const [verifiedFeed, setVerifiedFeed] = useState<VerifiedFeedEntry[]>([]);
  // AUTHORITATIVE, UNCAPPED integrity tally (see the refs below). Independent of the capped
  // display feed so an early checksum failure can never scroll out of view and flip the
  // run's red state back to green. Drives every failure indicator on the run screen.
  const [verifiedFailedTotal, setVerifiedFailedTotal] = useState(0);
  const [verifiedFailedByDest, setVerifiedFailedByDest] = useState<Map<number, number>>(new Map());
  // Destinations whose copy thread failed this run (drive pulled, unwritable path, panic).
  // Surfaced on the delivery screen + history status; a failed drive is never swallowed.
  const [destinationFailures, setDestinationFailures] = useState<DestinationFailure[]>([]);
  const [recentJobs, setRecentJobs] = useState<IngestHistoryJob[]>([]);
  const [variableSuggestions, setVariableSuggestions] = useState<Record<string, string[]>>({});
  const [historicalBps, setHistoricalBps] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isSavingProof, setIsSavingProof] = useState(false);
  const [cameraAliases, setCameraAliases] = useState<Record<string, string>>({});
  const [currentSegment, setCurrentSegment] = useState<{ label: string; index: number; total: number } | null>(null);
  const [metadataSummaries, setMetadataSummaries] = useState<MetadataPresetSummary[]>([]);
  const [metadataPresetId, setMetadataPresetId] = useState("");
  const [metadataPreset, setMetadataPreset] = useState<MetadataPreset | null>(null);
  const [metadataValues, setMetadataValues] = useState<Record<string, string>>({});
  const [isSavingManifest, setIsSavingManifest] = useState(false);
  const [iconikPush, setIconikPush] = useState<IconikPushState>({ status: "idle", results: [] });
  const [isNamingOpen, setIsNamingOpen] = useState(false);
  // Project name chosen via the Naming wizard for THIS ingest. Overrides the
  // preset's root folder name at run time without touching the preset itself.
  const [projectNameOverride, setProjectNameOverride] = useState("");
  const [queueMode, setQueueMode] = useState(false);
  const [queue, setQueue] = useState<QueueCard[]>([]);
  const [isQueueRunning, setIsQueueRunning] = useState(false);
  // Which drop zone the OS drag is currently over ("queue" | "destinations" | "sources" | null).
  const [dragZone, setDragZone] = useState<DropZone | null>(null);
  const currentIngestJobId = useRef<string | null>(null);
  // The source-path set most recently auto-scanned, so the auto-scan effect scans a
  // given set of sources at most once (and never retries a failed set in a loop).
  const autoScanSignatureRef = useRef("");
  // Live mirror of the queue so the async runner sees cards added mid-run.
  const queueRef = useRef<QueueCard[]>([]);
  // Dedupes scan-ahead: one in-flight scan promise per card id.
  const cardScanPromises = useRef<Map<string, Promise<SourceScan>>>(new Map());
  // Live mirrors so the window-level drop handler reads current destinations/sources.
  const destinationPathRef = useRef("");
  const secondaryDestinationsRef = useRef<string[]>([]);
  const sourcePathsRef = useRef<string[]>([]);
  // Variable values from a replayed recent ingest, applied once the new preset's
  // parameters resolve (so the defaults effect below doesn't clobber them).
  const pendingReplayValuesRef = useRef<Record<string, string> | null>(null);
  // Real speed-over-time tracking for the run-screen chart. The ingest-progress
  // event floods (one per 256 KB), so the listener only writes refs; a fixed-cadence
  // timer samples them into render state. X axis uses a frontend monotonic clock so
  // multi-destination/source runs (which reset the backend elapsed/bytes per segment)
  // render as one continuous, scrolling timeline.
  const progressBufferRef = useRef<SpeedSample[]>([]);
  const latestProgressRef = useRef<IngestProgress | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const runStartRef = useRef<number>(0);
  // file-verified arrives ~1/file/dest — a flood on large small-file cards. The listener
  // is a pure ref-writer (like the progress listener); the fixed-cadence sample timer
  // flushes the buffer into `verifiedFeed`, so we re-render at a steady rate, not per file.
  const verifiedFeedBufferRef = useRef<VerifiedFeedEntry[]>([]);
  const verifiedFeedIdRef = useRef(0);
  // Source of truth for the integrity tally (mirrored into state on the sample timer). Each
  // (file,dest) fires `file-verified` exactly once with a unique id, so a plain increment on
  // `!verified` is exact — no double counting — and never evicted like the capped feed.
  const verifiedFailedTotalRef = useRef(0);
  const verifiedFailedByDestRef = useRef<Map<number, number>>(new Map());
  const verifiedFailedDirtyRef = useRef(false);
  const setLastAction = useAppStore((state) => state.setLastAction);
  const setRequestedView = useAppStore((state) => state.setRequestedView);
  const metadataRev = useAppStore((state) => state.metadataRev);
  const presetsRev = useAppStore((state) => state.presetsRev);
  const settingsRev = useAppStore((state) => state.settingsRev);
  const sourcePath = sourcePaths[0] ?? "";
  const scan = useMemo(() => aggregateSourceScans(sourceScans), [sourceScans]);
  // Distinct destination drives, order-preserving. Deduped by the same canonical key Rust
  // uses (trim + trailing-separator + Windows-case) so the list stays 1:1 with the backend's
  // post-dedup list and the safety gate / Destinations count reflect real distinct copies —
  // two paths that canonicalize to one can't silently pass "require N verified copies".
  const destinationTargets = useMemo(() => {
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const path of [destinationPath, ...secondaryDestinationPaths]) {
      const trimmed = path.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const key = canonicalDestinationKey(trimmed);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push(trimmed);
    }
    return targets;
  }, [destinationPath, secondaryDestinationPaths]);

  const ingestParameters = useMemo(
    () => mergeGlobalAndPresetParameters(globalParameters, preset?.variables ?? []),
    [globalParameters, preset?.variables],
  );
  const routingPreview = useMemo(
    () => (preset && scan ? buildRoutingPreview(preset, scan, deleteSidecars) : []),
    [deleteSidecars, preset, scan],
  );
  const visibleRoutingPreview = useMemo(
    () =>
      showFilteredItems
        ? routingPreview
        : routingPreview.filter((extension) => !isFilteredPreviewRow(extension)),
    [routingPreview, showFilteredItems],
  );
  const filteredPreviewCount = useMemo(
    () => routingPreview.filter((extension) => isFilteredPreviewRow(extension)).length,
    [routingPreview],
  );
  const copyableFiles = useMemo(
    () => scan?.files.filter((file) => matchesRoutableKind(file.kind)) ?? [],
    [scan],
  );
  const visibleManifestFiles = useMemo(
    () => buildManifestFiles(sourceScans, selectedRelativePaths, deleteSidecars),
    [deleteSidecars, selectedRelativePaths, sourceScans],
  );
  const selectedFileCount = useMemo(
    () =>
      sourceScans.reduce(
        (count, entry) =>
          count +
          entry.scan.files.filter(
            (file) => matchesRoutableKind(file.kind) && selectedRelativePaths.has(sourceFileKey(entry.sourcePath, file.relative_path)),
          ).length,
        0,
      ),
    [selectedRelativePaths, sourceScans],
  );
  const selectedBytes = useMemo(
    () =>
      sourceScans.reduce(
        (sum, entry) =>
          sum +
          entry.scan.files
            .filter(
              (file) => matchesRoutableKind(file.kind) && selectedRelativePaths.has(sourceFileKey(entry.sourcePath, file.relative_path)),
            )
            .reduce((fileSum, file) => fileSum + file.size_bytes, 0),
        0,
      ),
    [selectedRelativePaths, sourceScans],
  );
  // Estimated transfer time for the selected bytes, using the median speed of past ingests.
  const ingestEtaMs =
    historicalBps > 0 && selectedBytes > 0 ? (selectedBytes / historicalBps) * 1000 : undefined;
  const selectedSidecarCount = useMemo(
    () => visibleManifestFiles.filter((file) => file.kind === "sidecar" && file.autoSelected).length,
    [visibleManifestFiles],
  );
  const canStartIngest = Boolean(
    sourcePath &&
      destinationTargets.length > 0 &&
      selectedPresetId &&
      scan &&
      selectedFileCount > 0,
  );
  // Keep the async queue runner reading the latest cards (incl. ones added mid-run).
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    destinationPathRef.current = destinationPath;
  }, [destinationPath]);
  useEffect(() => {
    secondaryDestinationsRef.current = secondaryDestinationPaths;
  }, [secondaryDestinationPaths]);
  useEffect(() => {
    sourcePathsRef.current = sourcePaths;
  }, [sourcePaths]);
  // Native folder drag-and-drop. A single window-level listener routes the drop by
  // which marked zone (data-drop-zone) it lands on: the card queue or the
  // destinations panel. Each dropped folder becomes a card / a destination.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragZone(dropZoneFromPoint(payload.position.x, payload.position.y));
        } else if (payload.type === "leave") {
          setDragZone(null);
        } else if (payload.type === "drop") {
          const zone = dropZoneFromPoint(payload.position.x, payload.position.y);
          setDragZone(null);
          if (zone === "destinations") {
            void handleDestinationDrop(payload.paths);
          } else if (zone === "queue") {
            void handleQueueDrop(payload.paths);
          } else if (zone === "sources") {
            void handleSourceDrop(payload.paths);
          }
        }
      })
      .then((next) => {
        if (active) {
          unlisten = next;
        } else {
          next();
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
      setDragZone(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const queueFileCount = useMemo(() => queue.reduce((sum, card) => sum + card.fileCount, 0), [queue]);
  const queueByteCount = useMemo(() => queue.reduce((sum, card) => sum + card.byteCount, 0), [queue]);
  const canStartQueue = Boolean(
    selectedPresetId && destinationTargets.length > 0 && queue.length > 0 && !isQueueRunning,
  );

  // Metadata presets: load the list once, and the full preset (with defaults) when
  // the picker changes, so the ingest fill panel can render its fields.
  useEffect(() => {
    void (async () => {
      try {
        let list = await listMetadataPresets();
        // Seed the starter iconik preset on first run so it's available here even if
        // the user hasn't opened the Metadata tab yet.
        if (list.length === 0) {
          await saveMetadataPreset(createDefaultMetadataPreset(new Date().toISOString()));
          list = await listMetadataPresets();
        }
        setMetadataSummaries(list);
      } catch {
        // non-fatal
      }
    })();
  }, [metadataRev]);
  useEffect(() => {
    if (!metadataPresetId) {
      setMetadataPreset(null);
      return;
    }
    let active = true;
    void getMetadataPreset(metadataPresetId)
      .then((preset) => {
        if (!active) {
          return;
        }
        setMetadataPreset(preset);
        if (preset) {
          setMetadataValues((current) => {
            const next = { ...current };
            for (const category of preset.categories) {
              for (const field of category.fields) {
                if (field.field_type === "shooter") {
                  // Default the shooter to this machine's operator (fill if still blank
                  // so it lands even if settings loaded after the preset).
                  if (!next[field.id]) {
                    next[field.id] = field.default || appSettings.operator_name || "";
                  }
                } else if (!(field.id in next)) {
                  next[field.id] = field.default ?? "";
                }
              }
            }
            return next;
          });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // metadataRev: re-fetch when the selected metadata preset is edited/deleted in the Metadata tab.
  }, [metadataPresetId, appSettings.operator_name, metadataRev]);
  const hasMetadataValues = useMemo(
    () => metadataPreset != null && Object.values(metadataValues).some((value) => value.trim().length > 0),
    [metadataPreset, metadataValues],
  );

  // Adds a shooter on the fly to the shared roster (persisted to settings) and returns
  // the name so the field can select it. On-the-fly adds default to "volunteer" so they
  // don't clutter the everyday staff list; recategorize in Settings. Used by the
  // "+ Add shooter" option on a Shooter field.
  async function addShooter(): Promise<string | null> {
    const name = window.prompt("Add a shooter (name)")?.trim();
    if (!name) {
      return null;
    }
    if (!appSettings.shooters.some((shooter) => shooter.name.toLowerCase() === name.toLowerCase())) {
      const next: AppSettings = {
        ...appSettings,
        shooters: [...appSettings.shooters, { name, group: "volunteer" as const }],
      };
      setAppSettings(next);
      try {
        await saveSettings(next);
      } catch {
        // non-fatal: the roster still updates in-session
      }
    }
    return name;
  }

  async function refreshPresets(preferredId = selectedPresetId) {
    setError(null);
    try {
      const nextPresets = await listPresets();
      setPresets(nextPresets);
      const nextId =
        preferredId && nextPresets.some((candidate) => candidate.id === preferredId)
          ? preferredId
          : nextPresets[0]?.id ?? "";
      setSelectedPresetId(nextId);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset load failed");
    }
  }

  async function refreshRecentJobs() {
    try {
      const jobs = await listHistory();
      setRecentJobs(jobs.slice(0, 5));
      setVariableSuggestions(recentValuesByVariable(jobs));
      setHistoricalBps(medianHistoricalBytesPerSecond(jobs));
    } catch {
      setRecentJobs([]);
      setVariableSuggestions({});
      setHistoricalBps(0);
    }
  }

  // Re-copy + re-verify only the files that failed verification, then merge the
  // repaired entries back into the result so the verification view updates.
  async function retryFailedCopiesForResult() {
    if (!ingestResult) {
      return;
    }
    const failed = ingestResult.copied_files.filter((file) => !file.verified);
    if (!failed.length) {
      return;
    }
    setIsRetrying(true);
    setError(null);
    try {
      const updated = await retryFailedCopies(
        failed.map((file) => ({
          source_path: file.source_path,
          destination_path: file.destination_path,
          kind: file.kind,
          size_bytes: file.size_bytes,
        })),
      );
      const repaired = new Map(updated.map((file) => [`${file.source_path} ${file.destination_path}`, file]));
      const mergedFiles = ingestResult.copied_files.map(
        (file) => repaired.get(`${file.source_path} ${file.destination_path}`) ?? file,
      );
      const verified = mergedFiles.filter((file) => file.verified).length;
      setIngestResult({
        ...ingestResult,
        copied_files: mergedFiles,
        verified_files: verified,
        verification_failed: mergedFiles.length - verified,
      });
      setLastAction(`Retried ${failed.length} failed file${failed.length === 1 ? "" : "s"}`);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setIsRetrying(false);
    }
  }

  // Generate a printable PDF offload integrity proof and (optionally) open it.
  async function saveOffloadProof(openAfter = true) {
    if (!ingestResult || !preset) {
      return;
    }
    setIsSavingProof(true);
    setError(null);
    try {
      const path = await generateOffloadProof({
        rootPath: ingestResult.root_path,
        presetName: preset.name,
        sourcePaths,
        destinationPaths: destinationTargets,
        copiedFiles: ingestResult.copied_files,
        filesCopied: ingestResult.files_copied,
        verifiedFiles: ingestResult.verified_files,
        verificationFailed: ingestResult.verification_failed,
        bytesCopied: ingestResult.bytes_copied,
        operator: appSettings.operator_name ?? "",
        generatedAt: new Date().toLocaleString(),
        outputDir: resolveReportDir(ingestResult.root_path, appSettings.report_defaults.output_location),
      });
      if (openAfter) {
        await openPath(path);
      }
      setLastAction("Offload proof saved");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setIsSavingProof(false);
    }
  }

  // Export a per-clip reel index (CSV) to the project root and open it.
  async function saveReelIndex() {
    if (!ingestResult) {
      return;
    }
    setError(null);
    try {
      const path = await exportReelIndex(
        ingestResult.root_path,
        ingestResult.copied_files,
        "csv",
        resolveReportDir(ingestResult.root_path, appSettings.report_defaults.output_location),
      );
      await openPath(path);
      setLastAction("Reel index saved");
    } catch (caught) {
      setError(String(caught));
    }
  }

  // Resolves any per-folder metadata presets into absolute-path overrides so the
  // manifest can tag each clip by the campus folder it landed in. Best-effort: a
  // folder whose preset can't load is simply skipped.
  async function buildFolderMetadataOverrides(rootPath: string): Promise<FolderMetadataOverride[]> {
    if (!preset) {
      return [];
    }
    const overrides: FolderMetadataOverride[] = [];
    const cache = new Map<string, MetadataPreset | null>();
    async function walk(nodes: FolderNode[], parentPath: string) {
      for (const node of nodes) {
        const name = await previewPattern(node.name_pattern, {
          preset_name: preset!.name,
          variable_values: variableValues,
          clip_number_padding: preset!.clip_number_padding,
        });
        const folderPath = joinPreviewPath(parentPath, name);
        if (node.metadata_preset_id) {
          let loaded = cache.get(node.metadata_preset_id);
          if (loaded === undefined) {
            loaded = await getMetadataPreset(node.metadata_preset_id).catch(() => null);
            cache.set(node.metadata_preset_id, loaded);
          }
          if (loaded) {
            overrides.push({ path_prefix: folderPath, preset: loaded });
          }
        }
        if (node.children?.length) {
          await walk(node.children, folderPath);
        }
      }
    }
    await walk(preset.folder_tree, rootPath);
    return overrides;
  }

  // Writes the metadata manifest CSV for the delivered ingest and opens it.
  async function saveMetadataManifest() {
    if (!ingestResult || !metadataPreset) {
      return;
    }
    setIsSavingManifest(true);
    setError(null);
    try {
      const overrides = await buildFolderMetadataOverrides(ingestResult.root_path);
      const path = await exportMetadataManifest(
        ingestResult.root_path,
        ingestResult.copied_files,
        metadataPreset,
        metadataValues,
        overrides,
        resolveReportDir(ingestResult.root_path, appSettings.report_defaults.output_location),
      );
      await openPath(path);
      setLastAction("Metadata manifest saved");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setIsSavingManifest(false);
    }
  }

  // Pushes this ingest's metadata straight onto the matching iconik assets over the
  // API (no sidecars, no CSV). Fetches the chosen view's fields, maps our metadata to
  // the exact iconik field names, then tags each clip by its delivered filename. If
  // `onlyTitles` is given, re-pushes just those clips (used to retry assets iconik
  // had not scanned yet).
  async function pushToIconik(onlyTitles?: string[]) {
    if (!ingestResult || !metadataPreset) {
      return;
    }
    const iconik = appSettings.iconik;
    if (!iconik.app_id.trim() || !iconik.auth_token.trim() || !iconik.view_id.trim()) {
      setIconikPush({
        status: "error",
        results: [],
        error: "Connect iconik and choose a metadata view in Settings first.",
      });
      return;
    }
    setIconikPush((current) => ({ ...current, status: "pushing", error: undefined }));
    try {
      const overrides = await buildFolderMetadataOverrides(ingestResult.root_path);
      const fields = await iconikViewFields(iconik, iconik.view_id);
      let items = buildIconikItems(
        ingestResult.copied_files,
        metadataPreset,
        metadataValues,
        overrides,
        fields,
      );
      if (onlyTitles) {
        const wanted = new Set(onlyTitles);
        items = items.filter((item) => wanted.has(item.title));
      }
      if (items.length === 0) {
        setIconikPush({
          status: "error",
          results: [],
          error: "No metadata values to push. Fill in the metadata fields for this ingest first.",
        });
        return;
      }
      const results = await iconikPushMetadata(iconik, iconik.view_id, items);
      // On a retry, merge the fresh results over the prior ones so the summary reflects
      // the whole ingest, not just the clips we retried.
      setIconikPush((current) => {
        const merged = onlyTitles
          ? mergePushResults(current.results, results)
          : results;
        return { status: "done", results: merged, error: undefined };
      });
      setLastAction(`iconik: ${results.filter((row) => row.status === "updated").length} tagged`);
    } catch (caught) {
      setIconikPush({ status: "error", results: [], error: String(caught) });
    }
  }

  // Auto-writes the metadata manifest into every destination root after an ingest, so
  // each drive carries the CSV for iconik. Non-fatal: a failure never breaks delivery.
  async function autoWriteMetadataManifest(result: IngestResult, roots: string[]) {
    const hasFolderMetadata = preset ? folderTreeHasMetadata(preset.folder_tree) : false;
    if (!metadataPreset || (!hasMetadataValues && !hasFolderMetadata)) {
      return;
    }
    const overrides = await buildFolderMetadataOverrides(result.root_path);
    for (const root of roots) {
      try {
        await exportMetadataManifest(
          root,
          result.copied_files,
          metadataPreset,
          metadataValues,
          overrides,
          resolveReportDir(root, appSettings.report_defaults.output_location),
        );
      } catch {
        // best-effort per destination
      }
    }
  }

  // The auto-detected camera for a source (used as the placeholder for its camera tag).
  function detectedCameraForSource(path: string) {
    const entry = sourceScans.find((scan) => scan.sourcePath === path);
    const file = entry?.scan.files.find((item) => item.kind === "footage") ?? entry?.scan.files[0] ?? null;
    return cameraHintForPreview(file);
  }

  // Replay a recent ingest: restore preset + variables (and destinations) so the
  // operator only has to pick the new card. Source/scan/result are cleared to force a
  // fresh scan of the next card.
  function applyRecentJobState(job: IngestHistoryJob) {
    const nextPresetId = job.preset_id ?? "";
    const presetChanges =
      Boolean(nextPresetId) &&
      nextPresetId !== selectedPresetId &&
      presets.some((candidate) => candidate.id === nextPresetId);
    if (job.variable_values) {
      const replayValues = job.variable_values;
      // Stash for the defaults effect so a preset change doesn't reset them; also apply
      // now so values land even when the preset is unchanged (effect won't re-fire).
      pendingReplayValuesRef.current = replayValues;
      setVariableValues((current) => ({ ...current, ...replayValues }));
    }
    if (presetChanges) {
      setSelectedPresetId(nextPresetId);
    }
    if (job.destination_paths.length > 0) {
      setDestinationPath(job.destination_paths[0] ?? "");
      setSecondaryDestinationPaths(job.destination_paths.slice(1));
    }
    setSourcePaths([]);
    setSourceScans([]);
    setSelectedRelativePaths(new Set());
    setIngestProgress(null);
    setIsFileSelectorOpen(false);
    setIngestResult(null);
    setShowFilteredItems(false);
    setLastAction(`Loaded recent ingest: ${job.preset_name}`);
  }

  // Naming wizard: resolve the chosen template + its fields into the SOP-correct
  // project name and apply it to THIS ingest only. The selected folder preset (its
  // tree, routing, variables) stays exactly as chosen — only the name changes.
  function applyNaming(deliverable: NamingDeliverable, values: Record<string, string>) {
    const name = previewNamingResult(deliverable, values);
    if (!name.trim()) {
      return;
    }
    setProjectNameOverride(name);
    setIngestResult(null);
    setIsNamingOpen(false);
    setLastAction(`Named via wizard: ${name}`);
  }

  async function loadSelectedPreset(id: string) {
    if (!id) {
      setPreset(null);
      setDestinationPath("");
      return;
    }

    setError(null);
    try {
      const nextPreset = await getPreset(id);
      setPreset(nextPreset);
      if (nextPreset) {
        setDeleteSidecars(!nextPreset.preserve_xml_sidecars);
        setRenameFiles(nextPreset.rename_files_default ?? true);
        setFileRenamePattern(nextPreset.file_rename_pattern ?? "");
        setShowFileNameEditor(false);
        setDestinationPath(nextPreset.destinations.primary ?? "");
        setSecondaryDestinationPaths(nextPreset.destinations.secondaries ?? []);
        // A preset can carry its own metadata preset; auto-select it so the operator
        // doesn't have to pick metadata separately on the ingest page.
        if (nextPreset.metadata_preset_id) {
          setMetadataPresetId(nextPreset.metadata_preset_id);
        }
        // Pre-fill the tags the preset chose (e.g. Content Type=Story), still editable
        // per import. The metadata-load effect fills any remaining fields with defaults.
        setMetadataValues({ ...(nextPreset.metadata_values ?? {}) });
      }
    } catch (caught) {
      setError(String(caught));
      setPreset(null);
      setLastAction("Preset detail load failed");
    }
  }

  async function chooseSource(mode: "replace" | "add" = "replace") {
    const path = await open({ directory: true, multiple: false });
    if (typeof path === "string") {
      const nextPaths = mode === "add" ? uniquePaths([...sourcePaths, path]) : [path];
      setSourcePaths(nextPaths);
      setSourceScans([]);
      setSelectedRelativePaths(new Set());
      setIngestProgress(null);
      setIsFileSelectorOpen(false);
      setIngestResult(null);
      if (appSettings.ingest_defaults.auto_scan_sources) {
        void scanPaths(nextPaths);
      }
    }
  }

  function removeSource(index: number) {
    setSourcePaths((current) => current.filter((_, sourceIndex) => sourceIndex !== index));
    setSourceScans([]);
    setSelectedRelativePaths(new Set());
    setIngestProgress(null);
    setIsFileSelectorOpen(false);
    setIngestResult(null);
  }

  async function chooseDestination() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path === "string") {
      setDestinationPath(path);
      setIngestResult(null);
    }
  }

  async function chooseSecondaryDestination(index?: number) {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") {
      return;
    }
    // Reject a backup that canonicalizes to a destination already chosen (a trailing-slash
    // or case variant of the primary / another backup) — it would be a phantom second copy.
    const key = canonicalDestinationKey(path);
    const others = [destinationPathRef.current, ...secondaryDestinationsRef.current].filter(
      (existing, existingIndex) => Boolean(existing) && existingIndex !== (typeof index === "number" ? index + 1 : -1),
    );
    if (others.some((existing) => canonicalDestinationKey(existing) === key)) {
      setError(`"${pathDisplayName(path)}" is already a destination — pick a different drive for a real second copy.`);
      return;
    }
    setSecondaryDestinationPaths((current) => {
      if (typeof index === "number") {
        return current.map((destination, destinationIndex) => (destinationIndex === index ? path : destination));
      }
      return [...current, path];
    });
    setIngestResult(null);
  }

  function removeSecondaryDestination(index: number) {
    setSecondaryDestinationPaths((current) => current.filter((_, destinationIndex) => destinationIndex !== index));
    setIngestResult(null);
  }

  function addSecondaryDestination() {
    setSecondaryDestinationPaths((current) => [...current, ""]);
    setIngestResult(null);
  }

  function updateSecondaryDestination(index: number, value: string) {
    setSecondaryDestinationPaths((current) =>
      current.map((destination, destinationIndex) => (destinationIndex === index ? value : destination)),
    );
    setIngestResult(null);
  }

  async function runScan() {
    await scanPaths(sourcePaths);
  }

  async function scanPaths(paths: string[]) {
    if (paths.length === 0) {
      setError("Choose at least one source folder first.");
      return;
    }

    setIsScanning(true);
    setError(null);
    setScanWarning(null);
    try {
      const nextScans = await Promise.all(
        paths.map(async (path) => ({
          sourcePath: path,
          scan: await scanSource(path),
        })),
      );
      setSourceScans(nextScans);
      setSelectedRelativePaths(
        new Set(
          nextScans.flatMap((entry) =>
            entry.scan.files
              .filter((file) => matchesRoutableKind(file.kind))
              .map((file) => sourceFileKey(entry.sourcePath, file.relative_path)),
          ),
        ),
      );
      setIngestResult(null);
      setShowFilteredItems(false);
      const totalFiles = nextScans.reduce((sum, entry) => sum + entry.scan.total_files, 0);
      const unreadableCount = nextScans.reduce((sum, entry) => sum + entry.scan.unreadable_paths.length, 0);
      setScanWarning(
        unreadableCount > 0
          ? `Skipped ${unreadableCount} item${unreadableCount === 1 ? "" : "s"} that couldn't be read (no access). The rest scanned fine.`
          : null,
      );
      setLastAction(`Scanned ${totalFiles} file${totalFiles === 1 ? "" : "s"} from ${nextScans.length} source${nextScans.length === 1 ? "" : "s"}`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Source scan failed");
    } finally {
      setIsScanning(false);
    }
  }

  // Wires up the flooding ingest-progress event into the speed chart for a job.
  // Returns a cleanup function that detaches the listener and the sampling timer.
  // Shared by the single-shot ingest and the queue runner.
  async function startProgressTracking(jobId: string): Promise<() => void> {
    setIngestProgress(null);
    setSpeedSeries([]);
    setInstantaneousBps(0);
    setDestinationProgress([]);
    setVerifiedFeed([]);
    setVerifiedFailedTotal(0);
    setVerifiedFailedByDest(new Map());
    setDestinationFailures([]);
    progressBufferRef.current = [];
    verifiedFeedBufferRef.current = [];
    verifiedFeedIdRef.current = 0;
    verifiedFailedTotalRef.current = 0;
    verifiedFailedByDestRef.current = new Map();
    verifiedFailedDirtyRef.current = false;
    latestProgressRef.current = null;
    runStartRef.current = performance.now();
    // Listener is a pure ref-writer — never setState here (events flood every 256 KB).
    const unlistenProgress = await listen<IngestProgress>("ingest-progress", (event) => {
      if (event.payload.job_id !== jobId) {
        return;
      }
      latestProgressRef.current = event.payload;
      const tMs = performance.now() - runStartRef.current;
      const buffer = progressBufferRef.current;
      const previous = buffer[buffer.length - 1];
      // Each source is one runIngestMulti call whose aggregate bytes_done runs 0→total
      // (all destinations tee together). Across sources the next call restarts at 0, so a
      // drop marks a SOURCE transition — reset the buffer to avoid a negative speed spike
      // at the seam. (Within a source all destinations advance together, no per-dest reset.)
      if (previous && event.payload.bytes_done < previous.bytesDone) {
        buffer.length = 0;
      }
      buffer.push({ tMs, bytesDone: event.payload.bytes_done });
      const cutoff = tMs - SPEED_BUFFER_WINDOW_MS;
      while (buffer.length > 2 && buffer[0].tMs < cutoff) {
        buffer.shift();
      }
    });
    // Live per-file integrity feed. Pure ref-writer (never setState here — a big small-file
    // card fires one event per file per destination); the sample timer flushes the buffer.
    const unlistenVerified = await listen<FileVerified>("file-verified", (event) => {
      if (event.payload.job_id !== jobId) {
        return;
      }
      verifiedFeedBufferRef.current.push({ id: verifiedFeedIdRef.current, data: event.payload });
      verifiedFeedIdRef.current += 1;
      // Authoritative uncapped tally — count the failure the instant it arrives, before the
      // display feed can evict it. Mark dirty so the sample timer mirrors it into state.
      if (!event.payload.verified) {
        const dest = event.payload.destination_index;
        verifiedFailedTotalRef.current += 1;
        verifiedFailedByDestRef.current.set(dest, (verifiedFailedByDestRef.current.get(dest) ?? 0) + 1);
        verifiedFailedDirtyRef.current = true;
      }
    });
    // Sample the refs at a fixed cadence so the whole run screen renders at a steady
    // rate regardless of how fast the card streams.
    sampleTimerRef.current = window.setInterval(() => {
      // Flush any buffered file-verified events into the feed (newest first, capped). Done
      // first + unconditionally so the feed drains even between progress ticks.
      const pending = verifiedFeedBufferRef.current;
      if (pending.length > 0) {
        verifiedFeedBufferRef.current = [];
        pending.reverse(); // buffer is oldest→newest; feed shows newest first
        setVerifiedFeed((previous) => {
          const next = [...pending, ...previous];
          return next.length > VERIFIED_FEED_CAP ? next.slice(0, VERIFIED_FEED_CAP) : next;
        });
      }
      // Mirror the authoritative failed tally into state whenever a new failure landed. A
      // fresh Map copy is required so React re-renders the per-destination ✗ counters.
      if (verifiedFailedDirtyRef.current) {
        verifiedFailedDirtyRef.current = false;
        setVerifiedFailedTotal(verifiedFailedTotalRef.current);
        setVerifiedFailedByDest(new Map(verifiedFailedByDestRef.current));
      }
      const latest = latestProgressRef.current;
      if (!latest) {
        return;
      }
      setIngestProgress(latest);
      setDestinationProgress(latest.destinations ?? []);
      const bps = windowedSpeed(progressBufferRef.current, SPEED_WINDOW_MS);
      setInstantaneousBps(bps);
      const t = performance.now() - runStartRef.current;
      setSpeedSeries((previous) => {
        const next = [...previous, { t, bps }];
        const cutoff = t - CHART_WINDOW_MS;
        let start = 0;
        while (start < next.length - 1 && next[start + 1].t < cutoff) {
          start += 1;
        }
        return next.slice(start);
      });
    }, SAMPLE_INTERVAL_MS);
    return () => {
      unlistenProgress();
      unlistenVerified();
      if (sampleTimerRef.current !== null) {
        window.clearInterval(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
    };
  }

  // Copies the given sources into every destination under one job id. Each SOURCE is
  // teed to ALL destinations concurrently inside Rust via one runIngestMulti call;
  // multiple sources still loop sequentially (per-source scan boundaries). Returns the
  // flattened per-root IngestResults, the resolved project root for each destination,
  // and any per-destination failures. The root map lets the queue runner funnel later
  // cards into the same project folder a first card created, instead of a new root each.
  async function copySourcesToDestinations(
    jobId: string,
    activeSources: RunSource[],
    options: { rootByDestination?: Map<string, string>; segmentBase?: number; segmentTotal?: number } = {},
  ): Promise<{ results: IngestResult[]; rootByDestination: Map<string, string>; failures: DestinationFailure[] }> {
    const rootByDestination = options.rootByDestination ?? new Map<string, string>();
    const existingRootMode = destinationMode === "existing_root";
    // One runIngestMulti call per source now, so the segment counter is per-source.
    const total = options.segmentTotal ?? Math.max(1, activeSources.length);
    const results: IngestResult[] = [];
    const failures: DestinationFailure[] = [];
    let segmentIndex = options.segmentBase ?? 0;
    for (let sourceIndex = 0; sourceIndex < activeSources.length; sourceIndex += 1) {
      const entry = activeSources[sourceIndex];
      if (entry.includedRelativePaths.length === 0) {
        continue;
      }
      // Reuse the project roots an earlier source/card already created for these
      // destinations; otherwise scaffold fresh under each chosen destination (or copy
      // straight into them when the user picked "copy into existing root"). A destination
      // that failed earlier has no root and is dropped from later sources — it stays
      // failed rather than spawning a fresh partial root.
      const perDestination = destinationTargets.map((destination) => ({
        destination,
        root: rootByDestination.get(destination),
      }));
      const reusing = perDestination.some((item) => item.root !== undefined);
      const targets = reusing ? perDestination.filter((item) => item.root !== undefined) : perDestination;
      if (targets.length === 0) {
        continue;
      }
      const destinationPaths = reusing
        ? targets.map((item) => item.root as string)
        : targets.map((item) => item.destination);
      const useExistingRoot = reusing || existingRootMode;

      segmentIndex += 1;
      setCurrentSegment({
        label:
          destinationTargets.length > 1
            ? `${pathDisplayName(entry.sourcePath)} → ${destinationTargets.length} destinations`
            : `${pathDisplayName(entry.sourcePath)} → ${pathDisplayName(destinationTargets[0] ?? "")}`,
        index: segmentIndex,
        total,
      });

      const multi = await runIngestMulti(
        selectedPresetId,
        entry.sourcePath,
        variableValues,
        destinationPaths,
        // preserve sidecars = don't delete them; Safe Mode's never-delete-source
        // forces preservation regardless of the delete-sidecars toggle.
        !deleteSidecars || appSettings.safety.never_delete_source,
        renameFiles,
        entry.cameraAlias?.trim() || undefined,
        entry.includedRelativePaths,
        useExistingRoot,
        jobId,
        projectNameOverride.trim() || undefined,
        renameFiles ? fileRenamePattern.trim() || undefined : undefined,
      );

      results.push(...multi.roots);
      // Lookup from the canonical key of what we PASSED (a drive on the first source, a
      // resolved project root on later ones) back to the ORIGINAL drive the user chose. Rust
      // reports a failure's `path` as the exact string it copied to, so keying by canonical
      // path re-attributes it to the right drive without depending on index order — robust
      // even if the backend collapsed two entries our string-dedup missed.
      const passedToDestination = new Map<string, string>();
      targets.forEach((target, index) => {
        passedToDestination.set(canonicalDestinationKey(destinationPaths[index]), target.destination);
      });
      // roots come back in destination order (successful destinations only); failures carry
      // their index into the destinationPaths array we passed. Walk the targets and consume
      // roots for the ones that didn't fail so each root maps to its original destination.
      const failedIndices = new Set(multi.failures.map((failure) => failure.index));
      let rootCursor = 0;
      targets.forEach((target, index) => {
        if (failedIndices.has(index)) {
          return;
        }
        const root = multi.roots[rootCursor];
        rootCursor += 1;
        if (root) {
          rootByDestination.set(target.destination, root.root_path);
        }
      });
      // Surface each failure against the drive the user chose (never a reused project-root
      // subfolder), keyed by path so attribution can't drift.
      for (const failure of multi.failures) {
        failures.push({
          index: failure.index,
          path: passedToDestination.get(canonicalDestinationKey(failure.path)) ?? failure.path,
          error: failure.error,
        });
      }
    }
    return { results, rootByDestination, failures };
  }

  async function startIngest() {
    if (!preset || !selectedPresetId) {
      setError("Choose a preset first.");
      return;
    }
    if (sourcePaths.length === 0) {
      setError("Choose at least one source folder first.");
      return;
    }
    if (destinationTargets.length === 0) {
      setError("Choose at least one destination folder first.");
      return;
    }
    if (sourceScans.length === 0) {
      setError("Scan the source folders before starting ingest.");
      return;
    }
    if (selectedFileCount === 0) {
      setError("Select at least one file to copy.");
      return;
    }
    // Safety guardrails: block before we start rather than fail partway. These read
    // from the individual settings (Safe Mode is just a convenience that turns the
    // group on), so the messages point at the specific setting rather than blaming
    // Safe Mode — which may well be off.
    const safety = appSettings.safety;
    if (safety.min_verified_copies > destinationTargets.length) {
      setError(
        `This ingest is set to require ${safety.min_verified_copies} verified copies, but only ${destinationTargets.length} destination${destinationTargets.length === 1 ? " is" : "s are"} set. Add more backup destinations, or lower "Require verified copies" in Settings → Safety.`,
      );
      return;
    }
    if (safety.low_space_stop_percent > 0) {
      for (const destination of destinationTargets) {
        const space = spaceByPath[destination];
        if (space && space.total_bytes > 0) {
          const freePercent = (space.available_bytes / space.total_bytes) * 100;
          if (freePercent < safety.low_space_stop_percent) {
            setError(
              `Low-space stop: "${destination}" is only ${freePercent.toFixed(1)}% free, below the ${safety.low_space_stop_percent}% limit. Free up space or lower "Low-space stop" in Settings → Safety.`,
            );
            return;
          }
        }
      }
    }

    setIsIngesting(true);
    setIsCancelling(false);
    setReportBuild({ status: "idle", progress: null });
    setError(null);
    const jobId = createJobId();
    const startedAt = new Date().toISOString();
    currentIngestJobId.current = jobId;
    const stopTracking = await startProgressTracking(jobId);
    try {
      const activeSources: RunSource[] = sourceScans
        .map((entry) => ({
          sourcePath: entry.sourcePath,
          scan: entry.scan,
          includedRelativePaths: entry.scan.files
            .filter((file) => selectedRelativePaths.has(sourceFileKey(entry.sourcePath, file.relative_path)))
            .map((file) => file.relative_path),
          cameraAlias: cameraAliases[entry.sourcePath],
        }))
        .filter((entry) => entry.includedRelativePaths.length > 0);
      const { results, failures } = await copySourcesToDestinations(jobId, activeSources);
      const result = mergeIngestResults(results);
      setIngestResult(result);
      setDestinationFailures(failures);
      // A failed drive OR any unverified file means the run needs a human look before it
      // can be trusted as a delivered backup.
      const needsReview = result.verification_failed > 0 || failures.length > 0;
      void autoWriteMetadataManifest(result, [...new Set(results.map((entry) => entry.root_path))]);
      if (failures.length > 0) {
        const names = failures.map((failure) => pathDisplayName(failure.path)).join(", ");
        setError(
          `${failures.length} destination${failures.length === 1 ? "" : "s"} failed (${names}). The other copies completed — review the delivery summary.`,
        );
      }
      setLastAction(
        `Ingest copied ${result.files_copied} file${result.files_copied === 1 ? "" : "s"} from ${sourceScans.length} source${sourceScans.length === 1 ? "" : "s"} to ${destinationTargets.length} destination${destinationTargets.length === 1 ? "" : "s"}${failures.length > 0 ? ` · ${failures.length} destination${failures.length === 1 ? "" : "s"} failed` : ""}`,
      );
      const completedAt = new Date().toISOString();
      const historyJob = {
        id: jobId,
        preset_id: selectedPresetId,
        preset_name: preset.name,
        variable_values: variableValues,
        status: needsReview ? "needs_review" : "verified",
        started_at: startedAt,
        completed_at: completedAt,
        source_paths: sourcePaths,
        destination_paths: destinationTargets,
        root_path: result.root_path,
        report_path: result.report_path,
        mhl_path: result.mhl_path,
        files_copied: result.files_copied,
        verified_files: result.verified_files,
        verification_failed: result.verification_failed,
        bytes_copied: result.bytes_copied,
        sidecars_deleted: result.skipped.filter((file) => file.reason === "Sidecar deletion is enabled.").length,
      };
      await saveHistoryJob(historyJob);
      void refreshRecentJobs();
      if (appSettings.report_defaults.write_html_report && result.root_path) {
        void buildReportInBackground({
          completedAt,
          destinationPaths: destinationTargets,
          destinationRoots: [...new Set(results.map((entry) => entry.root_path))],
          jobId,
          presetId: selectedPresetId,
          presetName: preset.name,
          result,
          sourcePaths,
          startedAt,
          variableValues,
        });
      } else if (appSettings.ingest_defaults.open_folder_when_done && result.root_path) {
        await openPath(result.root_path);
      }
    } catch (caught) {
      const message = String(caught);
      setError(message);
      setLastAction(message.toLowerCase().includes("cancelled") ? "Ingest cancelled" : "Ingest failed");
    } finally {
      stopTracking();
      setIsIngesting(false);
      setIsCancelling(false);
      setCurrentSegment(null);
      currentIngestJobId.current = null;
    }
  }

  // ---- Queue mode -------------------------------------------------------------

  function patchQueueCard(id: string, patch: Partial<QueueCard>) {
    setQueue((current) => current.map((card) => (card.id === id ? { ...card, ...patch } : card)));
  }

  // Scans one card's source in the background (scan-ahead). Dedupes via a per-id
  // promise so a card is never scanned twice, and records file/byte totals on it.
  function scanCard(id: string, sourcePath: string): Promise<SourceScan> {
    const existing = cardScanPromises.current.get(id);
    if (existing) {
      return existing;
    }
    patchQueueCard(id, { status: "scanning", error: null });
    const promise = scanSource(sourcePath)
      .then((scanned) => {
        const routable = scanned.files.filter((file) => matchesRoutableKind(file.kind));
        patchQueueCard(id, {
          status: "ready",
          scan: scanned,
          fileCount: routable.length,
          byteCount: routable.reduce((sum, file) => sum + file.size_bytes, 0),
        });
        return scanned;
      })
      .catch((caught) => {
        patchQueueCard(id, { status: "error", error: String(caught) });
        throw caught;
      });
    cardScanPromises.current.set(id, promise);
    return promise;
  }

  // Appends one source folder as a queue card and starts its scan-ahead. Skips a
  // folder already in the queue so a double-add / re-drop doesn't duplicate it.
  function enqueueCardForPath(path: string) {
    if (queueRef.current.some((card) => card.sourcePath === path)) {
      return;
    }
    const id = createJobId();
    setQueue((current) => [
      ...current,
      {
        id,
        sourcePath: path,
        cameraAlias: "",
        status: "pending",
        scan: null,
        fileCount: 0,
        byteCount: 0,
        result: null,
        error: null,
      },
    ]);
    setIngestResult(null);
    // Kick off scan-ahead immediately so the card is ready by the time it's reached.
    void scanCard(id, path).catch(() => undefined);
  }

  async function addQueueCard() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") {
      return;
    }
    enqueueCardForPath(path);
  }

  // Native OS drag-and-drop of folders onto the queue. Keeps only the directories
  // (each dropped folder = one card) and ignores stray files.
  async function handleQueueDrop(paths: string[]) {
    let directories: string[];
    try {
      directories = await filterDirectories(paths);
    } catch {
      directories = paths;
    }
    if (directories.length === 0) {
      setError("Drop camera-card folders onto the queue (files are ignored).");
      return;
    }
    setError(null);
    for (const path of directories) {
      enqueueCardForPath(path);
    }
  }

  // Native folder drop onto the destinations panel. The first dropped folder fills
  // the primary "Copy To" if it's empty; the rest append as backup destinations.
  async function handleDestinationDrop(paths: string[]) {
    let directories: string[];
    try {
      directories = await filterDirectories(paths);
    } catch {
      directories = paths;
    }
    if (directories.length === 0) {
      setError("Drop destination folders (files are ignored).");
      return;
    }
    setError(null);
    setIngestResult(null);
    const queued = [...directories];
    let primary = destinationPathRef.current;
    if (!primary.trim()) {
      primary = queued.shift() ?? "";
      setDestinationPath(primary);
    }
    if (queued.length > 0) {
      // Dedup by canonical key so a trailing-slash / case variant of a drive already chosen
      // (or dropped twice in the same batch) can't be added as a second "distinct" copy.
      const seen = new Set(
        [primary, ...secondaryDestinationsRef.current].filter(Boolean).map(canonicalDestinationKey),
      );
      const additions: string[] = [];
      for (const path of queued) {
        const key = canonicalDestinationKey(path);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        additions.push(path);
      }
      if (additions.length > 0) {
        setSecondaryDestinationPaths((current) => [...current, ...additions]);
      }
    }
  }

  // Native folder/file drop onto the "Copy From" source area (non-queue mode).
  // Dropped folders become sources; dropped files add their parent folders.
  async function handleSourceDrop(paths: string[]) {
    let directories: string[];
    try {
      directories = await filterDirectories(paths);
    } catch {
      directories = [];
    }
    if (directories.length === 0) {
      directories = [...new Set(paths.map(parentDirectory).filter((path): path is string => Boolean(path)))];
    }
    if (directories.length === 0) {
      setError("Drop source folders (or files) to add them.");
      return;
    }
    setError(null);
    const nextPaths = uniquePaths([...sourcePathsRef.current, ...directories]);
    setSourcePaths(nextPaths);
    setSourceScans([]);
    setSelectedRelativePaths(new Set());
    setIsFileSelectorOpen(false);
    setIngestResult(null);
    void scanPaths(nextPaths);
  }

  function removeQueueCard(id: string) {
    cardScanPromises.current.delete(id);
    setQueue((current) => current.filter((card) => card.id !== id));
  }

  function clearFinishedQueueCards() {
    setQueue((current) => current.filter((card) => card.status !== "done"));
  }

  // Sequential pipeline: copies queued cards in order into the shared destination(s),
  // scanning the next card while the current one copies, and picking up cards added
  // mid-run. All cards land under one job id / one merged delivery + report.
  async function runQueue() {
    if (!preset || !selectedPresetId) {
      setError("Choose a preset first.");
      return;
    }
    if (destinationTargets.length === 0) {
      setError("Choose at least one destination folder first.");
      return;
    }
    if (queueRef.current.length === 0) {
      setError("Add at least one card to the queue.");
      return;
    }

    setIsQueueRunning(true);
    setIsIngesting(true);
    setIsCancelling(false);
    setReportBuild({ status: "idle", progress: null });
    setError(null);
    const jobId = createJobId();
    const startedAt = new Date().toISOString();
    currentIngestJobId.current = jobId;
    const stopTracking = await startProgressTracking(jobId);
    const rootByDestination = new Map<string, string>();
    const allResults: IngestResult[] = [];
    const allFailures: DestinationFailure[] = [];
    const processedSourcePaths: string[] = [];
    let cancelled = false;
    try {
      let index = 0;
      // Re-read queueRef each turn so cards added mid-run get processed too.
      while (index < queueRef.current.length) {
        const card = queueRef.current[index];
        index += 1;
        if (card.status === "done") {
          continue;
        }
        let scanned: SourceScan;
        try {
          scanned = await scanCard(card.id, card.sourcePath);
        } catch {
          continue; // scan failed; card already marked "error"
        }
        // Scan-ahead: warm the next pending card while this one copies.
        const next = queueRef.current[index];
        if (next && next.status === "pending") {
          void scanCard(next.id, next.sourcePath).catch(() => undefined);
        }
        const included = scanned.files
          .filter((file) => matchesRoutableKind(file.kind))
          .map((file) => file.relative_path);
        if (included.length === 0) {
          patchQueueCard(card.id, { status: "done", error: null });
          continue;
        }
        patchQueueCard(card.id, { status: "copying", error: null });
        // One runIngestMulti call per card now, so segments count cards (not card × dest).
        const totalSegments = queueRef.current.length;
        try {
          const { results, failures } = await copySourcesToDestinations(
            jobId,
            [
              {
                sourcePath: card.sourcePath,
                scan: scanned,
                includedRelativePaths: included,
                cameraAlias: card.cameraAlias,
              },
            ],
            { rootByDestination, segmentBase: index - 1, segmentTotal: totalSegments },
          );
          const merged = mergeIngestResults(results);
          allResults.push(...results);
          allFailures.push(...failures);
          processedSourcePaths.push(card.sourcePath);
          const cardIssues =
            merged.verification_failed > 0 || failures.length > 0
              ? [
                  merged.verification_failed > 0 ? `${merged.verification_failed} file(s) not verified` : null,
                  failures.length > 0
                    ? `${failures.length} destination${failures.length === 1 ? "" : "s"} failed`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : null;
          patchQueueCard(card.id, {
            status: cardIssues ? "error" : "done",
            result: merged,
            error: cardIssues,
          });
        } catch (caught) {
          const message = String(caught);
          patchQueueCard(card.id, { status: "error", error: message });
          if (message.toLowerCase().includes("cancelled")) {
            cancelled = true;
            break;
          }
        }
      }

      if (allResults.length === 0) {
        if (!cancelled) {
          setError("Nothing was copied from the queue.");
        }
        setLastAction(cancelled ? "Queue cancelled" : "Queue produced no copies");
        return;
      }

      const result = mergeIngestResults(allResults);
      setIngestResult(result);
      // A destination can fail on more than one card; collapse to one row per drive for
      // the delivery banner while keeping the first error message seen for it.
      const uniqueFailures = [...new Map(allFailures.map((failure) => [failure.path, failure])).values()];
      setDestinationFailures(uniqueFailures);
      const needsReview = result.verification_failed > 0 || uniqueFailures.length > 0;
      void autoWriteMetadataManifest(result, [...new Set(allResults.map((entry) => entry.root_path))]);
      if (uniqueFailures.length > 0) {
        const names = uniqueFailures.map((failure) => pathDisplayName(failure.path)).join(", ");
        setError(
          `${uniqueFailures.length} destination${uniqueFailures.length === 1 ? "" : "s"} failed (${names}). The other copies completed — review the delivery summary.`,
        );
      }
      setLastAction(
        `Queue copied ${result.files_copied} file${result.files_copied === 1 ? "" : "s"} from ${processedSourcePaths.length} card${processedSourcePaths.length === 1 ? "" : "s"} to ${destinationTargets.length} destination${destinationTargets.length === 1 ? "" : "s"}${uniqueFailures.length > 0 ? ` · ${uniqueFailures.length} destination${uniqueFailures.length === 1 ? "" : "s"} failed` : ""}`,
      );
      const completedAt = new Date().toISOString();
      const historyJob = {
        id: jobId,
        preset_id: selectedPresetId,
        preset_name: preset.name,
        variable_values: variableValues,
        status: needsReview ? "needs_review" : "verified",
        started_at: startedAt,
        completed_at: completedAt,
        source_paths: processedSourcePaths,
        destination_paths: destinationTargets,
        root_path: result.root_path,
        report_path: result.report_path,
        mhl_path: result.mhl_path,
        files_copied: result.files_copied,
        verified_files: result.verified_files,
        verification_failed: result.verification_failed,
        bytes_copied: result.bytes_copied,
        sidecars_deleted: result.skipped.filter((file) => file.reason === "Sidecar deletion is enabled.").length,
      };
      await saveHistoryJob(historyJob);
      void refreshRecentJobs();
      if (appSettings.report_defaults.write_html_report && result.root_path) {
        void buildReportInBackground({
          completedAt,
          destinationPaths: destinationTargets,
          destinationRoots: [...new Set(allResults.map((entry) => entry.root_path))],
          jobId,
          presetId: selectedPresetId,
          presetName: preset.name,
          result,
          sourcePaths: processedSourcePaths,
          startedAt,
          variableValues,
        });
      } else if (appSettings.ingest_defaults.open_folder_when_done && result.root_path) {
        await openPath(result.root_path);
      }
    } catch (caught) {
      setError(String(caught));
      setLastAction("Queue failed");
    } finally {
      stopTracking();
      setIsIngesting(false);
      setIsQueueRunning(false);
      setIsCancelling(false);
      setCurrentSegment(null);
      currentIngestJobId.current = null;
      cardScanPromises.current.clear();
    }
  }

  async function buildReportInBackground({
    completedAt,
    destinationPaths,
    destinationRoots,
    jobId,
    presetId,
    presetName,
    result,
    sourcePaths,
    startedAt,
    variableValues,
  }: {
    completedAt: string;
    destinationPaths: string[];
    destinationRoots: string[];
    jobId: string;
    presetId: string;
    presetName: string;
    result: IngestResult;
    sourcePaths: string[];
    startedAt: string;
    variableValues: Record<string, string>;
  }) {
    const reportJobId = `${jobId}-report`;
    setReportBuild({ status: "building", progress: null });
    setLastAction("Copy complete; report building in background");

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<IngestProgress>("report-progress", (event) => {
        if (event.payload.job_id === reportJobId) {
          setReportBuild({ status: "building", progress: event.payload });
        }
      });

      const report = await generateIngestReport(
        presetName,
        sourcePaths.join("; "),
        result.root_path,
        destinationRoots,
        variableValues,
        result.copied_files,
        result.skipped,
        result.files_copied,
        result.verified_files,
        result.verification_failed,
        result.bytes_copied,
        result.mhl_path,
        reportJobId,
        Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
        resolveReportDir(result.root_path, appSettings.report_defaults.output_location),
      );
      // Take the report's copied_files back: thumbnail extraction happens in Rust, on Rust's
      // own copy of the list, so this is the only place the UI ever learns a thumbnail_path.
      // Without it ClipThumbnailGrid filters every file out and renders nothing at all.
      const reportPath = report.report_path;
      setIngestResult((current) =>
        current ? { ...current, report_path: reportPath, copied_files: report.copied_files } : current,
      );
      setReportBuild({ status: "ready", progress: null, path: reportPath });
      await saveHistoryJob({
        id: jobId,
        preset_id: presetId,
        preset_name: presetName,
        variable_values: variableValues,
        status: result.verification_failed > 0 ? "needs_review" : "verified",
        started_at: startedAt,
        completed_at: completedAt,
        source_paths: sourcePaths,
        destination_paths: destinationPaths,
        root_path: result.root_path,
        report_path: reportPath,
        mhl_path: result.mhl_path,
        files_copied: result.files_copied,
        verified_files: result.verified_files,
        verification_failed: result.verification_failed,
        bytes_copied: result.bytes_copied,
        sidecars_deleted: result.skipped.filter((file) => file.reason === "Sidecar deletion is enabled.").length,
      });
      setLastAction("Report ready");
      if (appSettings.report_defaults.open_report_when_done) {
        await openPath(reportPath);
      } else if (appSettings.ingest_defaults.open_folder_when_done && result.root_path) {
        await openPath(result.root_path);
      }
    } catch (caught) {
      const message = String(caught);
      setReportBuild({ status: "failed", progress: null, error: message });
      setLastAction("Report failed");
    } finally {
      unlisten?.();
    }
  }

  async function cancelCurrentIngest() {
    const jobId = currentIngestJobId.current;
    if (!jobId) {
      return;
    }

    setIsCancelling(true);
    setLastAction("Cancelling ingest...");
    try {
      await cancelIngest(jobId);
    } catch (caught) {
      setError(String(caught));
      setIsCancelling(false);
    }
  }

  // Settings: refetch on mount and whenever Settings is saved in another tab
  // (settingsRev). The ingest-defaults toggles (rename/sidecars/destination mode)
  // seed the in-session controls only ONCE so a later settings save doesn't clobber
  // the choices the operator made on this screen mid-setup.
  const ingestDefaultsSeeded = useRef(false);
  useEffect(() => {
    getSettings()
      .then((settings) => {
        setAppSettings(settings);
        setGlobalParameters(settings.global_parameters);
        if (!ingestDefaultsSeeded.current) {
          ingestDefaultsSeeded.current = true;
          setRenameFiles(settings.ingest_defaults.rename_files);
          setDeleteSidecars(settings.ingest_defaults.delete_sidecars);
          setDestinationMode(settings.ingest_defaults.destination_mode);
        }
      })
      .catch(() => setGlobalParameters([]));
  }, [settingsRev]);

  useEffect(() => {
    void refreshRecentJobs();
  }, []);

  // Presets: refetch the list on mount and whenever a preset is created/edited/
  // deleted in the Presets tab (presetsRev). Uses the default preferredId
  // (selectedPresetId) so a refresh keeps the operator's current selection —
  // which is "" on first mount, so mount still lands on the first preset.
  useEffect(() => {
    void refreshPresets();
  }, [presetsRev]);

  // Reload the selected preset's defaults only when the operator picks a different
  // preset. Deliberately NOT keyed on presetsRev: a full reload here resets the
  // destination, metadata, and job-variable fields, so re-running it just because a
  // preset was edited (or the Presets tab was visited) would wipe an in-progress
  // ingest setup. The preset list/names still refresh via refreshPresets(presetsRev).
  useEffect(() => {
    void loadSelectedPreset(selectedPresetId);
  }, [selectedPresetId]);

  // Card-watcher edge detection: the set of card paths seen on the previous poll, plus
  // a flag so the first poll only primes the baseline (no pop-open on launch).
  const knownCardPathsRef = useRef<Set<string>>(new Set());
  const cardBaselinePrimedRef = useRef(false);

  // Announce a finished transfer: play a success/needs-review chime, and if we're
  // running in the background, surface the window so the operator sees it. Runs once
  // per delivery (keyed on the project root) so single + queue both fire exactly once.
  const announcedRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ingestResult) {
      announcedRootRef.current = null;
      return;
    }
    if (announcedRootRef.current === ingestResult.root_path) {
      return;
    }
    announcedRootRef.current = ingestResult.root_path;
    if (appSettings.sound.enabled) {
      playCompletionSound(ingestResult.verification_failed === 0, appSettings.sound.volume);
    }
    if (appSettings.camera_watcher.tray_mode) {
      void showMainWindow();
    }
    // Safe Mode: always write the offload proof (silently) once per delivery.
    if (appSettings.safety.always_write_offload_proof && preset) {
      void saveOffloadProof(false);
    }
  }, [
    ingestResult,
    appSettings.camera_watcher.tray_mode,
    appSettings.sound.enabled,
    appSettings.sound.volume,
    appSettings.safety.always_write_offload_proof,
  ]);

  // When an ingest finishes, optionally push its metadata to iconik automatically
  // (Settings -> iconik -> "Push automatically after ingest"). Runs once per delivery.
  const autoPushedRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ingestResult) {
      autoPushedRootRef.current = null;
      return;
    }
    if (
      appSettings.iconik.auto_push &&
      appSettings.iconik.view_id &&
      metadataPreset &&
      autoPushedRootRef.current !== ingestResult.root_path
    ) {
      autoPushedRootRef.current = ingestResult.root_path;
      void pushToIconik();
    }
  }, [ingestResult, appSettings.iconik.auto_push, appSettings.iconik.view_id, metadataPreset]);

  // Clear the speed-sampling timer if we unmount mid-run (e.g. navigating away).
  useEffect(() => {
    return () => {
      if (sampleTimerRef.current !== null) {
        window.clearInterval(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const defaults = defaultsForParameters(ingestParameters);
    const replay = pendingReplayValuesRef.current;
    if (replay) {
      pendingReplayValuesRef.current = null;
      // Keep only replayed values for parameters that still exist on this preset.
      for (const key of Object.keys(defaults)) {
        if (replay[key] !== undefined) {
          defaults[key] = replay[key];
        }
      }
    }
    setVariableValues(defaults);
  }, [ingestParameters]);

  // Switching presets only changes routing and naming — both of which recompute
  // reactively from (preset, scan) — not which files exist on the card. So keep the
  // scan and the operator's file selection instead of wiping them and forcing a
  // manual Rescan; only the prior delivery result is no longer valid.
  useEffect(() => {
    setIngestResult(null);
  }, [selectedPresetId]);

  // Keep the file list in sync automatically: whenever there are source folders but
  // no current scan (e.g. right after adding or removing a source), scan them so the
  // operator never has to click Rescan to get "Files to Copy" back. Deduped by the
  // attempted path set so a scan that fails or finds nothing isn't retried in a loop
  // — the manual Rescan button stays available as the escape hatch. Honors the
  // auto-scan-sources setting and skips queue mode (which scans its own cards).
  useEffect(() => {
    if (queueMode || !appSettings.ingest_defaults.auto_scan_sources) {
      return;
    }
    if (sourcePaths.length === 0) {
      autoScanSignatureRef.current = "";
      return;
    }
    if (sourceScans.length > 0 || isScanning) {
      return;
    }
    const signature = JSON.stringify(sourcePaths);
    if (autoScanSignatureRef.current === signature) {
      return;
    }
    autoScanSignatureRef.current = signature;
    void scanPaths(sourcePaths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueMode, sourcePaths, sourceScans, isScanning, appSettings.ingest_defaults.auto_scan_sources]);

  useEffect(() => {
    setIngestResult(null);
  }, [deleteSidecars, renameFiles, variableValues]);

  useEffect(() => {
    let isCurrent = true;
    if (!preset) {
      setOutputPreview(null);
      return;
    }

    buildOutputPreview({
      destinationPath,
      destinationMode,
      preset,
      projectNameOverride,
      renameFiles,
      fileRenamePattern,
      scan,
      variableValues,
    })
      .then((preview) => {
        if (isCurrent) {
          setOutputPreview(preview);
        }
      })
      .catch((caught) => {
        if (isCurrent) {
          setOutputPreview({
            fileName: String(caught),
            folderName: "Preview unavailable",
            fullFolderPath: "",
            rootName: "Preview unavailable",
            sampleLabel: "Pattern error",
          });
        }
      });

    return () => {
      isCurrent = false;
    };
    // settingsRev: recompute the {date}-bearing preview when the date-format setting changes.
  }, [destinationMode, destinationPath, preset, projectNameOverride, renameFiles, fileRenamePattern, scan, variableValues, settingsRev]);

  useEffect(() => {
    const paths = uniquePaths([...sourcePaths, ...destinationTargets]).filter((path) => path.trim().length > 0);
    if (paths.length === 0) {
      setSpaceByPath({});
      return;
    }

    let isCurrent = true;
    Promise.all(
      paths.map(async (path) => {
        try {
          return [path, await diskSpace(path)] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    ).then((entries) => {
      if (!isCurrent) {
        return;
      }
      setSpaceByPath(Object.fromEntries(entries));
    });

    return () => {
      isCurrent = false;
    };
  }, [destinationTargets, sourcePaths]);

  useEffect(() => {
    let cancelled = false;

    async function refreshDetectedSources() {
      if (!appSettings.camera_watcher.auto_detect_cards) {
        setDetectedSources([]);
        return;
      }

      try {
        const sources = await detectCameraSources();
        if (cancelled) {
          return;
        }
        setDetectedSources(sources);
        // Edge-detect a newly inserted card: if a card path appears that wasn't there
        // on the previous poll, surface the window (from tray/background) and jump to
        // the ingest screen. The first poll only primes the baseline so we don't pop
        // on launch for a card that was already inserted.
        const currentPaths = sources.map((source) => source.path);
        if (appSettings.camera_watcher.pop_open_on_card && cardBaselinePrimedRef.current) {
          const isNewCard = currentPaths.some((path) => !knownCardPathsRef.current.has(path));
          if (isNewCard) {
            // Respect the pop-open style: always raise, only-if-already-in-front, or
            // just navigate in-app without stealing focus ("notify").
            const mode = appSettings.camera_watcher.pop_open_mode;
            const shouldRaise = mode === "always" || (mode === "if_frontmost" && document.hasFocus());
            if (shouldRaise) {
              void showMainWindow();
            }
            setRequestedView("ingest");
          }
        }
        knownCardPathsRef.current = new Set(currentPaths);
        cardBaselinePrimedRef.current = true;
        // Pre-load connected memory cards automatically: if nothing is set up yet and
        // a card (or cards) are plugged in, drop them straight into "Copy From" and
        // scan so the ingest screen is ready without any clicks.
        if (!sourcePath.trim() && sources.length > 0) {
          const paths = uniquePaths(sources.map((source) => source.path));
          setSourcePaths(paths);
          setSourceScans([]);
          setSelectedRelativePaths(new Set());
          setIngestProgress(null);
          setIsFileSelectorOpen(false);
          setIngestResult(null);
          setLastAction(
            paths.length === 1
              ? `Memory card detected: ${pathDisplayName(paths[0])}`
              : `${paths.length} memory cards detected`,
          );
          if (appSettings.ingest_defaults.auto_scan_sources) {
            void scanPaths(paths);
          }
        }
      } catch {
        if (!cancelled) {
          setDetectedSources([]);
        }
      }
    }

    void refreshDetectedSources();
    const intervalId = window.setInterval(() => void refreshDetectedSources(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    appSettings.camera_watcher.auto_detect_cards,
    appSettings.camera_watcher.pop_open_on_card,
    appSettings.camera_watcher.pop_open_mode,
    setLastAction,
    setRequestedView,
    sourcePath,
  ]);

  if (isIngesting && !isQueueRunning) {
    return (
      <IngestRunScreen
        isCancelling={isCancelling}
        onCancel={() => void cancelCurrentIngest()}
        progress={ingestProgress}
        speedSeries={speedSeries}
        instantaneousBps={instantaneousBps}
        currentSegment={currentSegment}
        selectedBytes={selectedBytes}
        selectedCount={selectedFileCount}
        destinationProgress={destinationProgress}
        verifiedFeed={verifiedFeed}
        verifiedFailedTotal={verifiedFailedTotal}
        verifiedFailedByDest={verifiedFailedByDest}
        spaceByPath={spaceByPath}
      />
    );
  }

  // Dedicated post-ingest delivery screen: a distinct "done" view with all the
  // stats/records, instead of an inline panel on the setup page.
  if (ingestResult) {
    const result = ingestResult;
    const allVerified = result.verification_failed === 0;
    return (
      <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
        <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Delivery</p>
            <h1 className="text-xl font-semibold tracking-normal">
              {allVerified ? "Transfer complete" : "Transfer complete — review needed"}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {result.report_path ? (
              <button
                className="text-xs font-semibold text-graphite underline-offset-2 hover:underline"
                onClick={() => void openPath(result.report_path)}
                type="button"
              >
                Open report
              </button>
            ) : null}
            <button
              className="text-xs font-semibold text-graphite underline-offset-2 hover:underline"
              onClick={() => void openPath(result.root_path)}
              type="button"
            >
              Open folder
            </button>
            <button
              className="text-xs font-semibold text-graphite underline-offset-2 hover:underline disabled:opacity-60"
              disabled={isSavingProof}
              onClick={() => void saveOffloadProof()}
              type="button"
            >
              {isSavingProof ? "Saving proof…" : "Offload proof (PDF)"}
            </button>
            <button
              className="text-xs font-semibold text-graphite underline-offset-2 hover:underline"
              onClick={() => void saveReelIndex()}
              type="button"
            >
              Reel index (CSV)
            </button>
            {metadataPreset ? (
              <button
                className="text-xs font-semibold text-graphite underline-offset-2 hover:underline disabled:opacity-60"
                disabled={isSavingManifest}
                onClick={() => void saveMetadataManifest()}
                type="button"
              >
                {isSavingManifest ? "Saving…" : "Metadata CSV"}
              </button>
            ) : null}
            {metadataPreset && appSettings.iconik.view_id ? (
              <button
                className="text-xs font-semibold text-graphite underline-offset-2 hover:underline disabled:opacity-60"
                disabled={iconikPush.status === "pushing"}
                onClick={() => void pushToIconik()}
                type="button"
              >
                {iconikPush.status === "pushing" ? "Pushing…" : "Push to iconik"}
              </button>
            ) : null}
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-signal px-3 text-xs font-semibold text-primaryfg transition hover:bg-black"
              onClick={() => {
                setIngestResult(null);
                setDestinationFailures([]);
                setError(null);
                setQueue([]);
                setIconikPush({ status: "idle", results: [] });
                cardScanPromises.current.clear();
              }}
              type="button"
            >
              New ingest
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <section className="overflow-hidden rounded-2xl border border-mist bg-white">
            <div className="grid grid-cols-2 gap-2 border-b border-mist bg-porcelain/50 p-2.5 md:grid-cols-4">
              <SummaryTile label="Copied" value={String(result.files_copied)} />
              <SummaryTile label="Verified" value={`${result.verified_files}/${result.files_copied}`} />
              <SummaryTile label="Failed" value={String(result.verification_failed)} />
              <SummaryTile label="Copied size" value={formatBytes(result.bytes_copied)} />
            </div>
            {destinationFailures.length > 0 ? (
              <div className="border-b border-mist bg-red-50/60 px-3 py-2.5">
                <div className="mb-1.5 text-xs font-semibold text-red-800">
                  {destinationFailures.length} destination{destinationFailures.length === 1 ? "" : "s"} failed — these copies did not complete
                </div>
                <div className="space-y-1">
                  {destinationFailures.map((failure) => (
                    <div
                      key={failure.path}
                      className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate font-semibold text-ink">{pathDisplayName(failure.path)}</span>
                      <span className="min-w-0 max-w-[60%] truncate font-medium text-red-700">{failure.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {queue.some((card) => card.result) ? <QueueCardsSummary cards={queue} /> : null}
            <VerificationPanel
              destinations={destinationTargets}
              isRetrying={isRetrying}
              onRetry={() => void retryFailedCopiesForResult()}
              result={result}
            />
            <ClipThumbnailGrid files={result.copied_files} rootPath={result.root_path} />
            <CoverageCard files={result.copied_files} />
            {iconikPush.status !== "idle" ? (
              <IconikPushPanel
                onRetry={(titles) => void pushToIconik(titles)}
                state={iconikPush}
              />
            ) : null}
            {reportBuild.status !== "idle" ? (
              <div className="border-b border-mist px-3 py-2">
                <div className="mb-1 flex items-center justify-between gap-3 text-xs font-semibold text-graphite">
                  <span>{reportStatusLabel(reportBuild)}</span>
                  {reportBuild.progress ? (
                    <span>
                      {reportBuild.progress.files_done}/{reportBuild.progress.total_files} thumbnails
                    </span>
                  ) : null}
                </div>
                {reportBuild.status === "building" ? (
                  <div className="h-2 overflow-hidden rounded-full bg-porcelain">
                    <div
                      className="h-full rounded-full bg-lavender transition-all"
                      style={{ width: `${reportBuild.progress ? progressPercent(reportBuild.progress) : 6}%` }}
                    />
                  </div>
                ) : null}
                {reportBuild.error ? (
                  <p className="mt-1 text-[11px] font-semibold text-red-700">{reportBuild.error}</p>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Copy and verify source media</p>
          <h1 className="text-xl font-semibold tracking-normal">Ingest Media</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-graphite">
            Pick copy rules, choose source and destination, scan, then copy only the media you want.
          </p>
        </div>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
          disabled={!sourcePath || isScanning}
          onClick={() => void runScan()}
          type="button"
        >
          <RefreshCw className={isScanning ? "animate-spin" : ""} size={16} />
          Rescan
        </button>
      </header>

      {error ? (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {scanWarning ? (
        <div className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>{scanWarning}</span>
          <button
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-amber-700 transition hover:bg-amber-100"
            onClick={() => setScanWarning(null)}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[220px_320px_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <PresetBrowser
            presets={presets}
            selectedPresetId={selectedPresetId}
            onSelect={(id) => {
              setSelectedPresetId(id);
              setIngestResult(null);
            }}
          />
          <div className="mt-auto min-h-0">
            <RecentIngestsCarousel
              recentJobs={recentJobs}
              presets={presets}
              onSelect={applyRecentJobState}
            />
          </div>
        </div>

        <section className="relative z-20 overflow-visible rounded-2xl border border-mist bg-white">
          <div className="flex h-9 items-center justify-between border-b border-mist px-3">
            <SectionTitle
              help="This is the job setup: which preset rules to use, what media to copy, and where the project should land."
              title="1. Copy Job"
            />
            <div className="flex min-w-0 items-center gap-1.5">
              {projectNameOverride ? (
                <span
                  className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full border border-signal/40 bg-signal/10 px-2 text-[11px] font-semibold text-ink"
                  title={`This ingest's project folder: ${projectNameOverride}`}
                >
                  <span className="max-w-[180px] truncate font-mono">{projectNameOverride}</span>
                  <button
                    aria-label="Clear project name"
                    className="rounded-full text-graphite transition hover:text-ink"
                    onClick={() => {
                      setProjectNameOverride("");
                      setIngestResult(null);
                    }}
                    type="button"
                  >
                    <X size={11} />
                  </button>
                </span>
              ) : null}
              <button
                className="inline-flex h-6 items-center gap-1.5 rounded-full border border-mist bg-white px-2 text-[11px] font-semibold text-graphite transition hover:bg-porcelain"
                onClick={() => setIsNamingOpen(true)}
                title="Naming wizard: pick a naming template and apply the SOP-correct project name to this ingest. Your selected preset stays the same."
                type="button"
              >
                <Wand2 size={12} />
                Name
              </button>
              <button
                className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold transition ${
                  queueMode
                    ? "border-signal bg-signal text-primaryfg"
                    : "border-mist bg-white text-graphite hover:bg-porcelain"
                }`}
                onClick={() => {
                  setQueueMode((on) => !on);
                  setIngestResult(null);
                  setError(null);
                }}
                title="Queue mode: add cards one after another and copy them in sequence."
                type="button"
              >
                <Layers size={12} />
                Queue{queueMode ? " on" : ""}
              </button>
            </div>
          </div>
          <div className="space-y-2 p-2">
            {queueMode ? (
              <div data-drop-zone="queue">
                <QueuePanel
                  cards={queue}
                  fileCount={queueFileCount}
                  byteCount={queueByteCount}
                  isRunning={isQueueRunning}
                  isDragOver={dragZone === "queue"}
                  currentSegment={currentSegment}
                  instantaneousBps={instantaneousBps}
                  onAddCard={() => void addQueueCard()}
                  onRemoveCard={removeQueueCard}
                  onClearFinished={clearFinishedQueueCards}
                  onAliasChange={(id, value) => patchQueueCard(id, { cameraAlias: value })}
                  detectedCameraForSource={detectedCameraForSource}
                />
              </div>
            ) : null}
            <label
              className={`block rounded-xl p-1 transition ${queueMode ? "hidden" : ""} ${
                dragZone === "sources" ? "bg-lavender/10 outline outline-2 outline-dashed outline-signal" : ""
              }`}
              data-drop-zone="sources"
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-graphite">
                <FieldLabel help="Choose one or more camera cards or source folders — or drag folders/files here. Detected camera cards are auto-filled when possible.">
                  Copy From
                </FieldLabel>
                {sourcePaths.some((path) => detectedSources.some((source) => source.path === path)) ? (
                  <span className="font-medium text-graphite/75">Camera card</span>
                ) : null}
              </div>
              <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                <input
                  className="h-9 min-w-0 rounded-xl border border-mist bg-white px-3 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                  onClick={() => void chooseSource("replace")}
                  readOnly
                  value={sourcePaths.length > 1 ? `${sourcePaths.length} sources selected` : sourcePath}
                />
                <button
                  className="inline-flex h-9 items-center gap-1 rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => void chooseSource("replace")}
                  type="button"
                >
                  <FolderOpen size={15} />
                  Pick
                </button>
                <button
                  className="inline-flex h-9 items-center justify-center rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => void chooseSource("add")}
                  type="button"
                >
                  +
                </button>
              </div>
              {sourcePaths.length > 0 ? (
                <div className="mt-1 space-y-1">
                  {sourcePaths.map((path, index) => (
                    <PathRow
                      key={path}
                      label={pathDisplayName(path)}
                      meta={sourceSizeSummary(path, sourceScans, isScanning, spaceByPath[path])}
                      onRemove={() => removeSource(index)}
                      path={path}
                    />
                  ))}
                </div>
              ) : null}
              {sourcePaths.length > 0 ? (
                <div className="mt-2 rounded-xl border border-mist bg-porcelain/40 p-2">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-graphite/60">
                    Camera tags
                  </div>
                  <div className="space-y-1">
                    {sourcePaths.map((path) => (
                      <div key={path} className="grid grid-cols-[1fr_120px] items-center gap-2">
                        <span className="min-w-0 truncate text-xs font-semibold text-ink">{pathDisplayName(path)}</span>
                        <input
                          className="h-7 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                          onChange={(event) =>
                            setCameraAliases((current) => ({ ...current, [path]: event.target.value }))
                          }
                          placeholder={detectedCameraForSource(path)}
                          value={cameraAliases[path] ?? ""}
                        />
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-graphite/60">
                    Sets the {"{camera}"} token per card (e.g. A, Wide, Drone). Blank = auto-detect.
                  </p>
                </div>
              ) : null}
            </label>

            <label
              className={`block rounded-xl p-1 transition ${
                dragZone === "destinations" ? "bg-lavender/10 outline outline-2 outline-dashed outline-signal" : ""
              }`}
              data-drop-zone="destinations"
            >
              <FieldLabel help="Choose whether Ingest Pilot should create the project root from the preset, or copy into a folder you already made. You can also drag destination folders here.">
                Project Folder
              </FieldLabel>
              <div className="mb-2 grid grid-cols-2 gap-1 rounded-xl border border-mist bg-porcelain/50 p-1">
                <button
                  className={`h-7 rounded-lg px-2 text-xs font-semibold transition ${
                    destinationMode === "create_new" ? "bg-white text-ink shadow-sm" : "text-graphite hover:bg-white/60"
                  }`}
                  onClick={() => setDestinationMode("create_new")}
                  type="button"
                >
                  New project folder
                </button>
                <button
                  className={`h-7 rounded-lg px-2 text-xs font-semibold transition ${
                    destinationMode === "existing_root" ? "bg-white text-ink shadow-sm" : "text-graphite hover:bg-white/60"
                  }`}
                  onClick={() => setDestinationMode("existing_root")}
                  type="button"
                >
                  Existing folder
                </button>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-graphite">
                {destinationMode === "existing_root"
                  ? "Copy into a project folder that already exists."
                  : "Create the preset's project folder inside the destination you choose."}
              </p>
              <span className="mb-1 flex items-center justify-between text-xs font-semibold text-graphite">
                <span>{destinationMode === "existing_root" ? "Use Folder" : "Copy To"}</span>
                {destinationPath ? (
                  <span className="font-medium text-graphite/75">
                    {destinationSpaceSummary(destinationPath, spaceByPath[destinationPath], selectedBytes, ingestEtaMs)}
                  </span>
                ) : null}
              </span>
              <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                <input
                  className="h-9 min-w-0 rounded-xl border border-mist bg-white px-3 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                  onChange={(event) => {
                    setDestinationPath(event.target.value);
                    setIngestResult(null);
                  }}
                  value={destinationPath}
                />
                <button
                  className="inline-flex h-9 items-center gap-1 rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => void chooseDestination()}
                  type="button"
                >
                  <FolderOpen size={15} />
                  Pick
                </button>
                <button
                  aria-label="Add backup destination"
                  className="inline-flex h-9 items-center justify-center rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={addSecondaryDestination}
                  type="button"
                >
                  +
                </button>
              </div>
              {secondaryDestinationPaths.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {secondaryDestinationPaths.map((path, index) => (
                    <div key={index}>
                      <span className="mb-1 flex items-center justify-between text-xs font-semibold text-graphite">
                        <span>Backup {index + 1}</span>
                        {path ? (
                          <span className="font-medium text-graphite/75">
                            {destinationSpaceSummary(path, spaceByPath[path], selectedBytes, ingestEtaMs)}
                          </span>
                        ) : null}
                      </span>
                      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                        <input
                          className="h-9 min-w-0 rounded-xl border border-mist bg-white px-3 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                          onChange={(event) => updateSecondaryDestination(index, event.target.value)}
                          placeholder="Backup copy location"
                          value={path}
                        />
                        <button
                          className="inline-flex h-9 items-center gap-1 rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                          onClick={() => void chooseSecondaryDestination(index)}
                          type="button"
                        >
                          <FolderOpen size={15} />
                          Pick
                        </button>
                        <button
                          aria-label={`Remove backup ${index + 1}`}
                          className="inline-flex h-9 items-center justify-center rounded-xl border border-mist bg-white px-3 text-graphite transition hover:bg-porcelain hover:text-ink"
                          onClick={() => removeSecondaryDestination(index)}
                          type="button"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </label>

            <button
              className={`inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-signal px-3 text-sm font-semibold text-primaryfg transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40 ${
                queueMode ? "hidden" : ""
              }`}
              disabled={!sourcePath || isScanning}
              onClick={() => void runScan()}
              type="button"
            >
              <Search size={16} />
              {isScanning ? "Scanning..." : scan ? "Rescan" : "Scan"}
            </button>

            <details open className="rounded-xl border border-mist bg-porcelain/45">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-graphite">
                Copy Options
              </summary>
              <div className="space-y-2 border-t border-mist p-2">
                <label className="flex min-h-8 items-center justify-between gap-3 rounded-lg bg-white px-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-ink">Delete sidecars</span>
                    <span className="block truncate text-[11px] text-graphite">Skip XML, XMP, THM, and CPF pairs.</span>
                  </span>
                  <input
                    checked={deleteSidecars}
                    className="h-4 w-4 accent-signal"
                    onChange={(event) => setDeleteSidecars(event.target.checked)}
                    type="checkbox"
                  />
                </label>

                <label className="flex min-h-8 items-center justify-between gap-3 rounded-lg bg-white px-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-ink">Rename files</span>
                    <span className="block truncate text-[11px] text-graphite">Apply a filename pattern as files copy.</span>
                  </span>
                  <input
                    checked={renameFiles}
                    className="h-4 w-4 accent-signal"
                    onChange={(event) => setRenameFiles(event.target.checked)}
                    type="checkbox"
                  />
                </label>

                {renameFiles ? (
                  <div className="rounded-lg bg-white px-2 py-1.5">
                    <button
                      className="flex w-full items-center justify-between gap-2 text-left"
                      onClick={() => setShowFileNameEditor((current) => !current)}
                      type="button"
                    >
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-ink">File name</span>
                        <span className="block truncate text-[11px] text-graphite">
                          {fileRenamePattern.trim() || "{original_name}{ext}"}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] font-semibold text-signal">
                        {showFileNameEditor ? "Done" : "Change"}
                      </span>
                    </button>
                    {showFileNameEditor ? (
                      <div className="mt-2 space-y-1.5">
                        <TokenSuggestInput
                          ariaLabel="File name pattern"
                          className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                          onChange={setFileRenamePattern}
                          placeholder="{camera}_{clip#} — type $ for tokens"
                          tokens={getTokenDefinitions("filename", ingestParameters)}
                          value={fileRenamePattern}
                        />
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-[11px] text-graphite">
                            Example: <span className="font-semibold text-ink">{outputPreview?.fileName ?? "—"}</span>
                          </span>
                          {preset && fileRenamePattern !== (preset.file_rename_pattern ?? "") ? (
                            <button
                              className="shrink-0 text-[11px] font-semibold text-graphite underline decoration-dotted hover:text-ink"
                              onClick={() => setFileRenamePattern(preset.file_rename_pattern ?? "")}
                              type="button"
                            >
                              Reset to preset
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </details>

            <div className="rounded-2xl border border-graphite/20 bg-white p-2 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-ink">{queueMode ? "Queue ready" : "Ready to copy"}</span>
                <span className="font-semibold text-graphite">
                  {queueMode
                    ? queue.length > 0
                      ? `${queue.length} card${queue.length === 1 ? "" : "s"} · ${queueFileCount} files / ${formatBytes(queueByteCount)}`
                      : "Add a card to begin"
                    : selectedFileCount > 0
                      ? `${selectedFileCount} files / ${formatBytes(selectedBytes)}`
                      : ingestStartHint({ destinationTargets, scan, selectedFileCount, selectedPresetId, sourcePath })}
                </span>
              </div>
              {queueMode ? (
                <button
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-black px-3 text-base font-semibold text-primaryfg shadow-sm transition hover:bg-ink disabled:cursor-not-allowed disabled:bg-graphite/35 disabled:text-primaryfg/80 disabled:shadow-none"
                  disabled={!canStartQueue}
                  onClick={() => void runQueue()}
                  type="button"
                >
                  {isQueueRunning ? "Running queue…" : `Start queue (${queue.length})`}
                </button>
              ) : (
                <button
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-black px-3 text-base font-semibold text-primaryfg shadow-sm transition hover:bg-ink disabled:cursor-not-allowed disabled:bg-graphite/35 disabled:text-primaryfg/80 disabled:shadow-none"
                  disabled={!canStartIngest}
                  onClick={() => void startIngest()}
                  type="button"
                >
                  Start Ingest
                </button>
              )}
              {isQueueRunning ? (
                <button
                  className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-50"
                  disabled={isCancelling}
                  onClick={() => void cancelCurrentIngest()}
                  type="button"
                >
                  {isCancelling ? "Cancelling…" : "Cancel queue"}
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <div className="grid min-h-0 gap-2">
          <div
            className={`grid gap-2 ${
              preset && ingestParameters.length > 0 ? "2xl:grid-cols-[minmax(0,1fr)_340px]" : ""
            }`}
          >
            {preset && ingestParameters.length > 0 ? (
              <section className="relative z-30 overflow-visible rounded-2xl border border-mist bg-white">
                <div className="flex h-9 items-center justify-between border-b border-mist px-3">
                  <SectionTitle
                    help="Variables fill in the preset tokens used for folder names, file names, and routing decisions."
                    title="2. Job Variables"
                  />
                  <span className="text-xs font-semibold text-graphite">{ingestParameters.length} vars</span>
                </div>
                <div className="divide-y divide-mist">
                  {ingestParameters.map((variable) => (
                    <ParameterField
                      key={variable.id}
                      onChange={(value) =>
                        setVariableValues((current) => ({
                          ...current,
                          [variable.id]: value,
                        }))
                      }
                      suggestions={variableSuggestions[variable.id]}
                      value={variableValues[variable.id] ?? ""}
                      variable={variable}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            <OutputPreviewCard preview={outputPreview} />
          </div>

          <MetadataFillPanel
            summaries={metadataSummaries}
            presetId={metadataPresetId}
            preset={metadataPreset}
            values={metadataValues}
            shooters={appSettings.shooters}
            operator={appSettings.operator_name}
            onAddShooter={addShooter}
            onSelectPreset={(id) => {
              setMetadataPresetId(id);
              setIngestResult(null);
            }}
            onChange={(fieldId, value) => setMetadataValues((current) => ({ ...current, [fieldId]: value }))}
          />

          {scan ? (
            <section className="overflow-hidden rounded-2xl border border-mist bg-white">
              <div className="flex h-9 items-center justify-between gap-3 border-b border-mist px-3">
                <SectionTitle
                  help="These are the files selected for this ingest. Use Choose files when you only need part of a card."
                  title="3. Files to Copy"
                />
                <button
                  className="rounded-lg border border-mist bg-white px-2 py-1 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={openFileSelector}
                  type="button"
                >
                  Choose files
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 bg-porcelain/40 p-2.5 md:grid-cols-4">
                <SummaryTile label="Sources" value={String(sourcePaths.length)} />
                <SummaryTile label="Destinations" value={String(destinationTargets.length)} />
                <SummaryTile label="Required" value={formatBytes(selectedBytes)} />
                <SummaryTile
                  label="Destination"
                  value={destinationSpaceSummary(destinationPath, spaceByPath[destinationPath], selectedBytes, ingestEtaMs)}
                />
              </div>
            </section>
          ) : null}

          {scan ? (
            <details open className="overflow-hidden rounded-2xl border border-mist bg-white">
              <summary className="flex h-9 cursor-pointer items-center justify-between border-b border-mist px-3">
                <SectionTitle
                  help="A scan summary grouped by file type. It shows what will copy, what will be filtered, and where each type routes."
                  title="Scan Summary & Routing"
                />
                <div className="flex items-center gap-2">
                  {filteredPreviewCount > 0 ? (
                    <button
                      className="rounded-lg border border-mist bg-white px-2 py-1 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                      onClick={(event) => {
                        event.preventDefault();
                        setShowFilteredItems((current) => !current);
                      }}
                      type="button"
                    >
                      {showFilteredItems ? "Hide filtered" : `View filtered (${filteredPreviewCount})`}
                    </button>
                  ) : null}
                  <span className="text-xs font-semibold text-graphite">{formatBytes(scan.total_bytes)}</span>
                </div>
              </summary>
              <div className="max-h-[420px] overflow-auto">
                {visibleRoutingPreview.map((extension) => (
                  <div
                    key={`${extension.kind}-${extension.extension}`}
                    className={`grid min-h-9 grid-cols-[80px_96px_1fr_104px] items-center gap-3 border-b border-mist px-3 py-1.5 text-sm last:border-b-0 ${
                      isFilteredPreviewRow(extension) ? "bg-porcelain/35 opacity-75" : ""
                    }`}
                  >
                    <code className="text-xs font-semibold text-ink">{extension.extension}</code>
                    <div className="text-xs font-semibold text-graphite">{labelForKind(extension.kind)}</div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-ink">{extension.targetFolderName}</div>
                      <div className="truncate text-xs text-graphite">{extension.note}</div>
                    </div>
                    <div className="text-right text-xs font-semibold text-graphite">
                      {extension.count} file{extension.count === 1 ? "" : "s"}
                      <br />
                      {formatBytes(extension.total_bytes)}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </div>
      {scan && isFileSelectorOpen ? (
        <FileSelectionDialog
          availableCount={copyableFiles.length}
          deleteSidecars={deleteSidecars}
          files={visibleManifestFiles}
          onClose={() => setIsFileSelectorOpen(false)}
          ui={filePickerUi}
          onUiChange={setFilePickerUi}
          onSelectNone={() => setSelectedRelativePaths(new Set())}
          selectedBytes={selectedBytes}
          selectedCount={selectedFileCount}
          selectedRelativePaths={selectedRelativePaths}
          setSelectedRelativePaths={setSelectedRelativePaths}
        />
      ) : null}
      {isNamingOpen ? (
        <NamingAssistant onApply={(deliverable, values) => applyNaming(deliverable, values)} onClose={() => setIsNamingOpen(false)} />
      ) : null}
    </div>
  );
}

const QUEUE_STATUS_STYLES: Record<QueueCardStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-porcelain text-graphite" },
  scanning: { label: "Scanning…", className: "bg-lavender/25 text-graphite" },
  ready: { label: "Ready", className: "bg-emerald-50 text-emerald-700" },
  copying: { label: "Copying…", className: "bg-signal text-primaryfg" },
  done: { label: "Done", className: "bg-emerald-600 text-primaryfg" },
  error: { label: "Issue", className: "bg-red-100 text-red-700" },
};

function QueuePanel({
  cards,
  fileCount,
  byteCount,
  isRunning,
  isDragOver,
  currentSegment,
  instantaneousBps,
  onAddCard,
  onRemoveCard,
  onClearFinished,
  onAliasChange,
  detectedCameraForSource,
}: {
  cards: QueueCard[];
  fileCount: number;
  byteCount: number;
  isRunning: boolean;
  isDragOver: boolean;
  currentSegment: { label: string; index: number; total: number } | null;
  instantaneousBps: number;
  onAddCard: () => void;
  onRemoveCard: (id: string) => void;
  onClearFinished: () => void;
  onAliasChange: (id: string, value: string) => void;
  detectedCameraForSource: (path: string) => string;
}) {
  const doneCount = cards.filter((card) => card.status === "done").length;
  return (
    <div
      className={`space-y-2 rounded-xl transition ${
        isDragOver ? "bg-lavender/10 outline outline-2 outline-dashed outline-signal" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <FieldLabel help="Add camera cards one after another. Each is scanned in the background and copied in order into the destination(s) below. You can keep adding cards while the queue runs.">
          Card Queue
        </FieldLabel>
        <div className="flex items-center gap-2">
          {doneCount > 0 ? (
            <button
              className="text-[11px] font-semibold text-graphite underline-offset-2 hover:underline"
              onClick={onClearFinished}
              type="button"
            >
              Clear done
            </button>
          ) : null}
          <span className="text-[11px] font-semibold text-graphite/70">
            {cards.length} card{cards.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {isRunning ? (
        <div className="rounded-xl border border-signal/30 bg-signal/5 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-graphite">
            <span className="min-w-0 truncate">{currentSegment?.label ?? "Preparing…"}</span>
            <span className="shrink-0">{formatBytes(instantaneousBps)}/s</span>
          </div>
          {currentSegment && currentSegment.total > 1 ? (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-porcelain">
              <div
                className="h-full rounded-full bg-signal transition-all"
                style={{ width: `${Math.round((currentSegment.index / currentSegment.total) * 100)}%` }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {cards.length === 0 ? (
        <p className="rounded-xl border border-dashed border-mist bg-porcelain/40 px-3 py-5 text-center text-xs text-graphite">
          {isDragOver ? (
            <span className="font-semibold text-graphite">Drop folders to queue them</span>
          ) : (
            <>
              Drag camera-card folders here, or use <span className="font-semibold">Add card</span>.
            </>
          )}
        </p>
      ) : (
        <div className="space-y-1.5">
          {cards.map((card, index) => {
            const status = QUEUE_STATUS_STYLES[card.status];
            return (
              <div
                key={card.id}
                className={`rounded-xl border bg-white p-2 ${
                  card.status === "copying" ? "border-signal shadow-sm" : "border-mist"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-porcelain text-[10px] font-bold text-graphite">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink" title={card.sourcePath}>
                    {pathDisplayName(card.sourcePath)}
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${status.className}`}>
                    {status.label}
                  </span>
                  {!isRunning ? (
                    <button
                      aria-label="Remove card"
                      className="shrink-0 rounded-lg p-1 text-graphite transition hover:bg-porcelain hover:text-ink"
                      onClick={() => onRemoveCard(card.id)}
                      type="button"
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-graphite">
                    {card.status === "error" && card.error
                      ? card.error
                      : card.fileCount > 0
                        ? `${card.fileCount} files · ${formatBytes(card.byteCount)}`
                        : card.status === "scanning"
                          ? "Scanning…"
                          : "—"}
                  </span>
                  <input
                    className="h-7 w-[110px] shrink-0 rounded-lg border border-mist bg-white px-2 text-[11px] outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                    onChange={(event) => onAliasChange(card.id, event.target.value)}
                    placeholder={detectedCameraForSource(card.sourcePath) || "camera"}
                    value={card.cameraAlias}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
        onClick={onAddCard}
        type="button"
      >
        <Plus size={15} />
        Add card
      </button>

      {cards.length > 0 ? (
        <p className="text-center text-[10px] text-graphite/60">
          {fileCount} files / {formatBytes(byteCount)} queued · set the {"{camera}"} tag per card
        </p>
      ) : null}
    </div>
  );
}

// Per-card breakdown on the delivery screen for a queue run — one row per imported
// card with its camera tag, file/verify counts, size, and status.
function QueueCardsSummary({ cards }: { cards: QueueCard[] }) {
  const shown = cards.filter((card) => card.result || card.status === "done" || card.status === "error");
  return (
    <div className="border-b border-mist px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-graphite/60">
        <span>Cards imported</span>
        <span>{shown.length}</span>
      </div>
      <div className="space-y-1">
        {shown.map((card, index) => {
          const result = card.result;
          const status = QUEUE_STATUS_STYLES[card.status];
          const allVerified = result ? result.verification_failed === 0 : card.status === "done";
          return (
            <div
              key={card.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border border-mist bg-white px-2 py-1.5"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-porcelain text-[10px] font-bold text-graphite">
                {index + 1}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs font-semibold text-ink" title={card.sourcePath}>
                    {pathDisplayName(card.sourcePath)}
                  </span>
                  {card.cameraAlias.trim() ? (
                    <span className="shrink-0 rounded bg-porcelain px-1.5 py-0.5 text-[10px] font-semibold text-graphite">
                      {card.cameraAlias.trim()}
                    </span>
                  ) : null}
                </div>
                <span className="text-[11px] text-graphite">
                  {result
                    ? `${result.verified_files}/${result.files_copied} verified · ${formatBytes(result.bytes_copied)}`
                    : card.status === "done"
                      ? "No media copied"
                      : (card.error ?? "Not imported")}
                </span>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  result && !allVerified ? "bg-red-100 text-red-700" : status.className
                }`}
              >
                {result ? (allVerified ? "Verified" : `${result.verification_failed} failed`) : status.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Renders one metadata field input by type; values are stored as strings
// (booleans as "true"/"false", multi-selects as comma-joined).
const ADD_SHOOTER_VALUE = " add-shooter";

// The Shooter field: a dropdown that defaults to this machine's operator and lists the
// internal staff by default. A toggle reveals pre-loaded volunteers/contractors (for a
// big event), and "+ Add shooter" adds someone on the fly.
function ShooterFieldInput({
  value,
  onChange,
  shooters,
  operator,
  onAddShooter,
}: {
  value: string;
  onChange: (value: string) => void;
  shooters: Shooter[];
  operator: string;
  onAddShooter: () => Promise<string | null>;
}) {
  const [showAll, setShowAll] = useState(false);
  const op = operator.trim();

  const staff: string[] = [];
  if (op) {
    staff.push(op);
  }
  for (const shooter of shooters) {
    if (shooter.group === "staff" && shooter.name.trim() && !staff.includes(shooter.name)) {
      staff.push(shooter.name);
    }
  }
  const extended = shooters.filter((shooter) => shooter.group !== "staff");
  const hasExtended = extended.length > 0;

  const options = [
    { label: "—", value: "" },
    ...staff.map((name) => ({ label: name === op ? `${name} (you)` : name, value: name })),
  ];
  if (showAll) {
    for (const shooter of extended) {
      options.push({ label: `${shooter.name} · ${shooter.group}`, value: shooter.name });
    }
  }
  // Keep the current value visible even if it belongs to a hidden tier.
  if (value && !options.some((option) => option.value === value)) {
    options.push({ label: value, value });
  }
  options.push({ label: "+ Add shooter…", value: ADD_SHOOTER_VALUE });

  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <SelectMenu
          onChange={(next) => {
            if (next === ADD_SHOOTER_VALUE) {
              void onAddShooter().then((added) => {
                if (added) {
                  setShowAll(true);
                  onChange(added);
                }
              });
              return;
            }
            onChange(next);
          }}
          options={options}
          size="sm"
          value={value}
        />
      </div>
      {hasExtended ? (
        <button
          aria-label={showAll ? "Show staff only" : "Show volunteers and contractors"}
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-mist transition hover:bg-porcelain ${
            showAll ? "bg-lavender/25 text-ink" : "bg-white text-graphite"
          }`}
          onClick={() => setShowAll((current) => !current)}
          title={showAll ? "Show staff only" : "Show volunteers & contractors"}
          type="button"
        >
          <Users size={14} />
        </button>
      ) : null}
    </div>
  );
}

function MetadataFieldInput({
  field,
  value,
  onChange,
  shooters,
  operator,
  onAddShooter,
}: {
  field: MetadataPreset["categories"][number]["fields"][number];
  value: string;
  onChange: (value: string) => void;
  shooters: Shooter[];
  operator: string;
  onAddShooter: () => Promise<string | null>;
}) {
  if (field.field_type === "shooter") {
    return (
      <ShooterFieldInput
        onAddShooter={onAddShooter}
        onChange={onChange}
        operator={operator}
        shooters={shooters}
        value={value}
      />
    );
  }
  if (field.field_type === "long_text") {
    return (
      <textarea
        className="min-h-[52px] w-full rounded-lg border border-mist bg-white px-2 py-1.5 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    );
  }
  if (field.field_type === "boolean") {
    return (
      <SelectMenu
        onChange={onChange}
        options={[
          { label: "—", value: "" },
          { label: "Yes", value: "true" },
          { label: "No", value: "false" },
        ]}
        size="sm"
        value={value}
      />
    );
  }
  if (field.field_type === "dropdown") {
    return (
      <SelectMenu
        onChange={onChange}
        options={[{ label: "—", value: "" }, ...field.options.map((option) => ({ label: option, value: option }))]}
        size="sm"
        value={value}
      />
    );
  }
  if (field.field_type === "date") {
    return (
      <input
        className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => onChange(event.target.value)}
        type="date"
        value={value}
      />
    );
  }
  // text and multi_select both edit as free text (multi-select is comma-separated).
  return (
    <input
      className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
      onChange={(event) => onChange(event.target.value)}
      placeholder={
        field.field_type === "multi_select"
          ? field.options.length > 0
            ? `${field.options.slice(0, 3).join(", ")}…`
            : "comma, separated"
          : undefined
      }
      value={value}
    />
  );
}

function MetadataFillPanel({
  summaries,
  presetId,
  preset,
  values,
  onSelectPreset,
  onChange,
  shooters,
  operator,
  onAddShooter,
}: {
  summaries: MetadataPresetSummary[];
  presetId: string;
  preset: MetadataPreset | null;
  values: Record<string, string>;
  onSelectPreset: (id: string) => void;
  onChange: (fieldId: string, value: string) => void;
  shooters: Shooter[];
  operator: string;
  onAddShooter: () => Promise<string | null>;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-mist bg-white">
      <div className="flex h-9 items-center justify-between gap-2 border-b border-mist px-3">
        <SectionTitle
          help="Optional shoot-level metadata tagged onto every clip and written as a CSV manifest for iconik. Manage schemas in the Metadata tab."
          title="Metadata"
        />
        <div className="w-44">
          <SelectMenu
            onChange={onSelectPreset}
            options={[{ label: "None", value: "" }, ...summaries.map((item) => ({ label: item.name, value: item.id }))]}
            placeholder="No metadata"
            size="sm"
            value={presetId}
          />
        </div>
      </div>
      {preset ? (
        <div className="max-h-[320px] space-y-2 overflow-auto p-2">
          {preset.categories.map((category) => (
            <div key={category.id} className="rounded-xl border border-mist bg-porcelain/30 p-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-graphite/60">{category.name}</div>
              <div className="space-y-1.5">
                {category.fields.map((field) => (
                  <div key={field.id} className="grid grid-cols-[110px_1fr] items-center gap-2">
                    <span className="truncate text-xs font-semibold text-graphite" title={field.label}>
                      {field.label}
                    </span>
                    <MetadataFieldInput
                      field={field}
                      onAddShooter={onAddShooter}
                      onChange={(value) => onChange(field.id, value)}
                      operator={operator}
                      shooters={shooters}
                      value={values[field.id] ?? ""}
                    />
                  </div>
                ))}
                {category.fields.length === 0 ? <p className="text-[11px] text-graphite/60">No fields.</p> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-3 py-2.5 text-xs text-graphite">
          Pick a metadata preset to tag this import for iconik. Values apply to every clip.
        </p>
      )}
    </section>
  );
}

// Guided naming per the team SOP: pick a deliverable, fill its fields, and the
// preview shows the exact project folder name. Applying it selects the matching
// seeded preset and pre-fills its variables (see applyNaming in IngestPage).
function NamingAssistant({
  onApply,
  onClose,
}: {
  onApply: (deliverable: NamingDeliverable, values: Record<string, string>) => void;
  onClose: () => void;
}) {
  // Templates come from the editable naming catalog (Naming tab), so anything the
  // team adds or edits there is immediately available here.
  const [templates, setTemplates] = useState<NamingDeliverable[]>(() => defaultNamingCatalog().deliverables);
  const [deliverableId, setDeliverableId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    getNamingCatalog()
      .then((persisted) => {
        if (active) {
          setTemplates(mergeNamingCatalog(persisted).deliverables);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // No default selection: the accordion starts fully collapsed until a template is
  // picked (its group then expands via the effect below).
  const deliverable = templates.find((item) => item.id === deliverableId) ?? null;
  const preview = deliverable ? previewNamingResult(deliverable, values) : "";
  const missingRequired = deliverable
    ? deliverable.fields.some((field) => field.required && !(values[field.id] ?? "").trim())
    : true;
  // Preserve catalog order while grouping.
  const groups = [...new Set(templates.map((item) => item.group))];

  // Accordion state — collapsed by default, but keep the picked template's group open.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (deliverable) {
      setExpandedGroups((prev) => (prev.has(deliverable.group) ? prev : new Set(prev).add(deliverable.group)));
    }
  }, [deliverable]);
  const toggleGroup = (group: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm">
      <section className="flex h-[88vh] w-full max-w-4xl select-none flex-col overflow-hidden rounded-[24px] border border-mist bg-white shadow-panel">
        <div className="flex items-center justify-between border-b border-mist px-4 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Wand2 size={16} />
              Naming Assistant
            </h2>
            <p className="text-xs font-medium text-graphite">Build the SOP-correct project name, then apply it to this ingest.</p>
          </div>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-mist bg-white text-graphite transition hover:bg-porcelain"
            onClick={onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
          {/* Same "hairline editorial" (design 1c) accordion as the Naming tab. */}
          <aside className="min-h-0 overflow-auto border-r border-mist bg-porcelain/25 px-3">
            {groups.map((group) => {
              const open = expandedGroups.has(group);
              const items = templates.filter((item) => item.group === group);
              return (
                <div key={group} className="border-t border-mist/70 first:border-t-0">
                  <button
                    className="flex w-full items-center gap-2 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.09em] text-ink transition hover:text-black"
                    onClick={() => toggleGroup(group)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1 truncate">{group}</span>
                    <span className="shrink-0 font-normal normal-case tracking-normal tabular-nums text-graphite/70">{items.length}</span>
                    <Plus className={`shrink-0 text-graphite transition-transform duration-300 ${open ? "rotate-45" : ""}`} size={13} />
                  </button>
                  <div
                    className="grid transition-[grid-template-rows] duration-300 ease-out"
                    style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className={`pb-2 transition-transform duration-300 ease-out ${open ? "translate-y-0" : "-translate-y-2"}`}>
                        {items.map((item) => {
                          const selected = deliverableId === item.id;
                          return (
                            <button
                              key={item.id}
                              className={`flex w-full items-center gap-2 py-1.5 text-left text-[13px] transition ${
                                selected ? "font-semibold text-ink" : "text-graphite hover:text-ink"
                              }`}
                              onClick={() => {
                                setDeliverableId(item.id);
                                setValues({});
                              }}
                              type="button"
                            >
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-signal transition-opacity ${selected ? "opacity-100" : "opacity-0"}`} />
                              <span className="min-w-0 truncate">{item.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </aside>

          <div className="flex min-h-0 flex-col overflow-auto p-4">
            {deliverable ? (
              <>
                <p className="mb-3 text-xs text-graphite">
                  Pattern: <code className="rounded bg-porcelain px-1 py-0.5">{deliverable.hint}</code>
                </p>
                <div className="space-y-2">
                  {deliverable.fields.length === 0 ? (
                    <p className="text-xs text-graphite">No fields needed — the date is filled automatically.</p>
                  ) : (
                    deliverable.fields.map((field) => (
                      <div key={field.id} className="grid grid-cols-[120px_1fr] items-center gap-2">
                        <label className="text-xs font-semibold text-graphite">
                          {field.label}
                          {field.required ? <span className="text-red-600"> *</span> : null}
                        </label>
                        {field.type === "dropdown" ? (
                          <SelectMenu
                            onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                            options={[{ label: "—", value: "" }, ...(field.options ?? []).map((option) => ({ label: option, value: option }))]}
                            size="sm"
                            value={values[field.id] ?? ""}
                          />
                        ) : (
                          <input
                            className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                            onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                            placeholder={field.placeholder}
                            value={values[field.id] ?? ""}
                          />
                        )}
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-4 rounded-xl border border-mist bg-porcelain/40 p-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-graphite/60">Project folder</div>
                  <div className="break-words font-mono text-sm font-semibold text-ink">{preview || "—"}</div>
                </div>

                <div className="mt-auto flex items-center justify-end gap-2 pt-4">
                  <button
                    className="inline-flex h-9 items-center rounded-xl border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                    onClick={onClose}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-signal px-4 text-sm font-semibold text-primaryfg transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={missingRequired}
                    onClick={() => onApply(deliverable, values)}
                    type="button"
                  >
                    <Check size={15} />
                    Use this name
                  </button>
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-graphite">
                Pick a naming template on the left to build this ingest's project name.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

// Traffic-light status vocabulary shared by the header phase chip and the per-destination
// dots. Tones use saturated palette colors at low alpha so the same class reads on both the
// light and dark card surfaces (no theme-specific hexes). `neutral` falls back to tokens.
type TrafficTone = "neutral" | "amber" | "blue" | "cyan" | "violet" | "green" | "red";

// Tint backgrounds/dots use saturated palette colors at low alpha (theme-safe on both
// surfaces). Text carries a dark:-400 variant because the -600 shades fail AA contrast on the
// #1c1d1f / #121314 dark surfaces — the phase/failure states must stay unmistakable there.
const toneStyles: Record<TrafficTone, { dot: string; chip: string; text: string }> = {
  neutral: { dot: "bg-graphite/50", chip: "border-mist bg-porcelain", text: "text-graphite" },
  amber: { dot: "bg-amber-500", chip: "border-amber-500/30 bg-amber-500/10", text: "text-amber-600 dark:text-amber-400" },
  blue: { dot: "bg-sky-500", chip: "border-sky-500/30 bg-sky-500/10", text: "text-sky-600 dark:text-sky-400" },
  cyan: { dot: "bg-cyan-500", chip: "border-cyan-500/30 bg-cyan-500/10", text: "text-cyan-600 dark:text-cyan-400" },
  violet: { dot: "bg-violet-500", chip: "border-violet-500/30 bg-violet-500/10", text: "text-violet-600 dark:text-violet-400" },
  green: { dot: "bg-emerald-500", chip: "border-emerald-500/30 bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400" },
  red: { dot: "bg-red-500", chip: "border-red-500/40 bg-red-500/15", text: "text-red-600 dark:text-red-400" },
};

// Map an engine phase string (copier.rs emits these verbatim) to a traffic-light tone. Any
// live failure forces red regardless of phase.
function phaseTone(phase: string | undefined, failed: boolean): TrafficTone {
  if (failed) {
    return "red";
  }
  switch (phase) {
    case "Preparing":
      return "amber";
    case "Copying":
      return "blue";
    case "Verifying":
      return "cyan";
    case "Copying sidecars":
    case "Writing verification record":
      return "violet";
    case "Complete":
      return "green";
    default:
      return "neutral";
  }
}

// The header status chip: a colored dot (pulsing while the run is live) + the phase label.
function PhaseChip({ phase, failed }: { phase: string | undefined, failed: boolean }) {
  const tone = phaseTone(phase, failed);
  const style = toneStyles[tone];
  const live = !failed && phase !== "Complete";
  const label = failed ? "Failure detected" : phase ?? "Preparing";
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold ${style.chip} ${style.text}`}
    >
      <span className={`relative flex h-2 w-2`}>
        {live ? <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${style.dot}`} /> : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
      </span>
      {label}
    </span>
  );
}

// A copy/verify progress bar: the copied portion (accent) with the verified portion (solid,
// trailing) layered on top; turns red when the destination has failed. Theme-safe fills.
function TwoToneBar({
  copyPercent,
  verifyPercent,
  failed,
  height = "h-2",
}: {
  copyPercent: number;
  verifyPercent: number;
  failed?: boolean;
  height?: string;
}) {
  const copying = copyPercent > 0 && copyPercent < 100 && !failed;
  return (
    <div className={`relative ${height} overflow-hidden rounded-full bg-app shadow-inner`}>
      <div className="absolute inset-y-0 left-0 rounded-full bg-lavender/60 transition-all" style={{ width: `${copyPercent}%` }} />
      {/* Verified portion trails the copy portion; dark-tuned ok token keeps AA on dark. */}
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-all ${failed ? "bg-red-500" : "bg-ok"}`}
        style={{ width: `${verifyPercent}%` }}
      />
      {/* Live highlight at the leading copy edge so an active transfer visibly "breathes". */}
      {copying ? (
        <div
          className="absolute inset-y-0 w-1.5 -translate-x-1/2 rounded-full bg-lavender animate-pulse"
          style={{ left: `${copyPercent}%` }}
        />
      ) : null}
    </div>
  );
}

export function IngestRunScreen({
  isCancelling,
  onCancel,
  progress,
  speedSeries,
  instantaneousBps,
  currentSegment,
  selectedBytes,
  selectedCount,
  destinationProgress,
  verifiedFeed,
  verifiedFailedTotal,
  verifiedFailedByDest,
  spaceByPath,
}: {
  isCancelling: boolean;
  onCancel: () => void;
  progress: IngestProgress | null;
  speedSeries: SpeedPoint[];
  instantaneousBps: number;
  currentSegment: { label: string; index: number; total: number } | null;
  selectedBytes: number;
  selectedCount: number;
  destinationProgress: DestinationProgress[];
  verifiedFeed: VerifiedFeedEntry[];
  verifiedFailedTotal: number;
  verifiedFailedByDest: Map<number, number>;
  spaceByPath: Record<string, DiskSpace | null>;
}) {
  const percent = progress ? progressPercent(progress) : 0;
  // Real windowed throughput (matches the graph), not the backend cumulative average.
  const speed = formatBytes(instantaneousBps);
  const remaining = progress?.remaining_ms ? formatDuration(progress.remaining_ms) : "--";
  const elapsed = progress ? formatDuration(progress.elapsed_ms) : "0s";
  const totalBytes = progress?.total_bytes || selectedBytes;
  const copiedBytes = progress?.bytes_done ?? 0;
  // Real verification progress reported by the engine (verified bytes / total).
  const verifyPercent =
    progress?.phase === "Complete"
      ? 100
      : progress && progress.total_bytes > 0
        ? Math.min(100, Math.round((progress.verified_bytes / progress.total_bytes) * 100))
        : 0;

  // Failure state comes from the parent's AUTHORITATIVE, UNCAPPED tally — never from the
  // capped display feed, whose oldest entries (which could include an early checksum
  // failure) are evicted. Per-dest failures aren't carried on `DestinationProgress` mid-run
  // (the backend keeps failed_files at 0 until the final per-root result), so the tally is
  // the only reliable mid-run signal of a bad checksum.
  const totalFailed = verifiedFailedTotal;
  const runFailed = totalFailed > 0;
  const totalVerified = progress?.verified_files ?? 0;
  const destCount = destinationProgress.length || progress?.destination_count || 0;
  // Only assert the algorithm once an event has actually reported it — no premature label.
  const algo = verifiedFeed[0]?.data.algo ?? null;
  // The h1 shows the source segment; fall back to a distinct title so it never echoes the
  // "Verified ingest" eyebrow above it.
  const sourceName = currentSegment?.label ?? "Transfer in progress";

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-graphite/70">
            Verified ingest
            {currentSegment && currentSegment.total > 1
              ? ` · card ${currentSegment.index} of ${currentSegment.total}`
              : ""}
          </p>
          <h1 className="truncate text-xl font-semibold tracking-normal">{sourceName}</h1>
          <p className="mt-1 flex items-center gap-1.5 truncate text-xs font-semibold text-graphite">
            <HardDrive size={13} className="shrink-0 text-graphite/70" />
            {destCount > 0 ? `${destCount} destination${destCount === 1 ? "" : "s"}` : "Preparing destinations"}
            <span className="text-graphite/40">·</span>
            {progress?.files_done ?? 0}/{progress?.total_files ?? selectedCount} files
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PhaseChip phase={progress?.phase} failed={runFailed} />
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 text-xs font-semibold text-red-600 transition hover:bg-red-500/20 disabled:opacity-60 dark:text-red-400"
            disabled={isCancelling}
            onClick={onCancel}
            type="button"
          >
            <X size={16} />
            {isCancelling ? "Cancelling..." : "Cancel"}
          </button>
        </div>
      </header>

      {/* Aggregate stat strip: a big progress readout plus the signature transfer metrics. */}
      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-xl border border-mist bg-porcelain/55 px-3 py-2">
          <p className="text-[11px] font-semibold text-graphite">Progress</p>
          <div className="mt-0.5 flex items-end gap-1">
            <span className="text-3xl font-semibold leading-none text-ink">{percent}</span>
            <span className="pb-0.5 text-sm font-semibold text-graphite">%</span>
          </div>
        </div>
        <SummaryTile label="Speed" value={`${speed}/s`} />
        <SummaryTile label="Remaining" value={remaining} />
        <SummaryTile label="Copied" value={`${progress?.files_done ?? 0}/${progress?.total_files ?? selectedCount}`} />
        <SummaryTile
          label="Verified"
          value={`${totalVerified}/${progress?.total_files ?? selectedCount}`}
          tone={runFailed ? "bad" : undefined}
          sub={runFailed ? `${totalFailed} failed` : undefined}
        />
        <SummaryTile label="Elapsed" value={elapsed} />
      </div>

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Left column: signature throughput chart + the per-destination centerpiece. */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          {/* Throughput is a slim supporting strip — the drives below are the centerpiece. */}
          <section className="shrink-0 overflow-hidden rounded-2xl border border-mist bg-card">
            <div className="flex h-8 items-center justify-between border-b border-mist px-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Activity size={14} className="text-graphite/70" />
                Throughput
              </h2>
              <span className="text-xs font-semibold tabular-nums text-graphite">{speed}/s</span>
            </div>
            <div className="p-2">
              <div className="relative h-[96px] overflow-hidden rounded-xl border border-mist bg-porcelain/35 p-1.5">
                <SpeedChart series={speedSeries} />
              </div>
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-graphite">
                  <span>{formatBytes(copiedBytes)} copied</span>
                  <span>{formatBytes(totalBytes)} total</span>
                </div>
                <TwoToneBar copyPercent={percent} verifyPercent={verifyPercent} failed={runFailed} height="h-2.5" />
              </div>
              {progress?.current_file ? (
                <div className="mt-2 truncate rounded-lg border border-mist bg-porcelain/50 px-2.5 py-1.5 text-[11px] font-semibold text-graphite">
                  {progress.current_file}
                </div>
              ) : null}
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-mist bg-card">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-mist px-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <HardDrive size={14} className="text-graphite/70" />
                Destinations
              </h2>
              <span className="rounded-full bg-porcelain px-2 py-0.5 text-[11px] font-semibold text-graphite">{destCount}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
              {destinationProgress.length > 0 ? (
                destinationProgress.map((dest) => (
                  <DestinationProgressRow
                    key={dest.index}
                    dest={dest}
                    freeFallback={spaceByPath[dest.path]?.available_bytes ?? null}
                    failedCount={verifiedFailedByDest.get(dest.index) ?? 0}
                  />
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-mist bg-porcelain/40 px-3 py-6 text-center text-xs font-semibold text-graphite/70">
                  Waiting for the first destination to report…
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right column: the live per-file verification feed — the "streaming integrity" signal. */}
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-mist bg-card">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-mist px-3">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <ShieldCheck size={14} className="text-emerald-500 dark:text-emerald-400" />
              Live verification
            </h2>
            {algo ? (
              <span className="rounded-md border border-mist bg-porcelain px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-graphite">
                {algo}
              </span>
            ) : null}
          </div>
          {verifiedFeed.length > 0 ? (
            <div className="min-h-0 flex-1 divide-y divide-mist/60 overflow-auto">
              {verifiedFeed.map((entry) => (
                <VerifiedFeedRow key={entry.id} item={entry.data} />
              ))}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-xs font-medium leading-5 text-graphite/70">
              Each file appears here the instant its copy is re-read and checksum-matched against the source.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// One rich per-destination row — the Hedge/Silverstack centerpiece. A traffic-light dot for
// the drive's phase, the volume label, a live free-space countdown, a two-tone copy/verify
// bar, MB/s, per-dest ETA, and a ✓verified/✗failed integrity counter. A failed drive reads
// unmistakably red.
function DestinationProgressRow({
  dest,
  freeFallback,
  failedCount,
}: {
  dest: DestinationProgress;
  freeFallback: number | null;
  failedCount: number;
}) {
  const copyPercent = dest.bytes_total > 0 ? Math.min(100, Math.round((dest.bytes_done / dest.bytes_total) * 100)) : 0;
  const verifyPercent =
    dest.phase === "Complete"
      ? 100
      : dest.bytes_total > 0
        ? Math.min(100, Math.round((dest.verified_bytes / dest.bytes_total) * 100))
        : 0;
  const failed = failedCount > 0;
  const tone = toneStyles[phaseTone(dest.phase, failed)];
  const live = !failed && dest.phase !== "Complete";
  // free_space_bytes is a static snapshot captured at ingest start; decrement by what this
  // drive has written for a live countdown (matches how Hedge shows the drive draining).
  const startFree = dest.free_space_bytes ?? freeFallback;
  const liveFree = startFree != null ? Math.max(0, startFree - dest.bytes_done) : null;
  const eta = dest.remaining_ms != null ? formatDuration(dest.remaining_ms) : null;
  return (
    <div
      className={`rounded-xl border px-2.5 py-2 ${failed ? "border-red-500/40 bg-red-500/10" : "border-mist bg-porcelain/40"}`}
    >
      {/* Line 1: drive identity + headline percent — sized above the feed so the eye lands here. */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {live ? <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${tone.dot}`} /> : null}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${tone.dot}`} />
          </span>
          <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{dest.label || pathDisplayName(dest.path)}</span>
        </span>
        <span className={`shrink-0 text-[15px] font-bold tabular-nums ${failed ? "text-red-600 dark:text-red-400" : "text-ink"}`}>
          {copyPercent}%
        </span>
      </div>
      <TwoToneBar copyPercent={copyPercent} verifyPercent={verifyPercent} failed={failed} />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-medium text-graphite/80">
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">✓{dest.verified_files}</span>
          {failed ? <span className="font-semibold text-red-600 dark:text-red-400">✗{failedCount}</span> : null}
        </span>
        <span className="shrink-0 font-semibold tabular-nums text-graphite">{formatBytes(dest.bytes_per_second)}/s</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] font-medium text-graphite/70">
        <span className="flex items-center gap-1">
          <HardDrive size={11} className="text-graphite/50" />
          {liveFree != null ? `${formatBytes(liveFree)} free` : "—"}
        </span>
        {eta ? (
          <span className="flex items-center gap-1 tabular-nums">
            <Clock size={11} className="text-graphite/50" />
            {eta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// One row in the live per-file integrity feed: a ✓/✗ status badge, filename, a destination
// chip, and size. Newest-first; ✗ rows read red so a bad checksum is impossible to miss.
function VerifiedFeedRow({ item }: { item: FileVerified }) {
  const name = item.relative_path.split(/[\\/]/).pop() || item.relative_path;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md ${
          item.verified ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-red-500/20 text-red-600 dark:text-red-400"
        }`}
      >
        {item.verified ? <Check size={11} strokeWidth={3} /> : <X size={11} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={item.relative_path}>
        {name}
      </span>
      <span className="shrink-0 rounded bg-porcelain px-1.5 py-0.5 text-[10px] font-semibold text-graphite/80">
        {pathDisplayName(item.destination_path)}
      </span>
      <span className="shrink-0 tabular-nums text-graphite/60">{formatBytes(item.size_bytes)}</span>
    </div>
  );
}

function Gauge({ label, value }: { label: string; value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="rounded-2xl border border-mist bg-white p-3">
      <div className="mb-2 flex items-center justify-between text-sm font-semibold">
        <span>{label}</span>
        <span className="text-xs text-graphite">{Math.round(clamped)}%</span>
      </div>
      <div
        className="mx-auto h-28 w-28 rounded-full p-2.5"
        style={{
          background: `conic-gradient(var(--gauge-fill) ${clamped * 3.6}deg, var(--gauge-track) 0deg)`,
        }}
      >
        <div className="flex h-full w-full items-center justify-center rounded-full bg-white text-center">
          <div>
            <div className="text-xl font-semibold">{Math.round(clamped)}</div>
            <div className="text-xs font-semibold text-graphite">percent</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PresetBrowser({
  onSelect,
  presets,
  selectedPresetId,
}: {
  onSelect: (id: string) => void;
  presets: PresetSummary[];
  selectedPresetId: string;
}) {
  const [query, setQuery] = useState("");
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId);
  const normalizedQuery = query.trim().toLowerCase();
  const visiblePresets = normalizedQuery
    ? presets.filter((preset) => preset.name.toLowerCase().includes(normalizedQuery))
    : presets;

  return (
    <section className="overflow-hidden rounded-2xl border border-mist bg-white">
      <div className="flex h-9 items-center justify-between border-b border-mist px-3">
        <SectionTitle
          help="Presets are reusable ingest profiles. Pick one to load its variables, folder routing, naming pattern, and sidecar defaults."
          title="Presets"
        />
        <span className="rounded-full bg-porcelain px-2 py-0.5 text-[11px] font-semibold text-graphite">
          {visiblePresets.length}
        </span>
      </div>
      {presets.length === 0 ? (
        <div className="p-3 text-xs leading-5 text-graphite">
          No presets saved yet. Create one from the Presets page, then it will appear here.
        </div>
      ) : (
        <div>
          <div className="border-b border-mist p-1.5">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-graphite/55" size={13} />
              <input
                className="h-8 w-full rounded-lg border border-mist bg-white pl-7 pr-2 text-xs font-medium outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search presets"
                value={query}
              />
            </label>
          </div>
          <div className="max-h-[calc(100vh-230px)] overflow-auto p-1.5">
            {visiblePresets.length === 0 ? (
              <div className="px-2 py-4 text-xs font-medium text-graphite">No matching presets.</div>
            ) : (
              visiblePresets.map((preset) => {
                const selected = preset.id === selectedPresetId;
                const color = presetColor(preset.color);
                return (
                  <button
                    key={preset.id}
                    className={`mb-1 flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border px-2 text-left transition last:mb-0 ${
                      selected
                        ? "border-lavender bg-lavender/20 text-ink shadow-sm"
                        : "border-transparent bg-white text-graphite hover:border-mist hover:bg-porcelain/70"
                    }`}
                    onClick={() => onSelect(preset.id)}
                    type="button"
                  >
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/10"
                      style={{ backgroundColor: color }}
                    />
                    <span className="min-w-0 truncate text-xs font-semibold text-ink">{preset.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
      {selectedPreset ? (
        <div className="border-t border-mist bg-porcelain/45 px-3 py-2 text-[11px] font-semibold text-graphite">
          Selected: <span className="text-ink">{selectedPreset.name}</span>
        </div>
      ) : null}
    </section>
  );
}

function presetColor(value?: string | null) {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value ?? "#c9a7ff" : "#c9a7ff";
}

// --- Real transfer-speed chart -------------------------------------------------
type SpeedSample = { tMs: number; bytesDone: number };
type SpeedPoint = { t: number; bps: number };

const SAMPLE_INTERVAL_MS = 220; // how often we sample refs into render state
const SPEED_WINDOW_MS = 1000; // window for the instantaneous-speed calculation
const SPEED_BUFFER_WINDOW_MS = 5000; // raw-sample retention (covers the speed window)
const CHART_WINDOW_MS = 60000; // visible X span; the line scrolls within this
const VERIFIED_FEED_CAP = 200; // most recent file-verified rows kept in the live feed

// A live-feed row: the FileVerified payload plus a stable monotonic id for React keys, so
// prepending a batch of newest events doesn't force every existing row to reconcile.
type VerifiedFeedEntry = { id: number; data: FileVerified };

// Instantaneous throughput = Δbytes / Δtime over the last `windowMs`. Returns a real
// 0 during verify-phase stalls (bytes_done frozen) or before two samples exist.
function windowedSpeed(buffer: SpeedSample[], windowMs: number): number {
  if (buffer.length < 2) {
    return 0;
  }
  const newest = buffer[buffer.length - 1];
  let i = buffer.length - 1;
  while (i > 0 && newest.tMs - buffer[i - 1].tMs <= windowMs) {
    i -= 1;
  }
  const oldest = buffer[i];
  const dt = newest.tMs - oldest.tMs;
  const db = newest.bytesDone - oldest.bytesDone;
  if (dt <= 0 || db <= 0) {
    return 0;
  }
  return (db / dt) * 1000;
}

function SpeedChart({ series }: { series: SpeedPoint[] }) {
  const PAD_L = 40;
  const PAD_R = 760;
  const PAD_T = 28;
  const PAD_B = 292;
  const visible = series.length > 0 ? series : [];
  const tNewest = visible.length > 0 ? visible[visible.length - 1].t : 0;
  const xWindow0 = tNewest - CHART_WINDOW_MS;
  const maxBps = visible.reduce((max, point) => Math.max(max, point.bps), 0);
  const yMax = Math.max(maxBps * 1.15, 1);

  const x = (t: number) => {
    const fraction = Math.max(0, Math.min(1, (t - xWindow0) / CHART_WINDOW_MS));
    return PAD_L + fraction * (PAD_R - PAD_L);
  };
  const y = (bps: number) => PAD_B - (bps / yMax) * (PAD_B - PAD_T);

  const points = visible.map((point) => `${x(point.t).toFixed(1)} ${y(point.bps).toFixed(1)}`);
  const linePath = points.length >= 2 ? `M${points.join(" L")}` : "";
  const areaPath =
    points.length >= 2
      ? `${linePath} L${x(tNewest).toFixed(1)} ${PAD_B} L${PAD_L} ${PAD_B} Z`
      : "";
  const midY = PAD_B - 0.5 * (PAD_B - PAD_T);

  return (
    <svg className="h-full w-full" viewBox="0 0 800 320" role="img" aria-label="Transfer speed over time">
      <defs>
        <linearGradient id="transferFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-area-top)" />
          <stop offset="100%" stopColor="var(--chart-area-bottom)" />
        </linearGradient>
      </defs>
      {/* baseline + mid gridline */}
      <line x1={PAD_L} x2={PAD_R} y1={PAD_B} y2={PAD_B} stroke="var(--chart-grid)" strokeWidth="1" />
      <line x1={PAD_L} x2={PAD_R} y1={midY} y2={midY} stroke="var(--chart-grid-faint)" strokeWidth="1" strokeDasharray="4 6" />
      {areaPath ? <path d={areaPath} fill="url(#transferFill)" /> : null}
      {linePath ? (
        <path d={linePath} fill="none" stroke="var(--chart-line)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
      ) : null}
      {/* axis labels */}
      <text x={PAD_L} y={PAD_T - 10} fontSize="13" fontWeight="600" fill="var(--chart-axis)">
        {formatBytes(yMax)}/s
      </text>
      <text x={PAD_R} y={PAD_T - 10} fontSize="12" fontWeight="600" fill="var(--chart-axis-faint)" textAnchor="end">
        last 60s
      </text>
    </svg>
  );
}

function ParameterField({
  onChange,
  suggestions,
  value,
  variable,
}: {
  onChange: (value: string) => void;
  suggestions?: string[];
  value: string;
  variable: PresetVariable;
}) {
  return (
    <label className="grid min-h-12 grid-cols-[180px_1fr] items-center gap-3 px-3 py-2">
      <span className="min-w-0">
        <span className="flex items-center gap-1 truncate text-sm font-semibold text-ink">
          <span className="min-w-0 truncate">{variable.name}</span>
          <FloatingHelp label={`${variable.name} help`} size={12}>
            {helpForVariable(variable)}
          </FloatingHelp>
        </span>
        <code className="text-xs text-graphite">{`{${variable.id}}`}</code>
      </span>
      {variable.type === "dropdown" && variable.options.length > 0 ? (
        <MultiSelectParameter onChange={onChange} options={variable.options} value={value} />
      ) : variable.type === "boolean" ? (
        <SelectMenu
          onChange={onChange}
          options={[
            { label: "True", value: "true" },
            { label: "False", value: "false" },
          ]}
          value={value || "false"}
        />
      ) : (
        <AutocompleteInput
          onChange={onChange}
          suggestions={variable.type === "date" ? [] : suggestions ?? []}
          type={variable.type === "date" ? "date" : "text"}
          value={value}
        />
      )}
    </label>
  );
}

// Free-text variable input with a styled suggestion dropdown (matches SelectMenu's
// menu look) drawn from previously-used values.
function AutocompleteInput({
  onChange,
  suggestions,
  type,
  value,
}: {
  onChange: (value: string) => void;
  suggestions: string[];
  type: "text" | "date";
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase();
    return suggestions
      .filter((item) => item.toLowerCase() !== query && (!query || item.toLowerCase().includes(query)))
      .slice(0, 8);
  }, [suggestions, value]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const showMenu = open && type === "text" && filtered.length > 0;

  return (
    <div ref={containerRef} className="relative min-w-0">
      <input
        className="h-9 w-full min-w-0 rounded-xl border border-mist bg-white px-3 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        type={type}
        value={value}
      />
      {showMenu ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-mist bg-white p-1 shadow-panel">
          <div className="max-h-56 overflow-auto">
            {filtered.map((item) => (
              <button
                key={item}
                className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm text-graphite transition hover:bg-porcelain"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(item);
                  setOpen(false);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate font-semibold">{item}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function helpForVariable(variable: PresetVariable) {
  if (variable.type === "dropdown") {
    return variable.options.length > 0
      ? `Choose one or more ${variable.name} values. If the preset uses this token inside a target folder, selected files route into that resolved folder.`
      : `This list variable has no saved options yet. Add options in the preset editor or global variables.`;
  }
  if (variable.type === "date") {
    return `This date replaces the {${variable.id}} token in project, folder, or file naming patterns.`;
  }
  if (variable.type === "boolean") {
    return `This true/false value can turn conditional preset folders on or off.`;
  }
  return `This value replaces the {${variable.id}} token anywhere the preset uses it.`;
}

function MultiSelectParameter({
  onChange,
  options,
  value,
}: {
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedValues = useMemo(() => parseSelectedValues(value), [value]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  function toggleOption(option: string) {
    const nextValues = selectedValues.includes(option)
      ? selectedValues.filter((value) => value !== option)
      : [...selectedValues, option];
    onChange(nextValues.join(", "));
  }

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-mist bg-white px-3 text-left text-sm outline-none transition hover:bg-porcelain focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span className={`min-w-0 flex-1 truncate ${selectedValues.length ? "font-semibold text-ink" : "text-graphite"}`}>
          {selectedValues.length ? selectedValues.join(", ") : "Choose..."}
        </span>
        <ChevronDown className="shrink-0 text-graphite" size={15} />
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-10 z-50 w-full min-w-52 overflow-hidden rounded-xl border border-mist bg-white p-1 shadow-panel">
          {options.map((option) => {
            const checked = selectedValues.includes(option);
            return (
              <button
                key={option}
                className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition ${
                  checked ? "bg-lavender/25 text-ink" : "text-graphite hover:bg-porcelain"
                }`}
                onClick={() => toggleOption(option)}
                type="button"
              >
                <span className={`flex h-4 w-4 items-center justify-center rounded border ${
                  checked ? "border-signal bg-signal text-primaryfg" : "border-mist bg-white"
                }`}>
                  {checked ? <Check size={11} strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate font-semibold">{option}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const FILE_KIND_FILTERS: { kind: ScanFileKind; label: string }[] = [
  { kind: "footage", label: "Footage" },
  { kind: "photo", label: "Photos" },
  { kind: "audio", label: "Audio" },
  { kind: "document", label: "Docs" },
];

// A clickable column header for the file list — file-explorer style: click to sort
// by that column, click again to flip direction; the active column shows an arrow.
function SortHeaderButton({
  label,
  active,
  direction,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  direction: FilePickerSortDirection;
  onClick: () => void;
  align?: "right";
}) {
  return (
    <button
      className={`inline-flex items-center gap-1 ${align === "right" ? "justify-self-end" : ""} ${
        active ? "text-ink" : "text-graphite hover:text-ink"
      }`}
      onClick={onClick}
      type="button"
    >
      {label}
      {active ? direction === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : null}
    </button>
  );
}

// A tile's preview: still being generated, or resolved to a URL (null = nothing extractable).
type SourceThumbnailState = "pending" | { url: string | null };

// ".arw" → "ARW". Shown on a tile whose format has no extractable preview, so the tile still
// says something useful about the file instead of just "No thumbnail".
function extLabel(extension: string): string {
  return extension.replace(/^\./, "").toUpperCase();
}

// How long we let requests accumulate before firing one batch. Long enough that a fast scroll
// through fifty tiles is one IPC round trip rather than fifty; short enough to feel immediate.
const THUMBNAIL_BATCH_MS = 120;

// Lazily generate source previews for tiles as they scroll into view.
//
// Generation is genuinely expensive — an ARW embedded-preview extract, or an ffmpeg poster
// seek, per file — so nothing is requested until a tile is actually visible, and each path is
// requested at most once. This is deliberately NOT done during `scan_source`: a full card would
// mean thousands of extractions before the user sees a single row.
function useSourceThumbnails() {
  const [thumbnails, setThumbnails] = useState<Map<string, SourceThumbnailState>>(new Map());
  // Paths already requested — the dedup gate. A ref, not state: it must be updated
  // synchronously, since several tiles can intersect within one render.
  const requestedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<Map<string, string | null>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against setState after the dialog closes mid-batch.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const flush = useCallback(() => {
    timerRef.current = null;
    const batch = Array.from(queueRef.current, ([path, preview_path]) => ({ path, preview_path }));
    queueRef.current.clear();
    if (batch.length === 0) {
      return;
    }
    generateSourceThumbnails(batch)
      .then((results) => {
        if (!mountedRef.current) {
          return;
        }
        setThumbnails((current) => {
          const next = new Map(current);
          for (const result of results) {
            // The returned path is inside the app's thumbnail cache — the only directory the
            // asset protocol is scoped to. Card paths would be refused by the scope.
            next.set(result.key, {
              url: result.thumbnail_path ? convertFileSrc(result.thumbnail_path) : null,
            });
          }
          return next;
        });
      })
      .catch(() => {
        // A failed batch must not strand its tiles as permanently "pending" spinners. Drop
        // them from the dedup set and from the map, which puts each tile back to its labelled
        // placeholder and lets the still-subscribed observer re-request it on the next scroll.
        // (This only works because the observer is NOT one-shot — see ThumbnailFileCard.)
        // A thumbnail failure is never worth surfacing as an error.
        for (const item of batch) {
          requestedRef.current.delete(item.path);
        }
        if (!mountedRef.current) {
          return;
        }
        setThumbnails((current) => {
          const next = new Map(current);
          for (const item of batch) {
            next.delete(item.path);
          }
          return next;
        });
      });
  }, []);

  const request = useCallback(
    (path: string, previewPath: string | null) => {
      if (requestedRef.current.has(path)) {
        return;
      }
      requestedRef.current.add(path);
      queueRef.current.set(path, previewPath);
      setThumbnails((current) => new Map(current).set(path, "pending"));
      if (timerRef.current === null) {
        timerRef.current = setTimeout(flush, THUMBNAIL_BATCH_MS);
      }
    },
    [flush],
  );

  return { thumbnails, request };
}

function FileSelectionDialog({
  availableCount,
  deleteSidecars,
  files,
  onClose,
  onSelectNone,
  selectedBytes,
  selectedCount,
  selectedRelativePaths,
  setSelectedRelativePaths,
  ui,
  onUiChange,
}: {
  availableCount: number;
  deleteSidecars: boolean;
  files: ManifestFile[];
  onClose: () => void;
  onSelectNone: () => void;
  selectedBytes: number;
  selectedCount: number;
  selectedRelativePaths: Set<string>;
  setSelectedRelativePaths: Dispatch<SetStateAction<Set<string>>>;
  ui: FilePickerUiState;
  onUiChange: Dispatch<SetStateAction<FilePickerUiState>>;
}) {
  const { viewMode, thumbnailSize, sortMode, sortDirection, search, kindFilter, groupByDate } = ui;
  const patchUi = useCallback(
    (patch: Partial<FilePickerUiState>) => onUiChange((current) => ({ ...current, ...patch })),
    [onUiChange],
  );
  // The click anchor for shift-range selection. Transient (resets each open) — it is not
  // part of the selection itself, which lives entirely in `selectedRelativePaths`.
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  // Source previews, generated lazily for visible tiles only (thumbs view never mounts a
  // ThumbnailFileCard in list view, so list view costs nothing).
  const { thumbnails, request: requestThumbnail } = useSourceThumbnails();
  // The tiles' IntersectionObserver must use THIS element as its root, not the viewport: the
  // tiles are clipped by this container long before they leave the viewport, so a viewport-
  // rooted observer sees zero intersection and `rootMargin` (which only expands the root rect)
  // does nothing. Callback ref rather than useRef so the cards re-render once it's attached.
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  // Collapse spanned camera clips (RED .RDC → one row) before filtering/sorting.
  const displayFiles = useMemo(() => collapseClips(files), [files]);
  const memberKeyMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const file of displayFiles) {
      map.set(file.sourceKey, memberKeysOf(file));
    }
    return map;
  }, [displayFiles]);
  // Per-kind selectable counts, for the filter-chip badges. Sidecars never appear as a
  // chip (they ride along with their parent), so they're excluded from the tally.
  const kindCounts = useMemo(() => {
    const counts = new Map<ScanFileKind, number>();
    for (const file of displayFiles) {
      if (file.kind === "sidecar") {
        continue;
      }
      counts.set(file.kind, (counts.get(file.kind) ?? 0) + 1);
    }
    return counts;
  }, [displayFiles]);
  const filteredFiles = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return displayFiles.filter((file) => {
      // Search matches BOTH the filename and its relative path, so a folder/card name
      // narrows the grid just as well as a filename does.
      if (needle && !file.file_name.toLowerCase().includes(needle) && !file.relative_path.toLowerCase().includes(needle)) {
        return false;
      }
      // Sidecars ride along with their parent media, so the kind filter ignores them.
      if (kindFilter.size > 0 && file.kind !== "sidecar" && !kindFilter.has(file.kind)) {
        return false;
      }
      return true;
    });
  }, [displayFiles, kindFilter, search]);
  const sourceGroups = useMemo(
    () => groupManifestFiles(filteredFiles, sortMode, sortDirection, groupByDate),
    [filteredFiles, groupByDate, sortDirection, sortMode],
  );
  const selectableFileKeys = useMemo(() => flattenSelectableFileKeys(sourceGroups), [sourceGroups]);
  const filteredOut = displayFiles.length - filteredFiles.length;

  const isSelected = useCallback(
    (file: ManifestFile) => file.autoSelected || memberKeysOf(file).every((key) => selectedRelativePaths.has(key)),
    [selectedRelativePaths],
  );

  // The top-level Select-all / tri-state pill is scoped to the currently VISIBLE (filtered +
  // sorted) files — same as every other select control here — so it never reaches past the
  // filters to select hidden files. Selections of hidden files are left untouched.
  const visibleSelectableFiles = useMemo(() => filteredFiles.filter((file) => !file.disabled), [filteredFiles]);
  const visibleMemberKeys = useMemo(() => visibleSelectableFiles.flatMap(memberKeysOf), [visibleSelectableFiles]);
  const visibleSelectedCount = visibleSelectableFiles.filter(isSelected).length;
  const allVisibleSelected = visibleSelectableFiles.length > 0 && visibleSelectedCount === visibleSelectableFiles.length;
  const someVisibleSelected = visibleSelectedCount > 0;

  function handleSort(mode: FilePickerSortMode) {
    if (mode === sortMode) {
      patchUi({ sortDirection: sortDirection === "asc" ? "desc" : "asc" });
    } else {
      // Sensible default direction per column: newest/largest first, names A→Z.
      patchUi({ sortMode: mode, sortDirection: mode === "date" || mode === "size" ? "desc" : "asc" });
    }
  }

  function toggleKindFilter(kind: ScanFileKind) {
    const next = new Set(kindFilter);
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    patchUi({ kindFilter: next });
  }

  // ONE selection model: clicking a row/tile toggles that file's selection (a visible
  // check + ring). Shift-click selects the contiguous range from the last click. Sidecars
  // are `disabled` — they ride along with their parent and can't be toggled here.
  function handleFileClick(file: ManifestFile, shiftKey: boolean) {
    if (file.disabled) {
      return;
    }

    if (shiftKey && anchorKey) {
      const startIndex = selectableFileKeys.indexOf(anchorKey);
      const endIndex = selectableFileKeys.indexOf(file.sourceKey);
      if (startIndex >= 0 && endIndex >= 0) {
        const [start, end] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
        const rangeKeys = selectableFileKeys.slice(start, end + 1).flatMap((key) => memberKeyMap.get(key) ?? [key]);
        selectFileKeys(rangeKeys, true, setSelectedRelativePaths);
        setAnchorKey(file.sourceKey);
        return;
      }
    }

    const nextSelected = !isSelected(file);
    selectFileKeys(memberKeysOf(file), nextSelected, setSelectedRelativePaths);
    setAnchorKey(file.sourceKey);
  }

  const hasFilters = kindFilter.size > 0 || search.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <section className="relative flex max-h-[88vh] w-full max-w-7xl select-none flex-col overflow-hidden rounded-[24px] border border-mist bg-paper shadow-panel">
        {/* Header: title + live selection summary, plus the view / density controls. */}
        <div className="flex items-center justify-between gap-3 border-b border-mist px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Choose Files</h2>
            <p className="truncate text-xs font-medium text-graphite">
              {availableCount} files available / {formatBytes(selectedBytes)} selected
              {deleteSidecars ? " / sidecars deleted" : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {viewMode === "thumbs" ? (
              <>
                <div className="w-32">
                  <SelectMenu
                    onChange={(value) => patchUi({ sortMode: value as FilePickerSortMode })}
                    options={[
                      { label: "Date", value: "date" },
                      { label: "Name", value: "name" },
                      { label: "Type", value: "type" },
                      { label: "Size", value: "size" },
                    ]}
                    size="sm"
                    value={sortMode}
                  />
                </div>
                <button
                  className="h-8 rounded-lg border border-mist bg-card px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => patchUi({ sortDirection: sortDirection === "asc" ? "desc" : "asc" })}
                  type="button"
                >
                  {sortDirectionLabel(sortMode, sortDirection)}
                </button>
                <label className="flex h-8 items-center gap-2 rounded-lg border border-mist bg-card px-2 text-xs font-semibold text-graphite">
                  Size
                  <input
                    className="w-24 accent-signal"
                    max={260}
                    min={80}
                    onChange={(event) => patchUi({ thumbnailSize: Number(event.target.value) })}
                    step={4}
                    type="range"
                    value={thumbnailSize}
                  />
                </label>
              </>
            ) : null}
            <div className="flex overflow-hidden rounded-lg border border-mist bg-card">
              <button
                className={`inline-flex h-8 items-center gap-1 px-2 text-xs font-semibold transition ${
                  viewMode === "list" ? "bg-signal text-primaryfg" : "text-graphite hover:bg-porcelain"
                }`}
                onClick={() => patchUi({ viewMode: "list" })}
                type="button"
              >
                <List size={14} />
                List
              </button>
              <button
                className={`inline-flex h-8 items-center gap-1 border-l border-mist px-2 text-xs font-semibold transition ${
                  viewMode === "thumbs" ? "bg-signal text-primaryfg" : "text-graphite hover:bg-porcelain"
                }`}
                onClick={() => patchUi({ viewMode: "thumbs" })}
                type="button"
              >
                <Image size={14} />
                Thumbnails
              </button>
            </div>
            <button
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-mist bg-card text-graphite transition hover:bg-porcelain"
              onClick={onClose}
              title="Close"
              type="button"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Filter chip row: select-all, search (name AND path), kind chips w/ counts, grouping. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-mist bg-porcelain/40 px-4 py-2">
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition disabled:opacity-40 ${
              allVisibleSelected ? "border-signal bg-signal text-primaryfg" : "border-mist bg-card text-graphite hover:bg-porcelain"
            }`}
            disabled={visibleSelectableFiles.length === 0}
            onClick={() => selectFileKeys(visibleMemberKeys, !allVisibleSelected, setSelectedRelativePaths)}
            type="button"
          >
            <span
              className={`flex h-4 w-4 items-center justify-center rounded border ${
                allVisibleSelected ? "border-primaryfg" : someVisibleSelected ? "border-signal bg-signal/20" : "border-graphite/50"
              }`}
            >
              {allVisibleSelected ? <Check size={11} strokeWidth={3} /> : someVisibleSelected ? <span className="h-0.5 w-2 rounded bg-signal" /> : null}
            </span>
            {allVisibleSelected ? "Select none" : "Select all"}
          </button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-graphite/60" size={13} />
            <input
              className="h-8 w-56 rounded-lg border border-mist bg-card pl-7 pr-2 text-xs text-ink outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
              onChange={(event) => patchUi({ search: event.target.value })}
              placeholder="Search name or path…"
              value={search}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {FILE_KIND_FILTERS.map(({ kind, label }) => {
              const count = kindCounts.get(kind) ?? 0;
              const active = kindFilter.has(kind);
              return (
                <button
                  key={kind}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-semibold transition disabled:opacity-40 ${
                    active ? "border-signal bg-signal text-primaryfg" : "border-mist bg-card text-graphite hover:bg-porcelain"
                  }`}
                  disabled={count === 0}
                  onClick={() => toggleKindFilter(kind)}
                  type="button"
                >
                  {label}
                  <span
                    className={`rounded px-1 text-[10px] font-semibold ${
                      active ? "bg-primaryfg/20 text-primaryfg" : "bg-porcelain text-graphite"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-semibold transition ${
              groupByDate ? "border-signal bg-signal text-primaryfg" : "border-mist bg-card text-graphite hover:bg-porcelain"
            }`}
            onClick={() => patchUi({ groupByDate: !groupByDate })}
            title="Group files into Today / Yesterday / date sections"
            type="button"
          >
            <Clock size={13} />
            Group by day
          </button>
          {hasFilters ? (
            <button
              className="h-8 rounded-lg px-2 text-xs font-semibold text-graphite underline-offset-2 hover:underline"
              onClick={() => patchUi({ search: "", kindFilter: new Set() })}
              type="button"
            >
              Clear filters
            </button>
          ) : null}
          {filteredOut > 0 ? (
            <span className="text-[11px] font-medium text-graphite/70">{filteredOut} hidden by filters</span>
          ) : null}
        </div>

        {viewMode === "list" ? (
          <div className="grid grid-cols-[26px_82px_1fr_128px_96px] items-center gap-2 border-b border-mist bg-card px-4 py-1.5 text-[11px] font-semibold">
            <span />
            <SortHeaderButton active={sortMode === "type"} direction={sortDirection} label="Type" onClick={() => handleSort("type")} />
            <SortHeaderButton active={sortMode === "name"} direction={sortDirection} label="Name" onClick={() => handleSort("name")} />
            <SortHeaderButton active={sortMode === "date"} direction={sortDirection} label="Date" onClick={() => handleSort("date")} />
            <SortHeaderButton active={sortMode === "size"} align="right" direction={sortDirection} label="Size" onClick={() => handleSort("size")} />
          </div>
        ) : null}

        {/* Scroll container — MUST stay the IntersectionObserver root for lazy thumbnails. */}
        <div className="min-h-0 flex-1 overflow-auto bg-paper pb-16" ref={setScrollRoot}>
          {sourceGroups.map((sourceGroup) => (
            <section key={sourceGroup.sourcePath} className="border-b border-mist last:border-b-0">
              <div className="sticky top-0 z-10 grid min-h-9 grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-mist bg-porcelain px-4 py-1">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-ink">{sourceGroup.sourceLabel}</h3>
                  <p className="truncate text-[11px] font-medium text-graphite">{sourceGroup.sourcePath}</p>
                </div>
                <span className="text-xs font-semibold text-graphite">{sourceGroup.fileCount} files / {formatBytes(sourceGroup.sizeBytes)}</span>
                <button
                  className="rounded-lg border border-mist bg-card px-2 py-1 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => selectFileKeys(sourceGroup.selectableKeys, true, setSelectedRelativePaths)}
                  type="button"
                >
                  Select source
                </button>
              </div>

              {sourceGroup.days.map((dayGroup) => (
                <div key={`${sourceGroup.sourcePath}-${dayGroup.dayKey}`} className="border-b border-mist/70 last:border-b-0">
                  <div className="grid min-h-8 grid-cols-[1fr_auto_auto] items-center gap-2 bg-paper px-4 py-1">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-ink">{dayGroup.label}</div>
                      <div className="text-[11px] font-medium text-graphite">{dayGroup.fileCount} files / {formatBytes(dayGroup.sizeBytes)}</div>
                    </div>
                    <button
                      className="rounded-lg border border-mist bg-card px-2 py-1 text-[11px] font-semibold text-graphite transition hover:bg-porcelain"
                      onClick={() => selectFileKeys(dayGroup.files.flatMap(memberKeysOf), true, setSelectedRelativePaths)}
                      type="button"
                    >
                      Check all
                    </button>
                    <button
                      className="rounded-lg border border-mist bg-card px-2 py-1 text-[11px] font-semibold text-graphite transition hover:bg-porcelain"
                      onClick={() => selectFileKeys(dayGroup.files.flatMap(memberKeysOf), false, setSelectedRelativePaths)}
                      type="button"
                    >
                      Uncheck all
                    </button>
                  </div>

                  {viewMode === "list" ? (
                    dayGroup.files.map((file) => (
                      <FileListRow
                        key={file.sourceKey}
                        file={file}
                        selected={isSelected(file)}
                        onToggle={handleFileClick}
                      />
                    ))
                  ) : (
                    <div
                      className="grid gap-2 border-t border-mist/70 bg-porcelain/25 p-2"
                      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))` }}
                    >
                      {dayGroup.files.map((file) => (
                        <ThumbnailFileCard
                          key={file.sourceKey}
                          file={file}
                          selected={isSelected(file)}
                          onToggle={handleFileClick}
                          onRequestThumbnail={requestThumbnail}
                          scrollRoot={scrollRoot}
                          size={thumbnailSize}
                          thumbnail={thumbnails.get(file.path)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
          {displayFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-graphite">
              <FolderOpen size={28} className="text-graphite/50" />
              No copyable files found in this scan.
            </div>
          ) : sourceGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-graphite">
              <Search size={28} className="text-graphite/50" />
              <span>No files match your filters.</span>
              <button
                className="rounded-lg border border-mist bg-card px-3 py-1 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                onClick={() => patchUi({ search: "", kindFilter: new Set() })}
                type="button"
              >
                Clear filters
              </button>
            </div>
          ) : null}
        </div>

        {/* Floating action bar — a clear commit affordance instead of just closing. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-4">
          <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-mist bg-card/95 px-4 py-2.5 shadow-panel backdrop-blur">
            {selectedCount > 0 ? (
              <>
                <span className="text-sm font-semibold text-ink">{selectedCount} selected</span>
                <span className="text-xs font-medium text-graphite">{formatBytes(selectedBytes)}</span>
                <button
                  className="rounded-lg border border-mist bg-card px-3 py-1.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={onSelectNone}
                  type="button"
                >
                  Clear
                </button>
                <button
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-signal px-4 text-sm font-semibold text-primaryfg transition hover:opacity-90"
                  onClick={onClose}
                  type="button"
                >
                  <Check size={15} strokeWidth={3} />
                  Add to ingest
                </button>
              </>
            ) : (
              <>
                <span className="text-sm font-medium text-graphite">No files selected</span>
                <button
                  className="inline-flex h-9 items-center justify-center rounded-xl border border-mist bg-card px-4 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={onClose}
                  type="button"
                >
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function FileListRow({
  file,
  selected,
  onToggle,
}: {
  file: ManifestFile;
  selected: boolean;
  onToggle: (file: ManifestFile, shiftKey: boolean) => void;
}) {
  // Clicking anywhere on the row toggles selection (the ONE selection model). Selected
  // rows get a filled mark + a lavender inset ring so the state is unmistakable.
  return (
    <div
      className={`grid min-h-9 grid-cols-[26px_82px_1fr_128px_96px] items-center gap-2 border-t border-mist/70 px-4 py-1 text-sm ${
        file.disabled
          ? "cursor-default bg-porcelain/35 text-graphite"
          : selected
            ? "cursor-pointer bg-lavender/20 text-ink ring-1 ring-inset ring-lavender/60"
            : "cursor-pointer text-ink hover:bg-porcelain/45"
      }`}
      onClick={(event) => onToggle(file, event.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onToggle(file, event.shiftKey);
        }
      }}
      onMouseDown={(event) => {
        if (event.shiftKey) {
          event.preventDefault();
        }
      }}
      role="button"
      tabIndex={file.disabled ? -1 : 0}
    >
      <SelectionMark checked={selected} disabled={file.disabled} onChange={() => onToggle(file, false)} />
      <span className="text-xs font-semibold text-graphite">{file.label}</span>
      <span className="min-w-0 truncate font-semibold" title={file.relative_path}>{file.file_name}</span>
      <span className="text-xs font-semibold text-graphite">{formatFileTimestamp(file.modified_at)}</span>
      <span className="text-right text-xs font-semibold text-graphite">{formatBytes(file.size_bytes)}</span>
    </div>
  );
}

function ThumbnailFileCard({
  file,
  selected,
  onToggle,
  onRequestThumbnail,
  scrollRoot,
  size,
  thumbnail,
}: {
  file: ManifestFile;
  selected: boolean;
  onToggle: (file: ManifestFile, shiftKey: boolean) => void;
  onRequestThumbnail: (path: string, previewPath: string | null) => void;
  scrollRoot: HTMLElement | null;
  size: number;
  thumbnail: SourceThumbnailState | undefined;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Ask for this tile's preview as it approaches the scroll viewport, and only then.
  //
  // NOTE: we do NOT render `file.thumbnail_path` directly, even when the scan supplied one.
  // That path points at the card, which the asset protocol deliberately refuses to serve —
  // it is a hint about where the pixels live, which the backend re-encodes into its cache.
  // Passing it here is what lets the backend skip the extractor ladder for that file.
  useEffect(() => {
    const node = cardRef.current;
    // Wait for the scroll container: rooting on the viewport instead would silently never
    // fire, because this tile's ancestors clip it out of the viewport's intersection rect.
    if (!node || !scrollRoot) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onRequestThumbnail(file.path, file.thumbnail_path ?? null);
        }
      },
      // Deliberately NOT disconnected on first fire. `onRequestThumbnail` dedups, so repeat
      // calls for a resolved tile are free — but a tile whose batch FAILED is dropped from
      // the dedup set, and staying subscribed is what lets the next scroll retry it. A
      // one-shot observer made those tiles permanently dead.
      { root: scrollRoot, rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [file.path, file.thumbnail_path, onRequestThumbnail, scrollRoot]);

  const pending = thumbnail === "pending";
  const thumbnailUrl = thumbnail && thumbnail !== "pending" ? thumbnail.url : null;
  const isVideo = file.kind === "footage";
  return (
    <div
      className={`group relative overflow-hidden rounded-lg border bg-card text-left shadow-sm transition ${
        selected ? "border-lavender ring-2 ring-lavender/60" : "border-mist hover:border-graphite/40"
      } ${file.disabled ? "opacity-70 cursor-default" : "cursor-pointer"}`}
      ref={cardRef}
      onClick={(event) => onToggle(file, event.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onToggle(file, event.shiftKey);
        }
      }}
      onMouseDown={(event) => {
        if (event.shiftKey) {
          event.preventDefault();
        }
      }}
      role="button"
      tabIndex={file.disabled ? -1 : 0}
    >
      <div
        className="relative flex items-center justify-center bg-porcelain"
        style={{ height: Math.round(size * 0.62) }}
      >
        {thumbnailUrl ? (
          <img
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            src={thumbnailUrl}
          />
        ) : (
          // "Loading…" while a preview is genuinely in flight, otherwise always a real label.
          // Every non-pending state — not yet requested, nothing extractable, or a batch that
          // failed outright — lands on the extension, which tells the user more than the old
          // blanket "No thumbnail" did. Never an empty string: a bare unlabelled icon was the
          // failure mode when a rejected batch dropped the tile out of the map entirely.
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-graphite">
            <Image
              className={pending ? "animate-pulse" : undefined}
              size={Math.max(18, Math.round(size * 0.18))}
            />
            <span className="text-[10px] font-semibold">
              {pending ? "Loading…" : extLabel(file.extension) || "No thumbnail"}
            </span>
          </div>
        )}
        {/* Footage marker in the corner (a duration badge would go here — see note: scan
            data carries no per-file duration, so we surface the video kind instead). */}
        {isVideo ? (
          <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded bg-ink/70 px-1.5 py-0.5 text-[10px] font-semibold text-primaryfg">
            <Film size={10} />
            {file.clipSegmentCount ? `${file.clipSegmentCount} clips` : extLabel(file.extension)}
          </span>
        ) : null}
        {/* Corner checkbox: always visible when selected, appears on hover otherwise. */}
        <span
          className={`absolute left-1.5 top-1.5 rounded-md bg-card/90 p-1 shadow-sm transition-opacity ${
            selected || file.disabled ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          }`}
        >
          <SelectionMark checked={selected} disabled={file.disabled} onChange={() => onToggle(file, false)} />
        </span>
      </div>
      <div className="space-y-0.5 p-1.5">
        <div className="truncate text-xs font-semibold text-ink" title={file.relative_path}>
          {file.file_name}
        </div>
        <div className="truncate text-[11px] font-medium text-graphite">{formatFileTimestamp(file.modified_at)}</div>
        <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-graphite">
          <span>{file.label}</span>
          <span>{formatBytes(file.size_bytes)}</span>
        </div>
      </div>
    </div>
  );
}

function SelectionMark({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (disabled) {
    // A sidecar rides along with its parent media and can't be toggled here — show a
    // filled, dimmed mark (distinct from an interactive checkbox) to signal that.
    return (
      <span
        className="flex h-4 w-4 items-center justify-center rounded border border-signal/60 bg-signal/60 text-primaryfg"
        title="Included automatically with its parent file"
      >
        <Check size={11} strokeWidth={3} />
      </span>
    );
  }

  return (
    <input
      checked={checked}
      className="h-4 w-4 accent-signal"
      onChange={(event) => onChange(event.target.checked)}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      type="checkbox"
    />
  );
}

function SummaryTile({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "bad";
  sub?: string;
}) {
  const valueClass =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "bad"
          ? "text-red-600 dark:text-red-400"
          : "text-ink";
  return (
    <div className="min-w-0 rounded-xl border border-mist bg-white px-3 py-2">
      <div className="text-xs font-semibold text-graphite">{label}</div>
      <div className={`mt-1 text-lg font-semibold leading-tight break-words ${valueClass}`}>{value}</div>
      {sub ? <div className="break-words text-[10px] font-medium text-graphite/70">{sub}</div> : null}
    </div>
  );
}

type CoverageRow = { key: string; count: number; bytes: number; durationMs: number };

function cameraForCopiedFile(file: CopiedFile): string {
  const name = file.source_path.split(/[\\/]/).pop() ?? "";
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  const prefix = cameraPrefixFromStem(stem);
  if (prefix) {
    return prefix;
  }
  const parts = file.source_path.split(/[\\/]/).filter(Boolean);
  return [...parts].reverse().slice(1).find((part) => !isGenericCameraFolder(part)) ?? "CAM";
}

function folderForCopiedFile(file: CopiedFile): string {
  const parts = file.destination_path.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "(root)";
}

function buildCoverage(files: CopiedFile[]) {
  const cameras = new Map<string, CoverageRow>();
  const folders = new Map<string, CoverageRow>();
  const bump = (map: Map<string, CoverageRow>, key: string, file: CopiedFile) => {
    const row = map.get(key) ?? { key, count: 0, bytes: 0, durationMs: 0 };
    row.count += 1;
    row.bytes += file.size_bytes;
    row.durationMs += file.duration_ms ?? 0;
    map.set(key, row);
  };
  for (const file of files) {
    if (file.kind === "sidecar") {
      continue;
    }
    bump(cameras, cameraForCopiedFile(file), file);
    bump(folders, folderForCopiedFile(file), file);
  }
  const sort = (map: Map<string, CoverageRow>) => [...map.values()].sort((a, b) => b.bytes - a.bytes);
  return { cameras: sort(cameras), folders: sort(folders) };
}

function CoverageCard({ files }: { files: CopiedFile[] }) {
  const { cameras, folders } = useMemo(() => buildCoverage(files), [files]);
  if (!files.length) {
    return null;
  }
  const totalDuration = files.reduce((sum, file) => sum + (file.duration_ms ?? 0), 0);
  return (
    <div className="border-b border-mist px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-graphite">Coverage</h3>
        {totalDuration > 0 ? (
          <span className="text-[11px] font-semibold text-graphite/70">{formatDuration(totalDuration)} total</span>
        ) : null}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <CoverageList rows={cameras} title="By camera" />
        <CoverageList rows={folders} title="By folder" />
      </div>
    </div>
  );
}

function CoverageList({ rows, title }: { rows: CoverageRow[]; title: string }) {
  return (
    <div className="rounded-xl border border-mist bg-white p-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-graphite/60">{title}</div>
      <div className="space-y-0.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-semibold text-ink">{row.key}</span>
            <span className="shrink-0 text-graphite">
              {row.count} · {formatBytes(row.bytes)}
              {row.durationMs > 0 ? ` · ${formatDuration(row.durationMs)}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Resolve a root-relative CopiedFile.thumbnail_path to a displayable asset URL. thumbnail_path
// is stored relative to its ingest root (report.rs renders it as a relative <img src>), so we
// re-join the root and hand it to Tauri's asset resolver — the same convertFileSrc pattern the
// file selector uses for source thumbnails.
function resolveThumbnailSrc(rootPath: string, thumbnailPath?: string | null): string | null {
  if (!thumbnailPath) {
    return null;
  }
  // Defensive: if the path is already absolute (Windows drive letter, UNC, or POSIX root),
  // hand it straight to the resolver instead of prefixing the ingest root.
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(thumbnailPath) || /^[\\/]/.test(thumbnailPath);
  if (isAbsolute) {
    return convertFileSrc(thumbnailPath.replace(/\\/g, "/"));
  }
  const rel = thumbnailPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || !rel) {
    return null;
  }
  return convertFileSrc(`${root}/${rel}`);
}

function extForFile(file: CopiedFile): string {
  const name = file.source_path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

// Thumbnail-forward delivery: a compact grid of clip stills (Phase B now generates previews
// for stills-RAW and cinema formats too) so a finished offload reads visually, not just as
// counts. Deduped to one tile per source clip.
function ClipThumbnailGrid({ files, rootPath }: { files: CopiedFile[]; rootPath: string }) {
  const clips = useMemo(() => {
    const seen = new Set<string>();
    const out: CopiedFile[] = [];
    for (const file of files) {
      if (file.kind === "sidecar" || !file.thumbnail_path) {
        continue;
      }
      if (seen.has(file.source_path)) {
        continue;
      }
      seen.add(file.source_path);
      out.push(file);
    }
    return out;
  }, [files]);
  if (clips.length === 0) {
    return null;
  }
  const CAP = 24;
  const shown = clips.slice(0, CAP);
  const extra = clips.length - shown.length;
  return (
    <div className="border-b border-mist px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-graphite">
          <Film size={13} className="text-graphite/60" />
          Clips
        </h3>
        <span className="text-[11px] font-semibold text-graphite/70">{clips.length} with previews</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {shown.map((file) => (
          <ClipThumbnail key={file.destination_path} file={file} rootPath={rootPath} />
        ))}
        {extra > 0 ? (
          <div className="flex aspect-video items-center justify-center rounded-md border border-mist bg-porcelain/50 text-[11px] font-semibold text-graphite">
            +{extra}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// One clip tile. Broken/absent previews fall back to a labeled placeholder so the grid never
// shows a broken-image glyph; a placeholder-kind or unverified clip is badged.
function ClipThumbnail({ file, rootPath }: { file: CopiedFile; rootPath: string }) {
  const [failed, setFailed] = useState(false);
  const src = resolveThumbnailSrc(rootPath, file.thumbnail_path);
  const name = pathDisplayName(file.destination_path);
  const isPlaceholder = file.thumbnail_kind === "placeholder";
  const duration = file.duration_ms ? formatDuration(file.duration_ms) : null;
  // `object-contain`, not cover: a portrait still must read upright and un-cropped
  // in the grid — cover would crop it back into a landscape slice.
  return (
    <div className="group relative aspect-video overflow-hidden rounded-md border border-mist bg-porcelain" title={name}>
      {src && !failed ? (
        <img alt="" className="h-full w-full object-contain" draggable={false} onError={() => setFailed(true)} src={src} />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 text-graphite/60">
          <Image size={16} />
          <span className="text-[9px] font-semibold uppercase">{extForFile(file)}</span>
        </div>
      )}
      {isPlaceholder && src && !failed ? (
        <span className="absolute left-1 top-1 rounded bg-black/55 px-1 py-0.5 text-[8px] font-semibold uppercase text-primaryfg">
          {extForFile(file)}
        </span>
      ) : null}
      {!file.verified ? (
        <span className="absolute right-1 top-1 rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primaryfg shadow-sm">
          Fail
        </span>
      ) : null}
      {duration ? (
        <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1 py-0.5 text-[8px] font-semibold tabular-nums text-primaryfg">
          {duration}
        </span>
      ) : null}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-2 text-[9px] font-semibold text-primaryfg opacity-0 transition group-hover:opacity-100">
        {name}
      </span>
    </div>
  );
}

function VerificationPanel({
  destinations,
  isRetrying,
  onRetry,
  result,
}: {
  destinations: string[];
  isRetrying: boolean;
  onRetry: () => void;
  result: IngestResult;
}) {
  const files = result.copied_files;
  if (!files.length) {
    return null;
  }
  const failedCount = files.filter((file) => !file.verified).length;
  const allOk = failedCount === 0;
  const norm = (path: string) => path.replace(/\\/g, "/");
  const perDestination = destinations.map((dest) => {
    const inDest = files.filter((file) => norm(file.destination_path).startsWith(norm(dest)));
    return { dest, total: inDest.length, verified: inDest.filter((file) => file.verified).length };
  });
  return (
    <div className="border-b border-mist px-3 py-2.5">
      <div
        className={`mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-semibold ${
          allOk ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"
        }`}
      >
        <span className="min-w-0 truncate">
          {allOk
            ? `All copies verified — bit-identical across ${destinations.length} destination${destinations.length === 1 ? "" : "s"}`
            : `${failedCount} file${failedCount === 1 ? "" : "s"} failed verification`}
        </span>
        {!allOk ? (
          <button
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-red-300 bg-white px-2 text-xs font-semibold text-red-800 transition hover:bg-red-100 disabled:opacity-60"
            disabled={isRetrying}
            onClick={onRetry}
            type="button"
          >
            {isRetrying ? "Retrying..." : `Retry failed (${failedCount})`}
          </button>
        ) : null}
      </div>
      {destinations.length > 1 ? (
        <div className="space-y-0.5">
          {perDestination.map((row) => (
            <div key={row.dest} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-semibold text-ink">{pathDisplayName(row.dest)}</span>
              <span
                className={`shrink-0 font-semibold ${row.verified === row.total ? "text-emerald-600" : "text-red-600"}`}
              >
                {row.verified}/{row.total} verified
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PathRow({
  label,
  meta,
  onClick,
  onRemove,
  path,
}: {
  label: string;
  meta?: string;
  onClick?: () => void;
  onRemove: () => void;
  path: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-1 rounded-lg border border-mist bg-white px-2 py-1">
      <button
        className="min-w-0 text-left"
        disabled={!onClick}
        onClick={onClick}
        title={path}
        type="button"
      >
        <span className="block truncate text-[11px] font-semibold text-ink">{label}</span>
        {meta ? <span className="block truncate text-[10px] font-medium text-graphite">{meta}</span> : null}
      </button>
      <button
        className="inline-flex h-5 w-5 items-center justify-center rounded-md text-graphite hover:bg-porcelain"
        onClick={onRemove}
        title="Remove"
        type="button"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function spaceSummary(space: DiskSpace | null | undefined) {
  if (typeof space === "undefined") {
    return "Checking space...";
  }
  if (space === null) {
    return "Could not read space";
  }
  return `${formatBytes(space.available_bytes)} free`;
}

function destinationSpaceSummary(
  path: string,
  space: DiskSpace | null | undefined,
  requiredBytes: number,
  etaMs?: number,
) {
  if (!path.trim()) {
    return "Choose destination";
  }
  if (typeof space === "undefined") {
    return "Checking space...";
  }
  if (space === null) {
    return "Could not read space";
  }
  if (requiredBytes <= 0) {
    return `${formatBytes(space.available_bytes)} available`;
  }
  const remaining = space.available_bytes - requiredBytes;
  if (remaining < 0) {
    return `⚠ ${formatBytes(Math.abs(remaining))} short — won't fit`;
  }
  const eta = etaMs && etaMs > 0 ? ` · ~${formatDuration(etaMs)}` : "";
  return `${formatBytes(remaining)} left after copy${eta}`;
}

function sourceSizeSummary(
  path: string,
  sourceScans: SourceScanEntry[],
  isScanning: boolean,
  space?: DiskSpace | null,
) {
  const entry = sourceScans.find((candidate) => candidate.sourcePath === path);
  if (entry) {
    return `${formatBytes(entry.scan.total_bytes)} scanned / ${entry.scan.ingest_files} usable files`;
  }
  if (isScanning) {
    return "Scanning...";
  }
  return spaceSummary(space);
}

function SectionTitle({ help, title }: { help: string; title: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
      <FloatingHelp label={`${title} help`}>{help}</FloatingHelp>
    </div>
  );
}

function FieldLabel({ children, help }: { children: string; help: string }) {
  return (
    <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-graphite">
      {children}
      <FloatingHelp label={`${children} help`} size={12}>
        {help}
      </FloatingHelp>
    </span>
  );
}

type IngestOutputPreview = {
  fileName: string;
  folderName: string;
  fullFolderPath: string;
  rootName: string;
  sampleLabel: string;
};

function OutputPreviewCard({ preview }: { preview: IngestOutputPreview | null }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-mist bg-white">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-mist px-3">
        <SectionTitle
          help="A sample of the project root, target folder, copied filename, and final path before the ingest starts."
          title="Output Preview"
        />
        {preview?.sampleLabel ? (
          <span className="min-w-0 truncate text-[11px] font-semibold text-graphite">{preview.sampleLabel}</span>
        ) : null}
      </div>
      <div className="p-3">
      {preview ? (
        <div className="space-y-2">
          <PreviewLine label="Project" value={preview.rootName} />
          <PreviewLine label="Folder" value={preview.folderName} />
          <PreviewLine label="File" value={preview.fileName} />
          {preview.fullFolderPath ? <PreviewLine label="Path" value={preview.fullFolderPath} /> : null}
        </div>
      ) : (
        <div className="text-xs font-medium text-graphite">Choose a preset to preview ingest output.</div>
      )}
      </div>
    </section>
  );
}

function PreviewLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[58px_1fr] gap-2 text-xs">
      <span className="font-semibold text-graphite">{label}</span>
      <span className="min-w-0 break-all font-semibold text-ink">{value}</span>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function pathDisplayName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

type RoutingPreviewRow = SourceScan["extensions"][number] & {
  targetFolderName: string;
  note: string;
};

type SourceScanEntry = {
  sourcePath: string;
  scan: SourceScan;
};

type ReportBuildState = {
  status: "idle" | "building" | "ready" | "failed";
  progress: IngestProgress | null;
  path?: string;
  error?: string;
};

type ManifestFile = ScannedFile & {
  autoSelected: boolean;
  disabled: boolean;
  label: string;
  note: string;
  sourceKey: string;
  sourceLabel: string;
  sourcePath: string;
  // For a collapsed camera clip (e.g. a RED .RDC folder of spanned .R3D segments):
  // the sourceKeys of every underlying file the clip row represents.
  clipMemberKeys?: string[];
  clipSegmentCount?: number;
};

// The real file keys a row toggles — a clip's members, or just itself.
function memberKeysOf(file: ManifestFile): string[] {
  return file.clipMemberKeys && file.clipMemberKeys.length > 0 ? file.clipMemberKeys : [file.sourceKey];
}

// Path up to and including a RED clip folder (`*.RDC`) within a relative path, or
// null if the file isn't inside one. RED records one clip as a .RDC folder full of
// spanned _001/_002… .R3D segments, so we group by that folder.
function clipFolderRelPath(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]/);
  const index = parts.findIndex((part) => part.toLowerCase().endsWith(".rdc"));
  return index >= 0 ? parts.slice(0, index + 1).join("/") : null;
}

// Collapses spanned camera-clip segments into a single row per clip (name, total
// size, segment count) so the Choose Files list is readable. Non-clip files pass
// through untouched. Row order doesn't matter — the list is sorted afterward.
function collapseClips(files: ManifestFile[]): ManifestFile[] {
  const singles: ManifestFile[] = [];
  const clips = new Map<string, ManifestFile[]>();
  for (const file of files) {
    const clipRel = clipFolderRelPath(file.relative_path);
    if (!clipRel) {
      singles.push(file);
      continue;
    }
    const key = `${file.sourcePath} ${clipRel}`;
    const bucket = clips.get(key);
    if (bucket) {
      bucket.push(file);
    } else {
      clips.set(key, [file]);
    }
  }
  const clipRows = [...clips.values()].map((members) => {
    const first = members[0];
    const clipRel = clipFolderRelPath(first.relative_path) as string;
    const clipName = (clipRel.split(/[\\/]/).pop() ?? clipRel).replace(/\.rdc$/i, "");
    return {
      ...first,
      file_name: clipName,
      relative_path: `${clipName}  ·  ${members.length} R3D`,
      size_bytes: members.reduce((sum, member) => sum + member.size_bytes, 0),
      modified_at: members.reduce<string | null>(
        (latest, member) => (member.modified_at && (!latest || member.modified_at > latest) ? member.modified_at : latest),
        first.modified_at ?? null,
      ),
      autoSelected: members.every((member) => member.autoSelected),
      disabled: members.every((member) => member.disabled),
      clipMemberKeys: members.map((member) => member.sourceKey),
      clipSegmentCount: members.length,
    } satisfies ManifestFile;
  });
  return [...singles, ...clipRows];
}

type ManifestDayGroup = {
  dayKey: string;
  fileCount: number;
  files: ManifestFile[];
  label: string;
  selectableKeys: string[];
  sizeBytes: number;
};

type ManifestSourceGroup = {
  days: ManifestDayGroup[];
  fileCount: number;
  selectableKeys: string[];
  sizeBytes: number;
  sourceLabel: string;
  sourcePath: string;
};

type FilePickerSortMode = "date" | "name" | "type" | "size";
type FilePickerSortDirection = "asc" | "desc";

// Persisted-across-opens view state for the file picker (lives on the page, not the
// dialog, so closing the modal doesn't reset the user's view/sort/filter choices).
type FilePickerUiState = {
  viewMode: "list" | "thumbs";
  thumbnailSize: number;
  sortMode: FilePickerSortMode;
  sortDirection: FilePickerSortDirection;
  search: string;
  kindFilter: Set<ScanFileKind>;
  groupByDate: boolean;
};

function sourceFileKey(sourcePath: string, relativePath: string) {
  return `${sourcePath}\u0000${relativePath}`;
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths.filter((path) => path.trim().length > 0)));
}

function aggregateSourceScans(sourceScans: SourceScanEntry[]): SourceScan | null {
  if (sourceScans.length === 0) {
    return null;
  }

  const extensionMap = new Map<string, ExtensionAccumulator>();
  const kindMap = new Map<ScanFileKind, KindAccumulator>();
  const files: ScannedFile[] = [];
  let total_files = 0;
  let total_bytes = 0;
  let ingest_files = 0;
  let ignored_files = 0;
  let sidecar_files = 0;

  for (const entry of sourceScans) {
    total_files += entry.scan.total_files;
    total_bytes += entry.scan.total_bytes;
    ingest_files += entry.scan.ingest_files;
    ignored_files += entry.scan.ignored_files;
    sidecar_files += entry.scan.sidecar_files;
    files.push(...entry.scan.files);
    for (const extension of entry.scan.extensions) {
      const key = `${extension.kind}:${extension.extension}`;
      const current = extensionMap.get(key) ?? {
        extension: extension.extension,
        kind: extension.kind,
        count: 0,
        total_bytes: 0,
      };
      current.count += extension.count;
      current.total_bytes += extension.total_bytes;
      extensionMap.set(key, current);
    }
    for (const kind of entry.scan.kinds) {
      const current = kindMap.get(kind.kind) ?? {
        kind: kind.kind,
        count: 0,
        total_bytes: 0,
      };
      current.count += kind.count;
      current.total_bytes += kind.total_bytes;
      kindMap.set(kind.kind, current);
    }
  }

  return {
    root_path: sourceScans.map((entry) => entry.sourcePath).join("; "),
    total_files,
    total_bytes,
    ingest_files,
    ignored_files,
    sidecar_files,
    extensions: Array.from(extensionMap.values()).sort((a, b) => a.extension.localeCompare(b.extension)),
    kinds: Array.from(kindMap.values()),
    files,
    unreadable_paths: sourceScans.flatMap((entry) => entry.scan.unreadable_paths),
  };
}

type ExtensionAccumulator = SourceScan["extensions"][number];
type KindAccumulator = SourceScan["kinds"][number];

function mergeIngestResults(results: IngestResult[]): IngestResult {
  if (results.length === 0) {
    return {
      root_path: "",
      files_copied: 0,
      sidecars_copied: 0,
      skipped_files: 0,
      verified_files: 0,
      verification_failed: 0,
      bytes_copied: 0,
      mhl_path: "",
      report_path: "",
      copied_files: [],
      skipped: [],
    };
  }

  return {
    root_path: results[0].root_path,
    files_copied: results.reduce((sum, result) => sum + result.files_copied, 0),
    sidecars_copied: results.reduce((sum, result) => sum + result.sidecars_copied, 0),
    skipped_files: results.reduce((sum, result) => sum + result.skipped_files, 0),
    verified_files: results.reduce((sum, result) => sum + result.verified_files, 0),
    verification_failed: results.reduce((sum, result) => sum + result.verification_failed, 0),
    bytes_copied: results.reduce((sum, result) => sum + result.bytes_copied, 0),
    mhl_path: results[results.length - 1].mhl_path,
    report_path: results[results.length - 1].report_path,
    copied_files: results.flatMap((result) => result.copied_files),
    skipped: results.flatMap((result) => result.skipped),
  };
}

function buildManifestFiles(
  sourceScans: SourceScanEntry[],
  selectedRelativePaths: Set<string>,
  deleteSidecars: boolean,
): ManifestFile[] {
  if (sourceScans.length === 0) {
    return [];
  }

  return sourceScans.flatMap((entry) =>
    entry.scan.files.filter((file) => matchesRoutableKind(file.kind) || file.kind === "sidecar").flatMap((file) => {
      const key = sourceFileKey(entry.sourcePath, file.relative_path);
      if (file.kind === "sidecar") {
        if (deleteSidecars) {
          return [];
        }
        const parentSelected = file.sidecar_for ? selectedRelativePaths.has(sourceFileKey(entry.sourcePath, file.sidecar_for)) : false;
        if (!parentSelected) {
          return [];
        }
        return {
          ...file,
          autoSelected: true,
          disabled: true,
          label: "Sidecar",
          note: "",
          sourceKey: key,
          sourceLabel: pathDisplayName(entry.sourcePath),
          sourcePath: entry.sourcePath,
        };
      }

      return {
        ...file,
        autoSelected: false,
        disabled: false,
        label: labelForKind(file.kind),
        note: "",
        sourceKey: key,
        sourceLabel: pathDisplayName(entry.sourcePath),
        sourcePath: entry.sourcePath,
      };
    }),
  );
}

function groupManifestFiles(
  files: ManifestFile[],
  sortMode: FilePickerSortMode,
  sortDirection: FilePickerSortDirection,
  groupByDate: boolean,
): ManifestSourceGroup[] {
  const sourceMap = new Map<string, ManifestFile[]>();
  for (const file of files) {
    const sourceFiles = sourceMap.get(file.sourcePath) ?? [];
    sourceFiles.push(file);
    sourceMap.set(file.sourcePath, sourceFiles);
  }

  return Array.from(sourceMap.entries()).map(([sourcePath, sourceFiles]) => {
    const sortedFiles = sortManifestFiles(sourceFiles, sortMode, sortDirection);
    // "Group by day" is now an explicit control (honestly wired to the group_by_date
    // setting), independent of the sort column: on → calendar-day sticky sections
    // (Today / Yesterday / weekday / date); off → one flat section per source.
    const days = groupByDate
      ? buildDayGroups(sortedFiles)
      : [makeDayGroup("sorted", `${sortModeLabel(sortMode)} / ${sortDirectionLabel(sortMode, sortDirection)}`, sortedFiles)];

    return {
      days,
      fileCount: sourceFiles.filter((file) => !file.disabled).length,
      selectableKeys: sourceFiles.filter((file) => !file.disabled).map((file) => file.sourceKey),
      sizeBytes: sourceFiles.reduce((sum, file) => sum + (file.disabled ? 0 : file.size_bytes), 0),
      sourceLabel: sourceFiles[0]?.sourceLabel ?? pathDisplayName(sourcePath),
      sourcePath,
    };
  });
}

function makeDayGroup(dayKey: string, label: string, files: ManifestFile[]): ManifestDayGroup {
  const selectable = files.filter((file) => !file.disabled);
  return {
    dayKey,
    label,
    files,
    fileCount: selectable.length,
    selectableKeys: selectable.map((file) => file.sourceKey),
    sizeBytes: files.reduce((sum, file) => sum + (file.disabled ? 0 : file.size_bytes), 0),
  };
}

// Buckets an already-sorted file list by shot/modified calendar day, preserving the
// incoming order so day groups appear newest→oldest (or oldest→newest) to match sort.
function buildDayGroups(sortedFiles: ManifestFile[]): ManifestDayGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, ManifestFile[]>();
  for (const file of sortedFiles) {
    const date = dateFromTimestamp(file.modified_at);
    const key = date ? dayKeyForDate(date) : "unknown";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(file);
  }
  return order.map((key) => {
    const dayFiles = buckets.get(key)!;
    const sample = dayFiles.find((file) => dateFromTimestamp(file.modified_at));
    return makeDayGroup(key, key === "unknown" ? "Unknown date" : dayLabelForDate(sample?.modified_at), dayFiles);
  });
}

function dayKeyForDate(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// "Today" / "Yesterday" for the last 48h, weekday within the past week, else a date.
function dayLabelForDate(value?: string | null) {
  const date = dateFromTimestamp(value);
  if (!date) {
    return "Unknown date";
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  if (diffDays === 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function flattenSelectableFileKeys(sourceGroups: ManifestSourceGroup[]) {
  return sourceGroups.flatMap((sourceGroup) =>
    sourceGroup.days.flatMap((dayGroup) =>
      dayGroup.files.filter((file) => !file.disabled).map((file) => file.sourceKey),
    ),
  );
}

function sortManifestFiles(
  files: ManifestFile[],
  sortMode: FilePickerSortMode,
  sortDirection: FilePickerSortDirection,
) {
  const direction = sortDirection === "asc" ? 1 : -1;
  return [...files].sort((left, right) => {
    let comparison = 0;
    if (sortMode === "date") {
      comparison = timestampForSort(left) - timestampForSort(right);
    } else if (sortMode === "name") {
      comparison = left.file_name.localeCompare(right.file_name, undefined, { numeric: true, sensitivity: "base" });
    } else if (sortMode === "type") {
      comparison =
        left.extension.localeCompare(right.extension, undefined, { sensitivity: "base" }) ||
        left.file_name.localeCompare(right.file_name, undefined, { numeric: true, sensitivity: "base" });
    } else {
      comparison = left.size_bytes - right.size_bytes;
    }
    return comparison === 0
      ? left.relative_path.localeCompare(right.relative_path, undefined, { numeric: true, sensitivity: "base" })
      : comparison * direction;
  });
}

function timestampForSort(file: ManifestFile) {
  return dateFromTimestamp(file.modified_at)?.getTime() ?? 0;
}

function sortModeLabel(sortMode: FilePickerSortMode) {
  if (sortMode === "date") {
    return "Date";
  }
  if (sortMode === "name") {
    return "Name";
  }
  if (sortMode === "type") {
    return "Type";
  }
  return "Size";
}

function sortDirectionLabel(sortMode: FilePickerSortMode, sortDirection: FilePickerSortDirection) {
  if (sortMode === "date") {
    return sortDirection === "desc" ? "Newest first" : "Oldest first";
  }
  if (sortMode === "size") {
    return sortDirection === "desc" ? "Largest first" : "Smallest first";
  }
  return sortDirection === "asc" ? "A-Z" : "Z-A";
}

function formatFileTimestamp(value?: string | null) {
  const date = dateFromTimestamp(value);
  if (!date) {
    return "Unknown time";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dateFromTimestamp(value?: string | null) {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return new Date(numeric * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toggleSelectedFile(
  relativePath: string,
  selected: boolean,
  setSelectedRelativePaths: Dispatch<SetStateAction<Set<string>>>,
) {
  setSelectedRelativePaths((current) => {
    const next = new Set(current);
    if (selected) {
      next.add(relativePath);
    } else {
      next.delete(relativePath);
    }
    return next;
  });
}

function selectFileKeys(
  keys: string[],
  selected: boolean,
  setSelectedRelativePaths: Dispatch<SetStateAction<Set<string>>>,
) {
  setSelectedRelativePaths((current) => {
    const next = new Set(current);
    for (const key of keys) {
      if (selected) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    return next;
  });
}

function progressPercent(progress: IngestProgress) {
  if (progress.total_bytes > 0) {
    return Math.min(100, Math.round((progress.bytes_done / progress.total_bytes) * 100));
  }
  if (progress.total_files > 0) {
    return Math.min(100, Math.round((progress.files_done / progress.total_files) * 100));
  }
  return progress.phase === "Complete" ? 100 : 0;
}

function ingestStartHint({
  destinationTargets,
  scan,
  selectedFileCount,
  selectedPresetId,
  sourcePath,
}: {
  destinationTargets: string[];
  scan: SourceScan | null;
  selectedFileCount: number;
  selectedPresetId: string;
  sourcePath: string;
}) {
  if (!selectedPresetId) {
    return "Choose preset";
  }
  if (!sourcePath) {
    return "Choose source";
  }
  if (destinationTargets.length === 0) {
    return "Choose destination";
  }
  if (!scan) {
    return "Scan first";
  }
  if (selectedFileCount === 0) {
    return "Choose files";
  }
  return "Ready";
}

// Delivery-screen panel summarizing an iconik metadata push: how many clips were
// tagged, how many iconik has not scanned yet (retryable), and any errors.
function IconikPushPanel({
  onRetry,
  state,
}: {
  onRetry: (titles: string[]) => void;
  state: IconikPushState;
}) {
  const updated = state.results.filter((row) => row.status === "updated");
  const notFound = state.results.filter((row) => row.status === "not_found");
  const errored = state.results.filter((row) => row.status === "error");
  return (
    <div className="border-b border-mist px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-graphite">iconik metadata push</span>
        {notFound.length > 0 && state.status !== "pushing" ? (
          <button
            className="text-[11px] font-semibold text-signal underline-offset-2 hover:underline"
            onClick={() => onRetry(notFound.map((row) => row.title))}
            type="button"
          >
            Retry {notFound.length} not found
          </button>
        ) : null}
      </div>
      {state.status === "pushing" ? (
        <p className="text-[11px] text-graphite">Matching clips and writing metadata to iconik…</p>
      ) : state.status === "error" ? (
        <p className="text-[11px] font-semibold text-red-700">{state.error}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
            <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-emerald-700 ring-1 ring-emerald-200">
              {updated.length} tagged
            </span>
            {notFound.length > 0 ? (
              <span className="rounded-md bg-amber-50 px-2 py-0.5 text-amber-700 ring-1 ring-amber-200">
                {notFound.length} not in iconik yet
              </span>
            ) : null}
            {errored.length > 0 ? (
              <span className="rounded-md bg-red-50 px-2 py-0.5 text-red-700 ring-1 ring-red-200">
                {errored.length} error{errored.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {notFound.length > 0 ? (
            <p className="mt-1 text-[11px] text-graphite/70">
              iconik may not have scanned these files yet. Give it a minute, then retry.
            </p>
          ) : null}
          {errored.length > 0 ? (
            <p className="mt-1 truncate text-[11px] text-red-700" title={errored[0].detail ?? undefined}>
              {errored[0].detail}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function reportStatusLabel(reportBuild: ReportBuildState) {
  if (reportBuild.status === "building") {
    return "Report building in background";
  }
  if (reportBuild.status === "ready") {
    return "Report ready";
  }
  if (reportBuild.status === "failed") {
    return "Report failed";
  }
  return "Report";
}

function reportPhase(phase: string) {
  const normalized = phase.toLowerCase();
  return normalized.includes("report") || normalized.includes("thumbnail");
}

async function buildOutputPreview({
  destinationPath,
  destinationMode,
  preset,
  projectNameOverride,
  renameFiles,
  fileRenamePattern,
  scan,
  variableValues,
}: {
  destinationPath: string;
  destinationMode: "create_new" | "existing_root";
  preset: Preset;
  projectNameOverride?: string;
  renameFiles: boolean;
  fileRenamePattern?: string;
  scan: SourceScan | null;
  variableValues: Record<string, string>;
}): Promise<IngestOutputPreview> {
  const sampleFile = firstRoutableFile(scan);
  const sampleKind = sampleFile?.kind ?? "footage";
  const sampleExtension = sampleFile?.extension ?? ".mp4";
  // A wizard-chosen project name replaces the preset's root pattern for this run,
  // mirroring the backend's root_name_override.
  const rootName = await previewPattern(projectNameOverride?.trim() || preset.root_folder_pattern, {
    preset_name: preset.name,
    variable_values: variableValues,
    clip_number_padding: preset.clip_number_padding,
  });
  // Year-aware sub-path (e.g. {year}/Broll) is inserted between the destination and
  // the project root when creating a new project, mirroring the Rust scaffolder.
  const subSegments = (preset.destinations.sub_path_pattern ?? "")
    .split(/[/\\]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const resolvedSubSegments: string[] = [];
  for (const segment of subSegments) {
    const resolved = await previewPattern(segment, {
      preset_name: preset.name,
      variable_values: variableValues,
      clip_number_padding: preset.clip_number_padding,
    });
    if (resolved.trim()) {
      resolvedSubSegments.push(resolved);
    }
  }
  const baseWithSub = resolvedSubSegments.reduce((path, segment) => joinPreviewPath(path, segment), destinationPath);
  const resolvedRoot = destinationMode === "existing_root" ? destinationPath : joinPreviewPath(baseWithSub, rootName);
  const targetFolderPath =
    routeFolderPathForKindAndExtension(preset, sampleKind, sampleExtension) ??
    findDeepestFolderPathByRole(preset.folder_tree, "footage") ??
    (preset.folder_tree[0] ? [preset.folder_tree[0]] : []);
  const folderNames = await Promise.all(
    targetFolderPath.map((folder) =>
      previewPattern(folder.name_pattern, {
        preset_name: preset.name,
        variable_values: variableValues,
        clip_number_padding: preset.clip_number_padding,
      }),
    ),
  );
  const folderName = folderNames[folderNames.length - 1] ?? "Footage";
  const folderPath = folderNames.reduce((path, name) => joinPreviewPath(path, name), "");
  const targetFolder = targetFolderPath[targetFolderPath.length - 1] ?? null;
  const patternPreview = await previewPattern(filePatternForFolder(preset, targetFolder, fileRenamePattern), {
    preset_name: preset.name,
    variable_values: variableValues,
    camera: cameraHintForPreview(sampleFile),
    clip_number: 1,
    clip_number_padding: preset.clip_number_padding,
    original_name: sampleFile?.stem ?? "C0001",
    capture_date: "20260424",
    extension: sampleExtension,
    folder_name: folderName,
  });
  const fileName = renameFiles
    ? ensurePreviewExtension(patternPreview, sampleExtension)
    : (sampleFile?.file_name ?? `C0001${sampleExtension}`);

  return {
    fileName,
    folderName,
    fullFolderPath: joinPreviewPath(resolvedRoot, folderPath),
    rootName: resolvedRoot || (destinationMode === "existing_root" ? "Choose existing folder" : rootName),
    sampleLabel: sampleFile ? sampleFile.file_name : "Sample clip",
  };
}

function buildRoutingPreview(preset: Preset, scan: SourceScan, deleteSidecars: boolean): RoutingPreviewRow[] {
  return scan.extensions.map((extension) => {
    const targetFolderId = preset.file_type_routing_overrides[extension.extension] ?? "";
    const targetFolder = targetFolderId ? findFolderById(preset.folder_tree, targetFolderId) : null;
    const defaultFolderName = defaultFolderNameForKind(extension.kind, preset.folder_tree);
    const targetFolderName =
      extension.kind === "ignored"
        ? "Ignored"
        : extension.kind === "unknown"
          ? "Needs review"
          : extension.kind === "sidecar" && deleteSidecars
            ? "Skipped"
            : (targetFolder?.name_pattern ?? defaultFolderName ?? "Footage target");

    return {
      ...extension,
      targetFolderName,
      note: noteForRouting(extension.kind, targetFolderId.length > 0, deleteSidecars),
    };
  });
}

function firstRoutableFile(scan: SourceScan | null) {
  return scan?.files.find((file) =>
    matchesRoutableKind(file.kind),
  ) ?? null;
}

function matchesRoutableKind(kind: ScanFileKind) {
  return kind === "footage" || kind === "photo" || kind === "audio" || kind === "document";
}

function routeFolderForKindAndExtension(preset: Preset, kind: ScanFileKind, extension: string) {
  const path = routeFolderPathForKindAndExtension(preset, kind, extension);
  return path ? path[path.length - 1] ?? null : null;
}

function routeFolderPathForKindAndExtension(preset: Preset, kind: ScanFileKind, extension: string) {
  const targetFolderId = preset.file_type_routing_overrides[extension] ?? "";
  const explicitTarget = targetFolderId ? findFolderPathById(preset.folder_tree, targetFolderId) : null;
  if (explicitTarget) {
    return explicitTarget;
  }

  const role =
    kind === "audio"
      ? "audio"
      : kind === "photo"
        ? "photos"
        : kind === "document"
        ? "documents"
        : "footage";
  return findDeepestFolderPathByRole(preset.folder_tree, role);
}

function filePatternForFolder(preset: Preset, folder: FolderNode | null, basePatternOverride?: string) {
  if (folder) {
    const override = preset.per_folder_rename_overrides[folder.id];
    if (override?.trim()) {
      return override;
    }
  }
  // A per-ingest override replaces the preset's base pattern (per-folder overrides
  // above still win), mirroring how the backend applies file_rename_pattern_override.
  const base = basePatternOverride?.trim() ? basePatternOverride : preset.file_rename_pattern;
  return base.trim() || "{original_name}{ext}";
}

function cameraHintForPreview(file: ScannedFile | null) {
  if (!file) {
    return "CAM";
  }
  const prefix = cameraPrefixFromStem(file.stem);
  if (prefix) {
    return prefix;
  }
  const parts = file.relative_path.split(/[\\/]/).filter(Boolean);
  return [...parts]
    .reverse()
    .slice(1)
    .find((part) => !isGenericCameraFolder(part)) ?? "CAM";
}

function cameraPrefixFromStem(stem: string) {
  const prefix = stem.split(/[_\-\s]/)[0]?.trim() ?? "";
  const hasLetter = /[A-Za-z]/.test(prefix);
  const hasDigit = /\d/.test(prefix);
  return prefix.length >= 2 && hasLetter && hasDigit ? prefix : "";
}

function isGenericCameraFolder(value: string) {
  return [
    "clip",
    "clips",
    "stream",
    "private",
    "m4root",
    "avchd",
    "bdmv",
    "dcim",
    "mp_root",
    "xdroot",
    "contents",
    "bpav",
    "100media",
    "101media",
  ].includes(value.toLowerCase());
}

function defaultFolderNameForKind(kind: ScanFileKind, folders: FolderNode[]) {
  const role =
    kind === "audio"
      ? "audio"
      : kind === "photo"
        ? "photos"
        : kind === "document"
          ? "documents"
          : "footage";
  return findFirstFolderByRole(folders, role)?.name_pattern;
}

function noteForRouting(kind: ScanFileKind, hasOverride: boolean, deleteSidecars: boolean) {
  if (kind === "ignored") {
    return "Filtered and not copied";
  }
  if (kind === "unknown") {
    return "Filtered until a routing rule exists";
  }
  if (kind === "sidecar") {
    return deleteSidecars ? "Delete sidecars is enabled" : "Kept beside matching media when paired";
  }
  return hasOverride ? "Uses preset extension override" : "Uses default media role";
}

function labelForKind(kind: ScanFileKind) {
  switch (kind) {
    case "footage":
      return "Footage";
    case "photo":
      return "Photos";
    case "audio":
      return "Audio";
    case "document":
      return "Docs";
    case "sidecar":
      return "Sidecar";
    case "ignored":
      return "Ignored";
    case "unknown":
    default:
      return "Review";
  }
}

function isFilteredPreviewRow(extension: RoutingPreviewRow) {
  return extension.kind === "ignored" || extension.kind === "unknown";
}

function findFolderById(folders: FolderNode[], id: string): FolderNode | null {
  for (const folder of folders) {
    if (folder.id === id) {
      return folder;
    }
    const child = findFolderById(folder.children, id);
    if (child) {
      return child;
    }
  }
  return null;
}

function findFolderPathById(folders: FolderNode[], id: string, parents: FolderNode[] = []): FolderNode[] | null {
  for (const folder of folders) {
    const path = [...parents, folder];
    if (folder.id === id) {
      return path;
    }
    const child = findFolderPathById(folder.children, id, path);
    if (child) {
      return child;
    }
  }
  return null;
}

function findFirstFolderByRole(folders: FolderNode[], role: FolderNode["role"] | "footage"): FolderNode | null {
  for (const folder of folders) {
    if (role === "footage" && folder.is_footage_destination) {
      return folder;
    }
    if (folder.role === role) {
      return folder;
    }
    const child = findFirstFolderByRole(folder.children, role);
    if (child) {
      return child;
    }
  }
  return null;
}

function findDeepestFolderPathByRole(
  folders: FolderNode[],
  role: FolderNode["role"] | "footage",
  parents: FolderNode[] = [],
): FolderNode[] | null {
  let match: FolderNode[] | null = null;
  for (const folder of folders) {
    const path = [...parents, folder];
    if (role === "footage" ? folder.is_footage_destination || folder.role === "footage" : folder.role === role) {
      match = path;
    }
    const child = findDeepestFolderPathByRole(folder.children, role, path);
    if (child) {
      match = child;
    }
  }
  return match;
}

function ensurePreviewExtension(fileName: string, extension: string) {
  if (!extension) {
    return fileName;
  }
  return fileName.toLowerCase().endsWith(extension.toLowerCase()) ? fileName : `${fileName}${extension}`;
}

function createJobId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseSelectedValues(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function joinPreviewPath(parent: string, child: string) {
  if (!parent.trim()) {
    return child;
  }
  if (!child.trim()) {
    return parent;
  }

  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child.replace(/^[\\/]+/, "")}`;
}
