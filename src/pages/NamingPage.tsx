import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ListTree, Plus, Save, Sparkles, Trash2, X } from "lucide-react";
import { FloatingHelp } from "../components/FloatingHelp";
import { OptionsTextField } from "../components/OptionsTextField";
import { SelectMenu } from "../components/SelectMenu";
import {
  buildNamingPreset,
  defaultNamingCatalog,
  mergeNamingCatalog,
  previewNamingResult,
  type NamingCatalog,
  type NamingDeliverable,
  type NamingField,
} from "../lib/namingCatalog";
import { slugifyToken } from "../lib/parameters";
import { getNamingCatalog, savePreset, saveNamingCatalog } from "../lib/tauri";
import type { Preset } from "../lib/types";

// Naming templates, laid out like the Metadata tab: the deliverable templates are
// the list on the left, everything to edit one is on the right. The shared option
// lists (campuses, signifiers, ministry codes) live behind a "Shared lists" button.
export function NamingPage() {
  const [catalog, setCatalog] = useState<NamingCatalog>(() => defaultNamingCatalog());
  const [selectedId, setSelectedId] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const persisted = await getNamingCatalog();
        const merged = mergeNamingCatalog(persisted);
        if (!cancelled) {
          setCatalog(merged);
          setSelectedId(merged.deliverables[0]?.id ?? "");
        }
        // Persist on first run OR when the shipped catalog is newer than what's on
        // disk (so the real SOP data replaces earlier placeholder defaults).
        if (!persisted || (persisted.schema_version ?? 1) < merged.schema_version) {
          await saveNamingCatalog(merged);
        }
      } catch (error) {
        console.error("[naming] load failed:", error);
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => catalog.deliverables.find((item) => item.id === selectedId) ?? null,
    [catalog.deliverables, selectedId],
  );

  function update(next: NamingCatalog) {
    setCatalog(next);
    setDirty(true);
    setSaved(false);
  }

  function updateSelected(patch: Partial<NamingDeliverable>) {
    update({
      ...catalog,
      deliverables: catalog.deliverables.map((item) => (item.id === selectedId ? { ...item, ...patch } : item)),
    });
  }

  async function save() {
    try {
      await saveNamingCatalog(catalog);
      setDirty(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (error) {
      console.error("[naming] save failed:", error);
    }
  }

  function addTemplate() {
    const id = `deliverable_${Date.now()}`;
    update({
      ...catalog,
      deliverables: [
        ...catalog.deliverables,
        {
          id,
          label: "New template",
          group: "Delivered Video",
          hint: "YYYY-MM-DD_Name",
          presetId: id,
          presetName: "New template",
          rootPattern: "{year}-{month}-{day}_{name}",
          fields: [{ id: "name", label: "Name", type: "short_text", required: true }],
        },
      ],
    });
    setSelectedId(id);
  }

  function removeTemplate(id: string) {
    if (!window.confirm("Delete this naming template?")) {
      return;
    }
    const remaining = catalog.deliverables.filter((item) => item.id !== id);
    update({ ...catalog, deliverables: remaining });
    if (selectedId === id) {
      setSelectedId(remaining[0]?.id ?? "");
    }
  }

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Naming</p>
          <h1 className="text-xl font-semibold tracking-normal">Naming Templates</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-graphite">
            SOP-correct project names without memorizing the sheet. Pick a template, fill a field or two, and turn it
            into a saved preset. Each template's fields and the shared option lists are editable and sync with your presets.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2.5 text-xs font-semibold text-graphite transition hover:bg-porcelain"
            onClick={() => setSharedOpen(true)}
            type="button"
          >
            <ListTree size={14} /> Shared lists
          </button>
          <button
            className={`inline-flex h-8 items-center gap-1 rounded-lg px-3 text-xs font-semibold transition ${
              dirty ? "bg-signal text-paper hover:brightness-105" : "border border-mist text-graphite"
            }`}
            disabled={!dirty}
            onClick={() => void save()}
            type="button"
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? "Saved" : dirty ? "Save" : "Saved"}
          </button>
        </div>
      </header>

      {!loaded ? (
        <div className="flex flex-1 items-center justify-center text-xs text-graphite/60">Loading templates…</div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-2 md:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-mist bg-white">
            <div className="flex items-center justify-between border-b border-mist px-2 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-graphite/60">Templates</span>
              <button
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                onClick={addTemplate}
                type="button"
              >
                <Plus size={13} /> New
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
              {catalog.deliverables.map((deliverable) => (
                <button
                  key={deliverable.id}
                  className={`w-full rounded-lg px-2 py-1.5 text-left text-sm transition ${
                    selectedId === deliverable.id
                      ? "bg-lavender/25 font-semibold text-ink ring-1 ring-lavender/60"
                      : "text-graphite hover:bg-porcelain"
                  }`}
                  onClick={() => setSelectedId(deliverable.id)}
                  type="button"
                >
                  <div className="truncate">{deliverable.label}</div>
                  <div className="text-[11px] text-graphite/70">{deliverable.group}</div>
                </button>
              ))}
              {catalog.deliverables.length === 0 ? (
                <p className="px-2 py-3 text-xs text-graphite">No templates yet — add one.</p>
              ) : null}
            </div>
          </aside>

          {selected ? (
            <TemplateEditor
              catalog={catalog}
              deliverable={selected}
              onChange={updateSelected}
              onRemove={() => removeTemplate(selected.id)}
            />
          ) : (
            <section className="flex items-center justify-center rounded-2xl border border-mist bg-white p-8 text-sm text-graphite">
              Select a template on the left, or create a new one.
            </section>
          )}
        </div>
      )}

      {sharedOpen ? <SharedListsModal catalog={catalog} onChange={update} onClose={() => setSharedOpen(false)} /> : null}
    </div>
  );
}

