import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Download,
  Copy,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  Import,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { FloatingHelp } from "../components/FloatingHelp";
import { PresetEditor } from "../components/PresetEditor";
import { mergeGlobalAndPresetParameters } from "../lib/parameters";
import { createBlankPreset, createShippedPresets } from "../lib/presetFactory";
import {
  deletePreset,
  duplicatePreset,
  exportPreset,
  getPreset,
  getSettings,
  importPreset,
  listPresets,
  previewPattern,
  savePreset,
} from "../lib/tauri";
import type { FolderNode, Preset, PresetSummary, PresetVariable, TokenContext } from "../lib/types";
import { useAppStore } from "../stores/appStore";

export function PresetsPage() {
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);
  const [globalParameters, setGlobalParameters] = useState<PresetVariable[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLibraryCollapsed, setIsLibraryCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setLastAction = useAppStore((state) => state.setLastAction);
  const bumpPresetsRev = useAppStore((state) => state.bumpPresetsRev);

  const selectedSummary = useMemo(
    () => presets.find((preset) => preset.id === selectedId) ?? null,
    [presets, selectedId],
  );

  async function refresh(preferredId = selectedId) {
    setIsLoading(true);
    setError(null);
    try {
      const nextPresets = await listPresets();
      setPresets(nextPresets);
      const nextSelectedId =
        preferredId && nextPresets.some((preset) => preset.id === preferredId)
          ? preferredId
          : nextPresets[0]?.id ?? null;
      setSelectedId(nextSelectedId);
      setLastAction(`Loaded ${nextPresets.length} preset${nextPresets.length === 1 ? "" : "s"}`);
      // Signal the always-mounted Ingest screen to re-fetch its preset list/detail.
      bumpPresetsRev();
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset load failed");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadPreset(id: string | null) {
    if (!id) {
      setSelectedPreset(null);
      return;
    }

    try {
      const preset = await getPreset(id);
      setSelectedPreset(preset);
    } catch (caught) {
      setSelectedPreset(null);
      setError(String(caught));
      setLastAction("Preset detail load failed");
    }
  }

  async function addStarterPresets() {
    setError(null);
    try {
      const summaries = await Promise.all(createShippedPresets().map((preset) => savePreset(preset)));
      await refresh(summaries[0]?.id ?? null);
      setLastAction(`${summaries.length} starter presets saved`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset save failed");
    }
  }

  function startNewPreset() {
    setEditingPreset(createBlankPreset());
    setLastAction("New preset editor opened");
  }

  function startEditingSelectedPreset() {
    if (!selectedPreset) {
      return;
    }

    setEditingPreset(structuredClone(selectedPreset));
    setLastAction(`${selectedPreset.name} editor opened`);
  }

  async function saveEditedPreset(preset: Preset) {
    setError(null);
    try {
      const summary = await savePreset(preset);
      const savedPreset = await getPreset(summary.id);
      setEditingPreset(null);
      await refresh(summary.id);
      setSelectedId(summary.id);
      setSelectedPreset(savedPreset);
      setLastAction(`${summary.name} saved`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset save failed");
    }
  }

  async function importPresetFromDisk() {
    setError(null);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Ingest Pilot preset", extensions: ["preset", "json"] }],
      });

      if (typeof path !== "string") {
        setLastAction("Preset import cancelled");
        return;
      }

      const summary = await importPreset(path);
      await refresh(summary.id);
      setLastAction(`${summary.name} imported`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset import failed");
    }
  }

  async function exportSelectedPreset() {
    if (!selectedSummary) {
      return;
    }

    setError(null);
    try {
      const targetPath = await save({
        defaultPath: `${selectedSummary.name.replace(/[^a-z0-9_-]+/gi, "_")}.preset`,
        filters: [{ name: "Ingest Pilot preset", extensions: ["preset"] }],
      });

      if (!targetPath) {
        setLastAction("Preset export cancelled");
        return;
      }

      await exportPreset(selectedSummary.id, targetPath);
      setLastAction(`${selectedSummary.name} exported`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset export failed");
    }
  }

  async function duplicateSelectedPreset() {
    if (!selectedSummary) {
      return;
    }

    setError(null);
    try {
      const summary = await duplicatePreset(selectedSummary.id);
      await refresh(summary.id);
      setLastAction(`${selectedSummary.name} duplicated`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset duplicate failed");
    }
  }

  async function removePreset(id: string) {
    const preset = presets.find((item) => item.id === id);
    const name = preset?.name ?? "this preset";
    if (!window.confirm(`Delete ${name}? This removes the local .preset file.`)) {
      setLastAction("Preset delete cancelled");
      return;
    }

    setError(null);
    try {
      await deletePreset(id);
      const remaining = presets.filter((item) => item.id !== id);
      setPresets(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setLastAction(`${name} deleted`);
      bumpPresetsRev();
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset delete failed");
    }
  }

  useEffect(() => {
    getSettings()
      .then((settings) => setGlobalParameters(settings.global_parameters))
      .catch(() => setGlobalParameters([]));
    void refresh(null);
  }, []);

  useEffect(() => {
    void loadPreset(selectedId);
  }, [selectedId]);

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Template builder</p>
          <h1 className="text-xl font-semibold tracking-normal">Presets</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-graphite">
            Build the reusable rules for folders, project variables, file names, routing, and starter files.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <ToolbarButton onClick={startNewPreset}>
            <Plus size={16} />
            New
          </ToolbarButton>
          <ToolbarButton onClick={() => void refresh()}>
            <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
            Refresh
          </ToolbarButton>
          <ToolbarButton onClick={() => void importPresetFromDisk()}>
            <Import size={16} />
            Import
          </ToolbarButton>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-signal px-2.5 text-xs font-semibold text-paper transition hover:bg-black"
            onClick={() => void addStarterPresets()}
            type="button"
          >
            <Plus size={16} />
            Add starters
          </button>
        </div>
      </header>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <section
        className={`grid min-h-0 min-w-0 flex-1 gap-2 ${
          isLibraryCollapsed
            ? "lg:grid-cols-[56px_minmax(0,1fr)]"
            : "lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)] 2xl:grid-cols-[230px_minmax(0,1fr)]"
        }`}
      >
        <div className="min-w-0 overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="flex h-10 items-center justify-between border-b border-mist px-3">
            {isLibraryCollapsed ? (
              <button
                aria-label="Expand preset library"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-graphite transition hover:bg-porcelain hover:text-ink"
                onClick={() => setIsLibraryCollapsed(false)}
                title="Expand preset library"
                type="button"
              >
                <PanelLeftOpen size={15} />
              </button>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <h2 className="text-sm font-semibold">Local presets</h2>
                  <FloatingHelp label="Local presets help">
                    Presets are reusable templates. Create one once, then use it to make folders or ingest media consistently.
                  </FloatingHelp>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-porcelain px-2.5 py-1 text-xs font-semibold text-graphite">
                    {presets.length}
                  </span>
                  <button
                    aria-label="Collapse preset library"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-graphite transition hover:bg-porcelain hover:text-ink"
                    onClick={() => setIsLibraryCollapsed(true)}
                    title="Collapse preset library"
                    type="button"
                  >
                    <PanelLeftClose size={15} />
                  </button>
                </div>
              </>
            )}
          </div>

          {presets.length === 0 ? (
            isLibraryCollapsed ? (
              <div className="flex justify-center py-2">
                <button
                  aria-label="Add starter presets"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-mist bg-white text-graphite transition hover:bg-porcelain hover:text-ink"
                  onClick={() => void addStarterPresets()}
                  title="Add starter presets"
                  type="button"
                >
                  <Plus size={15} />
                </button>
              </div>
            ) : (
              <EmptyPresetList onAddStarter={() => void addStarterPresets()} />
            )
          ) : isLibraryCollapsed ? (
            <div className="flex max-h-[610px] flex-col items-center gap-2 overflow-auto py-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  aria-label={preset.name}
                  className={`h-8 w-8 rounded-xl border transition ${
                    preset.id === selectedId
                      ? "border-lavender bg-porcelain ring-2 ring-lavender/40"
                      : "border-mist hover:bg-porcelain"
                  }`}
                  onClick={() => setSelectedId(preset.id)}
                  title={preset.name}
                  type="button"
                >
                  <span
                    className="mx-auto block h-4 w-4 rounded-md"
                    style={{ background: preset.color ?? "#c9a7ff" }}
                  />
                </button>
              ))}
            </div>
          ) : (
            <div className="max-h-[610px] divide-y divide-mist overflow-auto">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  className={`flex w-full items-center gap-2 px-2.5 py-2 text-left transition ${
                    preset.id === selectedId ? "bg-porcelain" : "bg-white hover:bg-porcelain/60"
                  }`}
                  onClick={() => setSelectedId(preset.id)}
                  type="button"
                >
                  <div
                    className="h-6 w-6 shrink-0 rounded-lg border border-mist"
                    style={{ background: preset.color ?? "#c9a7ff" }}
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold leading-5">{preset.name}</h3>
                    <p className="truncate text-xs text-graphite">
                      {preset.description ?? "No description"}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-2xl border border-mist bg-white">
          {editingPreset ? (
            <PresetEditor
              initialPreset={editingPreset}
              onCancel={() => {
                setEditingPreset(null);
                setLastAction("Preset edit cancelled");
              }}
              onSave={(preset) => void saveEditedPreset(preset)}
            />
          ) : selectedPreset ? (
            <PresetDetail
              preset={selectedPreset}
              onDelete={() => void removePreset(selectedPreset.id)}
              onDuplicate={() => void duplicateSelectedPreset()}
              onEdit={startEditingSelectedPreset}
              onExport={() => void exportSelectedPreset()}
              globalParameters={globalParameters}
            />
          ) : (
            <NoPresetSelected />
          )}
        </div>
      </section>
    </div>
  );
}

function ToolbarButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function EmptyPresetList({ onAddStarter }: { onAddStarter: () => void }) {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center px-5 py-8 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-porcelain text-graphite">
        <FileJson2 size={22} />
      </div>
      <h2 className="mb-2 text-base font-semibold">No presets yet</h2>
      <p className="mb-4 max-w-md text-sm leading-5 text-graphite">
        Add a starter preset or import an example file.
      </p>
      <button
        className="inline-flex h-9 items-center gap-2 rounded-xl bg-signal px-3 text-sm font-semibold text-paper transition hover:bg-black"
        onClick={onAddStarter}
        type="button"
      >
        <Plus size={16} />
        Add starters
      </button>
    </div>
  );
}

function NoPresetSelected() {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-porcelain text-graphite">
        <FileJson2 size={22} />
      </div>
      <h2 className="mb-2 text-base font-semibold">No preset selected</h2>
      <p className="max-w-md text-sm leading-5 text-graphite">
        Create or import a preset to inspect setup, folders, and routing.
      </p>
    </div>
  );
}

