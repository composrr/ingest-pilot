import { open } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, FolderOpen, Minus, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FloatingHelp } from "./FloatingHelp";
import { FolderTreeEditor } from "./FolderTreeEditor";
import { OptionsTextField } from "./OptionsTextField";
import { PatternInput } from "./PatternInput";
import { SelectMenu } from "./SelectMenu";
import { currentLocalDate, mergeGlobalAndPresetParameters, slugifyToken } from "../lib/parameters";
import { getSettings } from "../lib/tauri";
import type { FolderNode, Preset, PresetVariable, TokenContext, VariableType } from "../lib/types";

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

export function PresetEditor({ initialPreset, onCancel, onSave }: PresetEditorProps) {
  const [draft, setDraft] = useState<Preset>(initialPreset);
  const [variableRowKeys, setVariableRowKeys] = useState(() =>
    initialPreset.variables.map(() => createRowKey()),
  );
  const [globalParameters, setGlobalParameters] = useState<PresetVariable[]>([]);
  const allParameters = useMemo(
    () => mergeGlobalAndPresetParameters(globalParameters, draft.variables),
    [draft.variables, globalParameters],
  );
  const context = useMemo(() => createPreviewContext(draft, allParameters), [allParameters, draft]);

  useEffect(() => {
    getSettings()
      .then((settings) => setGlobalParameters(settings.global_parameters))
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
                <SpeedTargetField
                  onChange={(target_bps) => updateDraft({ target_bps })}
                  value={draft.target_bps}
                />
              </div>
            </section>

            <div className="grid gap-2">
              <section className="overflow-hidden rounded-2xl border border-mist bg-white">
                <SectionHeader
                  help="This pattern creates the root project folder name. The Preview line under the field shows the resolved example."
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
            variables={allParameters}
          />
        </div>
      </div>
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

function SpeedTargetField({
  onChange,
  value,
}: {
  onChange: (value: number) => void;
  value: number;
}) {
  // Stored as bytes/sec; edited as MB/s. 0 = no target.
  const mbps = value > 0 ? Math.round(value / 1_000_000) : "";
  return (
    <label className="grid min-h-10 grid-cols-[110px_1fr] items-center gap-2 px-3 py-1.5">
      <span className="text-xs font-semibold text-graphite">Speed target</span>
      <span className="flex min-w-0 items-center gap-2">
        <input
          className="h-8 w-20 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          inputMode="numeric"
          min={0}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange(Number.isFinite(next) && next > 0 ? Math.round(next * 1_000_000) : 0);
          }}
          placeholder="—"
          type="number"
          value={mbps}
        />
        <span className="truncate text-xs font-medium text-graphite">MB/s target on the run screen (optional)</span>
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
