import { Archive, CheckCircle2, FileText, FolderOpen, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { clearHistory, listHistory, openPath, type IngestHistoryJob } from "../lib/tauri";
import { useAppStore } from "../stores/appStore";

export function HistoryPage() {
  const [jobs, setJobs] = useState<IngestHistoryJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const lastAction = useAppStore((state) => state.lastAction);
  const setLastAction = useAppStore((state) => state.setLastAction);
  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? jobs[0] ?? null,
    [jobs, selectedId],
  );
  const totals = useMemo(
    () =>
      jobs.reduce(
        (current, job) => ({
          bytes: current.bytes + job.bytes_copied,
          files: current.files + job.files_copied,
          failed: current.failed + job.verification_failed,
          sidecarsDeleted: current.sidecarsDeleted + (job.sidecars_deleted ?? 0),
        }),
        { bytes: 0, files: 0, failed: 0, sidecarsDeleted: 0 },
      ),
    [jobs],
  );

  useEffect(() => {
    void refreshHistory();
  }, []);

  async function refreshHistory() {
    setIsLoading(true);
    setError(null);
    try {
      const nextJobs = await listHistory();
      setJobs(nextJobs);
      setSelectedId((current) => current ?? nextJobs[0]?.id ?? null);
      setLastAction(`Loaded ${nextJobs.length} history job${nextJobs.length === 1 ? "" : "s"}`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("History load failed");
    } finally {
      setIsLoading(false);
    }
  }

  async function clearAll() {
    setError(null);
    try {
      await clearHistory();
      setJobs([]);
      setSelectedId(null);
      setLastAction("History cleared");
    } catch (caught) {
      setError(String(caught));
      setLastAction("History clear failed");
    }
  }

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Completed ingest jobs</p>
          <h1 className="text-xl font-semibold tracking-normal">History</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-graphite">
            Reopen reports, inspect destinations, and review verification results from completed ingests.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            disabled={isLoading}
            onClick={() => void refreshHistory()}
            type="button"
          >
            <RefreshCw className={isLoading ? "animate-spin" : ""} size={14} />
            Refresh
          </button>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 text-xs font-semibold text-red-800 transition hover:bg-red-100 disabled:opacity-40"
            disabled={jobs.length === 0}
            onClick={() => void clearAll()}
            type="button"
          >
            <Trash2 size={14} />
            Clear
          </button>
        </div>
      </header>

      {error ? (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        <SummaryTile label="Jobs" value={String(jobs.length)} />
        <SummaryTile label="Copied" value={formatBytes(totals.bytes)} />
        <SummaryTile label="Files" value={String(totals.files)} />
        <SummaryTile label="Failures" value={String(totals.failed)} />
        <SummaryTile label="Sidecars Deleted" value={String(totals.sidecarsDeleted)} />
      </div>

      <section className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-h-0 overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="flex h-10 items-center justify-between border-b border-mist px-3">
            <h2 className="text-sm font-semibold">Recent Jobs</h2>
            <span className="rounded-full bg-porcelain px-2 py-0.5 text-xs font-semibold text-graphite">{jobs.length}</span>
          </div>
          {jobs.length === 0 ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center p-6 text-center">
              <Archive className="mb-3 text-graphite/50" size={34} />
              <h3 className="mb-1 text-sm font-semibold">No saved job history yet</h3>
              <p className="max-w-md text-xs leading-5 text-graphite">
                Completed ingests will appear here with report links, destinations, file counts, sizes, and verification status.
              </p>
            </div>
          ) : (
            <div className="max-h-[560px] overflow-auto">
              {jobs.map((job) => (
                <button
                  key={job.id}
                  className={`grid w-full grid-cols-[22px_1fr_auto] items-center gap-2 border-b border-mist px-3 py-2 text-left last:border-b-0 ${
                    selectedJob?.id === job.id ? "bg-lavender/20" : "bg-white hover:bg-porcelain/55"
                  }`}
                  onClick={() => setSelectedId(job.id)}
                  type="button"
                >
                  {job.verification_failed > 0 ? (
                    <XCircle className="text-red-700" size={17} />
                  ) : (
                    <CheckCircle2 className="text-emerald-700" size={17} />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{job.preset_name}</span>
                    <span className="block truncate text-xs text-graphite">
                      {formatDate(job.completed_at)} / {job.files_copied} files / {formatBytes(job.bytes_copied)}
                    </span>
                  </span>
                  <span className="rounded-full bg-porcelain px-2 py-0.5 text-[11px] font-semibold text-graphite">
                    {job.destination_paths.length} dest
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="min-h-0 overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="border-b border-mist px-3 py-2 text-sm font-semibold">Job Detail</div>
          {selectedJob ? (
            <div className="space-y-3 p-3">
              <div>
                <div className="flex items-center gap-2">
                  {selectedJob.verification_failed > 0 ? (
                    <XCircle className="text-red-700" size={18} />
                  ) : (
                    <CheckCircle2 className="text-emerald-700" size={18} />
                  )}
                  <h2 className="min-w-0 truncate text-base font-semibold">{selectedJob.preset_name}</h2>
                </div>
                <p className="mt-1 text-xs font-medium text-graphite">{formatDate(selectedJob.completed_at)}</p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <SummaryTile label="Copied" value={formatBytes(selectedJob.bytes_copied)} />
                <SummaryTile label="Verified" value={`${selectedJob.verified_files}/${selectedJob.files_copied}`} />
                <SummaryTile label="Deleted Sidecars" value={String(selectedJob.sidecars_deleted ?? 0)} />
                <SummaryTile label="Failures" value={String(selectedJob.verification_failed)} />
              </div>

              <DetailGroup title="Sources" values={selectedJob.source_paths} />
              <DetailGroup title="Destinations" values={selectedJob.destination_paths} />
              <DetailGroup title="Project Root" values={[selectedJob.root_path]} />

              <div className="grid gap-2">
                {selectedJob.report_path ? (
                  <button
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-signal px-3 text-xs font-semibold text-paper transition hover:bg-black"
                    onClick={() => void openPath(selectedJob.report_path)}
                    type="button"
                  >
                    <FileText size={15} />
                    Open report
                  </button>
                ) : null}
                <button
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-mist bg-white px-3 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => void openPath(selectedJob.root_path)}
                  type="button"
                >
                  <FolderOpen size={15} />
                  Open folder
                </button>
              </div>
            </div>
          ) : (
            <div className="p-4 text-sm text-graphite">Select a completed job to see details.</div>
          )}
        </aside>
      </section>

      <footer className="mt-auto pt-3 text-xs text-graphite/70">Last action: {lastAction}</footer>
    </div>
  );
}

function DetailGroup({ title, values }: { title: string; values: string[] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold text-graphite">{title}</h3>
      <div className="space-y-1">
        {values.map((value) => (
          <div key={value} className="truncate rounded-lg border border-mist bg-porcelain/45 px-2 py-1.5 text-xs font-semibold text-ink" title={value}>
            {value}
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-mist bg-white px-3 py-2">
      <div className="text-xs font-semibold text-graphite">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold text-ink">{value}</div>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
