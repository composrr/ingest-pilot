import { open } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, FolderOpen, Minus, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FloatingHelp } from "./FloatingHelp";
import { FolderTreeEditor } from "./FolderTreeEditor";
import { MetadataPresetsManager } from "./MetadataPresetsManager";
import { OptionsTextField } from "./OptionsTextField";
import { PatternInput } from "./PatternInput";
import { SelectMenu } from "./SelectMenu";
import { TokenSuggestInput } from "./TokenSuggest";
import {
  defaultNamingCatalog,
  mergeNamingCatalog,
  type NamingDeliverable,
  type NamingField,
} from "../lib/namingCatalog";
import { currentLocalDate, mergeGlobalAndPresetParameters, slugifyToken } from "../lib/parameters";
import { getMetadataPreset, getNamingCatalog, getSettings, listMetadataPresets, saveNamingCatalog } from "../lib/tauri";
import { getTokenDefinitions, parsePattern } from "../lib/tokens";
import { useAppStore } from "../stores/appStore";
import type {
  FolderNode,
  MetadataField,
  MetadataPreset,
  MetadataPresetSummary,
  Preset,
  PresetVariable,
  TokenContext,
  VariableType,
} from "../lib/types";

type PresetEditorProps = {
  initialPreset: Preset;
  onCancel: () => void;
  onSave: (preset: Preset) => void;
};

const variableTypes: Array<{ value: VariableType; label: string }> = [
  { value: "short_text", label: "Text" },
  { value: "long_text", label: "Long Text" },
  { value: "dropdown", label: "List" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
];

// Live preview of where the year-aware sub-path lands, mirroring the Rust resolver
// (date tokens + variable defaults, blank segments dropped). The trailing "/…"
// stands in for the project folder that gets created inside.
function subPathPreview(preset: Preset): string {
  const base = preset.destinations.primary?.trim() || "<destination>";
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const varDefaults: Record<string, string> = {};
  for (const variable of preset.variables) {
    const fallback = typeof variable.default === "string" ? variable.default : "";
    varDefaults[variable.id] = fallback || variable.options?.[0] || "";
  }
  const segments = (preset.destinations.sub_path_pattern ?? "")
    .split(/[/\\]/)
    .map((segment) =>
      segment
        .replace(/\{([^}]+)\}/g, (_match, token: string) => {
          if (token === "year") return year;
          if (token === "month") return month;
          if (token === "day") return day;
          if (token === "date") return `${year}${month}${day}`;
          return varDefaults[token] ?? "";
        })
        .trim(),
    )
    .filter((segment) => segment.length > 0);
  const tail = segments.length ? `${base}/${segments.join("/")}` : base;
  return `${tail}/…`;
}

// Value picker for a preset's chosen metadata tags. Dropdowns for list fields,
// yes/no for booleans, a date field for dates, free text otherwise.
function PresetMetadataValueInput({
  field,
  onChange,
  value,
}: {
  field: MetadataField;
  onChange: (value: string) => void;
  value: string;
}) {
  const inputClass =
    "h-8 w-full min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30";
  if (field.field_type === "dropdown") {
    return (
      <SelectMenu
        onChange={onChange}
        options={[{ label: "—", value: "" }, ...field.options.map((option) => ({ label: option, value: option }))]}
        placeholder="Any / choose"
        size="sm"
        value={value}
      />
    );
  }
  if (field.field_type === "boolean") {
    return (
      <SelectMenu
        onChange={onChange}
        options={[
          { label: "—", value: "" },
          { label: "Yes", value: "true" },
          { label: "No", value: "false" },
        ]}
        size="sm"
        value={value}
      />
    );
  }
  if (field.field_type === "date") {
    return <input className={inputClass} onChange={(event) => onChange(event.target.value)} type="date" value={value} />;
  }
  return (
    <input
      className={inputClass}
      onChange={(event) => onChange(event.target.value)}
      placeholder={
        field.field_type === "multi_select" && field.options.length
          ? `${field.options.slice(0, 3).join(", ")}…`
          : "Leave blank to fill at ingest"
      }
      value={value}
    />
  );
}

