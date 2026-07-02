import { AlertTriangle, ArrowRight, Download, RefreshCw, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { downloadAndInstall, type Update, type UpdateProgress } from "../lib/updater";

type UpdateModalProps = {
  update: Update;
  onDismiss: () => void;
};

type Phase =
  | { status: "idle" }
  | { status: "downloading"; progress: UpdateProgress | null }
  | { status: "installing" }
  | { status: "error"; message: string };

export function UpdateModal({ update, onDismiss }: UpdateModalProps) {
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const busy = phase.status === "downloading" || phase.status === "installing";

  async function install() {
    setPhase({ status: "downloading", progress: null });
    try {
      await downloadAndInstall(update, (progress) => {
        setPhase(
          progress.fraction === 1 ? { status: "installing" } : { status: "downloading", progress },
        );
      });
      // On most platforms relaunch() has already replaced this window by now; if
      // execution reaches here the app is on its way down anyway.
      setPhase({ status: "installing" });
    } catch (error) {
      setPhase({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const percent =
    phase.status === "downloading" && phase.progress?.fraction != null
      ? Math.round(phase.progress.fraction * 100)
      : null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
      <section className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-mist bg-paper shadow-panel">
        <div className="flex shrink-0 items-center justify-between border-b border-mist bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-signal text-paper">
              <Sparkles size={17} />
            </span>
            <div>
              <h1 className="text-base font-semibold">Update available</h1>
              <p className="text-xs font-medium text-graphite">Ingest Pilot v{update.version}</p>
            </div>
          </div>
          <button
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-graphite transition hover:bg-porcelain hover:text-ink disabled:opacity-40"
            disabled={busy}
            onClick={onDismiss}
            type="button"
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-3 flex items-center gap-2 text-sm text-graphite">
            <span className="rounded-md bg-porcelain px-2 py-0.5 font-mono text-xs text-ink">
              v{update.currentVersion}
            </span>
            <ArrowRight size={14} />
            <span className="rounded-md bg-signal/10 px-2 py-0.5 font-mono text-xs font-semibold text-signal">
              v{update.version}
            </span>
          </div>

          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-graphite/70">
            What's new
          </div>
          <div className="min-h-[260px] rounded-xl border border-mist bg-white p-3 text-sm leading-6 text-ink">
            {renderNotes(update.body)}
          </div>

          {phase.status === "error" ? (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 shrink-0" size={16} />
              <div>
                <div className="font-semibold">Update failed</div>
                <div className="text-red-600">{phase.message}</div>
              </div>
            </div>
          ) : null}

          {phase.status === "downloading" ? (
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-xs font-medium text-graphite">
                <span>Downloading update…</span>
                <span>{percent != null ? `${percent}%` : ""}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-porcelain">
                <div
                  className={`h-full rounded-full bg-signal transition-all ${
                    percent == null ? "animate-pulse" : ""
                  }`}
                  style={{ width: percent != null ? `${percent}%` : "40%" }}
                />
              </div>
            </div>
          ) : null}

          {phase.status === "installing" ? (
            <div className="mt-3 text-sm font-medium text-graphite">
              Installing… the app will restart automatically.
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-mist bg-white px-4 py-3">
          <button
            className="h-9 rounded-lg border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
            disabled={busy}
            onClick={onDismiss}
            type="button"
          >
            Later
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-signal px-3 text-sm font-semibold text-paper transition hover:bg-black disabled:opacity-60"
            disabled={busy}
            onClick={() => void install()}
            type="button"
          >
            {phase.status === "error" ? (
              <>
                <RefreshCw size={15} /> Try again
              </>
            ) : (
              <>
                <Download size={15} /> Install now
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Render release notes without pulling in a markdown dependency: bullet lists,
 * `#` headings, and paragraphs, with inline markdown markers stripped. Good
 * enough for patch notes; falls back to a generic line when the body is empty.
 */
function renderNotes(body?: string) {
  const text = (body ?? "").trim();
  if (!text) {
    return <p className="text-graphite">This release includes general improvements and fixes.</p>;
  }

  const lines = text.split(/\r?\n/);
  const blocks: JSX.Element[] = [];
  let bullets: string[] = [];
  let key = 0;

  const flushBullets = () => {
    if (bullets.length) {
      const items = bullets;
      blocks.push(
        <ul className="ml-4 list-disc space-y-1" key={key++}>
          {items.map((item, index) => (
            <li key={index}>{stripInlineMd(item)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushBullets();
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushBullets();
      blocks.push(
        <div className="mt-2 font-semibold first:mt-0" key={key++}>
          {stripInlineMd(heading[1])}
        </div>,
      );
      continue;
    }
    flushBullets();
    blocks.push(
      <p className="mt-1 first:mt-0" key={key++}>
        {stripInlineMd(line)}
      </p>,
    );
  }
  flushBullets();

  return <div className="space-y-1">{blocks}</div>;
}

function stripInlineMd(value: string): string {
  return repairMojibake(value)
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// Defensive: if UTF-8 punctuation (em dash, ellipsis, smart quotes) was mis-decoded
// as Latin-1 somewhere upstream, restore it so the notes don't show "â€"" garbage.
function repairMojibake(value: string): string {
  if (!value.includes("â€") && !value.includes("Â")) {
    return value;
  }
  return value
    .replace(/â€"/g, "—")
    .replace(/â€"/g, "–")
    .replace(/â€¦/g, "…")
    .replace(/â€™/g, "’")
    .replace(/â€˜/g, "‘")
    .replace(/â€œ/g, "“")
    .replace(/â€/g, "”")
    .replace(/Â /g, " ");
}
