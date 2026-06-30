import { Plus, Save, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { FloatingHelp } from "../components/FloatingHelp";
import { OptionsTextField } from "../components/OptionsTextField";
import { SelectMenu } from "../components/SelectMenu";
import { currentLocalDate, slugifyToken } from "../lib/parameters";
import { defaultAppSettings, getSettings, saveSettings } from "../lib/tauri";
import type { AppSettings, PresetVariable, VariableType } from "../lib/types";
import { useAppStore } from "../stores/appStore";

const variableTypes: Array<{ value: VariableType; label: string }> = [
  { value: "short_text", label: "Text" },
  { value: "long_text", label: "Long Text" },
  { value: "dropdown", label: "List" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const setLastAction = useAppStore((state) => state.setLastAction);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((caught) => {
        setError(String(caught));
        setLastAction("Settings load failed");
      });
  }, [setLastAction]);

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function updateParameter(index: number, patch: Partial<PresetVariable>) {
    setSettings((current) => {
      const global_parameters = [...current.global_parameters];
      global_parameters[index] = { ...global_parameters[index], ...patch };
      return { ...current, global_parameters };
    });
  }

  function addParameter() {
    setSettings((current) => {
      const number = current.global_parameters.length + 1;
      return {
        ...current,
        global_parameters: [
          ...current.global_parameters,
          {
            id: `global_${number}`,
            name: `Global ${number}`,
            type: "short_text",
            required: false,
            default: "",
            options: [],
          },
        ],
      };
    });
  }

  function removeParameter(index: number) {
    setSettings((current) => ({
      ...current,
      global_parameters: current.global_parameters.filter((_, parameterIndex) => parameterIndex !== index),
    }));
  }

  async function saveDraft() {
    setIsSaving(true);
    setError(null);
    try {
      const saved = await saveSettings(settings);
      setSettings(saved);
      setLastAction("Settings saved");
    } catch (caught) {
      setError(String(caught));
      setLastAction("Settings save failed");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">App defaults and shared setup</p>
          <h1 className="text-xl font-semibold tracking-normal">Settings</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-graphite">
            Set how ingest starts, how reports are written, how file picking behaves, and which variables are shared everywhere.
          </p>
        </div>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-signal px-2.5 text-xs font-semibold text-paper transition hover:bg-black disabled:opacity-40"
          disabled={isSaving}
          onClick={() => void saveDraft()}
          type="button"
        >
          <Save size={16} />
          {isSaving ? "Saving..." : "Save"}
        </button>
      </header>

      {error ? (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 gap-2 xl:grid-cols-2">
        <div className="grid min-h-0 gap-2">
          <SettingsSection
            help="These defaults apply when opening Ingest Media. Presets can still override some behavior."
            title="Ingest Defaults"
          >
            <ToggleRow
              checked={settings.ingest_defaults.auto_scan_sources}
              description="After choosing a source folder/card, scan in the background automatically."
              label="Auto-scan selected sources"
              onChange={(auto_scan_sources) =>
                updateSettings({ ingest_defaults: { ...settings.ingest_defaults, auto_scan_sources } })
              }
            />
            <ToggleRow
              checked={settings.ingest_defaults.rename_files}
              description="Use the preset filename pattern by default."
              label="Rename files during ingest"
              onChange={(rename_files) =>
                updateSettings({ ingest_defaults: { ...settings.ingest_defaults, rename_files } })
              }
            />
            <ToggleRow
              checked={settings.ingest_defaults.delete_sidecars}
              description="When enabled, XML/XMP/THM/CPF companions are skipped."
              label="Delete sidecars by default"
              onChange={(delete_sidecars) =>
                updateSettings({ ingest_defaults: { ...settings.ingest_defaults, delete_sidecars } })
              }
            />
            <CompactSelectRow
              description="Choose whether Ingest Media starts in new-project or existing-folder mode."
              label="Destination mode"
              onChange={(destination_mode) =>
                updateSettings({
                  ingest_defaults: {
                    ...settings.ingest_defaults,
                    destination_mode: destination_mode as AppSettings["ingest_defaults"]["destination_mode"],
                  },
                })
              }
              options={[
                { label: "Create new project folder", value: "create_new" },
                { label: "Use existing folder", value: "existing_root" },
              ]}
              value={settings.ingest_defaults.destination_mode}
            />
            <ToggleRow
              checked={settings.ingest_defaults.open_folder_when_done}
              description="Open the completed project folder after ingest finishes."
              label="Open folder when done"
              onChange={(open_folder_when_done) =>
                updateSettings({ ingest_defaults: { ...settings.ingest_defaults, open_folder_when_done } })
              }
            />
          </SettingsSection>

          <SettingsSection
            help="These settings control the Choose Files dialog without changing the ingest engine."
            title="File Selector"
          >
            <CompactSelectRow
              description="Default view when opening Choose Files."
              label="Default view"
              onChange={(default_view) =>
                updateSettings({
                  file_selector: {
                    ...settings.file_selector,
                    default_view: default_view as AppSettings["file_selector"]["default_view"],
                  },
                })
              }
              options={[
                { label: "List", value: "list" },
                { label: "Thumbnails", value: "thumbs" },
              ]}
              value={settings.file_selector.default_view}
            />
            <SliderRow
              description="Starting thumbnail size. You can still change it in the picker."
              label="Thumbnail size"
              max={260}
              min={80}
              onChange={(thumbnail_size) =>
                updateSettings({ file_selector: { ...settings.file_selector, thumbnail_size } })
              }
              value={settings.file_selector.thumbnail_size}
            />
          </SettingsSection>

        </div>

        <div className="grid min-h-0 content-start gap-2">
          <SettingsSection
            help="Report settings are persisted now; deeper report layout controls will come as reporting matures."
            title="Reports"
          >
            <ToggleRow
              checked={settings.report_defaults.write_html_report}
              description="Write the readable HTML report after ingest."
              label="Write HTML report"
              onChange={(write_html_report) =>
                updateSettings({ report_defaults: { ...settings.report_defaults, write_html_report } })
              }
            />
            <ToggleRow
              checked={settings.report_defaults.include_thumbnails}
              description="Use available thumbnails in reports when they can be matched."
              label="Include thumbnails"
              onChange={(include_thumbnails) =>
                updateSettings({ report_defaults: { ...settings.report_defaults, include_thumbnails } })
              }
            />
            <ToggleRow
              checked={settings.report_defaults.open_report_when_done}
              description="Open the report automatically after ingest finishes."
              label="Open report when done"
              onChange={(open_report_when_done) =>
                updateSettings({ report_defaults: { ...settings.report_defaults, open_report_when_done } })
              }
            />
            <TextRow
              description="Saved with settings now; report template insertion comes later."
              label="Default notes"
              onChange={(notes_template) =>
                updateSettings({ report_defaults: { ...settings.report_defaults, notes_template } })
              }
              value={settings.report_defaults.notes_template}
            />
            <TextRow
              description="Printed on offload integrity proofs (who performed the ingest)."
              label="Operator name"
              onChange={(operator_name) => updateSettings({ operator_name })}
              value={settings.operator_name}
            />
          </SettingsSection>

          <SettingsSection
            help="Near-term behavior for automatically finding camera cards."
            title="Camera Cards"
          >
            <ToggleRow
              checked={settings.camera_watcher.auto_detect_cards}
              description="Look for inserted camera cards and prefill Copy From."
              label="Auto-detect cards"
              onChange={(auto_detect_cards) =>
                updateSettings({ camera_watcher: { ...settings.camera_watcher, auto_detect_cards } })
              }
            />
            <ToggleRow
              checked={settings.camera_watcher.prompt_on_card_detected}
              description="Future tray behavior: prompt when a new camera card appears."
              label="Prompt on card"
              onChange={(prompt_on_card_detected) =>
                updateSettings({ camera_watcher: { ...settings.camera_watcher, prompt_on_card_detected } })
              }
            />
            <ToggleRow
              checked={settings.camera_watcher.tray_mode}
              description="Future behavior: keep the app ready in the tray."
              label="Tray mode"
              onChange={(tray_mode) =>
                updateSettings({ camera_watcher: { ...settings.camera_watcher, tray_mode } })
              }
            />
          </SettingsSection>
        </div>

        <section className="min-h-0 overflow-visible rounded-2xl border border-mist bg-white xl:col-span-2">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-mist px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-sm font-semibold">Global Variables</h2>
                  <FloatingHelp label="Global variables help">
                    Global variables show up in presets, Create Folders, and Ingest Media so common choices do not need to be recreated in every preset.
                  </FloatingHelp>
                </div>
                <p className="mt-0.5 text-[11px] font-medium text-graphite">
                  Shared tokens available everywhere: presets, Create Folders, and Ingest Media.
                </p>
              </div>
              <button
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                onClick={addParameter}
                type="button"
              >
                <Plus size={13} />
                Add variable
              </button>
            </div>

            <div>
              {settings.global_parameters.length === 0 ? (
                <div className="px-3 py-6 text-sm text-graphite">
                  Add shared variables like Campus once, then use them across presets, Create Folders, and Ingest Media.
                </div>
              ) : (
                <div className="divide-y divide-mist">
                  {settings.global_parameters.map((parameter, index) => (
                    <GlobalParameterRow
                      key={index}
                      onRemove={() => removeParameter(index)}
                      onUpdate={(patch) => updateParameter(index, patch)}
                      parameter={parameter}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
      </div>
    </div>
  );
}

function SettingsSection({ children, help, title }: { children: ReactNode; help: string; title: string }) {
  return (
    <section className="overflow-visible rounded-2xl border border-mist bg-white">
      <div className="flex h-10 items-center gap-1.5 border-b border-mist px-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <FloatingHelp label={`${title} help`}>{help}</FloatingHelp>
      </div>
      <div className="divide-y divide-mist">{children}</div>
    </section>
  );
}

function ToggleRow({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="grid min-h-10 grid-cols-[1fr_auto] items-center gap-3 px-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="block truncate text-[11px] text-graphite">{description}</span>
      </span>
      <input checked={checked} className="h-4 w-4 accent-signal" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
    </label>
  );
}

function CompactSelectRow({
  description,
  label,
  onChange,
  options,
  value,
}: {
  description: string;
  label: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
}) {
  return (
    <div className="grid min-h-10 grid-cols-[1fr_170px] items-center gap-3 px-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="block truncate text-[11px] text-graphite">{description}</span>
      </span>
      <SelectMenu onChange={onChange} options={options} size="sm" value={value} />
    </div>
  );
}

function SliderRow({
  description,
  label,
  max,
  min,
  onChange,
  value,
}: {
  description: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <div className="grid min-h-10 grid-cols-[1fr_190px] items-center gap-3 px-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="block truncate text-[11px] text-graphite">{description}</span>
      </span>
      <span className="flex items-center gap-2">
        <input className="w-full accent-signal" max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={4} type="range" value={value} />
        <span className="w-10 text-right text-[11px] font-semibold text-graphite">{value}px</span>
      </span>
    </div>
  );
}

function TextRow({
  description,
  label,
  onChange,
  value,
}: {
  description: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="grid min-h-10 grid-cols-[1fr_190px] items-center gap-3 px-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="block truncate text-[11px] text-graphite">{description}</span>
      </span>
      <input
        className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </div>
  );
}

function GlobalParameterRow({
  onRemove,
  onUpdate,
  parameter,
}: {
  onRemove: () => void;
  onUpdate: (patch: Partial<PresetVariable>) => void;
  parameter: PresetVariable;
}) {
  return (
    <div className="space-y-1 px-3 py-2 text-sm">
      <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
        <input
          className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => {
            const name = event.target.value;
            const shouldAutoUpdateId = parameter.id === slugifyToken(parameter.name);
            onUpdate({
              name,
              id: shouldAutoUpdateId ? slugifyToken(name) : parameter.id,
            });
          }}
          value={parameter.name}
        />
        <input
          className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 font-mono text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => onUpdate({ id: slugifyToken(event.target.value) })}
          value={parameter.id}
        />
        <button
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-graphite transition hover:bg-red-50 hover:text-red-800"
          onClick={onRemove}
          title={`Remove ${parameter.name}`}
          type="button"
        >
          <Trash2 size={15} />
        </button>
      </div>
      <div className="grid grid-cols-[112px_1fr] gap-1.5">
        <SelectMenu
          onChange={(value) =>
            onUpdate({
              type: value as VariableType,
              default: defaultForVariableType(value as VariableType),
              options: value === "dropdown" ? parameter.options : [],
            })
          }
          options={variableTypes}
          size="sm"
          value={parameter.type}
        />
        <DefaultOrOptions parameter={parameter} onUpdate={onUpdate} />
      </div>
    </div>
  );
}

function DefaultOrOptions({
  onUpdate,
  parameter,
}: {
  onUpdate: (patch: Partial<PresetVariable>) => void;
  parameter: PresetVariable;
}) {
  if (parameter.type === "boolean") {
    return (
      <SelectMenu
        onChange={(value) => onUpdate({ default: value === "true" })}
        options={[
          { label: "False", value: "false" },
          { label: "True", value: "true" },
        ]}
        size="sm"
        value={String(Boolean(parameter.default))}
      />
    );
  }

  if (parameter.type === "dropdown") {
    return (
      <OptionsTextField
        onChange={(options) => onUpdate({ options, default: "" })}
        placeholder="KLR, MCK, HLT, AGL"
        value={parameter.options}
      />
    );
  }

  if (parameter.type === "date") {
    return (
      <input
        className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => onUpdate({ default: event.target.value || "today" })}
        type="date"
        value={dateDefaultInputValue(parameter.default)}
      />
    );
  }

  return (
    <input
      className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
      onChange={(event) => onUpdate({ default: event.target.value })}
      value={String(parameter.default ?? "")}
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
