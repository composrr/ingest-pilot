import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  FileCheck2,
  FolderOpen,
  HardDriveDownload,
  ListChecks,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FloatingHelp } from "../components/FloatingHelp";
import { SelectMenu } from "../components/SelectMenu";
import {
  defaultValueForParameter,
  defaultsForParameters,
  mergeGlobalAndPresetParameters,
} from "../lib/parameters";
import {
  cancelIngest,
  detectCameraSources,
  diskSpace,
  generateIngestReport,
  getPreset,
  getSettings,
  listPresets,
  openPath,
  previewPattern,
  runIngest,
  saveHistoryJob,
  scanSource,
  type CameraSource,
  type DiskSpace,
  type IngestProgress,
  type IngestResult,
  type ScanFileKind,
  type ScannedFile,
  type SourceScan,
} from "../lib/tauri";
import type { AppSettings, FolderNode, Preset, PresetSummary, PresetVariable } from "../lib/types";
import { useAppStore } from "../stores/appStore";

type ConsoleTab = "files" | "preview" | "routing" | "options" | "report";

export function IngestConsolePreviewPage() {
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [presetQuery, setPresetQuery] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [globalParameters, setGlobalParameters] = useState<PresetVariable[]>([]);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [sourcePath, setSourcePath] = useState("");
  const [destinationPath, setDestinationPath] = useState("");
  const [destinationMode, setDestinationMode] = useState<"create_new" | "existing_root">("create_new");
  const [detectedSources, setDetectedSources] = useState<CameraSource[]>([]);
  const [scan, setScan] = useState<SourceScan | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [destinationSpace, setDestinationSpace] = useState<DiskSpace | null | undefined>(undefined);
  const [isScanning, setIsScanning] = useState(false);
  const [activeTab, setActiveTab] = useState<ConsoleTab>("files");
  const [renameFiles, setRenameFiles] = useState(true);
  const [deleteSidecars, setDeleteSidecars] = useState(false);
  const [isIngesting, setIsIngesting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [reportState, setReportState] = useState<"idle" | "building" | "ready" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [outputPreview, setOutputPreview] = useState<ConsolePreview | null>(null);
  const activeJobId = useRef<string | null>(null);
  const setLastAction = useAppStore((state) => state.setLastAction);

  const parameters = useMemo(
    () => mergeGlobalAndPresetParameters(globalParameters, preset?.variables ?? []),
    [globalParameters, preset?.variables],
  );
  const filteredPresets = useMemo(() => {
    const query = presetQuery.trim().toLowerCase();
    return query ? presets.filter((candidate) => candidate.name.toLowerCase().includes(query)) : presets;
  }, [presetQuery, presets]);
  const routableFiles = useMemo(() => scan?.files.filter((file) => isRoutableKind(file.kind)) ?? [], [scan]);
  const selectedRoutableFiles = useMemo(
    () => routableFiles.filter((file) => selectedFiles.has(file.relative_path)),
    [routableFiles, selectedFiles],
  );
  const selectedBytes = useMemo(
    () => selectedRoutableFiles.reduce((sum, file) => sum + file.size_bytes, 0),
    [selectedRoutableFiles],
  );
  const canStart = Boolean(preset && selectedPresetId && sourcePath && destinationPath && scan && selectedFiles.size > 0);
  const selectedPreset = presets.find((candidate) => candidate.id === selectedPresetId);

  useEffect(() => {
    getSettings()
      .then((nextSettings) => {
        setSettings(nextSettings);
        setGlobalParameters(nextSettings.global_parameters);
        setRenameFiles(nextSettings.ingest_defaults.rename_files);
        setDeleteSidecars(nextSettings.ingest_defaults.delete_sidecars);
        setDestinationMode(nextSettings.ingest_defaults.destination_mode);
      })
      .catch((caught) => setError(String(caught)));
    listPresets()
      .then((nextPresets) => {
        setPresets(nextPresets);
        setSelectedPresetId(nextPresets[0]?.id ?? "");
      })
      .catch((caught) => setError(String(caught)));
  }, []);

  useEffect(() => {
    if (!selectedPresetId) {
      setPreset(null);
      return;
    }
    getPreset(selectedPresetId)
      .then((nextPreset) => {
        setPreset(nextPreset);
        if (nextPreset) {
          setDeleteSidecars(!nextPreset.preserve_xml_sidecars);
          if (!destinationPath.trim()) {
            setDestinationPath(nextPreset.destinations.primary ?? "");
          }
        }
      })
      .catch((caught) => setError(String(caught)));
  }, [selectedPresetId]);

  useEffect(() => {
    setVariableValues(defaultsForParameters(parameters));
  }, [parameters]);

  useEffect(() => {
    let cancelled = false;
    detectCameraSources()
      .then((sources) => {
        if (cancelled) return;
        setDetectedSources(sources);
        if (!sourcePath.trim() && sources[0]) {
          setSourcePath(sources[0].path);
        }
      })
      .catch(() => setDetectedSources([]));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!destinationPath.trim()) {
      setDestinationSpace(undefined);
      return;
    }
    let cancelled = false;
    setDestinationSpace(undefined);
    diskSpace(destinationPath)
      .then((space) => {
        if (!cancelled) setDestinationSpace(space);
      })
      .catch(() => {
        if (!cancelled) setDestinationSpace(null);
      });
    return () => {
      cancelled = true;
    };
  }, [destinationPath]);

  useEffect(() => {
    let cancelled = false;
    if (!preset) {
      setOutputPreview(null);
      return;
    }
    buildConsolePreview({ destinationMode, destinationPath, preset, renameFiles, scan, variableValues })
      .then((preview) => {
        if (!cancelled) setOutputPreview(preview);
      })
      .catch((caught) => {
        if (!cancelled) setOutputPreview({ project: "Preview unavailable", file: String(caught), folder: "-", path: "-" });
      });
    return () => {
      cancelled = true;
    };
  }, [destinationMode, destinationPath, preset, renameFiles, scan, variableValues]);

  async function chooseSource() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") return;
    setSourcePath(path);
    setScan(null);
    setSelectedFiles(new Set());
    setResult(null);
  }

  async function chooseDestination() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") return;
    setDestinationPath(path);
    setResult(null);
  }

  async function scanCurrentSource() {
    if (!sourcePath.trim()) {
      setError("Choose a source folder first.");
      return;
    }
    setIsScanning(true);
    setError(null);
    try {
      const nextScan = await scanSource(sourcePath);
      setScan(nextScan);
      setSelectedFiles(new Set(nextScan.files.filter((file) => isRoutableKind(file.kind)).map((file) => file.relative_path)));
      setActiveTab("files");
      setLastAction(`Console preview scanned ${nextScan.ingest_files} usable files`);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setIsScanning(false);
    }
  }

  async function startIngest() {
    if (!canStart || !preset) {
      setError(startHint({ destinationPath, preset, scan, selectedCount: selectedFiles.size, sourcePath }));
      return;
    }
    setError(null);
    setResult(null);
    setProgress(null);
    setReportState("idle");
    setIsIngesting(true);
    setIsCancelling(false);
    const jobId = createJobId();
    const startedAt = new Date().toISOString();
    activeJobId.current = jobId;
    const unlisten = await listen<IngestProgress>("ingest-progress", (event) => {
      if (event.payload.job_id === jobId) {
        setProgress(event.payload);
      }
    });
    try {
      const ingestResult = await runIngest(
        selectedPresetId,
        sourcePath,
        variableValues,
        destinationPath,
        !deleteSidecars,
        renameFiles,
        Array.from(selectedFiles),
        destinationMode === "existing_root",
        jobId,
      );
      setResult(ingestResult);
      setLastAction(`Preview console copied ${ingestResult.files_copied} files`);
      const completedAt = new Date().toISOString();
      await saveHistoryJob({
        id: jobId,
        preset_name: preset.name,
        status: ingestResult.verification_failed > 0 ? "needs_review" : "verified",
        started_at: startedAt,
        completed_at: completedAt,
        source_paths: [sourcePath],
        destination_paths: [destinationPath],
        root_path: ingestResult.root_path,
        report_path: "",
        mhl_path: ingestResult.mhl_path,
        files_copied: ingestResult.files_copied,
        verified_files: ingestResult.verified_files,
        verification_failed: ingestResult.verification_failed,
        bytes_copied: ingestResult.bytes_copied,
        sidecars_deleted: ingestResult.skipped.filter((file) => file.reason === "Sidecar deletion is enabled.").length,
      });
      if (settings?.report_defaults.write_html_report) {
        void buildReport(jobId, preset.name, startedAt, completedAt, ingestResult);
      }
    } catch (caught) {
      setError(String(caught));
    } finally {
      unlisten();
      activeJobId.current = null;
      setIsIngesting(false);
      setIsCancelling(false);
    }
  }

  async function buildReport(jobId: string, presetName: string, startedAt: string, completedAt: string, ingestResult: IngestResult) {
    setReportState("building");
    try {
      const reportPath = await generateIngestReport(
        presetName,
        sourcePath,
        ingestResult.root_path,
        variableValues,
        ingestResult.copied_files,
        ingestResult.skipped,
        ingestResult.files_copied,
        ingestResult.verified_files,
        ingestResult.verification_failed,
        ingestResult.bytes_copied,
        ingestResult.mhl_path,
        `${jobId}-report`,
      );
      setResult((current) => (current ? { ...current, report_path: reportPath } : current));
      setReportState("ready");
      await saveHistoryJob({
        id: jobId,
        preset_name: presetName,
        status: ingestResult.verification_failed > 0 ? "needs_review" : "verified",
        started_at: startedAt,
        completed_at: completedAt,
        source_paths: [sourcePath],
        destination_paths: [destinationPath],
        root_path: ingestResult.root_path,
        report_path: reportPath,
        mhl_path: ingestResult.mhl_path,
        files_copied: ingestResult.files_copied,
        verified_files: ingestResult.verified_files,
        verification_failed: ingestResult.verification_failed,
        bytes_copied: ingestResult.bytes_copied,
        sidecars_deleted: ingestResult.skipped.filter((file) => file.reason === "Sidecar deletion is enabled.").length,
      });
    } catch {
      setReportState("failed");
    }
  }

  async function cancelCurrentIngest() {
    const jobId = activeJobId.current;
    if (!jobId) return;
    setIsCancelling(true);
    await cancelIngest(jobId);
  }

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[24px] border border-mist bg-paper p-2 shadow-panel">
      <header className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-graphite/70">Preview branch / Production Console concept</p>
          <h1 className="text-xl font-semibold tracking-normal">Ingest Console</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite hover:bg-porcelain disabled:opacity-40"
            disabled={!sourcePath || isScanning || isIngesting}
            onClick={() => void scanCurrentSource()}
            type="button"
          >
            <RefreshCw className={isScanning ? "animate-spin" : ""} size={14} />
            {scan ? "Rescan" : "Scan"}
          </button>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite hover:bg-porcelain"
            onClick={() => setActiveTab("options")}
            type="button"
          >
            <Settings2 size={14} />
            Options
          </button>
        </div>
      </header>

      {error ? (
        <div className="mb-2 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
          <span>{error}</span>
          <button onClick={() => setError(null)} type="button">
            <X size={14} />
          </button>
        </div>
      ) : null}

      <section className="mb-2 rounded-2xl border border-mist bg-white p-2">
        <div className="grid gap-2 xl:grid-cols-[190px_minmax(0,1fr)_minmax(0,1fr)_180px]">
          <label className="min-w-0">
            <CompactLabel>Preset</CompactLabel>
            <SelectMenu
              disabled={presets.length === 0}
              onChange={setSelectedPresetId}
              options={presets.map((candidate) => ({ label: candidate.name, value: candidate.id }))}
              value={selectedPresetId}
            />
          </label>
          <PathPicker label="Copy From" onPick={() => void chooseSource()} value={sourcePath} />
          <PathPicker label={destinationMode === "existing_root" ? "Use Folder" : "Copy To"} onPick={() => void chooseDestination()} value={destinationPath} />
          <div className="min-w-0">
            <CompactLabel>Destination Space</CompactLabel>
            <div className="flex h-9 items-center rounded-xl border border-mist bg-porcelain/50 px-3 text-xs font-semibold text-graphite">
              {destinationSpaceText(destinationPath, destinationSpace, selectedBytes)}
            </div>
          </div>
        </div>
        <ConsoleVariableStrip
          onVariableChange={(id, value) => setVariableValues((current) => ({ ...current, [id]: value }))}
          parameters={parameters}
          variableValues={variableValues}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-mist bg-porcelain/45 px-2 py-1.5">
          <span className="mr-1 text-xs font-semibold text-graphite">Copy behavior</span>
          <div className="grid grid-cols-2 rounded-lg border border-mist bg-white p-0.5">
            <button className={`h-7 rounded-md px-2 text-xs font-semibold ${destinationMode === "create_new" ? "bg-black text-white shadow-sm" : "text-graphite hover:bg-porcelain"}`} onClick={() => setDestinationMode("create_new")} type="button">
              Create new folder
            </button>
            <button className={`h-7 rounded-md px-2 text-xs font-semibold ${destinationMode === "existing_root" ? "bg-black text-white shadow-sm" : "text-graphite hover:bg-porcelain"}`} onClick={() => setDestinationMode("existing_root")} type="button">
              Use existing folder
            </button>
          </div>
          <InlineCheckbox checked={renameFiles} label="Rename files" onChange={setRenameFiles} />
          <InlineCheckbox checked={deleteSidecars} label="Delete sidecars" onChange={setDeleteSidecars} />
          <span className="min-w-[180px] flex-1 truncate text-right text-[11px] font-semibold text-graphite">
            {renameFiles ? "Preset filename pattern active" : "Original filenames kept"} / {deleteSidecars ? "sidecars skipped" : "sidecars kept"}
          </span>
        </div>
      </section>

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[190px_minmax(0,1fr)_300px]">
        <aside className="min-h-0 overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="border-b border-mist p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-graphite/55" size={13} />
              <input
                className="h-8 w-full rounded-lg border border-mist bg-white pl-7 pr-2 text-xs font-medium outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                onChange={(event) => setPresetQuery(event.target.value)}
                placeholder="Search presets"
                value={presetQuery}
              />
            </div>
          </div>
          <div className="max-h-[calc(100vh-250px)] overflow-auto p-1.5">
            {filteredPresets.map((candidate) => (
              <button
                key={candidate.id}
                className={`mb-1 flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-semibold transition ${
                  candidate.id === selectedPresetId ? "bg-lavender/25 text-ink ring-1 ring-lavender" : "text-graphite hover:bg-porcelain"
                }`}
                onClick={() => setSelectedPresetId(candidate.id)}
                type="button"
              >
                <span className="h-3 w-3 rounded-full border border-black/10" style={{ backgroundColor: presetColor(candidate.color) }} />
                <span className="min-w-0 truncate">{candidate.name}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-h-0 overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="flex h-9 items-center justify-between border-b border-mist px-2">
            <div className="flex gap-1">
              <ConsoleTabButton active={activeTab === "files"} icon={FileCheck2} label="Files" onClick={() => setActiveTab("files")} />
              <ConsoleTabButton active={activeTab === "preview"} icon={FolderOpen} label="Preview" onClick={() => setActiveTab("preview")} />
              <ConsoleTabButton active={activeTab === "routing"} icon={ListChecks} label="Routing" onClick={() => setActiveTab("routing")} />
              <ConsoleTabButton active={activeTab === "options"} icon={SlidersHorizontal} label="Options" onClick={() => setActiveTab("options")} />
              <ConsoleTabButton active={activeTab === "report"} icon={CheckCircle2} label="Report" onClick={() => setActiveTab("report")} />
            </div>
            <span className="text-xs font-semibold text-graphite">
              {scan ? `${selectedFiles.size}/${routableFiles.length} files selected` : "Scan source to review files"}
            </span>
          </div>
          <div className="h-[calc(100%-36px)] min-h-0 overflow-auto">
            {activeTab === "files" ? (
              <FilesPanel files={routableFiles} selectedFiles={selectedFiles} setSelectedFiles={setSelectedFiles} />
            ) : activeTab === "preview" ? (
              <StructurePreviewPanel
                deleteSidecars={deleteSidecars}
                destinationMode={destinationMode}
                destinationPath={destinationPath}
                files={routableFiles}
                preset={preset}
                renameFiles={renameFiles}
                selectedFiles={selectedFiles}
                variableValues={variableValues}
              />
            ) : activeTab === "routing" ? (
              <RoutingPanel preset={preset} scan={scan} deleteSidecars={deleteSidecars} />
            ) : activeTab === "options" ? (
              <OptionsPanel
                onVariableChange={(id, value) => setVariableValues((current) => ({ ...current, [id]: value }))}
                parameters={parameters}
                variableValues={variableValues}
              />
            ) : (
              <ReportPanel reportState={reportState} result={result} />
            )}
          </div>
        </main>

        <aside className="min-h-0 overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="flex h-9 items-center justify-between border-b border-mist px-3">
            <h2 className="text-sm font-semibold">Ready Panel</h2>
            <span className="text-xs font-semibold text-graphite">{selectedPreset?.name ?? "No preset"}</span>
          </div>
          <div className="space-y-2 p-2">
            <StatusCard label="Project" value={outputPreview?.project ?? "-"} />
            <StatusCard label="Folder" value={outputPreview?.folder ?? "-"} />
            <StatusCard label="File" value={outputPreview?.file ?? "-"} />
            <StatusCard label="Path" value={outputPreview?.path ?? "-"} />
            <div className="grid grid-cols-2 gap-2">
              <MiniStat label="Selected" value={String(selectedFiles.size)} />
              <MiniStat label="Size" value={formatBytes(selectedBytes)} />
              <MiniStat label="Usable" value={String(scan?.ingest_files ?? 0)} />
              <MiniStat label="Sidecars" value={String(scan?.sidecar_files ?? 0)} />
            </div>
            {detectedSources.length > 0 ? (
              <div className="rounded-xl border border-mist bg-porcelain/45 p-2 text-[11px] font-semibold text-graphite">
                Camera source detected: {detectedSources[0].label}
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <footer className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-mist bg-white p-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-ink">{isIngesting ? progress?.phase ?? "Copying" : startHint({ destinationPath, preset, scan, selectedCount: selectedFiles.size, sourcePath })}</div>
          <div className="mt-1 h-2 w-[320px] max-w-[70vw] overflow-hidden rounded-full bg-porcelain">
            <div className="h-full rounded-full bg-lavender transition-all" style={{ width: `${progress ? progressPercent(progress) : canStart ? 100 : 0}%` }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {result?.root_path ? (
            <button className="h-10 rounded-xl border border-mist px-3 text-sm font-semibold text-graphite hover:bg-porcelain" onClick={() => void openPath(result.root_path)} type="button">
              Open Folder
            </button>
          ) : null}
          {isIngesting ? (
            <button
              className="h-11 rounded-xl border border-red-200 bg-red-50 px-5 text-base font-semibold text-red-800 hover:bg-red-100 disabled:opacity-50"
              disabled={isCancelling}
              onClick={() => void cancelCurrentIngest()}
              type="button"
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </button>
          ) : (
            <button
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-black px-6 text-base font-semibold text-white shadow-sm transition hover:bg-ink disabled:cursor-not-allowed disabled:bg-graphite/35"
              disabled={!canStart}
              onClick={() => void startIngest()}
              type="button"
            >
              <HardDriveDownload size={18} />
              Start Ingest
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function PathPicker({ label, onPick, value }: { label: string; onPick: () => void; value: string }) {
  return (
    <label className="min-w-0">
      <CompactLabel>{label}</CompactLabel>
      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <input className="h-9 min-w-0 rounded-xl border border-mist bg-white px-3 text-sm outline-none" readOnly value={value} />
        <button className="inline-flex h-9 items-center gap-1 rounded-xl border border-mist px-2 text-xs font-semibold text-graphite hover:bg-porcelain" onClick={onPick} type="button">
          <FolderOpen size={14} />
          Pick
        </button>
      </div>
    </label>
  );
}

function CompactLabel({ children }: { children: string }) {
  return <span className="mb-1 block text-xs font-semibold text-graphite">{children}</span>;
}

function InlineCheckbox({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <label className="inline-flex h-8 cursor-pointer select-none items-center gap-1.5 px-1.5 text-xs font-semibold text-graphite">
      <input checked={checked} className="h-3.5 w-3.5 cursor-pointer accent-black" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      {label}
    </label>
  );
}

function ConsoleVariableStrip({
  onVariableChange,
  parameters,
  variableValues,
}: {
  onVariableChange: (id: string, value: string) => void;
  parameters: PresetVariable[];
  variableValues: Record<string, string>;
}) {
  if (parameters.length === 0) return null;
  return (
    <div className="mt-2 grid gap-2 rounded-xl border border-mist bg-white px-2 py-2 md:grid-cols-[110px_1fr]">
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-xs font-semibold text-graphite">
          Job fields
          <FloatingHelp label="Job fields help" size={12}>These values feed the preset tokens used in folder names and copied file names.</FloatingHelp>
        </div>
        <div className="mt-0.5 text-[11px] font-semibold text-graphite/70">Naming tokens</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {parameters.map((parameter) => (
          <label key={parameter.id} className="min-w-0">
            <span className="mb-1 flex min-w-0 items-center gap-1 text-[11px] font-semibold text-graphite">
              <span className="truncate">{parameter.name}</span>
              <code className="rounded bg-porcelain px-1 py-0.5 font-mono text-[10px] text-graphite">{`{${parameter.id}}`}</code>
            </span>
            <ParameterInput parameter={parameter} value={variableValues[parameter.id] ?? defaultValueForParameter(parameter)} onChange={(value) => onVariableChange(parameter.id, value)} />
          </label>
        ))}
      </div>
    </div>
  );
}

function ConsoleTabButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof FileCheck2; label: string; onClick: () => void }) {
  return (
    <button
      className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition ${active ? "bg-porcelain text-ink ring-1 ring-mist" : "text-graphite hover:bg-porcelain/70"}`}
      onClick={onClick}
      type="button"
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

type FileColumnId = "name" | "captured" | "size" | "path" | "type";

type FileColumnState = {
  id: FileColumnId;
  label: string;
  visible: boolean;
  width: string;
};

const defaultFileColumns: FileColumnState[] = [
  { id: "name", label: "Name", visible: true, width: "1.25fr" },
  { id: "captured", label: "Date captured", visible: true, width: "150px" },
  { id: "size", label: "Size", visible: true, width: "90px" },
  { id: "path", label: "Source path", visible: true, width: "1fr" },
  { id: "type", label: "Type", visible: false, width: "90px" },
];

function FilesPanel({ files, selectedFiles, setSelectedFiles }: { files: ScannedFile[]; selectedFiles: Set<string>; setSelectedFiles: (value: Set<string>) => void }) {
  const [columns, setColumns] = useState<FileColumnState[]>(defaultFileColumns);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null);
  const visibleColumns = columns.filter((column) => column.visible);
  const gridTemplateColumns = `38px ${visibleColumns.map((column) => column.width).join(" ")}`;

  useEffect(() => {
    if (!columnMenu) return;
    function closeMenu() {
      setColumnMenu(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [columnMenu]);

  if (files.length === 0) {
    return <EmptyPanel title="No files scanned" body="Choose a source and scan it to see the files that will copy." />;
  }
  function toggle(relativePath: string) {
    const next = new Set(selectedFiles);
    if (next.has(relativePath)) next.delete(relativePath);
    else next.add(relativePath);
    setSelectedFiles(next);
  }
  function toggleColumn(id: FileColumnId) {
    setColumns((current) => {
      const visibleCount = current.filter((column) => column.visible).length;
      return current.map((column) => {
        if (column.id !== id) return column;
        if (column.visible && visibleCount === 1) return column;
        return { ...column, visible: !column.visible };
      });
    });
  }
  function moveColumn(id: FileColumnId, direction: -1 | 1) {
    setColumns((current) => {
      const index = current.findIndex((column) => column.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }
  function renderCell(file: ScannedFile, id: FileColumnId) {
    if (id === "name") return <span className="truncate font-semibold text-ink">{file.file_name}</span>;
    if (id === "captured") return <span className="truncate font-semibold text-graphite">{formatCapturedDate(file.modified_at)}</span>;
    if (id === "size") return <span className="font-semibold text-graphite">{formatBytes(file.size_bytes)}</span>;
    if (id === "type") return <span className="font-semibold text-graphite">{labelForKind(file.kind)}</span>;
    return <span className="truncate text-graphite">{file.relative_path}</span>;
  }
  return (
    <div className="relative min-w-[820px]">
      <div
        className="grid cursor-default border-b border-mist bg-porcelain px-3 py-2 text-xs font-semibold text-graphite"
        onContextMenu={(event) => {
          event.preventDefault();
          setColumnMenu({ x: event.clientX, y: event.clientY });
        }}
        style={{ gridTemplateColumns }}
        title="Right-click to choose and reorder columns"
      >
        <div />
        {visibleColumns.map((column) => (
          <div key={column.id} className="flex min-w-0 items-center gap-1">
            <span className="truncate">{column.label}</span>
            {column.id === "captured" ? <span className="font-normal text-graphite/65">+ time</span> : null}
          </div>
        ))}
      </div>
      {files.map((file) => (
        <label
          key={file.relative_path}
          className="grid min-h-9 items-center border-b border-mist px-3 py-1 text-xs last:border-b-0 hover:bg-porcelain/55"
          style={{ gridTemplateColumns }}
          title={`${file.file_name}\n${formatCapturedDate(file.modified_at)}\n${file.relative_path}`}
        >
          <input checked={selectedFiles.has(file.relative_path)} className="h-4 w-4 accent-black" onChange={() => toggle(file.relative_path)} type="checkbox" />
          {visibleColumns.map((column) => (
            <span key={column.id} className="min-w-0 pr-3">
              {renderCell(file, column.id)}
            </span>
          ))}
        </label>
      ))}
      {columnMenu ? (
        <div
          className="fixed z-50 w-64 overflow-hidden rounded-xl border border-mist bg-white text-xs shadow-2xl"
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            left: Math.min(columnMenu.x, window.innerWidth - 280),
            top: Math.min(columnMenu.y, window.innerHeight - 300),
          }}
        >
          <div className="flex items-center justify-between border-b border-mist bg-porcelain px-3 py-2 font-semibold text-ink">
            <span className="inline-flex items-center gap-1.5">
              <SlidersHorizontal size={13} />
              Columns
            </span>
            <button className="rounded-md px-1.5 py-0.5 text-graphite hover:bg-white" onClick={() => setColumnMenu(null)} type="button">
              <X size={13} />
            </button>
          </div>
          <div className="p-1">
            {columns.map((column, index) => (
              <div key={column.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-1 rounded-lg px-2 py-1 hover:bg-porcelain">
                <label className="flex min-w-0 items-center gap-2 font-semibold text-graphite">
                  <input checked={column.visible} className="h-3.5 w-3.5 accent-black" onChange={() => toggleColumn(column.id)} type="checkbox" />
                  <span className="truncate">{column.label}</span>
                </label>
                <button className="rounded-md px-1.5 py-0.5 text-graphite hover:bg-white disabled:opacity-30" disabled={index === 0} onClick={() => moveColumn(column.id, -1)} type="button">
                  Up
                </button>
                <button className="rounded-md px-1.5 py-0.5 text-graphite hover:bg-white disabled:opacity-30" disabled={index === columns.length - 1} onClick={() => moveColumn(column.id, 1)} type="button">
                  Down
                </button>
              </div>
            ))}
          </div>
          <div className="border-t border-mist px-3 py-2 text-graphite">Right-click the header anytime to adjust this file list.</div>
        </div>
      ) : null}
    </div>
  );
}

type StructurePreview = {
  projectRoot: string;
  rootName: string;
  folders: ResolvedFolderNode[];
  routes: PreviewRoute[];
};

type ResolvedFolderNode = {
  id: string;
  name: string;
  role?: string | null;
  isTarget: boolean;
  children: ResolvedFolderNode[];
  templateFiles: string[];
};

type PreviewRoute = {
  source: string;
  file: string;
  folder: string;
  path: string;
  kind: ScanFileKind;
};

function StructurePreviewPanel({
  deleteSidecars,
  destinationMode,
  destinationPath,
  files,
  preset,
  renameFiles,
  selectedFiles,
  variableValues,
}: {
  deleteSidecars: boolean;
  destinationMode: "create_new" | "existing_root";
  destinationPath: string;
  files: ScannedFile[];
  preset: Preset | null;
  renameFiles: boolean;
  selectedFiles: Set<string>;
  variableValues: Record<string, string>;
}) {
  const [preview, setPreview] = useState<StructurePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!preset) {
      setPreview(null);
      return;
    }
    buildStructurePreview({
      destinationMode,
      destinationPath,
      files: files.filter((file) => selectedFiles.has(file.relative_path)),
      preset,
      renameFiles,
      variableValues,
    })
      .then((nextPreview) => {
        if (!cancelled) {
          setPreview(nextPreview);
          setError(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [destinationMode, destinationPath, files, preset, renameFiles, selectedFiles, variableValues]);

  if (!preset) {
    return <EmptyPanel title="No preset selected" body="Choose a preset to preview its folder structure and file destinations." />;
  }
  if (error) {
    return <EmptyPanel title="Preview unavailable" body={error} />;
  }
  if (!preview) {
    return <EmptyPanel title="Building preview" body="Resolving folder and filename tokens with the current job variables." />;
  }

  return (
    <div className="grid min-w-[860px] gap-2 p-2 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
      <section className="overflow-hidden rounded-xl border border-mist">
        <div className="flex h-8 items-center justify-between border-b border-mist bg-porcelain px-3 text-xs font-semibold text-graphite">
          <span>Folder Structure Preview</span>
          <span className="truncate pl-3 font-mono">{preview.projectRoot || preview.rootName}</span>
        </div>
        <div className="p-2 text-xs">
          <div className="mb-1 flex min-h-7 items-center gap-2 rounded-lg bg-lavender/20 px-2 font-semibold text-ink">
            <FolderOpen size={14} />
            <span className="truncate">{preview.rootName}</span>
          </div>
          <div className="pl-3">
            {preview.folders.length > 0 ? (
              preview.folders.map((folder) => <PreviewFolderNode key={folder.id} folder={folder} level={0} />)
            ) : (
              <p className="px-2 py-3 text-graphite">This preset has no folders yet.</p>
            )}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-mist">
        <div className="flex h-8 items-center justify-between border-b border-mist bg-porcelain px-3 text-xs font-semibold text-graphite">
          <span>Selected File Destinations</span>
          <span>{preview.routes.length} shown</span>
        </div>
        {preview.routes.length === 0 ? (
          <div className="p-3 text-sm text-graphite">Select files on the Files tab to preview exact destinations.</div>
        ) : (
          <div className="divide-y divide-mist">
            {preview.routes.map((route) => (
              <div key={`${route.source}-${route.path}`} className="grid grid-cols-[70px_1fr] gap-2 px-3 py-2 text-xs">
                <span className="font-semibold text-graphite">{labelForKind(route.kind)}</span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-ink">{route.file}</span>
                  <span className="block truncate text-graphite">{route.path}</span>
                  <span className="block truncate text-[11px] text-graphite/70">from {route.source}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-mist bg-porcelain/45 px-3 py-2 text-[11px] font-semibold text-graphite">
          Sidecars are {deleteSidecars ? "skipped during copy" : "kept with matching selected media"}.
        </div>
      </section>
    </div>
  );
}

function PreviewFolderNode({ folder, level }: { folder: ResolvedFolderNode; level: number }) {
  const tint = folder.role === "audio" ? "text-blue-700" : folder.role === "photos" ? "text-emerald-700" : folder.role === "documents" ? "text-violet-700" : "text-amber-700";
  return (
    <div>
      <div className="flex min-h-7 items-center gap-2 rounded-lg px-2 font-semibold text-ink hover:bg-porcelain/65" style={{ marginLeft: `${level * 16}px` }}>
        <FolderOpen className={tint} size={14} />
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        {folder.isTarget ? <span className="rounded-full bg-mint/45 px-1.5 py-0.5 text-[10px] font-bold text-green-800">TARGET</span> : null}
        {folder.role ? <span className="text-[10px] uppercase text-graphite/70">{folder.role}</span> : null}
      </div>
      {folder.templateFiles.map((file) => (
        <div key={`${folder.id}-${file}`} className="flex min-h-6 items-center gap-2 rounded-lg px-2 text-xs text-graphite" style={{ marginLeft: `${level * 16 + 22}px` }}>
          <FileCheck2 size={12} />
          <span className="truncate">{file}</span>
        </div>
      ))}
      {folder.children.map((child) => (
        <PreviewFolderNode key={child.id} folder={child} level={level + 1} />
      ))}
    </div>
  );
}

function RoutingPanel({ deleteSidecars, preset, scan }: { deleteSidecars: boolean; preset: Preset | null; scan: SourceScan | null }) {
  if (!scan) {
    return <EmptyPanel title="No routing yet" body="Scan a source to see how file types route into the selected preset." />;
  }
  return (
    <div className="min-w-[620px]">
      <div className="grid grid-cols-[90px_90px_100px_1fr] border-b border-mist bg-porcelain px-3 py-2 text-xs font-semibold text-graphite">
        <div>Extension</div>
        <div>Files</div>
        <div>Role</div>
        <div>Destination</div>
      </div>
      {scan.extensions.map((extension) => (
        <div key={`${extension.kind}-${extension.extension}`} className="grid min-h-9 grid-cols-[90px_90px_100px_1fr] items-center border-b border-mist px-3 py-1 text-xs last:border-b-0">
          <span className="font-mono font-semibold text-ink">{extension.extension || "(none)"}</span>
          <span className="font-semibold text-graphite">{extension.count}</span>
          <span className="font-semibold text-graphite">{labelForKind(extension.kind)}</span>
          <span className="truncate text-graphite">{routingLabel(preset, extension.kind, deleteSidecars)}</span>
        </div>
      ))}
    </div>
  );
}

function OptionsPanel({
  onVariableChange,
  parameters,
  variableValues,
}: {
  onVariableChange: (id: string, value: string) => void;
  parameters: PresetVariable[];
  variableValues: Record<string, string>;
}) {
  return (
    <div className="grid gap-2 p-2">
      <section className="overflow-hidden rounded-xl border border-mist">
        <div className="flex items-center justify-between border-b border-mist bg-porcelain px-3 py-2 text-xs font-semibold text-graphite">
          <span>Job Variables</span>
          <span>{parameters.length} vars</span>
        </div>
        {parameters.length === 0 ? (
          <div className="p-3 text-sm text-graphite">This preset has no variables.</div>
        ) : (
          parameters.map((parameter) => (
            <label key={parameter.id} className="grid min-h-10 grid-cols-[150px_1fr] items-center gap-2 border-b border-mist px-3 py-1.5 text-xs last:border-b-0">
              <span className="min-w-0">
                <span className="flex items-center gap-1 font-semibold text-ink">
                  <span className="truncate">{parameter.name}</span>
                  <FloatingHelp label={`${parameter.name} help`} size={12}>Used by folder names, file names, and conditions when this preset runs.</FloatingHelp>
                </span>
                <code className="text-graphite">{`{${parameter.id}}`}</code>
              </span>
              <ParameterInput parameter={parameter} value={variableValues[parameter.id] ?? defaultValueForParameter(parameter)} onChange={(value) => onVariableChange(parameter.id, value)} />
            </label>
          ))
        )}
      </section>
    </div>
  );
}

function ReportPanel({ reportState, result }: { reportState: string; result: IngestResult | null }) {
  if (!result) {
    return <EmptyPanel title="No completed ingest" body="Run an ingest to see verification and report output here." />;
  }
  return (
    <div className="grid gap-2 p-2 md:grid-cols-4">
      <MiniStat label="Copied" value={String(result.files_copied)} />
      <MiniStat label="Verified" value={`${result.verified_files}/${result.files_copied}`} />
      <MiniStat label="Failed" value={String(result.verification_failed)} />
      <MiniStat label="Report" value={reportState} />
    </div>
  );
}

function ParameterInput({ onChange, parameter, value }: { onChange: (value: string) => void; parameter: PresetVariable; value: string }) {
  if (parameter.type === "dropdown" && parameter.options.length > 0) {
    return <SelectMenu onChange={onChange} options={parameter.options.map((option) => ({ label: option, value: option }))} value={value} />;
  }
  if (parameter.type === "boolean") {
    return <SelectMenu onChange={onChange} options={[{ label: "False", value: "false" }, { label: "True", value: "true" }]} value={value || "false"} />;
  }
  return (
    <input
      className="h-8 min-w-0 rounded-lg border border-mist px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
      onChange={(event) => onChange(event.target.value)}
      type={parameter.type === "date" ? "date" : "text"}
      value={value}
    />
  );
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-mist bg-porcelain/40 p-2">
      <div className="text-[11px] font-semibold text-graphite">{label}</div>
      <div className="mt-1 truncate text-xs font-semibold text-ink" title={value}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-mist bg-white p-2">
      <div className="text-[11px] font-semibold text-graphite">{label}</div>
      <div className="mt-1 truncate text-base font-semibold text-ink">{value}</div>
    </div>
  );
}

function EmptyPanel({ body, title }: { body: string; title: string }) {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center p-6 text-center">
      <div>
        <div className="text-sm font-semibold text-ink">{title}</div>
        <p className="mt-1 max-w-sm text-xs leading-5 text-graphite">{body}</p>
      </div>
    </div>
  );
}

type ConsolePreview = {
  project: string;
  folder: string;
  file: string;
  path: string;
};

async function buildConsolePreview({
  destinationMode,
  destinationPath,
  preset,
  renameFiles,
  scan,
  variableValues,
}: {
  destinationMode: "create_new" | "existing_root";
  destinationPath: string;
  preset: Preset;
  renameFiles: boolean;
  scan: SourceScan | null;
  variableValues: Record<string, string>;
}): Promise<ConsolePreview> {
  const sample = scan?.files.find((file) => isRoutableKind(file.kind)) ?? null;
  const root = await previewPattern(preset.root_folder_pattern, {
    preset_name: preset.name,
    variable_values: variableValues,
    clip_number_padding: preset.clip_number_padding,
  });
  const project = destinationMode === "existing_root" ? destinationPath || "Existing folder" : joinPreviewPath(destinationPath, root);
  const folderPath = routeFolderPathForKind(preset.folder_tree, sample?.kind ?? "footage");
  const folderParts = await Promise.all(
    folderPath.map((folder) =>
      previewPattern(folder.name_pattern, {
        preset_name: preset.name,
        variable_values: variableValues,
        clip_number_padding: preset.clip_number_padding,
      }),
    ),
  );
  const folder = folderParts[folderParts.length - 1] ?? "Footage";
  const pattern = preset.file_rename_pattern.trim() || "{original_name}{ext}";
  const sampleExtension = sample?.extension ?? ".mp4";
  const previewName = renameFiles
    ? await previewPattern(pattern, {
        preset_name: preset.name,
        variable_values: variableValues,
        camera: cameraHintForPreview(sample),
        clip_number: 1,
        clip_number_padding: preset.clip_number_padding,
        original_name: sample?.stem ?? "C0001",
        capture_date: "20260424",
        extension: sampleExtension,
        folder_name: folder,
      })
    : sample?.file_name ?? `C0001${sampleExtension}`;
  const file = ensurePreviewExtension(previewName, sampleExtension);
  const folderRoute = folderParts.reduce((path, part) => joinPreviewPath(path, part), "");
  return {
    project,
    folder,
    file,
    path: joinPreviewPath(project, folderRoute),
  };
}

async function buildStructurePreview({
  destinationMode,
  destinationPath,
  files,
  preset,
  renameFiles,
  variableValues,
}: {
  destinationMode: "create_new" | "existing_root";
  destinationPath: string;
  files: ScannedFile[];
  preset: Preset;
  renameFiles: boolean;
  variableValues: Record<string, string>;
}): Promise<StructurePreview> {
  const rootName = await previewPattern(preset.root_folder_pattern, {
    preset_name: preset.name,
    variable_values: variableValues,
    clip_number_padding: preset.clip_number_padding,
  });
  const projectRoot = destinationMode === "existing_root" ? destinationPath || "Existing folder" : joinPreviewPath(destinationPath, rootName);
  const folders = await resolvePreviewFolders(preset.folder_tree, preset, variableValues);
  const routes = await Promise.all(
    files.slice(0, 12).map(async (file, index) => {
      const folderPath = routeFolderPathForKind(preset.folder_tree, file.kind);
      const folderParts = await Promise.all(
        folderPath.map((folder) =>
          previewPattern(folder.name_pattern, {
            preset_name: preset.name,
            variable_values: variableValues,
            clip_number_padding: preset.clip_number_padding,
          }),
        ),
      );
      const finalFolder = folderParts[folderParts.length - 1] ?? "Footage";
      const finalFolderNode = folderPath[folderPath.length - 1];
      const pattern = (finalFolderNode ? preset.per_folder_rename_overrides[finalFolderNode.id] : "")?.trim() || preset.file_rename_pattern.trim() || "{original_name}{ext}";
      const renamed = renameFiles
        ? await previewPattern(pattern, {
            preset_name: preset.name,
            variable_values: variableValues,
            camera: cameraHintForPreview(file),
            clip_number: index + 1,
            clip_number_padding: preset.clip_number_padding,
            original_name: file.stem,
            capture_date: formatTokenDate(file.modified_at),
            extension: file.extension,
            folder_name: finalFolder,
          })
        : file.file_name;
      const fileName = renameFiles ? ensurePreviewExtension(renamed, file.extension) : file.file_name;
      const folderRoute = folderParts.reduce((path, part) => joinPreviewPath(path, part), "");
      const destinationFolder = joinPreviewPath(projectRoot, folderRoute);
      return {
        source: file.relative_path,
        file: fileName,
        folder: finalFolder,
        path: joinPreviewPath(destinationFolder, fileName),
        kind: file.kind,
      };
    }),
  );
  return {
    folders,
    projectRoot,
    rootName: destinationMode === "existing_root" ? pathBaseName(destinationPath) || "Existing folder" : rootName,
    routes,
  };
}

async function resolvePreviewFolders(folders: FolderNode[], preset: Preset, variableValues: Record<string, string>): Promise<ResolvedFolderNode[]> {
  return Promise.all(
    folders.map(async (folder) => {
      const name = await previewPattern(folder.name_pattern, {
        preset_name: preset.name,
        variable_values: variableValues,
        clip_number_padding: preset.clip_number_padding,
      });
      const templateFiles = await Promise.all(folder.template_files.map((file) => previewTemplateFileName(file.source_path, file.name_from_folder, file.rename_pattern, name, preset, variableValues)));
      return {
        id: folder.id,
        name,
        role: folder.role,
        isTarget: folder.is_footage_destination,
        templateFiles,
        children: await resolvePreviewFolders(folder.children, preset, variableValues),
      };
    }),
  );
}

async function previewTemplateFileName(sourcePath: string, nameFromFolder: boolean, renamePattern: string | null | undefined, folderName: string, preset: Preset, variableValues: Record<string, string>) {
  const sourceName = pathBaseName(sourcePath) || "Template file";
  const extension = extensionFromName(sourceName);
  if (nameFromFolder) return `${folderName}${extension}`;
  if (!renamePattern?.trim()) return sourceName;
  const renamed = await previewPattern(renamePattern, {
    preset_name: preset.name,
    variable_values: variableValues,
    clip_number_padding: preset.clip_number_padding,
    original_name: stemFromName(sourceName),
    extension,
    folder_name: folderName,
  });
  return ensurePreviewExtension(renamed, extension);
}

function routeFolderPathForKind(folders: FolderNode[], kind: ScanFileKind, parents: FolderNode[] = []): FolderNode[] {
  const targetRole = kind === "audio" ? "audio" : kind === "photo" ? "photos" : kind === "document" ? "documents" : "footage";
  let match: FolderNode[] = [];
  for (const folder of folders) {
    const path = [...parents, folder];
    if (targetRole === "footage" ? folder.is_footage_destination || folder.role === "footage" : folder.role === targetRole) {
      match = path;
    }
    const child = routeFolderPathForKind(folder.children, kind, path);
    if (child.length > 0) match = child;
  }
  return match.length > 0 ? match : folders[0] ? [folders[0]] : [];
}

function isRoutableKind(kind: ScanFileKind) {
  return kind === "footage" || kind === "photo" || kind === "audio" || kind === "document";
}

function labelForKind(kind: ScanFileKind) {
  return kind === "footage" ? "Footage" : kind === "photo" ? "Photos" : kind === "audio" ? "Audio" : kind === "document" ? "Docs" : kind === "sidecar" ? "Sidecar" : "Review";
}

function routingLabel(preset: Preset | null, kind: ScanFileKind, deleteSidecars: boolean) {
  if (kind === "ignored") return "Filtered";
  if (kind === "unknown") return "Needs route";
  if (kind === "sidecar") return deleteSidecars ? "Deleted" : "Kept with media";
  if (!preset) return "Choose preset";
  return routeFolderPathForKind(preset.folder_tree, kind).map((folder) => folder.name_pattern).join(" / ") || "Preset default";
}

function destinationSpaceText(path: string, space: DiskSpace | null | undefined, requiredBytes: number) {
  if (!path.trim()) return "Choose destination";
  if (typeof space === "undefined") return "Checking space...";
  if (space === null) return "Could not read space";
  if (requiredBytes <= 0) return `${formatBytes(space.available_bytes)} available`;
  const remaining = space.available_bytes - requiredBytes;
  return remaining < 0 ? `${formatBytes(Math.abs(remaining))} short` : `${formatBytes(remaining)} left`;
}

function startHint({
  destinationPath,
  preset,
  scan,
  selectedCount,
  sourcePath,
}: {
  destinationPath: string;
  preset: Preset | null;
  scan: SourceScan | null;
  selectedCount: number;
  sourcePath: string;
}) {
  if (!preset) return "Choose a preset";
  if (!sourcePath.trim()) return "Choose a source";
  if (!destinationPath.trim()) return "Choose a destination";
  if (!scan) return "Scan source";
  if (selectedCount === 0) return "Choose files";
  return "Ready to ingest";
}

function progressPercent(progress: IngestProgress) {
  if (progress.total_bytes > 0) return Math.min(100, Math.round((progress.bytes_done / progress.total_bytes) * 100));
  if (progress.total_files > 0) return Math.min(100, Math.round((progress.files_done / progress.total_files) * 100));
  return progress.phase === "Complete" ? 100 : 0;
}

function formatCapturedDate(value?: string | null) {
  const date = parseFileDate(value);
  if (!date) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatTokenDate(value?: string | null) {
  const date = parseFileDate(value) ?? new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function parseFileDate(value?: string | null) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pathBaseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function extensionFromName(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

function stemFromName(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function presetColor(value?: string | null) {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value ?? "#c9a7ff" : "#c9a7ff";
}

function cameraHintForPreview(file: ScannedFile | null) {
  if (!file) return "CAM";
  const prefix = file.stem.split(/[_\-\s]/)[0] ?? "";
  return /[A-Za-z]/.test(prefix) && /\d/.test(prefix) ? prefix : "CAM";
}

function ensurePreviewExtension(fileName: string, extension: string) {
  return extension && !fileName.toLowerCase().endsWith(extension.toLowerCase()) ? `${fileName}${extension}` : fileName;
}

function joinPreviewPath(parent: string, child: string) {
  if (!parent.trim()) return child;
  if (!child.trim()) return parent;
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child.replace(/^[\\/]+/, "")}`;
}

function createJobId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