// The right pane: use the template (fill → generate → create preset) up top, then
// the editable definition (name pattern, sub-path, fields) below.
function TemplateEditor({
  catalog,
  deliverable,
  onChange,
  onRemove,
}: {
  catalog: NamingCatalog;
  deliverable: NamingDeliverable;
  onChange: (patch: Partial<NamingDeliverable>) => void;
  onRemove: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset the try-it inputs when switching templates.
  useEffect(() => {
    setValues({});
    setStatus(null);
  }, [deliverable.id]);

  function optionsForField(field: NamingField): string[] {
    if (field.options?.length) {
      return field.options;
    }
    if (field.id === "campus") {
      return catalog.campuses;
    }
    if (field.id === "signifier") {
      return catalog.signifiers;
    }
    return [];
  }

  const preview = previewNamingResult(deliverable, values);
  const subPathPreview = deliverable.subPath
    ? deliverable.subPath.replace(/\{year\}/g, String(new Date().getFullYear()))
    : "";

  async function createPreset() {
    const missing = deliverable.fields.filter((field) => field.required && !(values[field.id] ?? "").trim());
    if (missing.length) {
      setStatus({ kind: "err", message: `Fill required field: ${missing.map((f) => f.label).join(", ")}` });
      return;
    }
    const now = new Date().toISOString();
    const base = buildNamingPreset(deliverable, now);
    const resolvedName = preview || deliverable.presetName;
    const preset: Preset = {
      ...base,
      id: `preset_${slugifyToken(resolvedName) || slugifyToken(deliverable.presetName)}_${Date.now()}`,
      name: resolvedName,
      description: `Named via the Naming Assistant — ${deliverable.hint}`,
      variables: base.variables.map((variable) => ({ ...variable, default: values[variable.id] ?? "" })),
    };
    try {
      await savePreset(preset);
      setStatus({ kind: "ok", message: `Saved preset “${resolvedName}” to your Presets.` });
    } catch (error) {
      setStatus({ kind: "err", message: `Couldn't save preset: ${String(error)}` });
    }
  }

  async function copyName() {
    try {
      await navigator.clipboard.writeText(preview);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  function updateField(fieldIndex: number, patch: Partial<NamingField>) {
    onChange({ fields: deliverable.fields.map((field, i) => (i === fieldIndex ? { ...field, ...patch } : field)) });
  }

  function addField() {
    onChange({
      fields: [
        ...deliverable.fields,
        { id: `field_${Date.now()}`, label: "New field", type: "short_text", required: false },
      ],
    });
  }

  function removeField(fieldIndex: number) {
    onChange({ fields: deliverable.fields.filter((_, i) => i !== fieldIndex) });
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-mist bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-mist px-3 py-2">
        <input
          className="h-9 min-w-0 flex-1 rounded-xl border border-mist bg-white px-3 text-sm font-semibold outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => onChange({ label: event.target.value, presetName: event.target.value })}
          value={deliverable.label}
        />
        <button
          aria-label="Delete template"
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-mist bg-white text-graphite transition hover:bg-red-50 hover:text-red-700"
          onClick={onRemove}
          type="button"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {/* Use it */}
        <div className="rounded-xl border border-mist bg-porcelain/40 p-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-graphite">
            <Sparkles size={14} /> Build a name
          </div>
          {deliverable.fields.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {deliverable.fields.map((field) => {
                const options = optionsForField(field);
                return (
                  <label key={field.id} className="block">
                    <div className="mb-1 text-[11px] font-semibold text-graphite">
                      {field.label}
                      {field.required ? <span className="text-signal"> *</span> : null}
                    </div>
                    {field.type === "dropdown" && options.length ? (
                      <SelectMenu
                        onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                        options={[{ label: "—", value: "" }, ...options.map((option) => ({ label: option, value: option }))]}
                        placeholder={field.placeholder ?? "Choose"}
                        size="sm"
                        value={values[field.id] ?? ""}
                      />
                    ) : (
                      <input
                        className="h-8 w-full min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                        onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                        placeholder={field.placeholder ?? ""}
                        value={values[field.id] ?? ""}
                      />
                    )}
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-graphite/70">No fields — the date fills itself.</p>
          )}
          <div className="mt-2 rounded-lg border border-mist bg-white px-2.5 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-graphite/60">Result</div>
            <div className="mt-0.5 break-all font-mono text-sm font-semibold text-ink">{preview || "—"}</div>
            {subPathPreview ? (
              <div className="mt-1 break-all font-mono text-[11px] text-graphite/70">
                lands in …/{subPathPreview}/{preview || "…"}
              </div>
            ) : null}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <button
              className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-lg bg-signal px-2 text-xs font-semibold text-paper transition hover:brightness-105"
              onClick={() => void createPreset()}
              type="button"
            >
              <Save size={13} /> Create preset
            </button>
            <button
              className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-mist px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
              onClick={() => void copyName()}
              type="button"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {status ? (
            <div className={`mt-1 text-[11px] ${status.kind === "ok" ? "text-emerald-600" : "text-signal"}`}>
              {status.message}
            </div>
          ) : null}
        </div>

        {/* Define it */}
        <div className="rounded-xl border border-mist p-2.5">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-graphite/60">Template definition</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledInput label="Group" onChange={(group) => onChange({ group: group as NamingDeliverable["group"] })} value={deliverable.group} />
            <LabeledInput label="Hint" onChange={(hint) => onChange({ hint })} value={deliverable.hint} />
            <div className="sm:col-span-2">
              <LabeledInput
                help="The project folder name. Tokens: {year} {month} {day}, plus any field id below (e.g. {last_name})."
                label="Name pattern"
                mono
                onChange={(rootPattern) => onChange({ rootPattern })}
                value={deliverable.rootPattern}
              />
            </div>
            <div className="sm:col-span-2">
              <LabeledInput
                help="Optional pre-folders created inside the destination BEFORE the project folder, e.g. {year}/Broll."
                label="Pre-folder path"
                mono
                onChange={(subPath) => onChange({ subPath })}
                placeholder="{year}/Broll"
                value={deliverable.subPath ?? ""}
              />
            </div>
          </div>

          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-graphite/60">Fields</div>
              <button
                className="inline-flex h-6 items-center gap-1 rounded-md border border-mist px-1.5 text-[11px] font-semibold text-graphite hover:bg-porcelain"
                onClick={addField}
                type="button"
              >
                <Plus size={11} /> Field
              </button>
            </div>
            <div className="space-y-1.5">
              {deliverable.fields.map((field, fieldIndex) => (
                <div key={fieldIndex} className="grid grid-cols-[1fr_100px_minmax(0,1.4fr)_auto] items-center gap-1.5">
                  <input
                    className="h-7 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40"
                    onChange={(event) => updateField(fieldIndex, { label: event.target.value })}
                    placeholder="Label"
                    value={field.label}
                  />
                  <SelectMenu
                    onChange={(value) => updateField(fieldIndex, { type: value as NamingField["type"] })}
                    options={[
                      { label: "Text", value: "short_text" },
                      { label: "List", value: "dropdown" },
                    ]}
                    size="sm"
                    value={field.type}
                  />
                  {field.type === "dropdown" ? (
                    <OptionsTextField
                      onChange={(options) => updateField(fieldIndex, { options })}
                      placeholder="Options (blank = shared list)"
                      value={field.options ?? []}
                    />
                  ) : (
                    <span className="text-[11px] text-graphite/50">free text</span>
                  )}
                  <button
                    aria-label="Remove field"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-mist text-graphite hover:bg-porcelain"
                    onClick={() => removeField(fieldIndex)}
                    type="button"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// The "deeper" shared option lists, behind a button so templates stay the main view.
function SharedListsModal({
  catalog,
  onChange,
  onClose,
}: {
  catalog: NamingCatalog;
  onChange: (next: NamingCatalog) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-mist bg-paper shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-mist px-4 py-2.5">
          <div>
            <h2 className="text-base font-semibold">Shared lists</h2>
            <p className="text-[11px] text-graphite/70">
              Reused by any field that pulls from them (campus, signifier). Saved with the catalog.
            </p>
          </div>
          <button
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-mist text-graphite hover:bg-porcelain"
            onClick={onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </div>
        <div className="grid gap-2 overflow-auto p-3 md:grid-cols-2">
          <ListCard
            help="Shared campus list — used by any field whose id is “campus”."
            onChange={(campuses) => onChange({ ...catalog, campuses })}
            title="Campuses"
            value={catalog.campuses}
          />
          <ListCard
            help="Video signifiers appended to capture names (Recap, Story, Promo…)."
            onChange={(signifiers) => onChange({ ...catalog, signifiers })}
            title="Signifiers"
            value={catalog.signifiers}
          />
          <div className="overflow-hidden rounded-2xl border border-mist bg-white md:col-span-2">
            <div className="flex h-10 items-center gap-1.5 border-b border-mist px-3 text-xs font-semibold text-graphite">
              Ministry codes
              <FloatingHelp label="Ministry codes help">
                Codes from the naming sheet. Add rows as needed; the code is what appears in names.
              </FloatingHelp>
            </div>
            <div className="grid gap-1.5 p-2 sm:grid-cols-2">
              {catalog.ministries.map((ministry, index) => (
                <div key={index} className="grid grid-cols-[70px_1fr_auto] items-center gap-1.5">
                  <input
                    className="h-7 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs uppercase outline-none focus:border-graphite/40"
                    onChange={(event) =>
                      onChange({
                        ...catalog,
                        ministries: catalog.ministries.map((item, i) =>
                          i === index ? { ...item, code: event.target.value.toUpperCase() } : item,
                        ),
                      })
                    }
                    value={ministry.code}
                  />
                  <input
                    className="h-7 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40"
                    onChange={(event) =>
                      onChange({
                        ...catalog,
                        ministries: catalog.ministries.map((item, i) =>
                          i === index ? { ...item, label: event.target.value } : item,
                        ),
                      })
                    }
                    value={ministry.label}
                  />
                  <button
                    aria-label="Remove ministry"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-mist text-graphite hover:bg-porcelain"
                    onClick={() => onChange({ ...catalog, ministries: catalog.ministries.filter((_, i) => i !== index) })}
                    type="button"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-dashed border-mist px-2 text-xs font-semibold text-graphite hover:bg-porcelain"
                onClick={() => onChange({ ...catalog, ministries: [...catalog.ministries, { code: "NEW", label: "New ministry" }] })}
                type="button"
              >
                <Plus size={12} /> Add code
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ListCard({
  help,
  onChange,
  title,
  value,
}: {
  help: string;
  onChange: (value: string[]) => void;
  title: string;
  value: string[];
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-mist bg-white">
      <div className="flex h-10 items-center gap-1.5 border-b border-mist px-3 text-xs font-semibold text-graphite">
        {title}
        <FloatingHelp label={`${title} help`}>{help}</FloatingHelp>
      </div>
      <div className="p-2">
        <OptionsTextField onChange={onChange} placeholder="Comma-separated list" value={value} />
      </div>
    </div>
  );
}

function LabeledInput({
  help,
  label,
  mono,
  onChange,
  placeholder,
  value,
}: {
  help?: string;
  label: string;
  mono?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-graphite">
        {label}
        {help ? <FloatingHelp label={`${label} help`}>{help}</FloatingHelp> : null}
      </div>
      <input
        className={`h-8 w-full min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30 ${mono ? "font-mono" : ""}`}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}
