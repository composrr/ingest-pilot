import {
  Archive,
  CircleHelp,
  ClipboardList,
  FolderTree,
  HardDriveDownload,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  Settings,
  Sparkles,
  Tags,
  Wand2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { UpdateModal } from "./components/UpdateModal";
import { Walkthrough } from "./components/Walkthrough";
import { Dashboard } from "./pages/Dashboard";
import { HelpPage } from "./pages/HelpPage";
import { HistoryPage } from "./pages/HistoryPage";
import { IngestPage } from "./pages/IngestPage";
import { MetadataPage } from "./pages/MetadataPage";
import { NamingPage } from "./pages/NamingPage";
import { PresetsPage } from "./pages/PresetsPage";
import { ScaffoldPage } from "./pages/ScaffoldPage";
import { SettingsPage } from "./pages/SettingsPage";
import { GUIDES, openGuide } from "./lib/tauri";
import { checkForUpdate } from "./lib/updater";
import { useAppStore } from "./stores/appStore";

const navItems = [
  { icon: Home, label: "Home", view: "home" },
  { icon: ClipboardList, label: "Presets", view: "presets" },
  { icon: FolderTree, label: "Create Folders", view: "scaffold" },
  { icon: HardDriveDownload, label: "Ingest Media", view: "ingest" },
  { icon: Tags, label: "Metadata", view: "metadata" },
  { icon: Wand2, label: "Naming", view: "naming" },
  { icon: Archive, label: "History", view: "history" },
  { icon: Settings, label: "Settings", view: "settings" },
] as const;

type AppView = (typeof navItems)[number]["view"] | "help";

export function App() {
  const [activeView, setActiveView] = useState<AppView>("home");
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);
  const [isWalkthroughOpen, setIsWalkthroughOpen] = useState(false);
  const setLastAction = useAppStore((state) => state.setLastAction);
  const pendingUpdate = useAppStore((state) => state.pendingUpdate);
  const setPendingUpdate = useAppStore((state) => state.setPendingUpdate);
  const requestedView = useAppStore((state) => state.requestedView);
  const setRequestedView = useAppStore((state) => state.setRequestedView);
  const didCheckUpdate = useRef(false);

  // Another part of the app (e.g. the card watcher on insert) can ask us to switch
  // views. Consume the request once and clear it.
  useEffect(() => {
    if (requestedView) {
      setActiveView(requestedView as AppView);
      setRequestedView(null);
    }
  }, [requestedView, setRequestedView]);

  // Global keyboard shortcuts: Ctrl/Cmd + 1..8 jumps between the sidebar views, and
  // Ctrl/Cmd + , opens Settings. Ignored while typing in an input/textarea.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (event.key === ",") {
        event.preventDefault();
        selectView("settings");
        return;
      }
      const index = Number(event.key);
      if (Number.isInteger(index) && index >= 1 && index <= navItems.length) {
        event.preventDefault();
        selectView(navItems[index - 1].view);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (localStorage.getItem("ingest-pilot:onboarding-complete") !== "true") {
      setIsWalkthroughOpen(true);
    }
  }, []);

  useEffect(() => {
    // Check once per launch. Failures are swallowed so a flaky connection never
    // blocks startup; a newer signed release opens the changelog modal.
    if (didCheckUpdate.current) {
      return;
    }
    didCheckUpdate.current = true;
    checkForUpdate()
      .then((update) => {
        if (update) {
          setPendingUpdate(update);
        }
      })
      .catch((error) => console.error("[updater] startup check failed:", error));
  }, [setPendingUpdate]);

  function selectView(view: AppView) {
    setActiveView(view);
    const label = view === "help" ? "Help" : navItems.find((item) => item.view === view)?.label;
    setLastAction(`${label} selected`);
  }

  return (
    <main className="min-h-screen bg-app text-ink">
      <div className="flex min-h-screen">
        <aside
          className={`flex w-16 shrink-0 flex-col border-r border-mist/80 px-2 py-3 transition-all xl:px-3 ${
            isSidebarExpanded ? "xl:w-56" : "xl:w-16"
          }`}
        >
          <div className={`mb-5 flex items-center gap-2 px-0 ${isSidebarExpanded ? "xl:justify-start xl:px-1" : "justify-center"}`}>
            <div className="flex h-8 w-8 items-center justify-center rounded-2xl bg-signal text-primaryfg">
              <Sparkles size={18} strokeWidth={2.4} />
            </div>
            <div className={`${isSidebarExpanded ? "hidden xl:block" : "hidden"}`}>
              <div className="text-lg font-semibold tracking-tight">Ingest Pilot</div>
              <div className="text-xs font-medium text-graphite/70">MVP workspace</div>
            </div>
          </div>

          <button
            aria-label={isSidebarExpanded ? "Collapse navigation" : "Expand navigation"}
            className="mb-2 hidden h-7 items-center justify-center rounded-xl text-graphite transition hover:bg-paper hover:text-ink xl:flex"
            onClick={() => setIsSidebarExpanded((current) => !current)}
            title={isSidebarExpanded ? "Collapse navigation" : "Expand navigation"}
            type="button"
          >
            {isSidebarExpanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>

          <nav className="space-y-1">
            {navItems.map((item) => (
              <button
                key={item.label}
                aria-label={item.label}
                className={`flex w-full items-center justify-center gap-2 rounded-xl px-2 py-2 text-left text-sm font-medium transition ${
                  activeView === item.view
                    ? "bg-paper text-ink shadow-sm ring-1 ring-mist"
                    : "text-graphite hover:bg-paper/70 hover:text-ink"
                } ${isSidebarExpanded ? "xl:justify-start" : ""}`}
                onClick={() => selectView(item.view)}
                title={item.label}
                type="button"
              >
                <item.icon size={18} />
                <span className={`${isSidebarExpanded ? "hidden xl:inline" : "hidden"}`}>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className={`${isSidebarExpanded ? "mt-auto hidden rounded-2xl border border-mist bg-paper p-3 xl:block" : "hidden"}`}>
            <div className="mb-2 text-sm font-semibold">Need a map?</div>
            <p className="text-sm leading-5 text-graphite">
              Watch the video walkthrough, or replay the quick tour any time.
            </p>
            <div className="mt-3 grid gap-1.5">
              <button
                className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-signal px-2 text-xs font-semibold text-primaryfg transition hover:bg-black"
                onClick={() => void openGuide(GUIDES.walkthrough)}
                type="button"
              >
                <PlayCircle size={14} /> Watch the video
              </button>
              <button
                className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                onClick={() => setIsWalkthroughOpen(true)}
                type="button"
              >
                Take the interactive tour
              </button>
            </div>
          </div>

          <button
            aria-label="Help"
            className={`mt-2 flex items-center justify-center gap-2 rounded-xl px-2 py-2 text-sm font-medium text-graphite hover:bg-paper ${
              isSidebarExpanded ? "xl:justify-start" : ""
            }`}
            onClick={() => selectView("help")}
            title="Help"
            type="button"
          >
            <CircleHelp size={17} />
            <span className={`${isSidebarExpanded ? "hidden xl:inline" : "hidden"}`}>Help</span>
          </button>
        </aside>

        <section className="flex min-w-0 flex-1 p-2 xl:p-3 2xl:p-4">
          {/* IngestPage stays mounted so its setup (sources, scans, selection,
              queue, options) survives switching tabs within a session; it's just
              hidden when another view is active. */}
          <div className={activeView === "ingest" ? "flex min-w-0 flex-1" : "hidden"}>
            <IngestPage />
          </div>
          {activeView !== "ingest" ? renderView(activeView, selectView) : null}
        </section>
      </div>
      {isWalkthroughOpen ? (
        <Walkthrough
          onClose={() => setIsWalkthroughOpen(false)}
          onGoTo={(view) => selectView(view)}
        />
      ) : null}
      {pendingUpdate ? (
        <UpdateModal onDismiss={() => setPendingUpdate(null)} update={pendingUpdate} />
      ) : null}
    </main>
  );
}

function renderView(activeView: AppView, selectView: (view: AppView) => void) {
  if (activeView === "home") {
    return (
      <Dashboard
        onOpenHelp={() => selectView("help")}
        onOpenPresets={() => selectView("presets")}
        onStartIngest={() => selectView("ingest")}
        onOpenScaffold={() => selectView("scaffold")}
        onOpenHistory={() => selectView("history")}
      />
    );
  }

  if (activeView === "presets") {
    return <PresetsPage />;
  }

  // "ingest" is rendered persistently in App (kept mounted); never here.

  if (activeView === "metadata") {
    return <MetadataPage />;
  }

  if (activeView === "naming") {
    return <NamingPage />;
  }

  if (activeView === "scaffold") {
    return <ScaffoldPage />;
  }

  if (activeView === "settings") {
    return <SettingsPage />;
  }

  if (activeView === "history") {
    return <HistoryPage />;
  }

  if (activeView === "help") {
    return (
      <HelpPage
        onOpenIngest={() => selectView("ingest")}
        onOpenPresets={() => selectView("presets")}
        onOpenScaffold={() => selectView("scaffold")}
        onOpenSettings={() => selectView("settings")}
      />
    );
  }

  return (
    <Dashboard
      onOpenHelp={() => selectView("help")}
      onOpenPresets={() => selectView("presets")}
      onStartIngest={() => selectView("ingest")}
      onOpenScaffold={() => selectView("scaffold")}
      onOpenHistory={() => selectView("history")}
    />
  );
}
