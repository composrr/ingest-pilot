import { CircleHelp, FileJson2, FolderPlus, HardDriveDownload, Play } from "lucide-react";
import { useAppStore } from "../stores/appStore";

const milestoneCards = [
  {
    title: "Presets",
    body: "Templates for variables, naming, folder trees, routing, and starter files.",
    status: "Template",
    icon: FileJson2,
  },
  {
    title: "Create Folders",
    body: "Make a project folder structure from a preset without copying media.",
    status: "Folders",
    icon: FolderPlus,
  },
  {
    title: "Ingest Media",
    body: "Copy media, rename safely, verify hashes, and write reports.",
    status: "Copy",
    icon: HardDriveDownload,
  },
];

type DashboardProps = {
  onOpenHelp: () => void;
  onStartIngest: () => void;
  onOpenPresets: () => void;
};

export function Dashboard({ onOpenHelp, onStartIngest, onOpenPresets }: DashboardProps) {
  const { lastAction } = useAppStore();

  return (
    <div className="flex min-h-full w-full flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Ingest Pilot</p>
          <h1 className="text-xl font-semibold tracking-normal">Reusable ingest workflows</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={onOpenHelp}
            type="button"
          >
            <CircleHelp size={16} />
            How this works
          </button>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-signal px-2.5 text-xs font-semibold text-paper transition hover:bg-black"
            onClick={onStartIngest}
            type="button"
          >
            <Play size={16} fill="currentColor" />
            Ingest media
          </button>
        </div>
      </header>

      <section className="mb-2 overflow-hidden rounded-2xl border border-mist bg-white">
        <div className="grid gap-0 md:grid-cols-[1fr_1fr]">
          <QuickStart
            action="Edit presets"
            body="Start here if you want to define the reusable folder tree, variables, naming rules, routing, and starter files."
            onClick={onOpenPresets}
            title="Build the recipe once"
          />
          <QuickStart
            action="Ingest media"
            body="Start here if you already have a camera card or source folder and want to copy, rename, verify, and report."
            onClick={onStartIngest}
            title="Run the job when media arrives"
          />
        </div>
      </section>

      <section className="mb-2 overflow-hidden rounded-2xl border border-mist bg-white">
        <div className="grid divide-y divide-mist md:grid-cols-3 md:divide-x md:divide-y-0">
          <WorkflowStep
            label="1"
            title="Presets"
            body="Build the reusable template: variables, folder tree, naming rules, routing, and starter files."
          />
          <WorkflowStep
            label="2"
            title="Create Folders"
            body="Use a preset to make an empty project folder structure when you are not copying media yet."
          />
          <WorkflowStep
            label="3"
            title="Ingest Media"
            body="Scan source folders, select files, copy, rename, verify, and generate the report."
          />
        </div>
      </section>

      <section className="grid gap-2 md:grid-cols-3">
        {milestoneCards.map((card) => (
          <button
            key={card.title}
            className="rounded-2xl border border-mist bg-white p-3 text-left transition hover:bg-porcelain/60"
            onClick={card.title === "Presets" ? onOpenPresets : onStartIngest}
            type="button"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-porcelain text-graphite">
                <card.icon size={20} />
              </div>
              <span className="rounded-full bg-lavender/28 px-2 py-0.5 text-[11px] font-semibold text-graphite">
                {card.status}
              </span>
            </div>
            <h3 className="mb-1 text-sm font-semibold">{card.title}</h3>
            <p className="text-sm leading-5 text-graphite">{card.body}</p>
          </button>
        ))}
      </section>

      <footer className="mt-auto pt-3 text-xs text-graphite/70">Last action: {lastAction}</footer>
    </div>
  );
}

function WorkflowStep({ body, label, title }: { body: string; label: string; title: string }) {
  return (
    <div className="grid grid-cols-[28px_1fr] gap-2 p-3">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-signal text-xs font-semibold text-paper">
        {label}
      </div>
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-1 text-xs leading-5 text-graphite">{body}</p>
      </div>
    </div>
  );
}

function QuickStart({
  action,
  body,
  onClick,
  title,
}: {
  action: string;
  body: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <div className="border-b border-mist p-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <h2 className="mb-1 text-base font-semibold tracking-normal">{title}</h2>
      <p className="mb-3 max-w-xl text-sm leading-5 text-graphite">{body}</p>
      <button
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
        onClick={onClick}
        type="button"
      >
        {action}
      </button>
    </div>
  );
}