function PresetDetail({
  globalParameters,
  preset,
  onDelete,
  onDuplicate,
  onEdit,
  onExport,
}: {
  globalParameters: PresetVariable[];
  preset: Preset;
  onDelete: () => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onExport: () => void;
}) {
  const folderCount = countFolders(preset.folder_tree);
  const templateFileCount = countTemplateFiles(preset.folder_tree);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-mist px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="h-7 w-7 shrink-0 rounded-lg border border-mist"
            style={{ background: preset.color ?? "#c9a7ff" }}
          />
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{preset.name}</h2>
            <p className="truncate text-xs text-graphite">{preset.description ?? "No description"}</p>
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <SmallButton onClick={onEdit}>
            Edit
          </SmallButton>
          <SmallButton onClick={onDuplicate}>
            <Copy size={14} />
            Duplicate
          </SmallButton>
          <SmallButton onClick={onExport}>
            <Download size={14} />
            Export
          </SmallButton>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 text-xs font-semibold text-red-800 transition hover:bg-red-100"
            onClick={onDelete}
            type="button"
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </div>

      <div className="flex items-center justify-end border-b border-mist bg-porcelain/70 px-3 py-1.5">
        <div className="flex items-center gap-2 text-[11px] font-semibold text-graphite">
          <span>{preset.variables.length} vars</span>
          <span>{folderCount} folders</span>
          {templateFileCount > 0 ? <span>{templateFileCount} files</span> : null}
          <span>{preset.clip_number_padding} pad</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <PresetOverview globalParameters={globalParameters} preset={preset} />
      </div>
    </div>
  );
}

function SmallButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function PresetOverview({ globalParameters, preset }: { globalParameters: PresetVariable[]; preset: Preset }) {
  const context = useMemo(() => createPreviewContext(preset, globalParameters), [globalParameters, preset]);

  return (
    <div className="grid items-start gap-2 xl:grid-cols-[320px_minmax(0,1fr)]">
      <section className="overflow-hidden rounded-2xl border border-mist bg-white">
        <TableHeader title="Example Outputs" />
        <PatternSummary context={context} value={preset.root_folder_pattern} />
        <PatternSummary context={context} value={preset.file_rename_pattern} />
        <div className="divide-y divide-mist border-t border-mist">
          <CompactValue label="Primary destination" value={preset.destinations.primary || "Choose during ingest"} />
          <CompactValue
            label="Sidecars"
            value={preset.preserve_xml_sidecars ? "Preserve XML sidecars" : "Do not preserve XML sidecars"}
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-mist bg-white">
        <TableHeader title="Routing Summary" />
        <RoutingRows preset={preset} />
      </section>

      <FoldersTab preset={preset} />
    </div>
  );
}

function createPreviewContext(preset: Preset, globalParameters: PresetVariable[]): TokenContext {
  const parameters = mergeGlobalAndPresetParameters(globalParameters, preset.variables);
  const variable_values = Object.fromEntries(
    parameters.map((variable) => [
      variable.id,
      previewValueForVariable(variable),
    ]),
  );

  return {
    preset_name: preset.name,
    variable_values,
    date: "2026-04-24",
    camera: "FX3",
    clip_number: 1,
    clip_number_padding: preset.clip_number_padding,
    original_name: "C0001",
    capture_date: "20260424",
    extension: ".MP4",
    folder_name: "Footage",
  };
}

