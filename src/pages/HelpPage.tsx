import { ClipboardList, FolderTree, HardDriveDownload, Settings } from "lucide-react";
import type { ReactNode } from "react";

type HelpPageProps = {
  onOpenIngest: () => void;
  onOpenPresets: () => void;
  onOpenScaffold: () => void;
  onOpenSettings: () => void;
};

const workflow = [
  {
    title: "1. Build presets",
    body: "A preset is the reusable template: variables, naming rules, folder tree, routing, and sidecar behavior.",
  },
  {
    title: "2. Create folders",
    body: "Use Create Folders when you want the project structure first, before copying any camera cards.",
  },
  {
    title: "3. Ingest media",
    body: "Use Ingest Media when you are ready to scan source media, choose files, copy, rename, verify, and report.",
  },
];

const glossary = [
  ["Preset", "The reusable recipe for a production workflow."],
  ["Project variables", "Fields you fill out per job, like story name, campus, date, or camera."],
  ["Global variables", "Reusable variables shared across presets, managed in Settings."],
  ["Folder tree", "The folder and template-file structure the preset creates."],
  ["Sidecars", "Paired metadata files such as XML, XMP, THM, CPF, and similar camera companions."],
];

export function HelpPage({
  onOpenIngest,
  onOpenPresets,
  onOpenScaffold,
  onOpenSettings,
}: HelpPageProps) {
  return (
    <div className="flex min-h-full w-full flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">How this works</p>
          <h1 className="text-xl font-semibold tracking-normal">Ingest Pilot workflow</h1>
        </div>
      </header>

      <section className="mb-2 overflow-hidden rounded-2xl border border-mist bg-white">
        <div className="border-b border-mist bg-porcelain px-3 py-2 text-sm font-semibold">
          Start here
        </div>
        <div className="grid gap-0 md:grid-cols-3">
          {workflow.map((step) => (
            <div key={step.title} className="border-b border-mist p-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
              <h2 className="mb-1 text-sm font-semibold">{step.title}</h2>
              <p className="text-sm leading-5 text-graphite">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <div className="overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="border-b border-mist bg-porcelain px-3 py-2 text-sm font-semibold">
            Which screen do I use?
          </div>
          <div className="divide-y divide-mist">
            <HelpRow
              action="Open Presets"
              body="Use this when you are designing or editing the repeatable template."
              icon={<ClipboardList size={16} />}
              onClick={onOpenPresets}
              title="Presets"
              useFor="Set up variables, naming rules, folder trees, file routing, and template files."
            />
            <HelpRow
              action="Create Folders"
              body="Use this when a project needs folders now, but media ingest will happen later or somewhere else."
              icon={<FolderTree size={16} />}
              onClick={onOpenScaffold}
              title="Create Folders"
              useFor="Choose a preset, fill project variables, create the folder tree, and copy starter files."
            />
            <HelpRow
              action="Ingest Media"
              body="Use this when you have source media or camera cards and want verified copy work."
              icon={<HardDriveDownload size={16} />}
              onClick={onOpenIngest}
              title="Ingest Media"
              useFor="Pick source folders, choose a destination, scan, select files, copy, verify, and generate a report."
            />
            <HelpRow
              action="Open Settings"
              body="Right now Settings is mostly shared project variables. Later it will hold routing, report, and tray behavior."
              icon={<Settings size={16} />}
              onClick={onOpenSettings}
              title="Settings"
              useFor="Manage global variables like Campus or Date Format that should be reused across presets."
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="border-b border-mist bg-porcelain px-3 py-2 text-sm font-semibold">
            Key terms
          </div>
          <div className="divide-y divide-mist">
            {glossary.map(([term, definition]) => (
              <div key={term} className="grid grid-cols-[130px_1fr] gap-2 px-3 py-2 text-sm">
                <div className="font-semibold text-ink">{term}</div>
                <div className="text-graphite">{definition}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function HelpRow({
  action,
  body,
  icon,
  onClick,
  title,
  useFor,
}: {
  action: string;
  body: string;
  icon: ReactNode;
  onClick: () => void;
  title: string;
  useFor: string;
}) {
  return (
    <div className="grid gap-2 px-3 py-2 text-sm lg:grid-cols-[150px_minmax(0,1fr)_auto]">
      <div className="flex items-center gap-2 font-semibold text-ink">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-porcelain text-graphite">
          {icon}
        </span>
        {title}
      </div>
      <div className="min-w-0">
        <div className="font-medium text-ink">{useFor}</div>
        <div className="mt-0.5 text-xs leading-5 text-graphite">{body}</div>
      </div>
      <button
        className="h-8 rounded-lg border border-mist bg-white px-3 text-xs font-semibold text-graphite transition hover:bg-porcelain"
        onClick={onClick}
        type="button"
      >
        {action}
      </button>
    </div>
  );
}
