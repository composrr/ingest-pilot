import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Plus, Save, Sparkles, Trash2, Wand2 } from "lucide-react";
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

type Tab = "assistant" | "catalog";

export function NamingPage() {
  const [catalog, setCatalog] = useState<NamingCatalog>(() => defaultNamingCatalog());
  const [tab, setTab] = useState<Tab>("assistant");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const persisted = await getNamingCatalog();
        const merged = mergeNamingCatalog(persisted);
        if (!cancelled) {
          setCatalog(merged);
        }
        // Seed the file on first run so it exists in Documents for syncing.
        if (!persisted) {
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

  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Naming</p>
          <h1 className="text-xl font-semibold tracking-normal">Naming Assistant</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-graphite">
            Build SOP-correct project names without memorizing the sheet. Pick a deliverable, fill a couple of fields,
            and turn it into a saved preset. The options live in an editable catalog synced with your presets.
          </p>
        </div>
        <div className="flex shrink-0 rounded-xl border border-mist bg-white p-0.5 text-xs font-semibold">
          <button
            className={`rounded-lg px-3 py-1.5 transition ${tab === "assistant" ? "bg-porcelain text-ink" : "text-graphite"}`}
            onClick={() => setTab("assistant")}
            type="button"
          >
            Assistant
          </button>
          <button
            className={`rounded-lg px-3 py-1.5 transition ${tab === "catalog" ? "bg-porcelain text-ink" : "text-graphite"}`}
            onClick={() => setTab("catalog")}
            type="button"
          >
            Templates &amp; Options
          </button>
        </div>
      </header>

      {!loaded ? (
        <div className="flex flex-1 items-center justify-center text-xs text-graphite/60">Loading catalog…</div>
      ) : tab === "assistant" ? (
        <AssistantPanel catalog={catalog} />
      ) : (
        <CatalogEditor catalog={catalog} onChange={setCatalog} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant: pick a deliverable, fill fields, generate the SOP name, save a preset.
// ---------------------------------------------------------------------------

function AssistantPanel({ catalog }: { catalog: NamingCatalog }) {
  const deliverables = catalog.deliverables;
  const [deliverableId, setDeliverableId] = useState<string>(() => deliverables[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const deliverable = useMemo(
    () => deliverables.find((item) => item.id === deliverableId) ?? deliverables[0],
    [deliverables, deliverableId],
  );

  // Fields that pull their options from the shared catalog lists (campus/signifier).
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

  const preview = deliverable ? previewNamingResult(deliverable, values) : "";
  const subPathPreview = deliverable?.subPath
    ? deliverable.subPath.replace(/\{year\}/g, String(new Date().getFullYear()))
    : "";

  async function createPreset() {
    if (!deliverable) {
      return;
    }
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
      // Each generated preset is its own file, named after the SOP result.
      id: `preset_${slugifyToken(resolvedName) || slugifyToken(deliverable.presetName)}_${Date.now()}`,
      name: resolvedName,
      description: `Named via the Naming Assistant — ${deliverable.hint}`,
      // Keep the tokens but bake the entered values in as defaults so the preset
      // is ready to run and resolves to the same name.
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
      /* clipboard may be unavailable in some shells */
    }
  }

  return (
    <div className="grid min-h-0 flex-1 gap-2 overflow-auto xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="overflow-hidden rounded-2xl border border-mist bg-white">
        <div className="flex h-10 items-center gap-1.5 border-b border-mist px-3 text-xs font-semibold text-graphite">
          <Wand2 size={14} /> Build a name
        </div>
        <div className="space-y-3 p-3">
          <label className="block">
            <div className="mb-1 text-xs font-semibold text-graphite">Deliverable</div>
            <SelectMenu
              onChange={(value) => {
                setDeliverableId(value);
                setValues({});
                setStatus(null);
              }}
              options={deliverables.map((item) => ({ label: `${item.group} · ${item.label}`, value: item.id }))}
              placeholder="Choose a deliverable"
              value={deliverableId}
            />
          </label>

          {deliverable?.fields.length ? (
            <div className="space-y-2">
              {deliverable.fields.map((field) => {
                const options = optionsForField(field);
                return (
                  <label key={field.id} className="block">
                    <div className="mb-1 text-xs font-semibold text-graphite">
                      {field.label}
                      {field.required ? <span className="text-signal"> *</span> : null}
                    </div>
                    {field.type === "dropdown" && options.length ? (
                      <SelectMenu
                        onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                        options={[{ label: "—", value: "" }, ...options.map((option) => ({ label: option, value: option }))]}
                        placeholder={field.placeholder ?? "Choose"}
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
            <p className="text-xs text-graphite/70">This deliverable needs no extra fields — the date fills itself.</p>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="flex h-10 items-center gap-1.5 border-b border-mist px-3 text-xs font-semibold text-graphite">
            <Sparkles size={14} /> Result
          </div>
          <div className="space-y-2 p-3">
            <div className="rounded-lg border border-mist bg-porcelain px-2.5 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-graphite/60">Project name</div>
              <div className="mt-0.5 break-all font-mono text-sm font-semibold text-ink">{preview || "—"}</div>
            </div>
            {subPathPreview ? (
              <div className="rounded-lg border border-mist bg-porcelain px-2.5 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-graphite/60">Lands in</div>
                <div className="mt-0.5 break-all font-mono text-xs text-graphite">…/{subPathPreview}/{preview || "…"}</div>
              </div>
            ) : null}
            <div className="flex gap-1.5">
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
              <div className={`text-[11px] ${status.kind === "ok" ? "text-emerald-600" : "text-signal"}`}>{status.message}</div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog editor: the shared option lists + deliverable templates. This is where
// the naming sheet is folded in over time. Explicit Save writes the synced file.
// ---------------------------------------------------------------------------

function CatalogEditor({ catalog, onChange }: { catalog: NamingCatalog; onChange: (next: NamingCatalog) => void }) {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function update(next: NamingCatalog) {
    onChange(next);
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    try {
      await saveNamingCatalog(catalog);
      setDirty(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (error) {
      console.error("[naming] save failed:", error);
    } finally {
      setSaving(false);
    }
  }

  function updateDeliverable(index: number, patch: Partial<NamingDeliverable>) {
    const deliverables = catalog.deliverables.map((item, i) => (i === index ? { ...item, ...patch } : item));
    update({ ...catalog, deliverables });
  }

  function updateField(deliverableIndex: number, fieldIndex: number, patch: Partial<NamingField>) {
    const deliverable = catalog.deliverables[deliverableIndex];
    const fields = deliverable.fields.map((field, i) => (i === fieldIndex ? { ...field, ...patch } : field));
    updateDeliverable(deliverableIndex, { fields });
  }

  function addField(deliverableIndex: number) {
    const deliverable = catalog.deliverables[deliverableIndex];
    const fields = [
      ...deliverable.fields,
      { id: `field_${Date.now()}`, label: "New field", type: "short_text" as NamingField["type"], required: false },
    ];
    updateDeliverable(deliverableIndex, { fields });
  }

  function removeField(deliverableIndex: number, fieldIndex: number) {
    const deliverable = catalog.deliverables[deliverableIndex];
    updateDeliverable(deliverableIndex, { fields: deliverable.fields.filter((_, i) => i !== fieldIndex) });
  }

  function addDeliverable() {
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
  }

  function removeDeliverable(index: number) {
    update({ ...catalog, deliverables: catalog.deliverables.filter((_, i) => i !== index) });
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-graphite/70">
          Add the campuses, signifiers, and templates from your naming sheet. Everything here is saved to
          <span className="font-mono"> Documents/Ingest Pilot/Naming/catalog.json</span> so it syncs across machines.
        </p>
        <button
          className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-3 text-xs font-semibold transition ${
            dirty ? "bg-signal text-paper hover:brightness-105" : "border border-mist text-graphite"
          }`}
          disabled={!dirty || saving}
          onClick={() => void save()}
          type="button"
        >
          {saved ? <Check size={13} /> : <Save size={13} />}
          {saved ? "Saved" : saving ? "Saving…" : dirty ? "Save catalog" : "Saved"}
        </button>
      </div>

      <div className="grid gap-2 xl:grid-cols-3">
        <ListCard
          help="Shared campus list — used by any field whose id is “campus”."
          onChange={(campuses) => update({ ...catalog, campuses })}
          title="Campuses"
          value={catalog.campuses}
        />
        <ListCard
          help="Video signifiers appended to capture names (Recap, Story, Promo…)."
          onChange={(signifiers) => update({ ...catalog, signifiers })}
          title="Signifiers"
          value={catalog.signifiers}
        />
        <div className="overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="flex h-10 items-center gap-1.5 border-b border-mist px-3 text-xs font-semibold text-graphite">
            Ministry codes
            <FloatingHelp label="Ministry codes help">
              Codes from the naming sheet. Add rows as needed; the code is what appears in names.
            </FloatingHelp>
          </div>
          <div className="space-y-1.5 p-2">
            {catalog.ministries.map((ministry, index) => (
              <div key={index} className="grid grid-cols-[70px_1fr_auto] items-center gap-1.5">
                <input
                  className="h-7 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs uppercase outline-none focus:border-graphite/40"
                  onChange={(event) => {
                    const ministries = catalog.ministries.map((item, i) =>
                      i === index ? { ...item, code: event.target.value.toUpperCase() } : item,
                    );
                    update({ ...catalog, ministries });
                  }}
                  value={ministry.code}
                />
                <input
                  className="h-7 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40"
                  onChange={(event) => {
                    const ministries = catalog.ministries.map((item, i) =>
                      i === index ? { ...item, label: event.target.value } : item,
                    );
                    update({ ...catalog, ministries });
                  }}
                  value={ministry.label}
                />
                <button
                  aria-label="Remove ministry"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-mist text-graphite hover:bg-porcelain"
                  onClick={() => update({ ...catalog, ministries: catalog.ministries.filter((_, i) => i !== index) })}
                  type="button"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-dashed border-mist px-2 text-xs font-semibold text-graphite hover:bg-porcelain"
              onClick={() => update({ ...catalog, ministries: [...catalog.ministries, { code: "NEW", label: "New ministry" }] })}
              type="button"
            >
              <Plus size={12} /> Add code
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Deliverable templates</h2>
        <button
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist px-2 text-xs font-semibold text-graphite hover:bg-porcelain"
          onClick={addDeliverable}
          type="button"
        >
          <Plus size={13} /> Add template
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {catalog.deliverables.map((deliverable, index) => (
          <div key={deliverable.id} className="overflow-hidden rounded-2xl border border-mist bg-white p-3">
            <div className="grid gap-2 md:grid-cols-2">
              <LabeledInput label="Name" onChange={(label) => updateDeliverable(index, { label, presetName: label })} value={deliverable.label} />
              <LabeledInput label="Group" onChange={(group) => updateDeliverable(index, { group: group as NamingDeliverable["group"] })} value={deliverable.group} />
              <LabeledInput label="Name pattern" mono onChange={(rootPattern) => updateDeliverable(index, { rootPattern })} value={deliverable.rootPattern} />
              <LabeledInput label="Sub-path (optional)" mono onChange={(subPath) => updateDeliverable(index, { subPath })} placeholder="{year}/Broll" value={deliverable.subPath ?? ""} />
            </div>

            <div className="mt-2">
              <div className="mb-1 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-graphite/60">Fields</div>
                <button
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-mist px-1.5 text-[11px] font-semibold text-graphite hover:bg-porcelain"
                  onClick={() => addField(index)}
                  type="button"
                >
                  <Plus size={11} /> Field
                </button>
              </div>
              <div className="space-y-1.5">
                {deliverable.fields.map((field, fieldIndex) => (
                  <div key={fieldIndex} className="grid grid-cols-[1fr_110px_minmax(0,1.4fr)_auto] items-center gap-1.5">
                    <input
                      className="h-7 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40"
                      onChange={(event) => updateField(index, fieldIndex, { label: event.target.value })}
                      placeholder="Label"
                      value={field.label}
                    />
                    <SelectMenu
                      onChange={(value) => updateField(index, fieldIndex, { type: value as NamingField["type"] })}
                      options={[
                        { label: "Text", value: "short_text" },
                        { label: "List", value: "dropdown" },
                      ]}
                      size="sm"
                      value={field.type}
                    />
                    {field.type === "dropdown" ? (
                      <OptionsTextField
                        onChange={(options) => updateField(index, fieldIndex, { options })}
                        placeholder="Option A, Option B (blank = use shared list)"
                        value={field.options ?? []}
                      />
                    ) : (
                      <span className="text-[11px] text-graphite/50">free text</span>
                    )}
                    <button
                      aria-label="Remove field"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-mist text-graphite hover:bg-porcelain"
                      onClick={() => removeField(index, fieldIndex)}
                      type="button"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-2 flex justify-end">
              <button
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist px-2 text-[11px] font-semibold text-graphite hover:bg-porcelain"
                onClick={() => removeDeliverable(index)}
                type="button"
              >
                <Trash2 size={12} /> Remove template
              </button>
            </div>
          </div>
        ))}
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
  label,
  mono,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  mono?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-semibold text-graphite">{label}</div>
      <input
        className={`h-8 w-full min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30 ${mono ? "font-mono" : ""}`}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}