function previewValueForVariable(variable: Preset["variables"][number]) {
  if (typeof variable.default === "boolean") {
    return String(variable.default);
  }

  if (variable.type === "dropdown") {
    return `[${variable.name}]`;
  }

  if (typeof variable.default === "string" && variable.default.trim()) {
    return variable.default;
  }

  return sampleValueForVariable(variable.name);
}

function sampleValueForVariable(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("campus")) {
    return "KLR";
  }
  if (lower.includes("date")) {
    return "2026-04-24";
  }
  if (lower.includes("event")) {
    return "Serve Day";
  }
  if (lower.includes("story") || lower.includes("project")) {
    return "Johnson";
  }
  return "Sample";
}

function FoldersTab({ preset }: { preset: Preset }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-mist bg-white xl:col-span-2">
      <TableHeader title="Folder Structure" />
      <div className="min-h-48 bg-white p-2">
        {preset.folder_tree.length === 0 ? (
          <div className="px-3 py-3 text-sm text-graphite">No folders yet.</div>
        ) : (
          <div className="space-y-0.5">
            {preset.folder_tree.map((folder) => (
              <FolderVisualPreview key={folder.id} folder={folder} depth={0} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function RoutingRows({ preset }: { preset: Preset }) {
  const entries = Object.entries(preset.file_type_routing_overrides);

  return (
    <>
      <div className="grid grid-cols-[160px_1fr] border-b border-mist bg-porcelain px-3 py-2 text-xs font-semibold text-graphite">
        <div>Extension</div>
        <div>Target Folder ID</div>
      </div>
      <div className="divide-y divide-mist">
        {entries.length === 0 ? (
          <div className="px-3 py-3 text-sm text-graphite">No preset-specific routing overrides.</div>
        ) : (
          entries.map(([extension, folderId]) => (
            <div key={extension} className="grid min-h-9 grid-cols-[160px_1fr] items-center px-3 py-1.5 text-sm">
              <code className="text-xs font-semibold text-graphite">{extension}</code>
              <div className="truncate text-sm">{folderId}</div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function TableHeader({ icon, title }: { icon?: ReactNode; title: string }) {
  return (
    <div className="flex h-8 items-center gap-2 border-b border-mist px-3 text-xs font-semibold">
      {icon}
      {title}
    </div>
  );
}

function PatternSummary({
  context,
  value,
}: {
  context: TokenContext;
  value: string;
}) {
  const [preview, setPreview] = useState("Resolving...");

  useEffect(() => {
    let isCurrent = true;
    previewPattern(value, context)
      .then((resolved) => {
        if (isCurrent) {
          setPreview(resolved);
        }
      })
      .catch((caught) => {
        if (isCurrent) {
          setPreview(String(caught));
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [context, value]);

  return (
    <div className="border-b border-mist px-3 py-2">
      <div className="truncate rounded-lg bg-porcelain px-3 py-2 text-sm font-semibold text-ink ring-1 ring-mist">
        {preview}
      </div>
    </div>
  );
}

function CompactValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-h-9 grid-cols-[150px_1fr] items-center px-3 py-1.5 text-sm">
      <div className="text-xs font-semibold text-graphite">{label}</div>
      <code className="truncate text-xs text-ink">{value}</code>
    </div>
  );
}

function FolderVisualPreview({ folder, depth }: { folder: FolderNode; depth: number }) {
  const FolderIcon = folder.children.length > 0 || folder.template_files.length > 0 ? FolderOpen : Folder;

  return (
    <>
      <div className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-porcelain/60">
        <TreeIndent depth={depth} />
        <FolderIcon
          className={folderRoleColor(folder.role)}
          fill="currentColor"
          size={16}
          strokeWidth={1.5}
        />
        <span className="min-w-0 truncate font-semibold">{folder.name_pattern}</span>
      </div>
      {folder.template_files.map((file, index) => (
        <div
          key={`${folder.id}-file-${file.source_path}-${index}`}
          className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-sm text-graphite hover:bg-porcelain/45"
        >
          <TreeIndent depth={depth + 1} />
          <FileText className="shrink-0 text-violet-600" size={15} />
          <span className="min-w-0 truncate text-xs font-semibold">{fileNameFromPath(file.source_path)}</span>
          <span className="ml-auto max-w-[220px] truncate rounded-full bg-porcelain px-1.5 py-0.5 text-[10px] font-bold tracking-normal text-graphite">
            {templateFileRenamePattern(file)}
          </span>
        </div>
      ))}
      {folder.children.map((child) => (
        <FolderVisualPreview key={child.id} folder={child} depth={depth + 1} />
      ))}
    </>
  );
}

function TreeIndent({ depth }: { depth: number }) {
  if (depth === 0) {
    return <span className="w-1 shrink-0" />;
  }

  return (
    <span className="flex h-full shrink-0" style={{ width: depth * 18 }}>
      {Array.from({ length: depth }).map((_, index) => (
        <span key={index} className="relative h-full w-[18px]">
          <span className="absolute left-2 top-0 h-full border-l border-dotted border-graphite/25" />
          {index === depth - 1 ? (
            <span className="absolute left-2 top-1/2 w-3 border-t border-dotted border-graphite/25" />
          ) : null}
        </span>
      ))}
    </span>
  );
}

function folderRoleColor(role: FolderNode["role"]) {
  switch (role) {
    case "footage":
      return "text-emerald-700";
    case "audio":
      return "text-amber-500";
    case "photos":
      return "text-sky-600";
    case "documents":
      return "text-violet-600";
    case "other":
      return "text-graphite";
    default:
      return "text-amber-500";
  }
}

function countFolders(folders: FolderNode[]): number {
  return folders.reduce((count, folder) => count + 1 + countFolders(folder.children), 0);
}

function countTemplateFiles(folders: FolderNode[]): number {
  return folders.reduce(
    (count, folder) => count + folder.template_files.length + countTemplateFiles(folder.children),
    0,
  );
}

function templateFileRenamePattern(file: FolderNode["template_files"][number]) {
  if (file.rename_pattern && file.rename_pattern.trim()) {
    return file.rename_pattern;
  }

  return file.name_from_folder ? "{folder_name}{ext}" : "{original_name}{ext}";
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
