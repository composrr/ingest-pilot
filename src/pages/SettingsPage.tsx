import { CheckCircle2, DownloadCloud, Plus, Plug, RefreshCw, RotateCcw, Save, Trash2, UploadCloud, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { FloatingHelp } from "../components/FloatingHelp";
import { OptionsTextField } from "../components/OptionsTextField";
import { SelectMenu } from "../components/SelectMenu";
import { currentLocalDate, slugifyToken } from "../lib/parameters";
import { playCompletionSound } from "../lib/sound";
import {
  defaultAppSettings,
  exportConfigBundle,
  getSettings,
  iconikListViews,
  importConfigBundle,
  saveSettings,
  type IconikView,
} from "../lib/tauri";
import type {
  AppSettings,
  IconikSettings,
  PresetVariable,
  ReportOutputLocation,
  SafetySettings,
  Shooter,
  ShooterGroup,
  VariableType,
} from "../lib/types";
import { checkForUpdate } from "../lib/updater";
import { useAppStore } from "../stores/appStore";

const variableTypes: Array<{ value: VariableType; label: string }> = [
  { value: "short_text", label: "Text" },
  { value: "long_text", label: "Long Text" },
  { value: "dropdown", label: "List" },
  { value: "boolean", label: "Yes / No" },
  { value: "date", label: "Date" },
];

type SettingsTab = "ingest" | "automation" | "metadata" | "reports" | "safety" | "advanced" | "about";

const SETTINGS_TABS: { id: SettingsTab; label: string; advanced?: boolean }[] = [
  { id: "ingest", label: "Ingest" },
  { id: "automation", label: "Automation" },
  { id: "metadata", label: "Metadata" },
  { id: "reports", label: "Reports" },
  { id: "safety", label: "Safety" },
  { id: "advanced", label: "Advanced", advanced: true },
  { id: "about", label: "About" },
];

// Renders its children only when its tab is active. Sections are wrapped in these so
// the same flat JSX list can drive a tabbed layout without reordering the markup.
function TabPanel({ active, tab, children }: { active: SettingsTab; tab: SettingsTab; children: ReactNode }) {
  return active === tab ? <div className="space-y-2">{children}</div> : null;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("ingest");
  const setLastAction = useAppStore((state) => state.setLastAction);
  const bumpSettingsRev = useAppStore((state) => state.bumpSettingsRev);
  const setPendingUpdate = useAppStore((state) => state.setPendingUpdate);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "uptodate" | "error">("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);

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
    setJustSaved(false);
    setError(null);
    try {
      const saved = await saveSettings(settings);
      setSettings(saved);
      // Signal the always-mounted Ingest screen to re-read settings.
      bumpSettingsRev();
      setLastAction("Settings saved");
      // Flash a clear "Saved" confirmation so it's obvious the click took effect.
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2600);
    } catch (caught) {
      setError(String(caught));
      setLastAction("Settings save failed");
    } finally {
      setIsSaving(false);
    }
  }

  // Reset every setting back to defaults (after a confirm), then persist it so the
  // change is immediate and obvious.
  async function resetDefaults() {
    if (!window.confirm("Reset all settings to their defaults? This can't be undone.")) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const saved = await saveSettings(defaultAppSettings);
      setSettings(saved);
      bumpSettingsRev();
      setLastAction("Settings reset to defaults");
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2600);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setIsSaving(false);
    }
  }

  async function checkUpdates() {
    setUpdateStatus("checking");
    setUpdateError(null);
    try {
      const update = await checkForUpdate();
      if (update) {
        setPendingUpdate(update);
        setUpdateStatus("idle");
        setLastAction(`Update v${update.version} available`);
      } else {
        setUpdateStatus("uptodate");
        setLastAction("No updates found");
      }
    } catch (caught) {
      setUpdateStatus("error");
      setUpdateError(String(caught));
      setLastAction("Update check failed");
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
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-graphite">
            <input
              checked={settings.show_advanced}
              className="h-3.5 w-3.5 accent-signal"
              onChange={(event) => updateSettings({ show_advanced: event.target.checked })}
              type="checkbox"
            />
            Show advanced
          </label>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={() => void resetDefaults()}
            title="Reset all settings to their defaults"
            type="button"
          >
            <RotateCcw size={14} />
            Reset
          </button>
          <button
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-paper transition disabled:opacity-40 ${
              justSaved ? "bg-emerald-600 hover:bg-emerald-600" : "bg-signal hover:bg-black"
            }`}
            disabled={isSaving}
            onClick={() => void saveDraft()}
            type="button"
          >
            {justSaved ? <CheckCircle2 size={16} /> : <Save size={16} />}
            {isSaving ? "Saving..." : justSaved ? "Saved" : "Save"}
          </button>
        </div>
      </header>

      <div className="mb-2 flex flex-wrap gap-1 border-b border-mist pb-2">
        {SETTINGS_TABS.filter((tab) => !tab.advanced || settings.show_advanced).map((tab) => (
          <button
            key={tab.id}
            className={`h-7 rounded-lg px-3 text-xs font-semibold transition ${
              activeTab === tab.id ? "bg-signal text-paper" : "text-graphite hover:bg-porcelain"
            }`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {justSaved ? (
        <div className="mb-3 flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
          <CheckCircle2 size={16} />
          Settings saved.
        </div>
      ) : null}

      {error ? (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div>
        <TabPanel active={activeTab} tab="ingest">
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
              description="Skip the small helper files cameras write next to clips (XMP, THM, CPF). Your video/photo files are never touched."
              label="Delete sidecar files by default"
              onChange={(delete_sidecars) => {
                if (
                  delete_sidecars &&
                  settings.safety.confirm_destructive &&
                  !window.confirm(
                    "Turn on 'Delete sidecar files'? During ingest this permanently skips XMP/THM/CPF helper files. Your video and photo files are never affected.",
                  )
                ) {
                  return;
                }
                updateSettings({ ingest_defaults: { ...settings.ingest_defaults, delete_sidecars } });
              }}
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
            <ToggleRow
              checked={settings.file_selector.group_by_date}
              description="Group files by the day they were shot in Choose Files (Today / Yesterday / date)."
              label="Group files by date"
              onChange={(group_by_date) =>
                updateSettings({ file_selector: { ...settings.file_selector, group_by_date } })
              }
            />
          </SettingsSection>
        </TabPanel>

        <TabPanel active={activeTab} tab="reports">
          <SettingsSection
            help="What the app writes after an ingest and where it puts it."
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
            help="Where the app writes the report, offload proof, reel index, and metadata CSV. Keep them in the project folder, tuck them in a subfolder, or send them to one central folder. The verified MHL stays with the media unless you move it too. Presets can override this."
            title="Where reports go"
          >
            <ReportOutputEditor
              onChange={(output_location) =>
                updateSettings({ report_defaults: { ...settings.report_defaults, output_location } })
              }
              value={settings.report_defaults.output_location}
            />
          </SettingsSection>
        </TabPanel>

        <TabPanel active={activeTab} tab="automation">
          <SettingsSection
            help="Watch for camera cards and keep the app ready in the background so a card is ingest-ready the moment it's inserted."
            title="Camera Cards & Background"
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
              checked={settings.camera_watcher.pop_open_on_card}
              description="When a card is inserted, bring the window forward and jump to Ingest with it selected."
              label="Pop open when a card is inserted"
              onChange={(pop_open_on_card) =>
                updateSettings({ camera_watcher: { ...settings.camera_watcher, pop_open_on_card } })
              }
            />
            <ToggleRow
              checked={settings.camera_watcher.tray_mode}
              description="Closing the window keeps Ingest Pilot running in the tray so it can keep watching. Quit from the tray icon."
              label="Keep running in the background"
              onChange={(tray_mode) =>
                updateSettings({ camera_watcher: { ...settings.camera_watcher, tray_mode } })
              }
            />
            <ToggleRow
              checked={settings.camera_watcher.launch_at_login}
              description="Start Ingest Pilot automatically when you log in (applies on Save)."
              label="Launch at login"
              onChange={(launch_at_login) =>
                updateSettings({ camera_watcher: { ...settings.camera_watcher, launch_at_login } })
              }
            />
            <CompactSelectRow
              description="How the window behaves when a card is inserted."
              label="Pop-open style"
              onChange={(pop_open_mode) =>
                updateSettings({
                  camera_watcher: {
                    ...settings.camera_watcher,
                    pop_open_mode: pop_open_mode as AppSettings["camera_watcher"]["pop_open_mode"],
                  },
                })
              }
              options={[
                { label: "Always bring to front", value: "always" },
                { label: "Only if already in front", value: "if_frontmost" },
                { label: "Notify, don't steal focus", value: "notify" },
              ]}
              value={settings.camera_watcher.pop_open_mode}
            />
          </SettingsSection>

          <SettingsSection
            help="The chime that plays when a transfer finishes so you know it's done without watching the screen."
            title="Sound"
          >
            <ToggleRow
              checked={settings.sound.enabled}
              description="Play a chime when a transfer finishes (a bright tone for verified, a lower one if review is needed)."
              label="Completion sound"
              onChange={(enabled) => updateSettings({ sound: { ...settings.sound, enabled } })}
            />
            <SliderRow
              description="How loud the completion chime is."
              label="Volume"
              max={100}
              min={0}
              onChange={(volume) => updateSettings({ sound: { ...settings.sound, volume } })}
              value={settings.sound.volume}
            />
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[11px] text-graphite">Preview the sound</span>
              <button
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                onClick={() => playCompletionSound(true, settings.sound.volume)}
                type="button"
              >
                Play
              </button>
            </div>
          </SettingsSection>

          <SettingsSection
            help="Nickname your card readers and drives so auto-detect shows 'CFexpress Reader #2' instead of a bare drive letter."
            title="Drive Nicknames"
          >
            <DriveNicknamesEditor
              onChange={(drive_nicknames) => updateSettings({ drive_nicknames })}
              value={settings.drive_nicknames}
            />
          </SettingsSection>
        </TabPanel>

        <TabPanel active={activeTab} tab="metadata">
          <SettingsSection
            help="The people who shoot for your team. A 'Shooter' metadata field offers this list and defaults to this machine's operator name."
            title="Shooters"
          >
            <ShootersEditor
              onChange={(shooters) => updateSettings({ shooters })}
              operator={settings.operator_name}
              value={settings.shooters}
            />
          </SettingsSection>
        </TabPanel>

        <TabPanel active={activeTab} tab="safety">
          <SettingsSection
            help="Guardrails that enforce a safe data-management discipline on this machine. Turn on Safe Mode to switch on the whole set at once."
            title="Data Safety"
          >
            <SafetyEditor
              onChange={(safety) => updateSettings({ safety })}
              value={settings.safety}
            />
          </SettingsSection>
        </TabPanel>

        <TabPanel active={activeTab} tab="about">
          <SettingsSection
            help="Ingest Pilot checks for updates on launch and asks before installing. You can also check manually here."
            title="About & Updates"
          >
            <div className="grid min-h-10 grid-cols-[1fr_auto] items-center gap-3 px-3 py-1.5">
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-ink">Current version</span>
                <span
                  className={`block truncate text-[11px] ${
                    updateStatus === "error" ? "text-red-700" : "text-graphite"
                  }`}
                >
                  {updateStatus === "checking"
                    ? "Checking for updates…"
                    : updateStatus === "uptodate"
                      ? "You’re on the latest version."
                      : updateStatus === "error"
                        ? (updateError ?? "Update check failed.")
                        : "Updates install with your approval, then restart the app."}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-graphite">v{__APP_VERSION__}</span>
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-50"
                  disabled={updateStatus === "checking"}
                  onClick={() => void checkUpdates()}
                  type="button"
                >
                  <RefreshCw className={updateStatus === "checking" ? "animate-spin" : ""} size={14} />
                  Check for updates
                </button>
              </span>
            </div>
          </SettingsSection>
        </TabPanel>

        <TabPanel active={activeTab} tab="ingest">
        <section className="min-h-0 overflow-visible rounded-2xl border border-mist bg-white">
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-mist px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="text-sm font-semibold">Custom File Types</h2>
                <FloatingHelp label="Custom file types help">
                  Permanently classify extra extensions into a media role. Anything you add is treated as that role
                  everywhere — scans, routing to the role's folder, and reports. Save to apply.
                </FloatingHelp>
              </div>
              <p className="mt-0.5 text-[11px] font-medium text-graphite">
                Give an unusual extension a role so it lands with the rest of that media type.
              </p>
            </div>
          </div>
          <CustomFileKindsEditor
            onChange={(custom_file_kinds) => updateSettings({ custom_file_kinds })}
            value={settings.custom_file_kinds}
          />
        </section>
        </TabPanel>

        <TabPanel active={activeTab} tab="metadata">
        <section className="min-h-0 overflow-visible rounded-2xl border border-mist bg-white">
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-mist px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="text-sm font-semibold">iconik Metadata</h2>
                <FloatingHelp label="iconik metadata help">
                  Connect your iconik instance so Ingest Pilot can write metadata straight onto assets after an
                  ingest — no sidecar files, no CSV import. Assets are matched by filename. Your App-ID and
                  Auth-Token stay on this machine.
                </FloatingHelp>
              </div>
              <p className="mt-0.5 text-[11px] font-medium text-graphite">
                Push shoot metadata to iconik assets directly over the API. Matched by filename, no extra files.
              </p>
            </div>
          </div>
          <IconikSection
            onChange={(iconik) => updateSettings({ iconik })}
            value={settings.iconik}
          />
        </section>
        </TabPanel>

        <TabPanel active={activeTab} tab="advanced">
        <section className="min-h-0 overflow-visible rounded-2xl border border-mist bg-white">
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

          <SettingsSection
            help="Every naming token you can use in patterns: built-in date/camera/clip tokens plus your Global Variables. This is a read-only reference — edit values above or in the Naming tab."
            title="Naming Tokens"
          >
            <NamingTokenList globals={settings.global_parameters} />
          </SettingsSection>

          <SettingsSection
            help="Keyboard shortcuts for jumping around the app. They work anywhere except while typing in a field."
            title="Keyboard Shortcuts"
          >
            <KeyboardShortcutsList />
          </SettingsSection>

          <SettingsSection
            help="Save your whole setup (settings, presets, metadata presets, naming catalog, shooters) to one file, or load it onto another machine. iconik credentials are left out of the export for safety."
            title="Backup & Transfer Config"
          >
            <ConfigBundleRow onError={setError} />
          </SettingsSection>
        </TabPanel>
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

// iconik connection: base URL + App-ID + Auth-Token, a "Test connection" that lists
// the instance's metadata views, and a picker to choose which view assets are tagged
// against. Credentials live in settings.iconik and never leave the user's machine
// except in requests to their own iconik instance.
function IconikSection({
  onChange,
  value,
}: {
  onChange: (next: IconikSettings) => void;
  value: IconikSettings;
}) {
  const [status, setStatus] = useState<"idle" | "testing" | "connected" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [views, setViews] = useState<IconikView[]>([]);

  const canTest = value.base_url.trim() && value.app_id.trim() && value.auth_token.trim();

  async function testConnection() {
    setStatus("testing");
    setMessage(null);
    try {
      const loaded = await iconikListViews(value);
      setViews(loaded);
      setStatus("connected");
      setMessage(
        loaded.length
          ? `Connected — ${loaded.length} metadata view${loaded.length === 1 ? "" : "s"} found.`
          : "Connected, but this instance has no metadata views.",
      );
      // If the saved view no longer exists, clear it so we don't push to a stale id.
      if (value.view_id && !loaded.some((view) => view.id === value.view_id)) {
        onChange({ ...value, view_id: "", view_name: "" });
      }
    } catch (caught) {
      setStatus("error");
      setMessage(String(caught));
      setViews([]);
    }
  }

  const viewOptions = views.map((view) => ({ label: view.name, value: view.id }));

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-2">
      <div className="space-y-2">
        <LabeledField
          description="Your iconik URL. Usually https://app.iconik.io."
          label="Base URL"
        >
          <input
            className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
            onChange={(event) => onChange({ ...value, base_url: event.target.value })}
            placeholder="https://app.iconik.io"
            value={value.base_url}
          />
        </LabeledField>
        <LabeledField
          description="From iconik: Settings → Application tokens → App-ID."
          label="App-ID"
        >
          <input
            autoComplete="off"
            className="h-8 w-full rounded-lg border border-mist bg-white px-2 font-mono text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
            onChange={(event) => onChange({ ...value, app_id: event.target.value })}
            placeholder="00000000-0000-0000-0000-000000000000"
            value={value.app_id}
          />
        </LabeledField>
        <LabeledField
          description="The paired Auth-Token. Stored locally on this machine only."
          label="Auth-Token"
        >
          <input
            autoComplete="off"
            className="h-8 w-full rounded-lg border border-mist bg-white px-2 font-mono text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
            onChange={(event) => onChange({ ...value, auth_token: event.target.value })}
            placeholder="Paste your Auth-Token"
            type="password"
            value={value.auth_token}
          />
        </LabeledField>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
            disabled={!canTest || status === "testing"}
            onClick={() => void testConnection()}
            type="button"
          >
            {status === "testing" ? (
              <RefreshCw className="animate-spin" size={14} />
            ) : status === "connected" ? (
              <CheckCircle2 className="text-emerald-600" size={14} />
            ) : (
              <Plug size={14} />
            )}
            Test connection &amp; load views
          </button>
        </div>
        {message ? (
          <p className={`text-[11px] ${status === "error" ? "text-red-700" : "text-graphite"}`}>{message}</p>
        ) : (
          <p className="text-[11px] text-graphite/60">
            Enter your credentials, then test the connection to load your metadata views.
          </p>
        )}

        <LabeledField
          description="Assets are tagged against this metadata view when pushing."
          label="Metadata view"
        >
          {viewOptions.length ? (
            <SelectMenu
              onChange={(viewId) =>
                onChange({
                  ...value,
                  view_id: viewId,
                  view_name: views.find((view) => view.id === viewId)?.name ?? "",
                })
              }
              options={viewOptions}
              size="sm"
              value={value.view_id}
            />
          ) : (
            <div className="flex h-8 items-center rounded-lg border border-dashed border-mist px-2 text-[11px] text-graphite/60">
              {value.view_name ? `Saved view: ${value.view_name}` : "Test the connection to choose a view."}
            </div>
          )}
        </LabeledField>

        <label className="flex items-start gap-2 pt-1">
          <input
            checked={value.auto_push}
            className="mt-0.5 h-4 w-4 accent-signal"
            onChange={(event) => onChange({ ...value, auto_push: event.target.checked })}
            type="checkbox"
          />
          <span>
            <span className="block text-xs font-semibold text-ink">Push automatically after ingest</span>
            <span className="block text-[11px] text-graphite">
              Offer to push metadata to iconik as soon as an ingest finishes.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

function LabeledField({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description: string;
  label: string;
}) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">{label}</div>
      {children}
      <p className="mt-0.5 text-[11px] text-graphite/70">{description}</p>
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

const FILE_KIND_OPTIONS: { label: string; value: string }[] = [
  { label: "Footage", value: "footage" },
  { label: "Audio", value: "audio" },
  { label: "Photos", value: "photo" },
  { label: "Docs", value: "document" },
];

// Built-in extensions per kind (mirrors the Rust scanner) so the user can see what's
// already classified before adding their own.
const BUILTIN_KIND_EXTENSIONS: Record<string, string[]> = {
  footage: [".mp4", ".mov", ".mxf", ".avi", ".m4v", ".mts", ".m2ts", ".braw", ".r3d", ".crm", ".cine"],
  audio: [".wav", ".mp3", ".aif", ".aiff", ".m4a", ".flac"],
  photo: [".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".cr2", ".nef", ".arw", ".dng", ".raw", ".orf", ".rw2"],
  document: [".pdf", ".txt", ".doc", ".docx", ".csv", ".xlsx", ".xls", ".rtf"],
};

function normalizeExtension(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!trimmed) {
    return null;
  }
  const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  return /^\.[a-z0-9]+$/.test(withDot) ? withDot : null;
}

// Lets the user permanently map extra extensions into a media role. A role selector at
// the top-left drives two panels: the built-in extensions already covered for that role
// (left) and the custom ones the user is adding for it (right). Stored in
// settings.custom_file_kinds (ext -> kind) and applied globally.
const SHOOTER_GROUPS: { value: ShooterGroup; label: string; plural: string }[] = [
  { value: "staff", label: "Staff", plural: "Staff" },
  { value: "volunteer", label: "Volunteer", plural: "Volunteers" },
  { value: "contractor", label: "Contractor", plural: "Contractors" },
];

// The shared shooter roster, grouped into Staff / Volunteers / Contractors. Staff are
// the internal team shown by default on a Shooter field; volunteers and contractors are
// pre-loaded here (e.g. before a big serve day) and revealed on request at ingest so
// they don't clutter the everyday list. The operator is pinned into Staff as "you".
function ShootersEditor({
  value,
  operator,
  onChange,
}: {
  value: Shooter[];
  operator: string;
  onChange: (next: Shooter[]) => void;
}) {
  const [newName, setNewName] = useState("");
  const [newGroup, setNewGroup] = useState<ShooterGroup>("staff");

  function addShooter() {
    const name = newName.trim();
    setNewName("");
    if (name && !value.some((shooter) => shooter.name.toLowerCase() === name.toLowerCase())) {
      onChange([...value, { name, group: newGroup }]);
    }
  }

  function removeShooter(name: string) {
    onChange(value.filter((shooter) => shooter.name !== name));
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-1.5">
        <input
          className="h-8 flex-1 rounded-lg border border-mist bg-white px-2 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addShooter();
            }
          }}
          placeholder="Shooter name"
          value={newName}
        />
        <div className="w-32">
          <SelectMenu
            onChange={(group) => setNewGroup(group as ShooterGroup)}
            options={SHOOTER_GROUPS.map((entry) => ({ label: entry.label, value: entry.value }))}
            size="sm"
            value={newGroup}
          />
        </div>
        <button
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
          onClick={addShooter}
          type="button"
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      {SHOOTER_GROUPS.map((group) => {
        const members = value.filter((shooter) => shooter.group === group.value);
        const showOperator = group.value === "staff" && operator.trim().length > 0;
        if (members.length === 0 && !showOperator) {
          return null;
        }
        return (
          <div key={group.value} className="rounded-lg border border-mist bg-white p-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">{group.plural}</div>
            <div className="flex flex-wrap gap-1">
              {showOperator ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-lavender/25 px-2 py-0.5 text-[11px] font-semibold text-ink ring-1 ring-lavender/50">
                  {operator.trim()} (you)
                </span>
              ) : null}
              {members.map((shooter) => (
                <span key={shooter.name} className="inline-flex items-center gap-1 rounded-md bg-porcelain py-0.5 pl-2 pr-1 text-[11px] font-semibold text-ink">
                  {shooter.name}
                  <button
                    aria-label={`Remove ${shooter.name}`}
                    className="rounded p-0.5 text-graphite/60 transition hover:text-red-700"
                    onClick={() => removeShooter(shooter.name)}
                    type="button"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {value.length === 0 && !operator.trim() ? (
        <p className="text-[11px] text-graphite/50">No shooters yet — add your staff, then pre-load volunteers/contractors for events.</p>
      ) : null}
    </div>
  );
}

// Where generated artifacts land: project root, a named subfolder inside the project,
// or one central absolute path. The MHL can optionally move with them.
function ReportOutputEditor({
  value,
  onChange,
}: {
  value: ReportOutputLocation;
  onChange: (next: ReportOutputLocation) => void;
}) {
  return (
    <div className="space-y-2 p-3">
      <SelectMenu
        onChange={(mode) => onChange({ ...value, mode: mode as ReportOutputLocation["mode"] })}
        options={[
          { label: "Project folder (root)", value: "root" },
          { label: "A subfolder inside the project", value: "subfolder" },
          { label: "One central folder (absolute path)", value: "custom" },
        ]}
        size="sm"
        value={value.mode}
      />
      {value.mode === "subfolder" ? (
        <div>
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">Subfolder name</div>
          <input
            className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
            onChange={(event) => onChange({ ...value, subfolder: event.target.value })}
            placeholder="_Admin"
            value={value.subfolder}
          />
          <p className="mt-0.5 text-[11px] text-graphite/60">Tokens like {"{year}"} are allowed.</p>
        </div>
      ) : null}
      {value.mode === "custom" ? (
        <div>
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">Folder path</div>
          <input
            className="h-8 w-full rounded-lg border border-mist bg-white px-2 font-mono text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
            onChange={(event) => onChange({ ...value, custom_path: event.target.value })}
            placeholder="D:\\Ingest Reports"
            value={value.custom_path}
          />
        </div>
      ) : null}
      {value.mode !== "root" ? (
        <label className="flex items-start gap-2 pt-0.5">
          <input
            checked={value.move_mhl}
            className="mt-0.5 h-4 w-4 accent-signal"
            onChange={(event) => onChange({ ...value, move_mhl: event.target.checked })}
            type="checkbox"
          />
          <span>
            <span className="block text-xs font-semibold text-ink">Move the MHL manifest too</span>
            <span className="block text-[11px] text-graphite">
              Off by default — the checksum manifest belongs next to the media so the delivered folder self-verifies.
            </span>
          </span>
        </label>
      ) : null}
    </div>
  );
}

// A simple map of volume/drive path -> friendly name, shown in auto-detect / Copy From.
function DriveNicknamesEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const entries = Object.entries(value);

  function add() {
    const key = path.trim();
    const nickname = name.trim();
    setPath("");
    setName("");
    if (key && nickname) {
      onChange({ ...value, [key]: nickname });
    }
  }

  return (
    <div className="space-y-2 p-3">
      {entries.length > 0 ? (
        <div className="divide-y divide-mist rounded-lg border border-mist">
          {entries.map(([key, nickname]) => (
            <div key={key} className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <span className="w-24 shrink-0 truncate font-mono text-graphite" title={key}>{key}</span>
              <span className="min-w-0 flex-1 truncate font-semibold text-ink">{nickname}</span>
              <button
                aria-label={`Remove ${nickname}`}
                className="rounded p-0.5 text-graphite/60 transition hover:text-red-700"
                onClick={() => {
                  const next = { ...value };
                  delete next[key];
                  onChange(next);
                }}
                type="button"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-graphite/50">No nicknames yet.</p>
      )}
      <div className="flex items-center gap-1.5">
        <input
          className="h-8 w-24 shrink-0 rounded-lg border border-mist bg-white px-2 font-mono text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => setPath(event.target.value)}
          placeholder="E:\\"
          value={path}
        />
        <input
          className="h-8 flex-1 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="CFexpress Reader #2"
          value={name}
        />
        <button
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
          onClick={add}
          type="button"
        >
          <Plus size={13} />
          Add
        </button>
      </div>
    </div>
  );
}

// The data-integrity guardrails. Safe Mode flips on the strict set as a group.
function SafetyEditor({
  value,
  onChange,
}: {
  value: SafetySettings;
  onChange: (next: SafetySettings) => void;
}) {
  function setSafeMode(safe_mode: boolean) {
    if (safe_mode) {
      onChange({
        ...value,
        safe_mode: true,
        never_delete_source: true,
        always_write_offload_proof: true,
        confirm_destructive: true,
        min_verified_copies: Math.max(2, value.min_verified_copies),
        low_space_stop_percent: value.low_space_stop_percent > 0 ? value.low_space_stop_percent : 5,
      });
    } else {
      onChange({ ...value, safe_mode: false });
    }
  }

  return (
    <div className="divide-y divide-mist">
      <label className="flex items-start gap-2 px-3 py-2">
        <input checked={value.safe_mode} className="mt-0.5 h-4 w-4 accent-signal" onChange={(event) => setSafeMode(event.target.checked)} type="checkbox" />
        <span>
          <span className="block text-xs font-semibold text-ink">Safe Mode</span>
          <span className="block text-[11px] text-graphite">Turns on every guardrail below at once — good for volunteer/contractor laptops.</span>
        </span>
      </label>
      <ToggleRow
        checked={value.never_delete_source}
        description="Block any deletion of source media on this machine, no matter what."
        label="Never delete source"
        onChange={(never_delete_source) => onChange({ ...value, never_delete_source })}
      />
      <ToggleRow
        checked={value.always_write_offload_proof}
        description="Always write the offload-proof PDF, even if other reports are off."
        label="Always write offload proof"
        onChange={(always_write_offload_proof) => onChange({ ...value, always_write_offload_proof })}
      />
      <ToggleRow
        checked={value.confirm_destructive}
        description="Ask before turning on anything that removes files (like deleting sidecars)."
        label="Confirm risky changes"
        onChange={(confirm_destructive) => onChange({ ...value, confirm_destructive })}
      />
      <NumberRow
        description="Don't call an ingest done until at least this many destinations verify (1 = normal)."
        label="Require verified copies"
        max={5}
        min={1}
        onChange={(min_verified_copies) => onChange({ ...value, min_verified_copies })}
        value={value.min_verified_copies}
      />
      <NumberRow
        description="Hard-stop an ingest if a destination drops below this percent free (0 = off)."
        label="Low-space stop (%)"
        max={50}
        min={0}
        onChange={(low_space_stop_percent) => onChange({ ...value, low_space_stop_percent })}
        value={value.low_space_stop_percent}
      />
    </div>
  );
}

const BUILTIN_TOKENS: { token: string; meaning: string }[] = [
  { token: "{year}", meaning: "4-digit capture year" },
  { token: "{month}", meaning: "2-digit month" },
  { token: "{day}", meaning: "2-digit day" },
  { token: "{date}", meaning: "Full capture date (YYYY-MM-DD)" },
  { token: "{camera}", meaning: "Camera label / alias" },
  { token: "{clip}", meaning: "Clip number (zero-padded)" },
  { token: "{original}", meaning: "Original file name" },
  { token: "{ext}", meaning: "File extension" },
];

// Read-only reference of every naming token: built-ins plus the user's Global Variables.
function NamingTokenList({ globals }: { globals: PresetVariable[] }) {
  return (
    <div className="space-y-2 p-3">
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">Built-in</div>
        <div className="divide-y divide-mist rounded-lg border border-mist">
          {BUILTIN_TOKENS.map((entry) => (
            <div key={entry.token} className="flex items-center gap-2 px-2 py-1 text-xs">
              <span className="w-24 shrink-0 font-mono font-semibold text-signal">{entry.token}</span>
              <span className="min-w-0 flex-1 truncate text-graphite">{entry.meaning}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">Your global variables</div>
        {globals.length === 0 ? (
          <p className="text-[11px] text-graphite/50">None yet — add them above.</p>
        ) : (
          <div className="divide-y divide-mist rounded-lg border border-mist">
            {globals.map((variable) => (
              <div key={variable.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                <span className="w-24 shrink-0 font-mono font-semibold text-signal">{`{${variable.id}}`}</span>
                <span className="min-w-0 flex-1 truncate text-graphite">{variable.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Export/import the whole config bundle to a file the user picks.
function ConfigBundleRow({ onError }: { onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState<"idle" | "export" | "import">("idle");
  const [note, setNote] = useState<string | null>(null);
  const setLastAction = useAppStore((state) => state.setLastAction);

  async function doExport() {
    setBusy("export");
    setNote(null);
    onError(null);
    try {
      const path = await exportConfigBundle();
      if (path) {
        setNote(`Exported to ${path}`);
        setLastAction("Config exported");
      }
    } catch (caught) {
      onError(String(caught));
    } finally {
      setBusy("idle");
    }
  }

  async function doImport() {
    if (!window.confirm("Import a config bundle? This replaces your current settings, presets, metadata presets, naming catalog, and shooters.")) {
      return;
    }
    setBusy("import");
    setNote(null);
    onError(null);
    try {
      const imported = await importConfigBundle();
      if (imported) {
        setNote("Imported. Restart the app to see everything.");
        setLastAction("Config imported");
      }
    } catch (caught) {
      onError(String(caught));
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
          disabled={busy !== "idle"}
          onClick={() => void doExport()}
          type="button"
        >
          <DownloadCloud size={14} />
          Export config
        </button>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain disabled:opacity-40"
          disabled={busy !== "idle"}
          onClick={() => void doImport()}
          type="button"
        >
          <UploadCloud size={14} />
          Import config
        </button>
      </div>
      {note ? <p className="text-[11px] text-graphite">{note}</p> : null}
    </div>
  );
}

const KEYBOARD_SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Ctrl/⌘ + 1", action: "Home" },
  { keys: "Ctrl/⌘ + 2", action: "Presets" },
  { keys: "Ctrl/⌘ + 3", action: "Create Folders" },
  { keys: "Ctrl/⌘ + 4", action: "Ingest Media" },
  { keys: "Ctrl/⌘ + 5", action: "Metadata" },
  { keys: "Ctrl/⌘ + 6", action: "Naming" },
  { keys: "Ctrl/⌘ + 7", action: "History" },
  { keys: "Ctrl/⌘ + 8", action: "Settings" },
  { keys: "Ctrl/⌘ + ,", action: "Settings" },
];

function KeyboardShortcutsList() {
  return (
    <div className="p-3">
      <div className="divide-y divide-mist rounded-lg border border-mist">
        {KEYBOARD_SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys} className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
            <span className="text-graphite">{shortcut.action}</span>
            <span className="rounded-md bg-porcelain px-2 py-0.5 font-mono font-semibold text-ink ring-1 ring-mist">
              {shortcut.keys}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NumberRow({
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
    <div className="grid min-h-10 grid-cols-[1fr_90px] items-center gap-3 px-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="block text-[11px] text-graphite">{description}</span>
      </span>
      <input
        className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        max={max}
        min={min}
        onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))}
        type="number"
        value={value}
      />
    </div>
  );
}

function CustomFileKindsEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [selectedKind, setSelectedKind] = useState("audio");
  const [newExtension, setNewExtension] = useState("");

  const kindLabel = FILE_KIND_OPTIONS.find((option) => option.value === selectedKind)?.label ?? "";
  const kindAliases =
    selectedKind === "photo" ? ["photo", "photos"] : selectedKind === "document" ? ["document", "documents"] : [selectedKind];
  const customForKind = Object.entries(value)
    .filter(([, kind]) => kindAliases.includes(kind))
    .map(([extension]) => extension)
    .sort();

  function addExtension() {
    const extension = normalizeExtension(newExtension);
    setNewExtension("");
    if (extension) {
      onChange({ ...value, [extension]: selectedKind });
    }
  }

  function removeExtension(extension: string) {
    const next = { ...value };
    delete next[extension];
    onChange(next);
  }

  return (
    <div className="grid gap-3 p-3 md:grid-cols-2">
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">File type</div>
        <SelectMenu onChange={setSelectedKind} options={FILE_KIND_OPTIONS} size="sm" value={selectedKind} />
        <div className="mt-2 rounded-lg border border-mist bg-porcelain/25 p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">Already included</div>
          <div className="flex flex-wrap gap-1">
            {BUILTIN_KIND_EXTENSIONS[selectedKind].map((extension) => (
              <span key={extension} className="rounded-md bg-white px-1.5 py-0.5 text-[11px] font-semibold text-graphite ring-1 ring-mist">
                {extension}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-graphite/50">Custom {kindLabel.toLowerCase()} types</div>
        <div className="min-h-[52px] rounded-lg border border-mist bg-white p-2">
          <div className="flex flex-wrap gap-1">
            {customForKind.map((extension) => (
              <span
                key={extension}
                className="inline-flex items-center gap-1 rounded-md bg-porcelain py-0.5 pl-2 pr-1 text-[11px] font-semibold text-ink"
              >
                {extension}
                <button
                  aria-label={`Remove ${extension}`}
                  className="rounded p-0.5 text-graphite/60 transition hover:text-red-700"
                  onClick={() => removeExtension(extension)}
                  type="button"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {customForKind.length === 0 ? (
              <span className="text-[11px] text-graphite/50">None yet — add {kindLabel.toLowerCase()} types below.</span>
            ) : null}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input
            className="h-8 flex-1 rounded-lg border border-mist bg-white px-2 text-sm outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
            onChange={(event) => setNewExtension(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addExtension();
              }
            }}
            placeholder=".ext"
            value={newExtension}
          />
          <button
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={addExtension}
            type="button"
          >
            <Plus size={13} />
            Add type
          </button>
        </div>
      </div>
    </div>
  );
}
