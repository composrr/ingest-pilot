import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  Check,
  FileCheck,
  FolderOpen,
  FolderPlus,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IngestRunScreen } from "./IngestPage";
import {
  cancelIngest,
  diskSpace,
  generateOffloadProof,
  getSettings,
  listVolumes,
  openPath,
  resolveReportDir,
  runPassthroughMulti,
  saveSettings,
  scanSource,
} from "../lib/tauri";
import type {
  DestinationProgress,
  DiskSpace,
  FileVerified,
  IngestProgress,
  MultiIngestResult,
  Volume,
} from "../lib/tauri";
import type { AppSettings } from "../lib/types";
import { useAppStore } from "../stores/appStore";

// --- Self-contained copies of IngestPage's small run-screen helpers, so DitPage drives
// the shared IngestRunScreen without entangling the (NUL-byte-bearing) IngestPage module.
type SpeedPoint = { t: number; bps: number };
type SpeedSample = { tMs: number; bytesDone: number };
type VerifiedFeedEntry = { id: number; data: FileVerified };

const SAMPLE_INTERVAL_MS = 220;
const SPEED_WINDOW_MS = 1000;
const SPEED_BUFFER_WINDOW_MS = 5000;
const CHART_WINDOW_MS = 60000;
const VERIFIED_FEED_CAP = 200;

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

function createJobId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type Phase = "setup" | "running" | "delivery";