export function PresetEditor({ initialPreset, onCancel, onSave }: PresetEditorProps) {
  const metadataRev = useAppStore((state) => state.metadataRev);
  const [draft, setDraft] = useState<Preset>(initialPreset);
  const [variableRowKeys, setVariableRowKeys] = useState(() =>
    initialPreset.variables.map(() => createRowKey()),
  );
  const [globalParameters, setGlobalParameters] = useState<PresetVariable[]>([]);
  const [customFileKinds, setCustomFileKinds] = useState<Record<string, string>>({});
  const [metadataSummaries, setMetadataSummaries] = useState<MetadataPresetSummary[]>([]);
  const [isMetadataManagerOpen, setIsMetadataManagerOpen] = useState(false);
  const [attachedMetadata, setAttachedMetadata] = useState<MetadataPreset | null>(null);
  const [namingDeliverables, setNamingDeliverables] = useState<NamingDeliverable[]>([]);

  function refreshMetadataSummaries() {
    void listMetadataPresets().then(setMetadataSummaries).catch(() => undefined);
  }

  useEffect(() => {
    refreshMetadataSummaries();
  }, [metadataRev]);

  useEffect(() => {
    getNamingCatalog()
      .then((persisted) => setNamingDeliverables(mergeNamingCatalog(persisted).deliverables))
      .catch(() => setNamingDeliverables(defaultNamingCatalog().deliverables));
  }, []);

  // Load the attached metadata preset's schema so its fields can be shown as tag
  // pickers (the operator chooses values for this preset, not schema edits).
  useEffect(() => {
    const id = draft.metadata_preset_id;
    if (!id) {
      setAttachedMetadata(null);
      return;
    }
    let active = true;
    getMetadataPreset(id)
      .then((preset) => active && setAttachedMetadata(preset))
      .catch(() => active && setAttachedMetadata(null));
    return () => {
      active = false;
    };
    // metadataRev: refresh the tag picker when the attached preset's fields are
    // edited in the Manage-metadata modal.
  }, [draft.metadata_preset_id, metadataRev]);

  // "New naming preset": save this preset's current folder-name pattern (and
  // pre-folder path) into the naming catalog so it's reusable from the Naming tab
  // and the ingest Name wizard. Fields are derived from the pattern's non-date
  // tokens, using the preset's variables for labels/options.
  const [namingSaveOpen, setNamingSaveOpen] = useState(false);
  const [namingSaveName, setNamingSaveName] = useState("");
  const [namingSaveGroup, setNamingSaveGroup] = useState<NamingDeliverable["group"]>("Video Capture");
  const [namingSaveStatus, setNamingSaveStatus] = useState<string | null>(null);

  async function saveAsNamingPreset() {
    const label = namingSaveName.trim();
    if (!label) {
      return;
    }
    const globalIds = new Set(["date", "year", "month", "day", "preset_name"]);
    const tokenIds = [
      ...new Set(
        parsePattern(draft.root_folder_pattern)
          .filter((part) => part.type === "token")
          .map((part) => part.value)
          .filter((id) => !globalIds.has(id)),
      ),
    ];
    const fields = tokenIds.map((id) => {
      const variable = allParameters.find((item) => item.id === id);
      return {
        id,
        label: variable?.name ?? id,
        type: (variable?.type === "dropdown" ? "dropdown" : "short_text") as NamingField["type"],
        required: variable?.required ?? true,
        options: variable?.options?.length ? [...variable.options] : undefined,
      };
    });
    const deliverableId = `deliverable_${Date.now()}`;
    const deliverable: NamingDeliverable = {
      id: deliverableId,
      label,
      group: namingSaveGroup,
      hint: draft.root_folder_pattern.replace("{year}-{month}-{day}", "YYYY-MM-DD").replace("{date}", "YYYYMMDD"),
      presetId: deliverableId,
      presetName: label,
      rootPattern: draft.root_folder_pattern,
      subPath: draft.destinations.sub_path_pattern?.trim() || undefined,
      fields,
    };
    try {
      const catalog = mergeNamingCatalog(await getNamingCatalog());
      const next = { ...catalog, deliverables: [...catalog.deliverables, deliverable] };
      await saveNamingCatalog(next);
      setNamingDeliverables(next.deliverables);
      setNamingSaveOpen(false);
      setNamingSaveStatus(`Saved “${label}” to Naming`);
      window.setTimeout(() => setNamingSaveStatus(null), 2200);
    } catch (error) {
      setNamingSaveStatus(`Couldn't save: ${String(error)}`);
    }
  }

  function setMetadataValue(fieldId: string, value: string) {
    setDraft((current) => {
      const nextValues = { ...(current.metadata_values ?? {}) };
      if (value) {
        nextValues[fieldId] = value;
      } else {
        delete nextValues[fieldId];
      }
      return { ...current, metadata_values: nextValues };
    });
  }

  // Applies a naming template: sets the SOP name pattern + year-aware sub-path and
  // folds in any of the template's fields that aren't already variables, so the
  // preset is named per the SOP without leaving the editor.
  function applyNamingTemplate(id: string) {
    const deliverable = namingDeliverables.find((item) => item.id === id);
    if (!deliverable) {
      return;
    }
    setDraft((current) => {
      const existingIds = new Set(current.variables.map((variable) => variable.id));
      const addedVariables: PresetVariable[] = deliverable.fields
        .filter((field) => !existingIds.has(field.id))
        .map((field) => ({
          id: field.id,
          name: field.label,
          type: field.type,
          required: field.required,
          default: "",
          options: field.options ?? [],
        }));
      if (addedVariables.length) {
        setVariableRowKeys((keys) => [...keys, ...addedVariables.map(() => createRowKey())]);
      }
      return {
        ...current,
        root_folder_pattern: deliverable.rootPattern,
        destinations: {
          ...current.destinations,
          sub_path_pattern: deliverable.subPath ?? current.destinations.sub_path_pattern ?? "",
        },
        variables: [...current.variables, ...addedVariables],
      };
    });
  }
  const allParameters = useMemo(
    () => mergeGlobalAndPresetParameters(globalParameters, draft.variables),
    [draft.variables, globalParameters],
  );
  const context = useMemo(() => createPreviewContext(draft, allParameters), [allParameters, draft]);

  useEffect(() => {
    getSettings()
      .then((settings) => {
        setGlobalParameters(settings.global_parameters);
        setCustomFileKinds(settings.custom_file_kinds ?? {});
      })
      .catch(() => setGlobalParameters([]));
  }, []);

  function updateDraft(patch: Partial<Preset>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function updateVariable(index: number, patch: Partial<PresetVariable>) {
    setDraft((current) => {
      const variables = [...current.variables];
      const previous = variables[index];
      variables[index] = { ...previous, ...patch };
      return { ...current, variables };
    });
  }

  function addVariable() {
    setVariableRowKeys((current) => [...current, createRowKey()]);
    setDraft((current) => {
      const number = current.variables.length + 1;
      return {
        ...current,
        variables: [
          ...current.variables,
          {
            id: `parameter_${number}`,
            name: `Parameter ${number}`,
            type: "short_text",
            required: false,
            default: "",
            options: [],
          },
        ],
      };
    });
  }

  function removeVariable(index: number) {
    setVariableRowKeys((current) => current.filter((_, variableIndex) => variableIndex !== index));
    setDraft((current) => ({
      ...current,
      variables: current.variables.filter((_, variableIndex) => variableIndex !== index),
    }));
  }

  function moveVariable(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draft.variables.length) {
      return;
    }

    setVariableRowKeys((current) => moveArrayItem(current, index, nextIndex));
    setDraft((current) => ({
      ...current,
      variables: moveArrayItem(current.variables, index, nextIndex),
    }));
  }

  async function choosePrimaryDestination() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") {
      return;
    }

    setDraft((current) => ({
      ...current,
      destinations: {
        ...current.destinations,
        primary: path,
      },
    }));
  }

  function setSecondaries(updater: (current: string[]) => string[]) {
    setDraft((current) => ({
      ...current,
      destinations: {
        ...current.destinations,
        secondaries: updater(current.destinations.secondaries ?? []),
      },
    }));
  }

  function addSecondaryDestination() {
    setSecondaries((current) => [...current, ""]);
  }

  function updateSecondaryDestination(index: number, value: string) {
    setSecondaries((current) => current.map((path, i) => (i === index ? value : path)));
  }

  function removeSecondaryDestination(index: number) {
    setSecondaries((current) => current.filter((_, i) => i !== index));
  }

  async function chooseSecondaryDestination(index: number) {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") {
      return;
    }
    updateSecondaryDestination(index, path);
  }

  function saveDraft() {
    onSave({
      ...draft,
      variables: draft.variables.map((variable) =>
        variable.type === "dropdown" ? { ...variable, default: "" } : variable,
      ),
      updated_at: new Date().toISOString(),
    });
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-mist px-3 py-2">
        <div>
          <h2 className="text-base font-semibold">Preset Editor</h2>
          <p className="text-xs text-graphite">
            {draft.variables.length} vars / {countFolders(draft.folder_tree)} folders
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="inline-flex h-8 items-center gap-2 rounded-xl border border-mist bg-white px-3 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={onCancel}
            type="button"
          >
            <X size={14} />
            Cancel
          </button>
          <button
            className="inline-flex h-8 items-center gap-2 rounded-xl bg-signal px-3 text-xs font-semibold text-paper transition hover:bg-black"
            onClick={saveDraft}
            type="button"
          >
            <Save size={14} />
            Save
          </button>
        </div>
      </div>

      <div className="hidden">
        <div className="hidden">
          {draft.variables.length} vars · {countFolders(draft.folder_tree)} folders
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="grid gap-2 xl:grid-cols-[320px_minmax(0,1fr)]">
            <section className="overflow-hidden rounded-2xl border border-mist bg-white">
              <SectionHeader help="Basic identity, default destination, sidecar behavior, and clip-number formatting for this preset." title="Preset" />
              <div className="divide-y divide-mist">
                <CompactTextField
                  label="Name"
                  onChange={(name) => updateDraft({ name })}
                  value={draft.name}
                />
                <CompactTextField
                  label="Description"
                  onChange={(description) => updateDraft({ description })}
                  value={draft.description ?? ""}
                />
                {namingDeliverables.length ? (
                  <div className="grid min-h-10 grid-cols-[110px_1fr] items-center gap-2 px-3 py-1.5">
                    <div className="flex items-center gap-1 text-xs font-semibold text-graphite">
                      Naming preset
                      <FloatingHelp label="Naming preset help">
                        Apply a naming preset to set this preset's folder name pattern (and its year-aware pre-folder
                        path) per the team SOP, and pull in the fields it needs. Manage naming presets in the Naming tab.
                      </FloatingHelp>
                    </div>
                    <SelectMenu
                      onChange={(value) => value && applyNamingTemplate(value)}
                      options={[
                        { label: "Apply a naming preset…", value: "" },
                        ...namingDeliverables.map((item) => ({ label: item.label, value: item.id })),
                      ]}
                      placeholder="Apply a naming preset…"
                      searchable
                      size="sm"
                      sortOptions
                      value=""
                    />
                  </div>
                ) : null}
                <ColorField
                  onChange={(color) => updateDraft({ color })}
                  value={draft.color ?? "#c9a7ff"}
                />
                <div className="grid min-h-10 grid-cols-[110px_1fr_auto] items-center gap-2 px-3 py-1.5">
                  <div className="text-xs font-semibold text-graphite">Default Save To</div>
                  <input
                    className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                    onChange={(event) =>
                      updateDraft({
                        destinations: { ...draft.destinations, primary: event.target.value },
                      })
                    }
                    value={draft.destinations.primary}
                  />
                  <button
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                    onClick={() => void choosePrimaryDestination()}
                    type="button"
                  >
                    <FolderOpen size={13} />
                    Pick
                  </button>
                </div>
                <div className="px-3 py-2">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-graphite">
                    Pre-folder path (optional)
                    <FloatingHelp label="Pre-folder path help">
                      Folders placed BEFORE the project folder, inside “Default Save To”, resolved fresh each ingest.
                      The point: leave “Default Save To” pointed at a folder that never changes (e.g. …/Videos) and put the
                      parts that DO change here as tokens. {"{year}"} becomes the current year, so {" {year}/Broll"} always
                      lands in this year's Broll folder — no editing the preset in January. If the folders already exist the
                      ingest drops into them; otherwise it makes them. Leave blank to save straight into “Default Save To”.
                    </FloatingHelp>
                  </div>
                  <TokenSuggestInput
                    ariaLabel="Pre-folder path"
                    className="h-8 w-full min-w-0 rounded-lg border border-mist bg-white px-2 font-mono text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                    onChange={(sub_path_pattern) =>
                      updateDraft({
                        destinations: { ...draft.destinations, sub_path_pattern },
                      })
                    }
                    placeholder="{year}/Broll — type $ for tokens"
                    tokens={getTokenDefinitions("folder", allParameters)}
                    value={draft.destinations.sub_path_pattern ?? ""}
                  />
                  {(draft.destinations.sub_path_pattern ?? "").trim() ? (
                    <div className="mt-1 rounded-md bg-porcelain px-2 py-1 text-[11px] text-graphite/80">
                      <span className="font-semibold text-graphite/60">This ingest saves to: </span>
                      <span className="break-all font-mono">{subPathPreview(draft)}</span>
                    </div>
                  ) : null}
                </div>
                {(draft.destinations.secondaries ?? []).map((path, index) => (
                  <div
                    key={`secondary-${index}`}
                    className="grid min-h-10 grid-cols-[110px_1fr_auto_auto] items-center gap-2 px-3 py-1.5"
                  >
                    <div className="text-xs font-semibold text-graphite">Backup {index + 1}</div>
                    <input
                      className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                      onChange={(event) => updateSecondaryDestination(index, event.target.value)}
                      placeholder="Backup copy location"
                      value={path}
                    />
                    <button
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                      onClick={() => void chooseSecondaryDestination(index)}
                      type="button"
                    >
                      <FolderOpen size={13} />
                      Pick
                    </button>
                    <button
                      aria-label={`Remove backup ${index + 1}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-mist text-graphite transition hover:bg-porcelain hover:text-ink"
                      onClick={() => removeSecondaryDestination(index)}
                      type="button"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="px-3 py-1.5">
                  <button
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-dashed border-mist px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                    onClick={addSecondaryDestination}
                    type="button"
                  >
                    <Plus size={13} />
                    Add backup destination
                  </button>
                </div>
                <ClipPaddingField
                  onChange={(clip_number_padding) => updateDraft({ clip_number_padding })}
                  value={draft.clip_number_padding}
                />
                <SidecarToggle
                  onChange={(preserve_xml_sidecars) => updateDraft({ preserve_xml_sidecars })}
                  value={draft.preserve_xml_sidecars}
                />
                <RenameToggle
                  onChange={(rename_files_default) => updateDraft({ rename_files_default })}
                  value={draft.rename_files_default}
                />
                <div className="px-3 py-2">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-graphite">
                    Metadata preset
                    <FloatingHelp label="Metadata preset help">
                      Attach a metadata schema, then choose the tag values below that every import made with this preset
                      should carry (e.g. Content Type = Story). Those values pre-fill at ingest (still editable per
                      import) and are written to the iconik CSV. Edit the schema itself in the Metadata tab.
                    </FloatingHelp>
                  </div>
                  <div className="grid grid-cols-[1fr_auto] gap-1.5">
                    <SelectMenu
                      onChange={(value) => updateDraft({ metadata_preset_id: value || null })}
                      options={[{ label: "None", value: "" }, ...metadataSummaries.map((item) => ({ label: item.name, value: item.id }))]}
                      placeholder="No metadata"
                      size="sm"
                      value={draft.metadata_preset_id ?? ""}
                    />
                    <button
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                      onClick={() => setIsMetadataManagerOpen(true)}
                      type="button"
                    >
                      Manage
                    </button>
                  </div>

                  {attachedMetadata && attachedMetadata.categories.some((category) => category.fields.length) ? (
                    <div className="mt-2 space-y-2">
                      <div className="text-[11px] text-graphite/70">Tags applied to every import with this preset:</div>
                      {attachedMetadata.categories
                        .filter((category) => category.fields.length)
                        .map((category) => (
                          <div key={category.id} className="rounded-lg border border-mist bg-porcelain/40 p-2">
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/60">
                              {category.name}
                            </div>
                            <div className="space-y-1.5">
                              {category.fields.map((field) => (
                                <div key={field.id} className="grid grid-cols-[100px_1fr] items-center gap-2">
                                  <span className="truncate text-[11px] font-semibold text-graphite" title={field.label}>
                                    {field.label}
                                  </span>
                                  <PresetMetadataValueInput
                                    field={field}
                                    onChange={(value) => setMetadataValue(field.id, value)}
                                    value={draft.metadata_values?.[field.id] ?? ""}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <div className="grid gap-2">
              <section className="overflow-hidden rounded-2xl border border-mist bg-white">
                <SectionHeader
                  action={
                    <div className="flex items-center gap-1.5">
                      {namingSaveStatus ? (
                        <span className="max-w-[180px] truncate text-[11px] font-semibold text-emerald-600">{namingSaveStatus}</span>
                      ) : null}
                      <button
                        className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                        onClick={() => {
                          setNamingSaveName(draft.name);
                          setNamingSaveOpen(true);
                        }}
                        title="Save this folder-name pattern as a naming preset, usable from the Naming tab and the ingest Name wizard."
                        type="button"
                      >
                        <Plus size={13} />
                        New naming preset
                      </button>
                    </div>
                  }
                  help="This pattern creates the root project folder name. The Preview line under the field shows the resolved example. Type $ in the field to search tokens."
                  title="Project Folder Name"
                />
                <div className="p-2">
                  <PatternInput
                    context={context}
                    density="compact"
                    label="Project folder"
                    onChange={(root_folder_pattern) => updateDraft({ root_folder_pattern })}
                    scope="folder"
                    value={draft.root_folder_pattern}
                    variables={allParameters}
                  />
                </div>
              </section>

              <section className="overflow-hidden rounded-2xl border border-mist bg-white">
                <SectionHeader
                  help="This pattern renames copied media during ingest. The Preview line under the field shows the resolved example filename."
                  title="Copied File Name"
                />
                <div className="p-2">
                  <PatternInput
                    context={context}
                    density="compact"
                    label="Copied file"
                    onChange={(file_rename_pattern) => updateDraft({ file_rename_pattern })}
                    scope="filename"
                    value={draft.file_rename_pattern}
                    variables={allParameters}
                  />
                </div>
              </section>
            </div>
        </div>

        <section className="mt-2 overflow-x-auto rounded-2xl border border-mist bg-white">
            <SectionHeader
              action={
                <button
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={addVariable}
                  type="button"
                >
                  <Plus size={13} />
                  Add
                </button>
              }
              help="Variables are the fields users fill out on Create Folders and Ingest Media. Their tokens can be used in folder and file names."
              title="Project Variables"
            />
            <div className="grid min-w-[760px] grid-cols-[1fr_1fr_104px_1fr_76px_64px_44px] border-b border-mist bg-porcelain px-3 py-2 text-xs font-semibold text-graphite">
              <div>Title</div>
              <div>Token</div>
              <div>Type</div>
              <div>Default / Options</div>
              <div>Required</div>
              <div>Order</div>
              <div />
            </div>
            <div className="divide-y divide-mist">
              {draft.variables.map((variable, index) => (
                <VariableRow
                  canMoveDown={index < draft.variables.length - 1}
                  canMoveUp={index > 0}
                  key={variableRowKeys[index] ?? index}
                  onMoveDown={() => moveVariable(index, 1)}
                  onMoveUp={() => moveVariable(index, -1)}
                  onRemove={() => removeVariable(index)}
                  onUpdate={(patch) => updateVariable(index, patch)}
                  variable={variable}
                />
              ))}
            </div>
        </section>

        <div className="mt-2">
          <FolderTreeEditor
            context={context}
            folders={draft.folder_tree}
            onChange={(folder_tree) => updateDraft({ folder_tree })}
            routingOverrides={draft.file_type_routing_overrides}
            onRoutingChange={(file_type_routing_overrides) => updateDraft({ file_type_routing_overrides })}
            customFileKinds={customFileKinds}
            metadataSummaries={metadataSummaries}
            variables={allParameters}
          />
        </div>
      </div>

      {namingSaveOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm" onClick={() => setNamingSaveOpen(false)}>
          <section
            className="w-full max-w-sm rounded-[24px] border border-mist bg-paper p-4 shadow-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-base font-semibold">New naming preset</h3>
            <p className="mt-0.5 text-xs text-graphite">
              Saves this pattern to the Naming tab so it can be applied to other presets or picked in the ingest Name
              wizard.
            </p>
            <div className="mt-2 rounded-lg bg-porcelain px-2 py-1.5 font-mono text-xs text-ink">{draft.root_folder_pattern}</div>
            <label className="mt-3 block">
              <div className="mb-1 text-xs font-semibold text-graphite">Name</div>
              <input
                autoFocus
                className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                onChange={(event) => setNamingSaveName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void saveAsNamingPreset();
                  }
                }}
                value={namingSaveName}
              />
            </label>
            <label className="mt-2 block">
              <div className="mb-1 text-xs font-semibold text-graphite">Group</div>
              <input
                className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                list="naming-group-suggestions"
                onChange={(event) => setNamingSaveGroup(event.target.value)}
                placeholder="e.g. Video Capture, Weekends, Home"
                value={namingSaveGroup}
              />
              <datalist id="naming-group-suggestions">
                {[...new Set(namingDeliverables.map((item) => item.group))].map((group) => (
                  <option key={group} value={group} />
                ))}
              </datalist>
            </label>
            <div className="mt-3 flex justify-end gap-2">
              <button
                className="inline-flex h-8 items-center rounded-lg border border-mist bg-white px-3 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                onClick={() => setNamingSaveOpen(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex h-8 items-center rounded-lg bg-signal px-3 text-xs font-semibold text-paper transition hover:bg-black disabled:opacity-40"
                disabled={!namingSaveName.trim()}
                onClick={() => void saveAsNamingPreset()}
                type="button"
              >
                Create
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isMetadataManagerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm">
          <section className="flex h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-[24px] border border-mist bg-paper p-3 shadow-panel">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">Metadata presets</h2>
                <p className="text-xs text-graphite">Create or edit metadata schemas and their field options. Selecting one attaches it to this preset.</p>
              </div>
              <button
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-signal px-3 text-sm font-semibold text-paper transition hover:bg-black"
                onClick={() => {
                  setIsMetadataManagerOpen(false);
                  refreshMetadataSummaries();
                }}
                type="button"
              >
                Done
              </button>
            </div>
            <MetadataPresetsManager
              onChange={refreshMetadataSummaries}
              onSelect={(id) => updateDraft({ metadata_preset_id: id })}
              selectedId={draft.metadata_preset_id}
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}

function ColorField({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  const normalizedColor = /^#[0-9a-f]{6}$/i.test(value) ? value : "#c9a7ff";

  return (
    <label className="grid min-h-10 grid-cols-[110px_1fr_auto] items-center gap-2 px-3 py-1.5">
      <span className="text-xs font-semibold text-graphite">Color</span>
      <input
        className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 font-mono text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
      <input
        aria-label="Preset color"
        className="h-8 w-9 cursor-pointer rounded-lg border border-mist bg-white p-1"
        onChange={(event) => onChange(event.target.value)}
        type="color"
        value={normalizedColor}
      />
    </label>
  );
}

function ClipPaddingField({
  onChange,
  value,
}: {
  onChange: (value: number) => void;
  value: number;
}) {
  const normalizedValue = Math.min(6, Math.max(1, value || 1));

  function step(amount: number) {
    onChange(Math.min(6, Math.max(1, normalizedValue + amount)));
  }

  return (
    <div className="px-3 py-1.5">
      <div className="grid min-h-8 grid-cols-[110px_1fr] items-center gap-2">
        <div className="flex items-center gap-1 text-xs font-semibold text-graphite">
          Clip # Padding
          <FloatingHelp label="Clip number padding help">
            <div className="mb-1 font-semibold text-ink">Clip number padding</div>
            <div className="text-graphite">
              Controls how many digits the <code className="font-semibold text-ink">{"{clip#}"}</code> token uses.
              A value of <strong className="text-ink">3</strong> turns clip 1 into{" "}
              <strong className="text-ink">001</strong>.
            </div>
          </FloatingHelp>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <input
            className="h-8 w-16 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
            max={6}
            min={1}
            onChange={(event) => onChange(Math.min(6, Math.max(1, Number(event.target.value) || 1)))}
            type="number"
            value={normalizedValue}
          />
          <div className="flex shrink-0 overflow-hidden rounded-lg border border-mist">
            <button
              className="inline-flex h-8 w-8 items-center justify-center bg-white text-graphite transition hover:bg-porcelain hover:text-ink"
              onClick={() => step(-1)}
              title="Decrease clip number padding"
              type="button"
            >
              <Minus size={13} />
            </button>
            <button
              className="inline-flex h-8 w-8 items-center justify-center border-l border-mist bg-white text-graphite transition hover:bg-porcelain hover:text-ink"
              onClick={() => step(1)}
              title="Increase clip number padding"
              type="button"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidecarToggle({
  onChange,
  value,
}: {
  onChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <label className="grid min-h-10 grid-cols-[110px_1fr] items-center gap-2 px-3 py-1.5">
      <span className="text-xs font-semibold text-graphite">Sidecars</span>
      <span className="flex min-w-0 items-center gap-2">
        <input
          checked={!value}
          className="h-4 w-4 shrink-0 accent-black"
          onChange={(event) => onChange(!event.target.checked)}
          type="checkbox"
        />
        <span className="truncate text-xs font-medium text-graphite">Delete XML and paired sidecar files</span>
      </span>
    </label>
  );
}

function RenameToggle({
  onChange,
  value,
}: {
  onChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <label className="grid min-h-10 grid-cols-[110px_1fr] items-center gap-2 px-3 py-1.5">
      <span className="text-xs font-semibold text-graphite">Rename</span>
      <span className="flex min-w-0 items-center gap-2">
        <input
          checked={value}
          className="h-4 w-4 shrink-0 accent-black"
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span className="truncate text-xs font-medium text-graphite">Rename clips with the file pattern by default</span>
      </span>
    </label>
  );
}

function SectionHeader({ action, help, title }: { action?: ReactNode; help?: ReactNode; title: string }) {
  return (
    <div className="flex h-10 items-center justify-between border-b border-mist px-3">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {help ? <FloatingHelp label={`${title} help`}>{help}</FloatingHelp> : null}
      </div>
      {action}
    </div>
  );
}

function CompactTextField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="grid min-h-10 grid-cols-[110px_1fr] items-center gap-2 px-3 py-1.5">
      <span className="text-xs font-semibold text-graphite">{label}</span>
      <input
        className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function VariableRow({
  canMoveDown,
  canMoveUp,
  onMoveDown,
  onMoveUp,
  onRemove,
  onUpdate,
  variable,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<PresetVariable>) => void;
  variable: PresetVariable;
}) {
  return (
    <div className="grid min-h-10 min-w-[760px] grid-cols-[1fr_1fr_104px_1fr_76px_64px_44px] items-center gap-2 px-3 py-1.5 text-sm">
      <input
        className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => {
          const name = event.target.value;
          const shouldAutoUpdateId = variable.id === slugifyToken(variable.name);
          onUpdate({
            name,
            id: shouldAutoUpdateId ? slugifyToken(name) : variable.id,
          });
        }}
        value={variable.name}
      />
      <input
        className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 font-mono text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => onUpdate({ id: slugifyToken(event.target.value) })}
        value={variable.id}
      />
      <SelectMenu
        onChange={(value) =>
          onUpdate({
            type: value as VariableType,
            default: defaultForVariableType(value as VariableType),
            options: value === "dropdown" ? variable.options : [],
          })
        }
        options={variableTypes}
        size="sm"
        value={variable.type}
      />
      <DefaultValueEditor onUpdate={onUpdate} variable={variable} />
      <label className="flex items-center justify-center">
        <input
          checked={variable.required}
          className="h-4 w-4 accent-black"
          onChange={(event) => onUpdate({ required: event.target.checked })}
          type="checkbox"
        />
      </label>
      <div className="flex overflow-hidden rounded-lg border border-mist">
        <button
          aria-label={`Move ${variable.name} up`}
          className="inline-flex h-8 w-8 items-center justify-center bg-white text-graphite transition hover:bg-porcelain hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
          disabled={!canMoveUp}
          onClick={onMoveUp}
          title="Move up"
          type="button"
        >
          <ArrowUp size={13} />
        </button>
        <button
          aria-label={`Move ${variable.name} down`}
          className="inline-flex h-8 w-8 items-center justify-center border-l border-mist bg-white text-graphite transition hover:bg-porcelain hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
          disabled={!canMoveDown}
          onClick={onMoveDown}
          title="Move down"
          type="button"
        >
          <ArrowDown size={13} />
        </button>
      </div>
      <button
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-graphite transition hover:bg-red-50 hover:text-red-800"
        onClick={onRemove}
        title={`Remove ${variable.name}`}
        type="button"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function DefaultValueEditor({
  onUpdate,
  variable,
}: {
  onUpdate: (patch: Partial<PresetVariable>) => void;
  variable: PresetVariable;
}) {
  if (variable.type === "boolean") {
    return (
      <SelectMenu
        onChange={(value) => onUpdate({ default: value === "true" })}
        options={[
          { label: "False", value: "false" },
          { label: "True", value: "true" },
        ]}
        size="sm"
        value={String(Boolean(variable.default))}
      />
    );
  }

  if (variable.type === "dropdown") {
    return (
      <OptionsTextField
        onChange={(options) => onUpdate({ options, default: "" })}
        placeholder="KLR, FM, TL"
        value={variable.options}
      />
    );
  }

  if (variable.type === "date") {
    return (
      <input
        className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => onUpdate({ default: event.target.value || "today" })}
        type="date"
        value={dateDefaultInputValue(variable.default)}
      />
    );
  }

  return (
    <input
      className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
      onChange={(event) => onUpdate({ default: event.target.value })}
      value={String(variable.default ?? "")}
    />
  );
}

function defaultForVariableType(type: VariableType) {
  if (type === "boolean") {
    return false;
  }
  if (type === "date") {
    return "today";
  }
  return "";
}

function dateDefaultInputValue(value: PresetVariable["default"]) {
  const defaultValue = typeof value === "string" ? value.trim() : "";
  return !defaultValue || defaultValue.toLowerCase() === "today" ? currentLocalDate() : defaultValue;
}

function createPreviewContext(preset: Preset, parameters: PresetVariable[]): TokenContext {
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

function previewValueForVariable(variable: PresetVariable) {
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

function countFolders(folders: FolderNode[]): number {
  return folders.reduce((count, folder) => count + 1 + countFolders(folder.children), 0);
}

function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number) {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  if (typeof item !== "undefined") {
    next.splice(toIndex, 0, item);
  }
  return next;
}

function createRowKey() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
