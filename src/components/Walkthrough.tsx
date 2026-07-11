import { CheckCircle2, ClipboardList, FolderTree, HardDriveDownload, Settings, Sparkles, Type, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { defaultAppSettings, getSettings, saveSettings } from "../lib/tauri";
import type { AppSettings } from "../lib/types";

type WalkthroughProps = {
  onClose: () => void;
  onGoTo: (view: "presets" | "scaffold" | "ingest" | "settings") => void;
};

const steps = [
  {
    icon: UserRound,
    title: "Who's operating?",
    body: "Your name goes on offload proofs and reports so it's clear who ran the ingest. You can change it any time in Settings.",
    kind: "name" as const,
  },
  {
    icon: ClipboardList,
    title: "Presets are the recipe",
    body: "Build reusable folder trees, variables, naming rules, routing, and starter files once. Then use that recipe over and over.",
  },
  {
    icon: Type,
    title: "Name projects consistently",
    body: "The Naming tab holds reusable naming templates so every project folder follows the same pattern. A few generic starters ship with the app — edit them or add your own, and they're saved as files in your Documents so you can share them with the team.",
  },
  {
    icon: FolderTree,
    title: "Create folders when media is not ready",
    body: "Make the project structure first, including template files, without copying camera cards.",
  },
  {
    icon: HardDriveDownload,
    title: "Ingest media when cards arrive",
    body: "Choose sources, pick destinations, select files by source/date, rename, verify, and generate reports.",
  },
  {
    icon: Settings,
    title: "Tune the defaults",
    body: "Settings controls auto-scan, sidecars, report behavior, thumbnails, camera detection, and shared variables.",
  },
];

export function Walkthrough({ onClose, onGoTo }: WalkthroughProps) {
  const [index, setIndex] = useState(0);
  const [operatorName, setOperatorName] = useState("");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const step = steps[index];
  const Icon = step.icon;
  const isLast = index === steps.length - 1;

  useEffect(() => {
    void getSettings()
      .then((loaded) => {
        setSettings(loaded);
        setOperatorName(loaded.operator_name);
      })
      .catch(() => setSettings(defaultAppSettings));
  }, []);

  async function saveOperatorName() {
    const base = settings ?? defaultAppSettings;
    const trimmed = operatorName.trim();
    if (trimmed === base.operator_name) {
      return;
    }
    try {
      await saveSettings({ ...base, operator_name: trimmed });
    } catch {
      // non-fatal; name can still be set later in Settings
    }
  }

  function finish(view?: "presets" | "scaffold" | "ingest" | "settings") {
    void saveOperatorName();
    localStorage.setItem("ingest-pilot:onboarding-complete", "true");
    onClose();
    if (view) {
      onGoTo(view);
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
      <section className="w-full max-w-2xl overflow-hidden rounded-2xl border border-mist bg-paper shadow-panel">
        <div className="flex items-center justify-between border-b border-mist bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-signal text-paper">
              <Sparkles size={17} />
            </span>
            <div>
              <h1 className="text-base font-semibold">Welcome to Ingest Pilot</h1>
              <p className="text-xs font-medium text-graphite">A quick map of how the app works.</p>
            </div>
          </div>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-graphite transition hover:bg-porcelain hover:text-ink"
            onClick={() => finish()}
            title="Skip walkthrough"
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-0 md:grid-cols-[220px_1fr]">
          <aside className="border-b border-mist bg-porcelain/60 p-3 md:border-b-0 md:border-r">
            <div className="space-y-1">
              {steps.map((candidate, candidateIndex) => {
                const CandidateIcon = candidate.icon;
                return (
                  <button
                    key={candidate.title}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                      candidateIndex === index ? "bg-white text-ink shadow-sm ring-1 ring-mist" : "text-graphite hover:bg-white/70"
                    }`}
                    onClick={() => setIndex(candidateIndex)}
                    type="button"
                  >
                    {candidateIndex < index ? <CheckCircle2 size={15} className="text-emerald-700" /> : <CandidateIcon size={15} />}
                    <span className="min-w-0 truncate">{candidate.title}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="p-5">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-lavender/25 text-ink">
              <Icon size={24} />
            </div>
            <h2 className="mb-2 text-xl font-semibold tracking-normal">{step.title}</h2>
            <p className="mb-4 text-sm leading-6 text-graphite">{step.body}</p>

            {"kind" in step && step.kind === "name" ? (
              <label className="mb-5 block">
                <span className="mb-1 block text-xs font-semibold text-graphite">Operator name</span>
                <input
                  autoFocus
                  className="h-10 w-full rounded-xl border border-mist bg-white px-3 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                  onChange={(event) => setOperatorName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveOperatorName();
                      setIndex((current) => current + 1);
                    }
                  }}
                  placeholder="e.g. Alex Rivera"
                  value={operatorName}
                />
              </label>
            ) : null}

            {isLast ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  className="h-9 rounded-lg border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => finish("presets")}
                  type="button"
                >
                  Start with Presets
                </button>
                <button
                  className="h-9 rounded-lg bg-signal px-3 text-sm font-semibold text-paper transition hover:bg-black"
                  onClick={() => finish("ingest")}
                  type="button"
                >
                  Ingest Media
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <button
                  className="h-9 rounded-lg border border-mist bg-white px-3 text-sm font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => finish()}
                  type="button"
                >
                  Skip
                </button>
                <button
                  className="h-9 rounded-lg bg-signal px-4 text-sm font-semibold text-paper transition hover:bg-black"
                  onClick={() => {
                    if ("kind" in step && step.kind === "name") {
                      void saveOperatorName();
                    }
                    setIndex((current) => current + 1);
                  }}
                  type="button"
                >
                  Next
                </button>
              </div>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