// `active` is true only while the DIT tab is the visible view. The page stays
// mounted across tab switches (so an offload survives navigation), but the live
// volume poll must pause when hidden — otherwise it would enumerate every drive
// every few seconds in the background and keep external disks spun up.
export function DitPage({ active }: { active: boolean }) {
  const setLastAction = useAppStore((state) => state.setLastAction);

  const [phase, setPhase] = useState<Phase>("setup");
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<string[]>([]);
  const [spaceByPath, setSpaceByPath] = useState<Record<string, DiskSpace | null>>({});
  const [preserveStructure, setPreserveStructure] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Source scan (file/byte count for the Offload button).
  const [isScanning, setIsScanning] = useState(false);
  const [scanFiles, setScanFiles] = useState(0);
  const [scanBytes, setScanBytes] = useState(0);
  const scanTokenRef = useRef(0);

  // Run-screen state (mirrors IngestPage.startProgressTracking).
  const [isCancelling, setIsCancelling] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [speedSeries, setSpeedSeries] = useState<SpeedPoint[]>([]);
  const [instantaneousBps, setInstantaneousBps] = useState(0);
  const [destinationProgress, setDestinationProgress] = useState<DestinationProgress[]>([]);
  const [verifiedFeed, setVerifiedFeed] = useState<VerifiedFeedEntry[]>([]);
  const [verifiedFailedTotal, setVerifiedFailedTotal] = useState(0);
  const [verifiedFailedByDest, setVerifiedFailedByDest] = useState<Map<number, number>>(new Map());
  const [currentSegment, setCurrentSegment] = useState<
    { label: string; index: number; total: number } | null
  >(null);
  const [result, setResult] = useState<MultiIngestResult | null>(null);

  const currentJobId = useRef<string | null>(null);
  const progressBufferRef = useRef<SpeedSample[]>([]);
  const verifiedFeedBufferRef = useRef<VerifiedFeedEntry[]>([]);
  const verifiedFeedIdRef = useRef(0);
  const verifiedFailedTotalRef = useRef(0);
  const verifiedFailedByDestRef = useRef<Map<number, number>>(new Map());
  const verifiedFailedDirtyRef = useRef(false);
  const latestProgressRef = useRef<IngestProgress | null>(null);
  const runStartRef = useRef(0);
  const sampleTimerRef = useRef<number | null>(null);

  // Loads disk space for one path into spaceByPath (undefined→null on failure).
  const loadSpace = useCallback((path: string) => {
    diskSpace(path)
      .then((space) => setSpaceByPath((current) => ({ ...current, [path]: space })))
      .catch(() => setSpaceByPath((current) => ({ ...current, [path]: null })));
  }, []);

  const refreshVolumes = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const list = await listVolumes();
      setVolumes(list);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // First load: settings (pinned destinations) + volumes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await getSettings();
        if (cancelled) {
          return;
        }
        setAppSettings(settings);
        setDestinations(settings.dit_destinations);
        settings.dit_destinations.forEach((path) => loadSpace(path));
      } catch (caught) {
        if (!cancelled) {
          setError(String(caught));
        }
      }
    })();
    void refreshVolumes();
    return () => {
      cancelled = true;
    };
  }, [loadSpace, refreshVolumes]);

  // Poll volumes every ~4s while the DIT setup screen is actually visible (drives
  // connect/disconnect live). Gated on `active` so the always-mounted page doesn't
  // keep hammering the disks in the background from another tab; a fresh refresh
  // fires immediately on becoming active so the list is never stale on arrival.
  useEffect(() => {
    if (!active || phase !== "setup") {
      return;
    }
    void refreshVolumes();
    const timer = window.setInterval(() => void refreshVolumes(), 4000);
    return () => window.clearInterval(timer);
  }, [active, phase, refreshVolumes]);

  // Clean up the run timer on unmount (the always-mounted page never remounts, but a
  // stray timer would still leak if the component ever tore down).
  useEffect(() => {
    return () => {
      if (sampleTimerRef.current !== null) {
        window.clearInterval(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
    };
  }, []);

  // Scan the selected source for a file/byte count (drives the Offload button).
  useEffect(() => {
    if (!selectedSource) {
      setScanFiles(0);
      setScanBytes(0);
      setIsScanning(false);
      return;
    }
    const token = scanTokenRef.current + 1;
    scanTokenRef.current = token;
    setIsScanning(true);
    setScanFiles(0);
    setScanBytes(0);
    scanSource(selectedSource)
      .then((scan) => {
        if (scanTokenRef.current !== token) {
          return;
        }
        setScanFiles(scan.ingest_files);
        setScanBytes(scan.total_bytes);
      })
      .catch(() => {
        if (scanTokenRef.current === token) {
          setError("Could not scan the selected drive.");
        }
      })
      .finally(() => {
        if (scanTokenRef.current === token) {
          setIsScanning(false);
        }
      });
  }, [selectedSource]);

  // Persist the pinned destination list to settings so it survives restarts.
  async function persistDestinations(next: string[]) {
    setDestinations(next);
    if (!appSettings) {
      return;
    }
    const updated: AppSettings = { ...appSettings, dit_destinations: next };
    setAppSettings(updated);
    try {
      await saveSettings(updated);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function addDestination() {
    const picked = await open({ directory: true, multiple: false, title: "Pin a destination folder" });
    if (!picked || Array.isArray(picked)) {
      return;
    }
    if (destinations.includes(picked)) {
      return;
    }
    loadSpace(picked);
    await persistDestinations([...destinations, picked]);
    setLastAction("Destination pinned");
  }

  async function removeDestination(path: string) {
    await persistDestinations(destinations.filter((entry) => entry !== path));
  }

  // Mirrors IngestPage.startProgressTracking: two pure ref-writer listeners plus a sample
  // timer. Returns a cleanup that removes BOTH listeners and clears the timer.
  async function startProgressTracking(jobId: string): Promise<() => void> {
    setIngestProgress(null);
    setSpeedSeries([]);
    setInstantaneousBps(0);
    setDestinationProgress([]);
    setVerifiedFeed([]);
    setVerifiedFailedTotal(0);
    setVerifiedFailedByDest(new Map());
    progressBufferRef.current = [];
    verifiedFeedBufferRef.current = [];
    verifiedFeedIdRef.current = 0;
    verifiedFailedTotalRef.current = 0;
    verifiedFailedByDestRef.current = new Map();
    verifiedFailedDirtyRef.current = false;
    latestProgressRef.current = null;
    runStartRef.current = performance.now();

    const unlistenProgress = await listen<IngestProgress>("ingest-progress", (event) => {
      if (event.payload.job_id !== jobId) {
        return;
      }
      latestProgressRef.current = event.payload;
      const tMs = performance.now() - runStartRef.current;
      const buffer = progressBufferRef.current;
      const previous = buffer[buffer.length - 1];
      if (previous && event.payload.bytes_done < previous.bytesDone) {
        buffer.length = 0;
      }
      buffer.push({ tMs, bytesDone: event.payload.bytes_done });
      const cutoff = tMs - SPEED_BUFFER_WINDOW_MS;
      while (buffer.length > 2 && buffer[0].tMs < cutoff) {
        buffer.shift();
      }
    });

    const unlistenVerified = await listen<FileVerified>("file-verified", (event) => {
      if (event.payload.job_id !== jobId) {
        return;
      }
      verifiedFeedBufferRef.current.push({ id: verifiedFeedIdRef.current, data: event.payload });
      verifiedFeedIdRef.current += 1;
      if (!event.payload.verified) {
        const dest = event.payload.destination_index;
        verifiedFailedTotalRef.current += 1;
        verifiedFailedByDestRef.current.set(dest, (verifiedFailedByDestRef.current.get(dest) ?? 0) + 1);
        verifiedFailedDirtyRef.current = true;
      }
    });

    sampleTimerRef.current = window.setInterval(() => {
      const pending = verifiedFeedBufferRef.current;
      if (pending.length > 0) {
        verifiedFeedBufferRef.current = [];
        pending.reverse();
        setVerifiedFeed((previous) => {
          const next = [...pending, ...previous];
          return next.length > VERIFIED_FEED_CAP ? next.slice(0, VERIFIED_FEED_CAP) : next;
        });
      }
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

  async function startOffload() {
    if (!selectedSource) {
      setError("Select a source drive first.");
      return;
    }
    if (destinations.length === 0) {
      setError("Pin at least one destination folder first.");
      return;
    }
    if (scanFiles === 0) {
      setError("The selected drive has no copyable files.");
      return;
    }
    setError(null);
    setResult(null);
    setIsCancelling(false);
    const jobId = createJobId();
    currentJobId.current = jobId;
    setCurrentSegment({
      label:
        destinations.length > 1
          ? `${pathDisplayName(selectedSource)} → ${destinations.length} destinations`
          : `${pathDisplayName(selectedSource)} → ${pathDisplayName(destinations[0])}`,
      index: 1,
      total: 1,
    });
    setPhase("running");
    const stopTracking = await startProgressTracking(jobId);
    try {
      const multi = await runPassthroughMulti(selectedSource, destinations, jobId, preserveStructure);
      setResult(multi);
      setPhase("delivery");
      setLastAction("DIT offload complete");
    } catch (caught) {
      setError(String(caught));
      setPhase("setup");
    } finally {
      stopTracking();
      currentJobId.current = null;
    }
  }

  async function cancelOffload() {
    if (!currentJobId.current) {
      return;
    }
    setIsCancelling(true);
    try {
      await cancelIngest(currentJobId.current);
    } catch (caught) {
      setError(String(caught));
    }
  }

  function resetForNewOffload() {
    setPhase("setup");
    setResult(null);
    setError(null);
    setCurrentSegment(null);
    setIngestProgress(null);
    void refreshVolumes();
    destinations.forEach((path) => loadSpace(path));
  }

  async function openOffloadProof(root: MultiIngestResult["roots"][number]) {
    if (!appSettings) {
      return;
    }
    try {
      const path = await generateOffloadProof({
        rootPath: root.root_path,
        presetName: "DIT Offload",
        sourcePaths: selectedSource ? [selectedSource] : [],
        destinationPaths: [root.root_path],
        copiedFiles: root.copied_files,
        filesCopied: root.files_copied,
        verifiedFiles: root.verified_files,
        verificationFailed: root.verification_failed,
        bytesCopied: root.bytes_copied,
        operator: appSettings.operator_name ?? "",
        generatedAt: new Date().toLocaleString(),
        outputDir: resolveReportDir(root.root_path, appSettings.report_defaults.output_location),
      });
      await openPath(path);
      setLastAction("Offload proof saved");
    } catch (caught) {
      setError(String(caught));
    }
  }

  if (phase === "running") {
    return (
      <div className="flex min-h-full w-full min-w-0">
        <IngestRunScreen
          isCancelling={isCancelling}
          onCancel={() => void cancelOffload()}
          progress={ingestProgress}
          speedSeries={speedSeries}
          instantaneousBps={instantaneousBps}
          currentSegment={currentSegment}
          selectedBytes={scanBytes}
          selectedCount={scanFiles}
          destinationProgress={destinationProgress}
          verifiedFeed={verifiedFeed}
          verifiedFailedTotal={verifiedFailedTotal}
          verifiedFailedByDest={verifiedFailedByDest}
          spaceByPath={spaceByPath}
        />
      </div>
    );
  }

  if (phase === "delivery" && result) {
    return (
      <DeliveryScreen
        result={result}
        onNewOffload={resetForNewOffload}
        onOpenProof={openOffloadProof}
        error={error}
      />
    );
  }

  // --- SETUP -------------------------------------------------------------------
  const selectedVolume = volumes.find((volume) => volume.path === selectedSource) ?? null;
  const canOffload = !!selectedSource && destinations.length > 0 && scanFiles > 0 && !isScanning;

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-3 shadow-panel xl:p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-graphite/70">
            DIT mode
          </p>
          <h1 className="text-xl font-semibold tracking-normal text-ink">Fast verified offload</h1>
          <p className="mt-1 text-xs font-medium text-graphite">
            Pick a drive, pick your pinned destinations, hit copy. Verified with checksums + MHL —
            no presets, folders, or naming.
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600 dark:text-red-400">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button aria-label="Dismiss" onClick={() => setError(null)} type="button">
            <X size={14} />
          </button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        {/* LEFT: connected drives (sources). */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-mist bg-card">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-mist px-3">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <HardDrive size={15} className="text-graphite/70" />
              Sources · Connected drives
            </h2>
            <button
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-mist bg-porcelain/50 px-2 text-[11px] font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-60"
              disabled={isRefreshing}
              onClick={() => void refreshVolumes()}
              type="button"
            >
              <RefreshCw size={12} className={isRefreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {volumes.length === 0 ? (
              <EmptyHint icon={HardDrive} text="No drives detected. Connect a card reader or SSD." />
            ) : (
              <ul className="space-y-1.5">
                {volumes.map((volume) => (
                  <DriveRow
                    key={volume.path}
                    volume={volume}
                    selected={volume.path === selectedSource}
                    onSelect={() => setSelectedSource(volume.path)}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* RIGHT: pinned destinations. */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-mist bg-card">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-mist px-3">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <FolderOpen size={15} className="text-graphite/70" />
              Destinations · Pinned
            </h2>
            <button
              className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-signal px-2 text-[11px] font-semibold text-primaryfg transition hover:bg-black"
              onClick={() => void addDestination()}
              type="button"
            >
              <FolderPlus size={12} />
              Add destination
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {destinations.length === 0 ? (
              <EmptyHint
                icon={FolderPlus}
                text="No destinations yet. Pin the folders you always offload to — they stick around between sessions."
              />
            ) : (
              <ul className="space-y-1.5">
                {destinations.map((path) => (
                  <DestinationRow
                    key={path}
                    path={path}
                    space={spaceByPath[path]}
                    requiredBytes={scanBytes}
                    onRemove={() => void removeDestination(path)}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* ACTION BAR */}
      <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-mist bg-card p-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-4">
          <Toggle
            label="Verify"
            checked
            disabled
            hint="Passthrough always checksum-verifies"
            onChange={() => undefined}
          />
          <Toggle
            label="Preserve folder structure"
            checked={preserveStructure}
            onChange={setPreserveStructure}
          />
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-graphite">
            <ShieldCheck size={13} className="text-emerald" />
            Verified copy · MHL · report
          </div>
        </div>
        <button
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-signal px-5 text-sm font-semibold text-primaryfg shadow-sm transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canOffload}
          onClick={() => void startOffload()}
          type="button"
        >
          {isScanning ? (
            <>
              <RefreshCw size={16} className="animate-spin" />
              Scanning {selectedVolume ? pathDisplayName(selectedVolume.path) : "drive"}…
            </>
          ) : (
            <>
              Copy {scanFiles} file{scanFiles === 1 ? "" : "s"} · {formatBytes(scanBytes)}
              <ArrowRight size={16} />
              {destinations.length} destination{destinations.length === 1 ? "" : "s"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// One connected-drive row. Greyed when the volume reports 0 total bytes (not ready).
function DriveRow({
  volume,
  selected,
  onSelect,
}: {
  volume: Volume;
  selected: boolean;
  onSelect: () => void;
}) {
  const ready = volume.total_bytes > 0;
  const used = ready ? Math.max(0, volume.total_bytes - volume.available_bytes) : 0;
  const usedPercent = ready ? Math.min(100, Math.round((used / volume.total_bytes) * 100)) : 0;
  const name = volume.nickname || volume.label || volume.path;

  return (
    <li>
      <button
        className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
          selected
            ? "border-signal bg-signal/10 ring-1 ring-signal"
            : "border-mist bg-porcelain/40 hover:bg-porcelain/70"
        } ${ready ? "" : "opacity-50"}`}
        disabled={!ready}
        onClick={onSelect}
        type="button"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <HardDrive size={15} className="shrink-0 text-graphite/70" />
            <span className="truncate text-sm font-semibold text-ink">{name}</span>
            {volume.camera_reason ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-lavender/20 px-1.5 py-0.5 text-[10px] font-semibold text-lavender">
                <Camera size={10} />
                Camera
              </span>
            ) : null}
          </div>
          <span className="shrink-0 text-[11px] font-semibold tabular-nums text-graphite">
            {volume.path}
          </span>
        </div>
        {ready ? (
          <>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-mist">
              <div
                className={`h-full rounded-full ${usedPercent > 90 ? "bg-warn" : "bg-signal"}`}
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] font-medium text-graphite">
              <span>{formatBytes(volume.available_bytes)} free</span>
              <span>{formatBytes(volume.total_bytes)} total</span>
            </div>
          </>
        ) : (
          <div className="mt-1 text-[11px] font-medium text-graphite/70">Drive not ready</div>
        )}
        {volume.camera_reason ? (
          <div className="mt-1 truncate text-[10px] font-medium text-graphite/60">
            {volume.camera_reason}
          </div>
        ) : null}
      </button>
    </li>
  );
}

// One pinned-destination row with a fit hint against the selected source.
function DestinationRow({
  path,
  space,
  requiredBytes,
  onRemove,
}: {
  path: string;
  space: DiskSpace | null | undefined;
  requiredBytes: number;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-xl border border-mist bg-porcelain/40 px-3 py-2.5">
      <FolderOpen size={15} className="shrink-0 text-graphite/70" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-ink">{pathDisplayName(path)}</div>
        <div className="truncate text-[11px] font-medium text-graphite">{path}</div>
        <div
          className={`mt-0.5 text-[11px] font-semibold ${
            spaceTone(space, requiredBytes) === "bad" ? "text-red-500 dark:text-red-400" : "text-graphite/80"
          }`}
        >
          {spaceHint(space, requiredBytes)}
        </div>
      </div>
      <button
        aria-label="Remove destination"
        className="shrink-0 rounded-lg border border-mist bg-card p-1.5 text-graphite transition hover:bg-porcelain hover:text-ink"
        onClick={onRemove}
        type="button"
      >
        <X size={14} />
      </button>
    </li>
  );
}

function spaceTone(space: DiskSpace | null | undefined, requiredBytes: number): "ok" | "bad" {
  if (space && requiredBytes > 0 && space.available_bytes - requiredBytes < 0) {
    return "bad";
  }
  return "ok";
}

function spaceHint(space: DiskSpace | null | undefined, requiredBytes: number): string {
  if (typeof space === "undefined") {
    return "Checking space…";
  }
  if (space === null) {
    return "Could not read space";
  }
  if (requiredBytes <= 0) {
    return `${formatBytes(space.available_bytes)} free`;
  }
  const remaining = space.available_bytes - requiredBytes;
  if (remaining < 0) {
    return `Won't fit — ${formatBytes(Math.abs(remaining))} short`;
  }
  return `${formatBytes(remaining)} left after copy`;
}

function DeliveryScreen({
  result,
  onNewOffload,
  onOpenProof,
  error,
}: {
  result: MultiIngestResult;
  onNewOffload: () => void;
  onOpenProof: (root: MultiIngestResult["roots"][number]) => void;
  error: string | null;
}) {
  const totalVerified = result.roots.reduce((sum, root) => sum + root.verified_files, 0);
  const totalFailed = result.roots.reduce((sum, root) => sum + root.verification_failed, 0);
  const anyFailure = result.failures.length > 0 || totalFailed > 0;

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-3 shadow-panel xl:p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-graphite/70">
            DIT mode · Delivered
          </p>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
            {anyFailure ? (
              <AlertTriangle size={20} className="text-warn" />
            ) : (
              <Check size={20} className="text-emerald" />
            )}
            {anyFailure ? "Offload finished with issues" : "Offload verified"}
          </h1>
          <p className="mt-1 text-xs font-medium text-graphite">
            {totalVerified} verified {totalVerified === 1 ? "copy" : "copies"} across{" "}
            {result.roots.length} destination{result.roots.length === 1 ? "" : "s"}
            {totalFailed > 0 ? ` · ${totalFailed} failed verification` : ""}.
          </p>
        </div>
        <button
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-primaryfg transition hover:bg-black"
          onClick={onNewOffload}
          type="button"
        >
          New offload
        </button>
      </header>

      {error ? (
        <div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : null}

      {result.failures.length > 0 ? (
        <div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400">
            <AlertTriangle size={15} />
            {result.failures.length} destination{result.failures.length === 1 ? "" : "s"} failed
          </div>
          <ul className="space-y-1">
            {result.failures.map((failure) => (
              <li key={`${failure.index}-${failure.path}`} className="text-[11px] font-medium text-graphite">
                <span className="font-semibold text-ink">{pathDisplayName(failure.path)}</span> —{" "}
                {failure.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto sm:grid-cols-2">
        {result.roots.map((root) => (
          <div key={root.root_path} className="rounded-2xl border border-mist bg-card p-3">
            <div className="flex items-center gap-2">
              {root.verification_failed > 0 ? (
                <AlertTriangle size={15} className="shrink-0 text-warn" />
              ) : (
                <FileCheck size={15} className="shrink-0 text-emerald" />
              )}
              <span className="min-w-0 truncate text-sm font-semibold text-ink">
                {pathDisplayName(root.root_path)}
              </span>
            </div>
            <div className="mt-1 truncate text-[11px] font-medium text-graphite">{root.root_path}</div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-semibold text-graphite">
              <span>
                <span className="text-emerald">{root.verified_files}</span> verified
              </span>
              {root.verification_failed > 0 ? (
                <span className="text-red-500 dark:text-red-400">{root.verification_failed} failed</span>
              ) : null}
              <span>{formatBytes(root.bytes_copied)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-mist bg-porcelain/50 px-2 text-[11px] font-semibold text-graphite transition hover:bg-porcelain"
                onClick={() => void openPath(root.root_path)}
                type="button"
              >
                <FolderOpen size={12} />
                Open folder
              </button>
              {root.report_path ? (
                <button
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-mist bg-porcelain/50 px-2 text-[11px] font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => void openPath(root.report_path)}
                  type="button"
                >
                  Open report
                </button>
              ) : null}
              <button
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-mist bg-porcelain/50 px-2 text-[11px] font-semibold text-graphite transition hover:bg-porcelain"
                onClick={() => onOpenProof(root)}
                type="button"
              >
                <ShieldCheck size={12} />
                Offload proof
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      className={`flex items-center gap-2 text-xs font-semibold ${
        disabled ? "cursor-default text-graphite/70" : "text-ink"
      }`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={hint}
      type="button"
    >
      <span
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition ${
          checked ? "bg-signal" : "bg-mist"
        }`}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full bg-primaryfg transition ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

function EmptyHint({
  icon: Icon,
  text,
}: {
  icon: typeof HardDrive;
  text: string;
}) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 p-4 text-center">
      <Icon size={22} className="text-graphite/40" />
      <p className="max-w-xs text-xs font-medium text-graphite">{text}</p>
    </div>
  );
}
