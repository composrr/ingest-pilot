import { ChevronDown, ChevronUp, History } from "lucide-react";
import { useState } from "react";
import type { IngestHistoryJob } from "../lib/tauri";
import type { PresetSummary } from "../lib/types";

type RecentIngestsCarouselProps = {
  recentJobs: IngestHistoryJob[];
  presets: PresetSummary[];
  onSelect: (job: IngestHistoryJob) => void;
};

// Generic leaf names that don't identify a project on their own; when a path ends
// in one of these we show "parent/leaf" so the row stays meaningful.
const GENERIC_LEAF_NAMES = new Set([
  "clip",
  "clips",
  "dcim",
  "media",
  "private",
  "card",
  "footage",
  "audio",
  "video",
  "data",
  "root",
]);

const MAX_VISIBLE_BADGES = 3;

export function RecentIngestsCarousel({ recentJobs, presets, onSelect }: RecentIngestsCarouselProps) {
  const [open, setOpen] = useState(true);
  if (recentJobs.length === 0) {
    return null;
  }

  // Anchored at the bottom of the column: the list renders ABOVE the toggle, so
  // expanding grows the panel upward. The toggle stays pinned at the bottom.
  return (
    <div className="overflow-hidden rounded-2xl border border-mist bg-white">
      {open ? (
      <div className="max-h-[260px] space-y-1.5 overflow-auto p-1.5">
        {recentJobs.map((job) => {
          const preset = presets.find((candidate) => candidate.id === job.preset_id);
          const presetMissing = Boolean(job.preset_id) && !preset;
          const dotColor = presetColor(preset?.color);
          const badges = variableBadges(job.variable_values);
          const hiddenBadges = badges.length - MAX_VISIBLE_BADGES;
          const visibleBadges = badges.slice(0, MAX_VISIBLE_BADGES);
          return (
            <button
              key={job.id}
              aria-label={`Replay ingest with ${job.preset_name}, ${relativeTime(job.completed_at)}`}
              className="flex w-full min-w-0 flex-col gap-1 rounded-xl border border-mist bg-white px-2.5 py-1.5 text-left transition hover:border-lavender hover:bg-lavender/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-lavender/40"
              onClick={() => onSelect(job)}
              type="button"
            >
              <div className="flex h-5 items-center gap-2">
                <span
                  aria-hidden
                  className={`h-3.5 w-3.5 shrink-0 rounded-full border border-black/10 ${dotColor ? "" : "bg-lavender/40"}`}
                  style={dotColor ? { backgroundColor: dotColor } : undefined}
                />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{job.preset_name}</span>
                <span className="shrink-0 text-[11px] font-medium text-graphite/75">{relativeTime(job.completed_at)}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-graphite">
                <span className="min-w-0 truncate" title={job.source_paths.join(", ")}>
                  {sourceLabel(job.source_paths)}
                </span>
                <span className="text-graphite/50">to</span>
                <span className="min-w-0 truncate" title={job.destination_paths.join(", ")}>
                  {destinationLabel(job.destination_paths)}
                </span>
              </div>
              {presetMissing ? (
                <span className="text-[10px] font-semibold text-red-700">Preset no longer exists</span>
              ) : null}
              {badges.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {visibleBadges.map((badge) => (
                    <span
                      key={badge.key}
                      className="max-w-full truncate rounded-md bg-porcelain px-1.5 py-0.5 text-[10px] font-semibold text-graphite"
                      title={`${badge.key}: ${badge.value}`}
                    >
                      {badge.key}: {badge.value}
                    </span>
                  ))}
                  {hiddenBadges > 0 ? (
                    <span
                      className="rounded-md bg-porcelain px-1.5 py-0.5 text-[10px] font-semibold text-graphite/75"
                      title={badges
                        .slice(MAX_VISIBLE_BADGES)
                        .map((badge) => `${badge.key}: ${badge.value}`)
                        .join("\n")}
                    >
                      +{hiddenBadges}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
      ) : null}
      <button
        className={`flex h-9 w-full items-center justify-between px-3 text-left transition hover:bg-porcelain ${
          open ? "border-t border-mist" : ""
        }`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-graphite">
          <History size={13} />
          Recent Ingests
        </span>
        <span className="flex items-center gap-1.5">
          <span className="rounded-full bg-porcelain px-2 py-0.5 text-[11px] font-semibold text-graphite">
            {recentJobs.length}
          </span>
          {open ? (
            <ChevronDown size={14} className="text-graphite/60" />
          ) : (
            <ChevronUp size={14} className="text-graphite/60" />
          )}
        </span>
      </button>
    </div>
  );
}

// Returns a valid hex color, or null so the caller can fall back to the lavender
// Tailwind token (keeps the theme reference in one place instead of a hardcoded hex).
function presetColor(value?: string | null): string | null {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? (value as string) : null;
}

function variableBadges(values?: Record<string, string>) {
  if (!values) {
    return [] as Array<{ key: string; value: string }>;
  }
  return Object.entries(values)
    .filter(([, value]) => value.trim().length > 0)
    .map(([key, value]) => ({ key, value }));
}

function sourceLabel(paths: string[]) {
  if (paths.length === 0) {
    return "No source";
  }
  const first = abbreviatePath(paths[0]);
  return paths.length > 1 ? `${first} +${paths.length - 1}` : first;
}

function destinationLabel(paths: string[]) {
  if (paths.length === 0) {
    return "No destination";
  }
  const first = abbreviatePath(paths[0]);
  return paths.length > 1 ? `${first} +${paths.length - 1} backup` : first;
}

// Show the basename, but if it's a generic name (CLIP, DCIM, MEDIA, ...) prepend
// the parent directory so the row still tells the operator which job this was.
function abbreviatePath(path: string) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) {
    return path;
  }
  const leaf = segments[segments.length - 1];
  if (GENERIC_LEAF_NAMES.has(leaf.toLowerCase()) && segments.length > 1) {
    return `${segments[segments.length - 2]}/${leaf}`;
  }
  return leaf;
}

function relativeTime(timestamp: string) {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  const weeks = Math.round(days / 7);
  if (weeks < 5) {
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
