import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, FolderOpen, Image, List, RefreshCw, Search, X } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultsForParameters,
  medianHistoricalBytesPerSecond,
  mergeGlobalAndPresetParameters,
  recentValuesByVariable,
} from "../lib/parameters";
import { FloatingHelp } from "../components/FloatingHelp";
import { RecentIngestsCarousel } from "../components/RecentIngestsCarousel";
import { SelectMenu } from "../components/SelectMenu";
import {
  defaultAppSettings,
  getPreset,
  getSettings,
  listHistory,
  listPresets,
  openPath,
  previewPattern,
  cancelIngest,
  diskSpace,
  exportReelIndex,
  generateIngestReport,
  generateOffloadProof,
  runIngest,
  retryFailedCopies,
  saveHistoryJob,
  scanSource,
  detectCameraSources,
  type CameraSource,
  type CopiedFile,
  type DiskSpace,
  type IngestHistoryJob,
  type IngestProgress,
  type IngestResult,
  type ScanFileKind,
  type ScannedFile,
  type SourceScan,
} from "../lib/tauri";
import type { AppSettings, FolderNode, Preset, PresetSummary, PresetVariable } from "../lib/types";
import { useAppStore } from "../stores/appStore";

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
  const [isScanning, setIsScanning] = useState(false);
  const [isIngesting, setIsIngesting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [deleteSidecars, setDeleteSidecars] = useState(false);
  const [renameFiles, setRenameFiles] = useState(true);
  const [showFilteredItems, setShowFilteredItems] = useState(false);
  const [outputPreview, setOutputPreview] = useState<IngestOutputPreview | null>(null);
  const [selectedRelativePaths, setSelectedRelativePaths] = useState<Set<string>>(new Set());
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [speedSeries, setSpeedSeries] = useState<SpeedPoint[]>([]);
  const [instantaneousBps, setInstantaneousBps] = useState(0);
  const [reportBuild, setReportBuild] = useState<ReportBuildState>({ status: "idle", progress: null });
  const [isFileSelectorOpen, setIsFileSelectorOpen] = useState(false);
  const [spaceByPath, setSpaceByPath] = useState<Record<string, DiskSpace | null>>({});
  const [recentJobs, setRecentJobs] = useState<IngestHistoryJob[]>([]);
  const [variableSuggestions, setVariableSuggestions] = useState<Record<string, string[]>>({});
  const [historicalBps, setHistoricalBps] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isSavingProof, setIsSavingProof] = useState(false);
  const [cameraAliases, setCameraAliases] = useState<Record<string, string>>({});
  const currentIngestJobId = useRef<string | null>(null);
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
  const setLastAction = useAppStore((state) => state.setLastAction);
  const sourcePath = sourcePaths[0] ?? "";
  const scan = useMemo(() => aggregateSourceScans(sourceScans), [sourceScans]);
  const destinationTargets = useMemo(
    () => [destinationPath, ...secondaryDestinationPaths].filter((path) => path.trim().length > 0),
    [destinationPath, secondaryDestinationPaths],
  );

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

  // Generate a printable PDF offload integrity proof at the project root and open it.
  async function saveOffloadProof() {
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
      });
      await openPath(path);
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
      const path = await exportReelIndex(ingestResult.root_path, ingestResult.copied_files, "csv");
      await openPath(path);
      setLastAction("Reel index saved");
    } catch (caught) {
      setError(String(caught));
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
        setDestinationPath(nextPreset.destinations.primary ?? "");
        setSecondaryDestinationPaths(nextPreset.destinations.secondaries ?? []);
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
      setLastAction(`Scanned ${totalFiles} file${totalFiles === 1 ? "" : "s"} from ${nextScans.length} source${nextScans.length === 1 ? "" : "s"}`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Source scan failed");
    } finally {
      setIsScanning(false);
    }
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

    setIsIngesting(true);
    setIsCancelling(false);
    setIngestProgress(null);
    setSpeedSeries([]);
    setInstantaneousBps(0);
    progressBufferRef.current = [];
    latestProgressRef.current = null;
    runStartRef.current = performance.now();
    setReportBuild({ status: "idle", progress: null });
    setError(null);
    const jobId = createJobId();
    const startedAt = new Date().toISOString();
    currentIngestJobId.current = jobId;
    // Listener is a pure ref-writer — never setState here (events flood every 256 KB).
    const unlisten = await listen<IngestProgress>("ingest-progress", (event) => {
      if (event.payload.job_id !== jobId) {
        return;
      }
      latestProgressRef.current = event.payload;
      const tMs = performance.now() - runStartRef.current;
      const buffer = progressBufferRef.current;
      const previous = buffer[buffer.length - 1];
      // Multi-segment runs restart bytes_done at 0 per runIngest call; a drop means a
      // new segment, so reset the buffer to avoid a negative speed spike at the seam.
      if (previous && event.payload.bytes_done < previous.bytesDone) {
        buffer.length = 0;
      }
      buffer.push({ tMs, bytesDone: event.payload.bytes_done });
      const cutoff = tMs - SPEED_BUFFER_WINDOW_MS;
      while (buffer.length > 2 && buffer[0].tMs < cutoff) {
        buffer.shift();
      }
    });
    // Sample the refs at a fixed cadence so the whole run screen renders at a steady
    // rate regardless of how fast the card streams.
    sampleTimerRef.current = window.setInterval(() => {
      const latest = latestProgressRef.current;
      if (!latest) {
        return;
      }
      setIngestProgress(latest);
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
    try {
      const results: IngestResult[] = [];
      for (const destination of destinationTargets) {
        let projectRoot = destination;
        for (let sourceIndex = 0; sourceIndex < sourceScans.length; sourceIndex += 1) {
          const entry = sourceScans[sourceIndex];
          const includedRelativePaths = entry.scan.files
            .filter((file) => selectedRelativePaths.has(sourceFileKey(entry.sourcePath, file.relative_path)))
            .map((file) => file.relative_path);
          if (includedRelativePaths.length === 0) {
            continue;
          }
          const result = await runIngest(
            selectedPresetId,
            entry.sourcePath,
            variableValues,
            sourceIndex === 0 ? destination : projectRoot,
            !deleteSidecars,
            renameFiles,
            cameraAliases[entry.sourcePath]?.trim() || undefined,
            includedRelativePaths,
            destinationMode === "existing_root" || sourceIndex > 0,
            jobId,
          );
          results.push(result);
          projectRoot = result.root_path;
        }
      }
      const result = mergeIngestResults(results);
      setIngestResult(result);
      setLastAction(
        `Ingest copied ${result.files_copied} file${result.files_copied === 1 ? "" : "s"} from ${sourceScans.length} source${sourceScans.length === 1 ? "" : "s"} to ${destinationTargets.length} destination${destinationTargets.length === 1 ? "" : "s"}`,
      );
      const completedAt = new Date().toISOString();
      const historyJob = {
        id: jobId,
        preset_id: selectedPresetId,
        preset_name: preset.name,
        variable_values: variableValues,
        status: result.verification_failed > 0 ? "needs_review" : "verified",
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
      unlisten();
      if (sampleTimerRef.current !== null) {
        window.clearInterval(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
      setIsIngesting(false);
      setIsCancelling(false);
      currentIngestJobId.current = null;
    }
  }

  async function buildReportInBackground({
    completedAt,
    destinationPaths,
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

      const reportPath = await generateIngestReport(
        presetName,
        sourcePaths.join("; "),
        result.root_path,
        variableValues,
        result.copied_files,
        result.skipped,
        result.files_copied,
        result.verified_files,
        result.verification_failed,
        result.bytes_copied,
        result.mhl_path,
        reportJobId,
      );
      setIngestResult((current) => (current ? { ...current, report_path: reportPath } : current));
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

  useEffect(() => {
    getSettings()
      .then((settings) => {
        setAppSettings(settings);
        setGlobalParameters(settings.global_parameters);
        setRenameFiles(settings.ingest_defaults.rename_files);
        setDeleteSidecars(settings.ingest_defaults.delete_sidecars);
        setDestinationMode(settings.ingest_defaults.destination_mode);
      })
      .catch(() => setGlobalParameters([]));
    void refreshPresets("");
    void refreshRecentJobs();
  }, []);

  useEffect(() => {
    void loadSelectedPreset(selectedPresetId);
  }, [selectedPresetId]);

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

  useEffect(() => {
    setSourceScans([]);
    setIngestResult(null);
    setSelectedRelativePaths(new Set());
    setIngestProgress(null);
    setIsFileSelectorOpen(false);
  }, [selectedPresetId]);

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
      renameFiles,
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
  }, [destinationMode, destinationPath, preset, renameFiles, scan, variableValues]);

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
        if (!sourcePath.trim() && sources[0]) {
          setSourcePaths([sources[0].path]);
          setSourceScans([]);
          setSelectedRelativePaths(new Set());
          setIngestProgress(null);
          setIsFileSelectorOpen(false);
          setIngestResult(null);
          setLastAction(`Camera source detected: ${sources[0].label}`);
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
  }, [appSettings.camera_watcher.auto_detect_cards, setLastAction, sourcePath]);

  if (isIngesting) {
    return (
      <IngestRunScreen
        isCancelling={isCancelling}
        onCancel={() => void cancelCurrentIngest()}
        progress={ingestProgress}
        speedSeries={speedSeries}
        instantaneousBps={instantaneousBps}
        selectedBytes={selectedBytes}
        selectedCount={selectedFileCount}
      />
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

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[220px_320px_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <RecentIngestsCarousel
            recentJobs={recentJobs}
            presets={presets}
            onSelect={applyRecentJobState}
          />
          <PresetBrowser
            presets={presets}
            selectedPresetId={selectedPresetId}
            onSelect={(id) => {
              setSelectedPresetId(id);
              setIngestResult(null);
            }}
          />
        </div>

        <section className="relative z-20 overflow-visible rounded-2xl border border-mist bg-white">
          <div className="flex h-9 items-center justify-between border-b border-mist px-3">
            <SectionTitle
              help="This is the job setup: which preset rules to use, what media to copy, and where the project should land."
              title="1. Copy Job"
            />
            <span className="text-xs font-semibold text-graphite">Scan + copy</span>
          </div>
          <div className="space-y-2 p-2">
            <label className="block">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-graphite">
                <FieldLabel help="Choose one or more camera cards or source folders. Detected camera cards are auto-filled when possible.">
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

            <label className="block">
              <FieldLabel help="Choose whether Ingest Pilot should create the project root from the preset, or copy into a folder you already made.">
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
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-signal px-3 text-sm font-semibold text-paper transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
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
                    <span className="block truncate text-[11px] text-graphite">Apply the preset filename pattern.</span>
                  </span>
                  <input
                    checked={renameFiles}
                    className="h-4 w-4 accent-signal"
                    onChange={(event) => setRenameFiles(event.target.checked)}
                    type="checkbox"
                  />
                </label>
              </div>
            </details>

            <div className="rounded-2xl border border-graphite/20 bg-white p-2 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-ink">Ready to copy</span>
                <span className="font-semibold text-graphite">
                  {selectedFileCount > 0 ? `${selectedFileCount} files / ${formatBytes(selectedBytes)}` : ingestStartHint({ destinationTargets, scan, selectedFileCount, selectedPresetId, sourcePath })}
                </span>
              </div>
              <button
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-black px-3 text-base font-semibold text-white shadow-sm transition hover:bg-ink disabled:cursor-not-allowed disabled:bg-graphite/35 disabled:text-white/80 disabled:shadow-none"
                disabled={!canStartIngest}
                onClick={() => void startIngest()}
                type="button"
              >
                Start Ingest
              </button>
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

          {ingestResult ? (
            <section className="overflow-hidden rounded-2xl border border-mist bg-white">
              <div className="flex h-9 items-center justify-between border-b border-mist px-3">
                <h2 className="text-sm font-semibold">Ingest Result</h2>
                <div className="flex items-center gap-2">
                  {ingestResult.report_path ? (
                    <button
                      className="text-xs font-semibold text-graphite underline-offset-2 hover:underline"
                      onClick={() => void openPath(ingestResult.report_path)}
                      type="button"
                    >
                      Open report
                    </button>
                  ) : null}
                  <button
                    className="text-xs font-semibold text-graphite underline-offset-2 hover:underline"
                    onClick={() => void openPath(ingestResult.root_path)}
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
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 border-b border-mist bg-porcelain/50 p-2.5 md:grid-cols-4">
                <SummaryTile label="Copied" value={String(ingestResult.files_copied)} />
                <SummaryTile label="Verified" value={`${ingestResult.verified_files}/${ingestResult.files_copied}`} />
                <SummaryTile label="Failed" value={String(ingestResult.verification_failed)} />
                <SummaryTile label="Copied size" value={formatBytes(ingestResult.bytes_copied)} />
              </div>
              <VerificationPanel
                destinations={destinationTargets}
                isRetrying={isRetrying}
                onRetry={() => void retryFailedCopiesForResult()}
                result={ingestResult}
              />
              <CoverageCard files={ingestResult.copied_files} />
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
                  {reportBuild.error ? <p className="mt-1 text-[11px] font-semibold text-red-700">{reportBuild.error}</p> : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {scan ? (
            <section className="overflow-hidden rounded-2xl border border-mist bg-white">
              <div className="flex h-9 items-center justify-between gap-3 border-b border-mist px-3">
                <SectionTitle
                  help="These are the files selected for this ingest. Use Choose files when you only need part of a card."
                  title="3. Files to Copy"
                />
                <button
                  className="rounded-lg border border-mist bg-white px-2 py-1 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => setIsFileSelectorOpen(true)}
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
          defaultThumbnailSize={appSettings.file_selector.thumbnail_size}
          defaultView={appSettings.file_selector.default_view}
          deleteSidecars={deleteSidecars}
          files={visibleManifestFiles}
          onClose={() => setIsFileSelectorOpen(false)}
          onSelectAll={() =>
            setSelectedRelativePaths(
              new Set(
                sourceScans.flatMap((entry) =>
                  entry.scan.files
                    .filter((file) => matchesRoutableKind(file.kind))
                    .map((file) => sourceFileKey(entry.sourcePath, file.relative_path)),
                ),
              ),
            )
          }
          onSelectNone={() => setSelectedRelativePaths(new Set())}
          selectedBytes={selectedBytes}
          selectedCount={selectedFileCount}
          selectedRelativePaths={selectedRelativePaths}
          setSelectedRelativePaths={setSelectedRelativePaths}
        />
      ) : null}
    </div>
  );
}

function IngestRunScreen({
  isCancelling,
  onCancel,
  progress,
  speedSeries,
  instantaneousBps,
  selectedBytes,
  selectedCount,
}: {
  isCancelling: boolean;
  onCancel: () => void;
  progress: IngestProgress | null;
  speedSeries: SpeedPoint[];
  instantaneousBps: number;
  selectedBytes: number;
  selectedCount: number;
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

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Verified ingest</p>
          <h1 className="text-xl font-semibold tracking-normal">{progress?.phase ?? "Preparing ingest"}</h1>
        </div>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 text-xs font-semibold text-red-800 transition hover:bg-red-100 disabled:opacity-60"
          disabled={isCancelling}
          onClick={onCancel}
          type="button"
        >
          <X size={16} />
          {isCancelling ? "Cancelling..." : "Cancel"}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[minmax(0,1fr)_280px]">
        <section className="overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="flex h-9 items-center justify-between border-b border-mist px-3">
            <h2 className="text-sm font-semibold">Copy + verify</h2>
            <span className="text-xs font-semibold text-graphite">{formatBytes(copiedBytes)} of {formatBytes(totalBytes)}</span>
          </div>
          <div className="p-2">
            <div className="mb-2 grid grid-cols-[minmax(0,1.15fr)_repeat(2,minmax(0,0.75fr))] gap-2 md:grid-cols-[minmax(0,1.2fr)_repeat(4,minmax(0,0.8fr))]">
              <div className="rounded-xl border border-mist bg-porcelain/55 px-3 py-2">
                <p className="text-[11px] font-semibold text-graphite">Progress</p>
                <div className="mt-0.5 flex items-end gap-2">
                  <span className="text-4xl font-semibold leading-none text-ink">{percent}</span>
                  <span className="pb-1 text-sm font-semibold text-graphite">%</span>
                </div>
              </div>
              <SummaryTile label="Speed" value={`${speed}/s`} />
              <SummaryTile label="Remaining" value={remaining} />
              <SummaryTile label="Copied" value={`${progress?.files_done ?? 0}/${progress?.total_files ?? selectedCount}`} />
              <SummaryTile label="Elapsed" value={elapsed} />
            </div>

            <div className="relative h-[300px] overflow-hidden rounded-2xl border border-mist bg-porcelain/35 p-3">
              <SpeedChart series={speedSeries} />
              <div className="absolute bottom-4 left-4 right-4">
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-graphite">
                  <span>{formatBytes(copiedBytes)} copied</span>
                  <span>{formatBytes(totalBytes)} total</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full bg-signal transition-all" style={{ width: `${percent}%` }} />
                </div>
              </div>
            </div>

            {progress?.current_file ? (
              <div className="mt-3 truncate rounded-xl border border-mist bg-porcelain/50 px-3 py-2 text-xs font-semibold text-graphite">
                {progress.current_file}
              </div>
            ) : null}
          </div>
        </section>

        <aside className="space-y-2">
          <Gauge label="Copy" value={percent} />
          <Gauge label="Verify" value={verifyPercent} />
          <div className="rounded-2xl border border-mist bg-white p-3 text-xs font-semibold text-graphite">
            Reports and thumbnails build after the transfer completes, so ingest speed stays the priority.
          </div>
        </aside>
      </div>
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
          background: `conic-gradient(#78d88f ${clamped * 3.6}deg, #f1ede6 0deg)`,
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
          <stop offset="0%" stopColor="#c9a7ff" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#c9a7ff" stopOpacity="0.04" />
        </linearGradient>
      </defs>
      {/* baseline + mid gridline */}
      <line x1={PAD_L} x2={PAD_R} y1={PAD_B} y2={PAD_B} stroke="#e7e2d8" strokeWidth="1" />
      <line x1={PAD_L} x2={PAD_R} y1={midY} y2={midY} stroke="#efeae0" strokeWidth="1" strokeDasharray="4 6" />
      {areaPath ? <path d={areaPath} fill="url(#transferFill)" /> : null}
      {linePath ? (
        <path d={linePath} fill="none" stroke="#8f67dd" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
      ) : null}
      {/* axis labels */}
      <text x={PAD_L} y={PAD_T - 10} fontSize="13" fontWeight="600" fill="#8a8577">
        {formatBytes(yMax)}/s
      </text>
      <text x={PAD_R} y={PAD_T - 10} fontSize="12" fontWeight="600" fill="#b4afa2" textAnchor="end">
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
                  checked ? "border-signal bg-signal text-paper" : "border-mist bg-white"
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

function FileSelectionDialog({
  availableCount,
  defaultThumbnailSize,
  defaultView,
  deleteSidecars,
  files,
  onClose,
  onSelectAll,
  onSelectNone,
  selectedBytes,
  selectedCount,
  selectedRelativePaths,
  setSelectedRelativePaths,
}: {
  availableCount: number;
  defaultThumbnailSize: number;
  defaultView: "list" | "thumbs";
  deleteSidecars: boolean;
  files: ManifestFile[];
  onClose: () => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  selectedBytes: number;
  selectedCount: number;
  selectedRelativePaths: Set<string>;
  setSelectedRelativePaths: Dispatch<SetStateAction<Set<string>>>;
}) {
  const [highlightedFileKeys, setHighlightedFileKeys] = useState<Set<string>>(new Set());
  const [lastHighlightedFileKey, setLastHighlightedFileKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "thumbs">(defaultView);
  const [thumbnailSize, setThumbnailSize] = useState(defaultThumbnailSize);
  const [sortMode, setSortMode] = useState<FilePickerSortMode>("date");
  const [sortDirection, setSortDirection] = useState<FilePickerSortDirection>("desc");
  const sourceGroups = useMemo(() => groupManifestFiles(files, sortMode, sortDirection), [files, sortDirection, sortMode]);
  const selectableFileKeys = useMemo(() => flattenSelectableFileKeys(sourceGroups), [sourceGroups]);
  const highlightedCount = highlightedFileKeys.size;

  useEffect(() => {
    setHighlightedFileKeys((current) => new Set([...current].filter((key) => selectableFileKeys.includes(key))));
    if (lastHighlightedFileKey && !selectableFileKeys.includes(lastHighlightedFileKey)) {
      setLastHighlightedFileKey(null);
    }
  }, [lastHighlightedFileKey, selectableFileKeys]);

  function handleFileHighlight(file: ManifestFile, shiftKey: boolean) {
    if (file.disabled) {
      return;
    }

    if (shiftKey && lastHighlightedFileKey) {
      const startIndex = selectableFileKeys.indexOf(lastHighlightedFileKey);
      const endIndex = selectableFileKeys.indexOf(file.sourceKey);
      if (startIndex >= 0 && endIndex >= 0) {
        const [start, end] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
        setHighlightedFileKeys(new Set(selectableFileKeys.slice(start, end + 1)));
        setLastHighlightedFileKey(file.sourceKey);
        return;
      }
    }

    setHighlightedFileKeys(new Set([file.sourceKey]));
    setLastHighlightedFileKey(file.sourceKey);
  }

  function handleFileChecked(file: ManifestFile, checked: boolean) {
    if (file.disabled) {
      return;
    }

    const keys =
      highlightedFileKeys.has(file.sourceKey) && highlightedFileKeys.size > 0
        ? [...highlightedFileKeys].filter((key) => selectableFileKeys.includes(key))
        : [file.sourceKey];
    selectFileKeys(keys, checked, setSelectedRelativePaths);
    setHighlightedFileKeys(new Set(keys));
    setLastHighlightedFileKey(file.sourceKey);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm">
      <section className="flex max-h-[88vh] w-full max-w-7xl select-none flex-col overflow-hidden rounded-[24px] border border-mist bg-white shadow-panel">
        <div className="flex items-center justify-between gap-3 border-b border-mist px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">Choose Files</h2>
            <p className="text-xs font-medium text-graphite">
              Sorted by {sortModeLabel(sortMode).toLowerCase()}. {selectedCount} of {availableCount} files selected / {formatBytes(selectedBytes)}
              {deleteSidecars ? " / sidecars deleted" : ""}
              {highlightedCount > 1 ? ` / ${highlightedCount} highlighted` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-36">
              <SelectMenu
                onChange={(value) => setSortMode(value as FilePickerSortMode)}
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
              className="h-8 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
              onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
              type="button"
            >
              {sortDirectionLabel(sortMode, sortDirection)}
            </button>
            <div className="flex overflow-hidden rounded-lg border border-mist bg-white">
              <button
                className={`inline-flex h-8 items-center gap-1 px-2 text-xs font-semibold transition ${
                  viewMode === "list" ? "bg-signal text-paper" : "text-graphite hover:bg-porcelain"
                }`}
                onClick={() => setViewMode("list")}
                type="button"
              >
                <List size={14} />
                List
              </button>
              <button
                className={`inline-flex h-8 items-center gap-1 border-l border-mist px-2 text-xs font-semibold transition ${
                  viewMode === "thumbs" ? "bg-signal text-paper" : "text-graphite hover:bg-porcelain"
                }`}
                onClick={() => setViewMode("thumbs")}
                type="button"
              >
                <Image size={14} />
                Thumbnails
              </button>
            </div>
            {viewMode === "thumbs" ? (
              <label className="flex h-8 items-center gap-2 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite">
                Size
                <input
                  className="w-28 accent-signal"
                  max={260}
                  min={80}
                  onChange={(event) => setThumbnailSize(Number(event.target.value))}
                  step={4}
                  type="range"
                  value={thumbnailSize}
                />
              </label>
            ) : null}
            <button
              className="rounded-lg border border-mist bg-white px-3 py-1.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
              onClick={onSelectAll}
              type="button"
            >
              All
            </button>
            <button
              className="rounded-lg border border-mist bg-white px-3 py-1.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
              onClick={onSelectNone}
              type="button"
            >
              None
            </button>
            <button
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-mist bg-white text-graphite transition hover:bg-porcelain"
              onClick={onClose}
              title="Close"
              type="button"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-white">
          {sourceGroups.map((sourceGroup) => (
            <section key={sourceGroup.sourcePath} className="border-b border-mist last:border-b-0">
              <div className="sticky top-0 z-10 grid min-h-9 grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-mist bg-porcelain px-4 py-1">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-ink">{sourceGroup.sourceLabel}</h3>
                  <p className="truncate text-[11px] font-medium text-graphite">{sourceGroup.sourcePath}</p>
                </div>
                <span className="text-xs font-semibold text-graphite">{sourceGroup.fileCount} files / {formatBytes(sourceGroup.sizeBytes)}</span>
                <button
                  className="rounded-lg border border-mist bg-white px-2 py-1 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => selectFileKeys(sourceGroup.selectableKeys, true, setSelectedRelativePaths)}
                  type="button"
                >
                  Select source
                </button>
              </div>

              {sourceGroup.days.map((dayGroup) => (
                <div key={`${sourceGroup.sourcePath}-${dayGroup.dayKey}`} className="border-b border-mist/70 last:border-b-0">
                  <div className="grid min-h-8 grid-cols-[1fr_auto_auto] items-center gap-2 bg-white px-4 py-1">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-ink">{dayGroup.label}</div>
                      <div className="text-[11px] font-medium text-graphite">{dayGroup.fileCount} files / {formatBytes(dayGroup.sizeBytes)}</div>
                    </div>
                    <button
                      className="rounded-lg border border-mist bg-white px-2 py-1 text-[11px] font-semibold text-graphite transition hover:bg-porcelain"
                      onClick={() => selectFileKeys(dayGroup.selectableKeys, true, setSelectedRelativePaths)}
                      type="button"
                    >
                      Check all
                    </button>
                    <button
                      className="rounded-lg border border-mist bg-white px-2 py-1 text-[11px] font-semibold text-graphite transition hover:bg-porcelain"
                      onClick={() => selectFileKeys(dayGroup.selectableKeys, false, setSelectedRelativePaths)}
                      type="button"
                    >
                      Uncheck all
                    </button>
                  </div>

                  {viewMode === "list" ? (
                    dayGroup.files.map((file) => {
                      const selected = file.autoSelected || selectedRelativePaths.has(file.sourceKey);
                      return (
                        <FileListRow
                          checked={selected}
                          key={file.sourceKey}
                          file={file}
                          highlighted={highlightedFileKeys.has(file.sourceKey)}
                          onCheck={handleFileChecked}
                          onHighlight={handleFileHighlight}
                        />
                      );
                    })
                  ) : (
                    <div
                      className="grid gap-2 border-t border-mist/70 bg-porcelain/25 p-2"
                      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))` }}
                    >
                      {dayGroup.files.map((file) => {
                        const selected = file.autoSelected || selectedRelativePaths.has(file.sourceKey);
                        return (
                          <ThumbnailFileCard
                            checked={selected}
                            key={file.sourceKey}
                            file={file}
                            highlighted={highlightedFileKeys.has(file.sourceKey)}
                            onCheck={handleFileChecked}
                            onHighlight={handleFileHighlight}
                            size={thumbnailSize}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
          {sourceGroups.length === 0 ? (
            <div className="p-5 text-sm text-graphite">No copyable files found in this scan.</div>
          ) : null}
        </div>

        <div className="flex items-center justify-end border-t border-mist bg-porcelain/40 px-4 py-3">
          <button
            className="inline-flex h-9 items-center justify-center rounded-xl bg-signal px-4 text-sm font-semibold text-paper transition hover:bg-black"
            onClick={onClose}
            type="button"
          >
            Done
          </button>
        </div>
      </section>
    </div>
  );
}

function FileListRow({
  checked,
  file,
  highlighted,
  onCheck,
  onHighlight,
}: {
  checked: boolean;
  file: ManifestFile;
  highlighted: boolean;
  onCheck: (file: ManifestFile, checked: boolean) => void;
  onHighlight: (file: ManifestFile, shiftKey: boolean) => void;
}) {
  return (
    <div
      className={`grid min-h-9 grid-cols-[26px_82px_1fr_128px_96px] items-center gap-2 border-t border-mist/70 px-4 py-1 text-sm ${
        file.disabled
          ? "cursor-default bg-porcelain/35 text-graphite"
          : highlighted
            ? "cursor-default bg-lavender/25 text-ink ring-1 ring-inset ring-lavender/60"
            : "cursor-default text-ink hover:bg-porcelain/45"
      }`}
      onClick={(event) => onHighlight(file, event.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onHighlight(file, event.shiftKey);
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
      <SelectionMark checked={checked} disabled={file.disabled} onChange={(nextChecked) => onCheck(file, nextChecked)} />
      <span className="text-xs font-semibold text-graphite">{file.label}</span>
      <span className="min-w-0 truncate font-semibold">{file.relative_path}</span>
      <span className="text-xs font-semibold text-graphite">{formatFileTimestamp(file.modified_at)}</span>
      <span className="text-right text-xs font-semibold text-graphite">{formatBytes(file.size_bytes)}</span>
    </div>
  );
}

function ThumbnailFileCard({
  checked,
  file,
  highlighted,
  onCheck,
  onHighlight,
  size,
}: {
  checked: boolean;
  file: ManifestFile;
  highlighted: boolean;
  onCheck: (file: ManifestFile, checked: boolean) => void;
  onHighlight: (file: ManifestFile, shiftKey: boolean) => void;
  size: number;
}) {
  const thumbnailUrl = file.thumbnail_path ? convertFileSrc(file.thumbnail_path) : null;
  return (
    <div
      className={`group overflow-hidden rounded-lg border bg-white text-left shadow-sm transition ${
        highlighted ? "border-lavender ring-2 ring-lavender/50" : "border-mist hover:bg-white"
      } ${file.disabled ? "opacity-65" : "cursor-default"}`}
      onClick={(event) => onHighlight(file, event.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onHighlight(file, event.shiftKey);
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
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-graphite">
            <Image size={Math.max(18, Math.round(size * 0.18))} />
            <span className="text-[10px] font-semibold">No thumbnail</span>
          </div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded-md bg-white/90 p-1 shadow-sm">
          <SelectionMark checked={checked} disabled={file.disabled} onChange={(nextChecked) => onCheck(file, nextChecked)} />
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
    return (
      <span className="flex h-4 w-4 items-center justify-center rounded border border-signal bg-signal text-paper">
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
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-red-600"
          : "text-ink";
  return (
    <div className="rounded-xl border border-mist bg-white px-3 py-2">
      <div className="text-xs font-semibold text-graphite">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${valueClass}`}>{value}</div>
      {sub ? <div className="truncate text-[10px] font-medium text-graphite/70">{sub}</div> : null}
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
};

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
): ManifestSourceGroup[] {
  const sourceMap = new Map<string, ManifestFile[]>();
  for (const file of files) {
    const sourceFiles = sourceMap.get(file.sourcePath) ?? [];
    sourceFiles.push(file);
    sourceMap.set(file.sourcePath, sourceFiles);
  }

  return Array.from(sourceMap.entries()).map(([sourcePath, sourceFiles]) => {
    const sortedFiles = sortManifestFiles(sourceFiles, sortMode, sortDirection);
    const days = [
      {
        dayKey: "sorted",
        fileCount: sortedFiles.filter((file) => !file.disabled).length,
        files: sortedFiles,
        label: `${sortModeLabel(sortMode)} / ${sortDirectionLabel(sortMode, sortDirection)}`,
        selectableKeys: sortedFiles.filter((file) => !file.disabled).map((file) => file.sourceKey),
        sizeBytes: sortedFiles.reduce((sum, file) => sum + (file.disabled ? 0 : file.size_bytes), 0),
      },
    ];

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
  renameFiles,
  scan,
  variableValues,
}: {
  destinationPath: string;
  destinationMode: "create_new" | "existing_root";
  preset: Preset;
  renameFiles: boolean;
  scan: SourceScan | null;
  variableValues: Record<string, string>;
}): Promise<IngestOutputPreview> {
  const sampleFile = firstRoutableFile(scan);
  const sampleKind = sampleFile?.kind ?? "footage";
  const sampleExtension = sampleFile?.extension ?? ".mp4";
  const rootName = await previewPattern(preset.root_folder_pattern, {
    preset_name: preset.name,
    variable_values: variableValues,
    clip_number_padding: preset.clip_number_padding,
  });
  const resolvedRoot = destinationMode === "existing_root" ? destinationPath : joinPreviewPath(destinationPath, rootName);
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
  const patternPreview = await previewPattern(filePatternForFolder(preset, targetFolder), {
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

function filePatternForFolder(preset: Preset, folder: FolderNode | null) {
  if (folder) {
    const override = preset.per_folder_rename_overrides[folder.id];
    if (override?.trim()) {
      return override;
    }
  }
  return preset.file_rename_pattern.trim() || "{original_name}{ext}";
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
