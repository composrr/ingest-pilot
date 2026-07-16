import { open } from "@tauri-apps/plugin-dialog";
import { Check, CheckCircle2, ChevronDown, FileText, Folder, FolderOpen, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FloatingHelp } from "../components/FloatingHelp";
import { SelectMenu } from "../components/SelectMenu";
import { defaultsForParameters, mergeGlobalAndPresetParameters } from "../lib/parameters";
import { getPreset, getSettings, listPresets, openPath, previewPattern, scaffoldProject, type ScaffoldResult } from "../lib/tauri";
import type { FolderNode, FolderRole, Preset, PresetSummary, PresetVariable } from "../lib/types";
import { useAppStore } from "../stores/appStore";

type FolderPreviewNode = {
  id: string;
  name: string;
  role?: FolderRole | null;
  isFootageDestination: boolean;
  children: FolderPreviewNode[];
  files: string[];
};

export function ScaffoldPage() {
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [globalParameters, setGlobalParameters] = useState<PresetVariable[]>([]);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [destination, setDestination] = useState("");
  const [result, setResult] = useState<ScaffoldResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [rootPreview, setRootPreview] = useState("");
  // Resolved pre-folder path (preset sub_path_pattern), inserted before the project
  // folder so the preview shows the real location, e.g. Desktop/2026/Broll/…
  const [subPathPreview, setSubPathPreview] = useState("");
  const [folderPreview, setFolderPreview] = useState<FolderPreviewNode[]>([]);
  const setLastAction = useAppStore((state) => state.setLastAction);
  const projectParameters = useMemo(
    () => mergeGlobalAndPresetParameters(globalParameters, preset?.variables ?? []),
    [globalParameters, preset?.variables],
  );

  const canCreate = Boolean(preset && destination.trim() && !isLoading);
  const requiredMissing = useMemo(
    () =>
      projectParameters.filter(
        (variable) => variable.required && !(variableValues[variable.id] ?? "").trim(),
      ),
    [projectParameters, variableValues],
  );

  async function refreshPresets(preferredId = selectedPresetId) {
    setError(null);
    try {
      const nextPresets = await listPresets();
      setPresets(nextPresets);
      const nextId =
        preferredId && nextPresets.some((candidate) => candidate.id === preferredId)
          ? preferredId
          : nextPresets[0]?.id ?? "";
      setSelectedPresetId(nextId);
      setLastAction(`Loaded ${nextPresets.length} preset${nextPresets.length === 1 ? "" : "s"}`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Preset load failed");
    }
  }

  async function loadSelectedPreset(id: string) {
    if (!id) {
      setPreset(null);
      setVariableValues({});
      setDestination("");
      return;
    }

    setError(null);
    try {
      const nextPreset = await getPreset(id);
      setPreset(nextPreset);
      setDestination(nextPreset?.destinations.primary ?? "");
      setResult(null);
    } catch (caught) {
      setError(String(caught));
      setPreset(null);
      setLastAction("Preset detail load failed");
    }
  }

  async function chooseDestination() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path === "string") {
      setDestination(path);
    }
  }

  async function createFolders() {
    if (!preset || requiredMissing.length > 0) {
      setError("Fill in required fields before creating folders.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);
    try {
      const scaffoldResult = await scaffoldProject(preset.id, variableValues, destination);
      setResult(scaffoldResult);
      openPath(scaffoldResult.root_path).catch((caught) => {
        setError(`Project created, but the folder could not be opened automatically: ${String(caught)}`);
      });
      setLastAction(`Created ${scaffoldResult.folders_created} folder${scaffoldResult.folders_created === 1 ? "" : "s"}`);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Scaffold failed");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    getSettings()
      .then((settings) => setGlobalParameters(settings.global_parameters))
      .catch(() => setGlobalParameters([]));
    void refreshPresets("");
  }, []);

  useEffect(() => {
    void loadSelectedPreset(selectedPresetId);
  }, [selectedPresetId]);

  useEffect(() => {
    setVariableValues(defaultsForParameters(projectParameters));
  }, [projectParameters]);

  useEffect(() => {
    let isCurrent = true;
    if (!preset) {
      setRootPreview("");
      setSubPathPreview("");
      setFolderPreview([]);
      return;
    }

    Promise.all([
      previewPattern(preset.root_folder_pattern, {
        preset_name: preset.name,
        variable_values: variableValues,
        clip_number_padding: preset.clip_number_padding,
      }),
      buildFolderPreview(preset, variableValues),
      resolveSubPathPreview(preset, variableValues),
    ])
      .then(([preview, nextFolderPreview, subPath]) => {
        if (isCurrent) {
          setRootPreview(preview);
          setFolderPreview(nextFolderPreview);
          setSubPathPreview(subPath);
        }
      })
      .catch((caught) => {
        if (isCurrent) {
          setRootPreview(String(caught));
          setFolderPreview([]);
          setSubPathPreview("");
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [preset, variableValues]);

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Make folders without copying media</p>
          <h1 className="text-xl font-semibold tracking-normal">Create Folders</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-graphite">
            Use this when you want the project structure first. To copy media into an existing structure, use Ingest Media and choose Use existing folder.
          </p>
        </div>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
          onClick={() => void refreshPresets()}
          type="button"
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </header>

      {error ? (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[360px_minmax(0,1fr)] xl:grid-rows-[auto_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-2xl border border-mist bg-white xl:col-start-1 xl:row-start-1">
          <div className="flex h-10 items-center justify-between border-b border-mist px-3">
            <SectionTitle
              help="A preset is the reusable recipe: folder tree, tokens, template files, and naming rules."
              title="1. Choose Template"
            />
            <span className="rounded-full bg-porcelain px-2 py-0.5 text-xs font-semibold text-graphite">
              {presets.length}
            </span>
          </div>

          <div className="space-y-2 p-2">
            <label className="block">
              <FieldLabel help="Pick the structure you want to create. You can edit presets from the Presets page.">
                Preset
              </FieldLabel>
              <SelectMenu
                disabled={presets.length === 0}
                onChange={setSelectedPresetId}
                options={presets.map((summary) => ({ label: summary.name, value: summary.id }))}
                placeholder="No presets saved"
                value={selectedPresetId}
              />
            </label>

            <label className="block">
              <FieldLabel help="Choose the parent location. The project folder shown below will be created inside this destination.">
                Destination
              </FieldLabel>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                  onChange={(event) => setDestination(event.target.value)}
                  value={destination}
                />
                <button
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => void chooseDestination()}
                  type="button"
                >
                  <FolderOpen size={15} />
                  Pick
                </button>
              </div>
            </label>

            <div className="rounded-lg border border-mist bg-porcelain/50 p-2">
              <FieldLabel help="This is the root folder name after tokens and variables are resolved.">
                Project Folder Preview
              </FieldLabel>
              <div className="break-all text-xs font-semibold text-ink">
                {rootPreview
                  ? joinPreviewPath(joinPreviewPath(destination, subPathPreview), rootPreview)
                  : "Choose a preset to preview the folder name."}
              </div>
            </div>

            <button
              className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-signal px-3 text-sm font-semibold text-primaryfg transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canCreate}
              onClick={() => void createFolders()}
              type="button"
            >
              <Play size={16} />
              {isLoading ? "Creating..." : "Create Project"}
            </button>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-mist bg-white xl:col-start-1 xl:row-start-2">
          <div className="flex h-10 items-center justify-between border-b border-mist px-3">
            <SectionTitle
              help="Variables fill in the tokens used by the preset. For list variables, selecting multiple values creates matching branches."
              title="2. Fill Variables"
            />
            {preset ? <span className="text-xs font-semibold text-graphite">{projectParameters.length} vars</span> : null}
          </div>

          {!preset ? (
            <div className="p-3 text-sm text-graphite">Choose a preset to create its project folders.</div>
          ) : projectParameters.length === 0 ? (
            <div className="p-3 text-sm text-graphite">This preset has no parameters.</div>
          ) : (
            <div className="divide-y divide-mist">
              {projectParameters.map((variable) => (
                <ParameterField
                  key={variable.id}
                  onChange={(value) =>
                    setVariableValues((current) => ({
                      ...current,
                      [variable.id]: value,
                    }))
                  }
                  value={variableValues[variable.id] ?? ""}
                  variable={variable}
                />
              ))}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl border border-mist bg-white xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <div className="flex h-10 items-center justify-between border-b border-mist px-3">
            <div className="flex items-center gap-2">
              <SectionTitle
                help="This is the exact folder and template-file structure that will be created before anything touches disk."
                title="3. Preview Before Creating"
              />
              {preset ? <span className="rounded-full bg-porcelain px-2 py-0.5 text-[11px] font-semibold text-graphite">{folderPreview.length} root items</span> : null}
            </div>
            {result ? (
              <button
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                onClick={() => void openPath(result.root_path)}
                type="button"
              >
                <CheckCircle2 className="text-emerald-700" size={14} />
                Open created folder
              </button>
            ) : null}
          </div>
          {preset ? (
            <div className="p-2">
              {result ? (
                <div className="mb-2 grid gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs font-semibold text-emerald-900 sm:grid-cols-[1fr_auto_auto]">
                  <span className="min-w-0 truncate">{result.root_path}</span>
                  <span>{result.folders_created} folders</span>
                  <span>{result.files_copied} files</span>
                </div>
              ) : null}
              <div className="max-h-[360px] overflow-auto rounded-xl border border-mist bg-white p-1">
                <PreviewRootRow name={rootPreview || "Project folder"} path={joinPreviewPath(destination, subPathPreview)} />
                {folderPreview.length > 0 ? (
                  folderPreview.map((node) => <PreviewFolderRow key={node.id} node={node} depth={1} />)
                ) : (
                  <div className="px-3 py-2 text-sm text-graphite">This preset has no folders yet.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="p-3 text-sm text-graphite">
              Choose a preset to preview the folder structure before anything is created.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

async function buildFolderPreview(preset: Preset, variableValues: Record<string, string>) {
  const nodes = await Promise.all(
    preset.folder_tree.flatMap((folder) =>
      buildFolderPreviewNode(folder, preset, `${folder.id}`, variableValues),
    ),
  );
  return nodes.flat();
}

async function buildFolderPreviewNode(
  folder: FolderNode,
  preset: Preset,
  idPrefix: string,
  scopedValues: Record<string, string>,
): Promise<FolderPreviewNode[]> {
  if (!folderConditionMatches(folder, scopedValues)) {
    return [];
  }

  const contexts = expandedContextsForPattern(folder.name_pattern, scopedValues);
  const previewNodes = await Promise.all(
    contexts.map(async (context, index) => {
      const folderName = await previewPattern(folder.name_pattern, {
        preset_name: preset.name,
        variable_values: context,
        clip_number_padding: preset.clip_number_padding,
      });
      const childGroups = await Promise.all(
        folder.children.flatMap((child) =>
          buildFolderPreviewNode(child, preset, `${idPrefix}-${index}-${child.id}`, context),
        ),
      );
      const files = await Promise.all(
        folder.template_files.map((file) => previewTemplateFileName(file.source_path, file.rename_pattern, preset, context, folderName)),
      );

      return {
        id: `${idPrefix}-${index}`,
        name: folderName,
        role: folder.role,
        isFootageDestination: folder.is_footage_destination,
        children: childGroups.flat(),
        files,
      };
    }),
  );

  return previewNodes;
}

function folderConditionMatches(folder: FolderNode, variableValues: Record<string, string>) {
  if (!folder.condition) {
    return true;
  }

  const value = variableValues[folder.condition.variable_id];
  if (folder.condition.type === "variable_has_value") {
    return Boolean(value?.trim());
  }

  return String(value ?? "") === String(folder.condition.value);
}

function expandedContextsForPattern(pattern: string, variableValues: Record<string, string>) {
  const tokenIds = Array.from(pattern.matchAll(/\{([^{}]+)\}/g)).map((match) => match[1]);
  let contexts = [variableValues];

  for (const tokenId of tokenIds) {
    const parts = parseSelectedValues(variableValues[tokenId] ?? "");
    if (parts.length <= 1) {
      continue;
    }
    contexts = contexts.flatMap((context) => parts.map((part) => ({ ...context, [tokenId]: part })));
  }

  return contexts;
}

async function previewTemplateFileName(
  sourcePath: string,
  renamePattern: string | null | undefined,
  preset: Preset,
  variableValues: Record<string, string>,
  folderName: string,
) {
  const sourceName = fileNameFromPath(sourcePath) || "Template file";
  const { stem, extension } = splitFileName(sourceName);
  const pattern = renamePattern?.trim() ? renamePattern : "{original_name}{ext}";
  return previewPattern(pattern, {
    preset_name: preset.name,
    variable_values: variableValues,
    clip_number_padding: preset.clip_number_padding,
    original_name: stem,
    extension,
    folder_name: folderName,
  });
}

function PreviewRootRow({ name, path }: { name: string; path: string }) {
  return (
    <div className="flex min-h-8 items-center gap-2 rounded-lg bg-lavender/20 px-2 text-sm font-semibold text-ink">
      <Folder className="shrink-0 text-amber-500" size={16} fill="currentColor" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {path.trim() ? <span className="hidden max-w-[40%] truncate text-[11px] font-medium text-graphite md:block">{path}</span> : null}
    </div>
  );
}

function PreviewFolderRow({ depth, node }: { depth: number; node: FolderPreviewNode }) {
  return (
    <>
      <div
        className="grid min-h-7 grid-cols-[1fr_auto] items-center gap-2 rounded-md px-2 text-sm hover:bg-porcelain/70"
        style={{ paddingLeft: 8 + depth * 20 }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-px w-3 shrink-0 bg-mist" />
          <Folder className={`shrink-0 ${folderRoleTextColor(node.role)}`} size={15} fill="currentColor" />
          <span className="min-w-0 truncate font-semibold text-ink">{node.name}</span>
        </span>
        {node.isFootageDestination ? (
          <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-800">
            Footage
          </span>
        ) : null}
      </div>
      {node.files.map((file) => (
        <div
          key={`${node.id}-${file}`}
          className="grid min-h-6 grid-cols-[1fr] items-center rounded-md px-2 text-xs text-graphite hover:bg-porcelain/60"
          style={{ paddingLeft: 30 + depth * 20 }}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-px w-3 shrink-0 bg-mist" />
            <FileText className="shrink-0 text-indigo-600" size={13} />
            <span className="min-w-0 truncate font-semibold">{file}</span>
          </span>
        </div>
      ))}
      {node.children.map((child) => (
        <PreviewFolderRow key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

function folderRoleTextColor(role?: FolderRole | null) {
  switch (role) {
    case "footage":
      return "text-emerald-700";
    case "audio":
      return "text-sky-700";
    case "photos":
      return "text-violet-700";
    case "documents":
      return "text-blue-700";
    case "other":
      return "text-neutral-500";
    default:
      return "text-amber-500";
  }
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function splitFileName(name: string) {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return { stem: name, extension: "" };
  }
  return {
    stem: name.slice(0, dotIndex),
    extension: name.slice(dotIndex),
  };
}

function SectionTitle({ help, title }: { help: string; title: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <FloatingHelp label={`${title} help`}>{help}</FloatingHelp>
    </div>
  );
}

function FieldLabel({ children, help }: { children: string; help: string }) {
  return (
    <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-graphite">
      {children}
      <FloatingHelp label={`${children} help`} size={12}>
        {help}
      </FloatingHelp>
    </span>
  );
}

function ParameterField({
  onChange,
  value,
  variable,
}: {
  onChange: (value: string) => void;
  value: string;
  variable: PresetVariable;
}) {
  return (
    <label className="grid min-h-12 grid-cols-[180px_1fr] items-center gap-3 px-3 py-2">
      <span className="min-w-0">
        <span className="flex items-center gap-1 truncate text-sm font-semibold text-ink">
          <span className="min-w-0 truncate">{variable.name}</span>
          <FloatingHelp label={`${variable.name} help`} size={12}>
            {helpForVariable(variable)}
          </FloatingHelp>
        </span>
        <code className="text-xs text-graphite">{`{${variable.id}}`}</code>
      </span>
      {variable.type === "dropdown" && variable.options.length > 0 ? (
        <MultiSelectParameter onChange={onChange} options={variable.options} value={value} />
      ) : variable.type === "boolean" ? (
        <SelectMenu
          onChange={onChange}
          options={[
            { label: "True", value: "true" },
            { label: "False", value: "false" },
          ]}
          value={value || "false"}
        />
      ) : (
        <input
          className="h-9 min-w-0 rounded-xl border border-mist bg-white px-3 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => onChange(event.target.value)}
          type={variable.type === "date" ? "date" : "text"}
          value={value}
        />
      )}
    </label>
  );
}

function helpForVariable(variable: PresetVariable) {
  if (variable.type === "dropdown") {
    return variable.options.length > 0
      ? `Choose one or more ${variable.name} values. Multiple selections create repeated folder branches when this token is used in the tree.`
      : `This list variable has no saved options yet. Add options in the preset editor or global variables.`;
  }
  if (variable.type === "date") {
    return `This date can be used anywhere the {${variable.id}} token appears in folder or file names.`;
  }
  if (variable.type === "boolean") {
    return `This true/false value can drive conditional folders in the preset.`;
  }
  return `This value replaces the {${variable.id}} token wherever the preset uses it.`;
}

function MultiSelectParameter({
  onChange,
  options,
  value,
}: {
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedValues = useMemo(() => parseSelectedValues(value), [value]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  function toggleOption(option: string) {
    const nextValues = selectedValues.includes(option)
      ? selectedValues.filter((value) => value !== option)
      : [...selectedValues, option];
    onChange(nextValues.join(", "));
  }

  function clearValues() {
    onChange("");
  }

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-mist bg-white px-3 text-left text-sm outline-none transition hover:bg-porcelain focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span className={`min-w-0 flex-1 truncate ${selectedValues.length ? "font-semibold text-ink" : "text-graphite"}`}>
          {selectedValues.length ? selectedValues.join(", ") : "Choose..."}
        </span>
        <ChevronDown className="shrink-0 text-graphite" size={15} />
      </button>

      {isOpen ? (
        <div className="absolute right-0 top-10 z-30 w-full min-w-52 overflow-hidden rounded-xl border border-mist bg-white p-1 shadow-panel">
          <div className="max-h-56 overflow-auto">
            {options.map((option) => {
              const checked = selectedValues.includes(option);
              return (
                <button
                  key={option}
                  className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition ${
                    checked ? "bg-lavender/25 text-ink" : "text-graphite hover:bg-porcelain"
                  }`}
                  onClick={() => toggleOption(option)}
                  type="button"
                >
                  <span className={`flex h-4 w-4 items-center justify-center rounded border ${
                    checked ? "border-signal bg-signal text-primaryfg" : "border-mist bg-white"
                  }`}>
                    {checked ? <Check size={11} strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{option}</span>
                </button>
              );
            })}
          </div>
          {selectedValues.length > 0 ? (
            <button
              className="mt-1 h-7 w-full rounded-lg text-xs font-semibold text-graphite transition hover:bg-porcelain hover:text-ink"
              onClick={clearValues}
              type="button"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-1 text-[11px] font-medium text-graphite">
        Select one or more values to create matching folder branches.
      </div>
    </div>
  );
}

function parseSelectedValues(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function joinPreviewPath(destination: string, rootName: string) {
  if (!rootName.trim()) {
    return destination;
  }
  if (!destination.trim()) {
    return rootName;
  }

  const separator = destination.includes("\\") ? "\\" : "/";
  return `${destination.replace(/[\\/]+$/, "")}${separator}${rootName}`;
}

// Resolves the preset's optional pre-folder path (sub_path_pattern) into a display
// string like "2026/Broll" — each `/`-separated segment resolved via the token
// engine, blanks dropped — so the folder preview shows where the project lands.
async function resolveSubPathPreview(preset: Preset, variableValues: Record<string, string>) {
  const pattern = preset.destinations.sub_path_pattern ?? "";
  const segments = pattern.split(/[/\\]/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  const resolved: string[] = [];
  for (const segment of segments) {
    const value = await previewPattern(segment, {
      preset_name: preset.name,
      variable_values: variableValues,
      clip_number_padding: preset.clip_number_padding,
    });
    if (value.trim()) {
      resolved.push(value);
    }
  }
  return resolved.join("/");
}
