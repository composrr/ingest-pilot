import { ChevronRight, ClipboardList, FolderPlus, HardDriveDownload, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { diskSpace, listHistory, listPresets, type DiskSpace, type IngestHistoryJob } from "../lib/tauri";
import type { PresetSummary } from "../lib/types";
import { useAppStore } from "../stores/appStore";

type DashboardProps = {
  onOpenHelp: () => void;
  onStartIngest: () => void;
  onOpenPresets: () => void;
  onOpenScaffold: () => void;
  onOpenHistory: () => void;
};

// Home — "Do / Recent split": primary actions and presets on the left, the recent
// jobs feed on the right, with a live destinations/free-space strip along the bottom.
export function Dashboard({ onOpenHelp, onStartIngest, onOpenPresets, onOpenScaffold, onOpenHistory }: DashboardProps) {
  const { lastAction } = useAppStore();
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [jobs, setJobs] = useState<IngestHistoryJob[]>([]);
  const [space, setSpace] = useState<DiskSpace[]>([]);

  useEffect(() => {
    void listPresets().then(setPresets).catch(() => undefined);
    void listHistory().then(setJobs).catch(() => undefined);
  }, []);

  // Destinations shown in the ingest card + free-space strip come from the most
  // recent job's targets, so the home screen reflects where media actually lands.
  const destinations = useMemo(() => {
    const latest = jobs[0];
    if (!latest) {
      return [];
    }
    const seen = new Set<string>();
    return latest.destination_paths
      .map((path) => ({ path, name: baseName(path) }))
      .filter((entry) => (seen.has(entry.path) ? false : (seen.add(entry.path), true)));
  }, [jobs]);

  useEffect(() => {
    if (destinations.length === 0) {
      setSpace([]);
      return;
    }
    let active = true;
    Promise.all(destinations.map((entry) => diskSpace(entry.path).catch(() => null)))
      .then((results) => active && setSpace(results.filter((item): item is DiskSpace => item != null)))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [destinations]);

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Ingest Pilot</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Home</h1>
        </div>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-xl bg-signal px-4 text-sm font-semibold text-paper transition hover:bg-black"
          onClick={onStartIngest}
          type="button"
        >
          <Play size={11} fill="currentColor" />
          Ingest media
        </button>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[1.04fr_0.96fr]">
        {/* Left: primary actions + presets */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Ingest media */}
          <section className="rounded-2xl border border-mist bg-white p-[18px]">
            <div className="flex items-center gap-3.5">
              <ActionIcon>
                <HardDriveDownload size={18} />
              </ActionIcon>
              <div className="min-w-0 flex-1">
                <div className="text-base font-bold text-ink">Ingest media</div>
                <div className="mt-0.5 text-[12.5px] text-graphite">Copy, rename, verify, report</div>
              </div>
              <button
                className="inline-flex h-9 items-center rounded-xl bg-signal px-[18px] text-[13px] font-semibold text-paper transition hover:bg-black"
                onClick={onStartIngest}
                type="button"
              >
                Start
              </button>
            </div>
            {destinations.length > 0 ? (
              <div className="mt-[15px] flex flex-wrap items-center gap-2 border-t border-mist/70 pt-[13px]">
                <span className="text-[11px] font-semibold tracking-[0.06em] text-graphite/70">DESTINATIONS</span>
                {destinations.map((entry) => (
                  <span
                    key={entry.path}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-mist px-2.5 py-1 text-[11.5px] text-graphite"
                    title={entry.path}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-ink" />
                    {entry.name}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          {/* Create folders */}
          <button
            className="flex items-center gap-3.5 rounded-2xl border border-mist bg-white p-[18px] text-left transition hover:border-graphite/25"
            onClick={onOpenScaffold}
            type="button"
          >
            <ActionIcon>
              <FolderPlus size={18} />
            </ActionIcon>
            <div className="min-w-0 flex-1">
              <div className="text-base font-bold text-ink">Create folders</div>
              <div className="mt-0.5 text-[12.5px] text-graphite">Empty project tree from a preset</div>
            </div>
            <span className="inline-flex h-9 items-center rounded-xl border border-mist bg-white px-4 text-[13px] font-semibold text-ink">
              New project
            </span>
          </button>

          {/* Presets */}
          <section className="flex min-w-0 flex-col rounded-2xl border border-mist bg-white p-[18px]">
            <div className="flex items-center gap-3">
              <ActionIcon>
                <ClipboardList size={18} />
              </ActionIcon>
              <div className="flex-1 text-base font-bold text-ink">Presets</div>
              <button
                className="inline-flex h-8 items-center rounded-lg border border-mist bg-white px-3.5 text-[12.5px] font-semibold text-ink transition hover:bg-porcelain"
                onClick={onOpenPresets}
                type="button"
              >
                Edit presets
              </button>
            </div>
            <div className="mt-2">
              {presets.slice(0, 3).map((preset) => (
                <button
                  key={preset.id}
                  className="flex w-full items-center gap-2.5 border-t border-mist/70 px-0.5 py-[11px] text-left transition hover:opacity-80"
                  onClick={onOpenPresets}
                  type="button"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{preset.name}</span>
                  <span className="shrink-0 text-[11.5px] text-graphite/70">{relativeDay(preset.updated_at)}</span>
                  <ChevronRight className="shrink-0 text-graphite/60" size={14} />
                </button>
              ))}
              {presets.length === 0 ? (
                <button
                  className="w-full border-t border-mist/70 px-0.5 py-3 text-left text-[12.5px] text-graphite"
                  onClick={onOpenPresets}
                  type="button"
                >
                  No presets yet — create your first one.
                </button>
              ) : null}
            </div>
          </section>
        </div>

        {/* Right: recent jobs */}
        <section className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-mist bg-white p-[18px]">
          <div className="flex items-baseline">
            <span className="text-sm font-bold text-ink">Recent jobs</span>
            <button
              className="ml-auto text-[12px] text-graphite underline decoration-mist underline-offset-2 transition hover:text-ink"
              onClick={onOpenHistory}
              type="button"
            >
              View history
            </button>
          </div>
          <div className="mt-1.5 min-h-0 flex-1 overflow-auto">
            {jobs.length === 0 ? (
              <p className="border-t border-mist/70 py-4 text-[12.5px] text-graphite">
                Completed ingests will appear here — run one to get started.
              </p>
            ) : (
              jobs.slice(0, 6).map((job) => {
                const failed = job.verification_failed > 0;
                return (
                  <button
                    key={job.id}
                    className="flex w-full items-center gap-2.5 border-t border-mist/70 px-0.5 py-[13px] text-left transition hover:opacity-80"
                    onClick={onOpenHistory}
                    type="button"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${failed ? "bg-red-600" : "bg-ink"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12.5px] font-semibold text-ink">
                        {jobName(job)}
                      </div>
                      <div className="mt-0.5 truncate text-[12px] text-graphite">
                        {job.preset_name} · {job.files_copied} files · {formatBytes(job.bytes_copied)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`text-[12px] font-semibold ${failed ? "text-red-700" : "text-emerald-700"}`}>
                        {failed ? `${job.verification_failed} failed` : "Verified"}
                      </div>
                      <div className="mt-0.5 text-[11px] text-graphite/70">{relativeTime(job.completed_at)}</div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>
      </div>

      <footer className="mt-3 flex flex-wrap items-center gap-2 pt-1 text-[11.5px] text-graphite/70">
        <span>Last action: {lastAction}</span>
        {space.length > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-ink" />
            {space.map((item) => `${baseName(item.path)} ${formatBytes(item.available_bytes)} free`).join(" · ")}
          </span>
        ) : (
          <button className="ml-auto text-graphite/70 underline decoration-mist underline-offset-2 hover:text-ink" onClick={onOpenHelp} type="button">
            How this works
          </button>
        )}
      </footer>
    </div>
  );
}

function ActionIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[9px] border border-mist bg-porcelain text-graphite">
      {children}
    </div>
  );
}

function baseName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// The project folder for a job (its root folder name), falling back to the preset.
function jobName(job: IngestHistoryJob) {
  return baseName(job.root_path) || job.preset_name;
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

// "Used today" / "Yesterday" / "Jun 27" for the presets list.
function relativeDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const days = dayDiff(date);
  if (days === 0) {
    return "Used today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "Today 4:12 PM" for jobs completed today, else "Jun 28".
function relativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  if (dayDiff(date) === 0) {
    return `Today ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayDiff(date: Date) {
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  return Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
}
