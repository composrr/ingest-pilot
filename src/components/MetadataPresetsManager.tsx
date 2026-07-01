import { Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { SelectMenu } from "./SelectMenu";
import { createDefaultMetadataPreset } from "../lib/metadataPresetFactory";
import {
  deleteMetadataPreset,
  getMetadataPreset,
  listMetadataPresets,
  saveMetadataPreset,
} from "../lib/tauri";
import type {
  MetadataCategory,
  MetadataField,
  MetadataFieldType,
  MetadataPreset,
  MetadataPresetSummary,
} from "../lib/types";

const FIELD_TYPE_OPTIONS: { label: string; value: MetadataFieldType }[] = [
  { label: "Text", value: "text" },
  { label: "Long text", value: "long_text" },
  { label: "Dropdown", value: "dropdown" },
  { label: "Multi-select", value: "multi_select" },
  { label: "Yes / No", value: "boolean" },
  { label: "Date", value: "date" },
];

function slugify(value: string) {
  return value.replace(/[^a-zA-Z0-9]+/g, "").replace(/^(\d)/, "_$1") || `field${Math.floor(performance.now())}`;
}

// The reusable metadata-preset manager: a list of presets on the left and a
// category/field editor on the right. Used both as the Metadata page and as a
// pop-out inside the preset editor (where selecting/creating a preset can flow back
// to the folder preset via onSelect).
export function MetadataPresetsManager({
  selectedId,
  onSelect,
  onChange,
}: {
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onChange?: () => void;
}) {
  const [summaries, setSummaries] = useState<MetadataPresetSummary[]>([]);
  const [draft, setDraft] = useState<MetadataPreset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function bootstrap() {
    try {
      let list = await listMetadataPresets();
      if (list.length === 0) {
        await saveMetadataPreset(createDefaultMetadataPreset(new Date().toISOString()));
        list = await listMetadataPresets();
      }
      setSummaries(list);
      const initial = (selectedId && list.find((item) => item.id === selectedId)?.id) || list[0]?.id;
      if (initial) {
        await select(initial);
      }
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function refreshList() {
    const list = await listMetadataPresets();
    setSummaries(list);
    onChange?.();
  }

  async function select(id: string) {
    setError(null);
    setStatus(null);
    const preset = await getMetadataPreset(id);
    if (preset) {
      setDraft(preset);
    }
  }

  function newPreset() {
    const now = new Date().toISOString();
    setDraft({
      schema_version: 1,
      id: `metadata_${Math.floor(performance.now())}`,
      name: "New metadata preset",
      description: "",
      categories: [{ id: "general", name: "General", fields: [] }],
      created_at: now,
      updated_at: now,
    });
    setStatus(null);
    setError(null);
  }

  async function save() {
    if (!draft) {
      return;
    }
    try {
      await saveMetadataPreset(draft);
      setStatus("Saved");
      await refreshList();
      onSelect?.(draft.id);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function remove() {
    if (!draft || !window.confirm(`Delete "${draft.name}"?`)) {
      return;
    }
    try {
      await deleteMetadataPreset(draft.id);
      setDraft(null);
      await refreshList();
    } catch (caught) {
      setError(String(caught));
    }
  }

  function patch(next: Partial<MetadataPreset>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setStatus(null);
  }

  function patchCategory(index: number, next: Partial<MetadataCategory>) {
    setDraft((current) =>
      current
        ? { ...current, categories: current.categories.map((category, i) => (i === index ? { ...category, ...next } : category)) }
        : current,
    );
    setStatus(null);
  }

  function addCategory() {
    setDraft((current) =>
      current
        ? {
            ...current,
            categories: [...current.categories, { id: slugify(`category ${current.categories.length + 1}`), name: "New Category", fields: [] }],
          }
        : current,
    );
  }

  function removeCategory(index: number) {
    setDraft((current) => (current ? { ...current, categories: current.categories.filter((_, i) => i !== index) } : current));
  }

  function patchField(categoryIndex: number, fieldIndex: number, next: Partial<MetadataField>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            categories: current.categories.map((category, ci) =>
              ci === categoryIndex
                ? { ...category, fields: category.fields.map((field, fi) => (fi === fieldIndex ? { ...field, ...next } : field)) }
                : category,
            ),
          }
        : current,
    );
    setStatus(null);
  }

  function addField(categoryIndex: number) {
    setDraft((current) =>
      current
        ? {
            ...current,
            categories: current.categories.map((category, ci) =>
              ci === categoryIndex
                ? {
                    ...category,
                    fields: [
                      ...category.fields,
                      { id: slugify(`Field ${category.fields.length + 1}`), label: "New Field", field_type: "text", options: [], default: null },
                    ],
                  }
                : category,
            ),
          }
        : current,
    );
  }

  function removeField(categoryIndex: number, fieldIndex: number) {
    setDraft((current) =>
      current
        ? {
            ...current,
            categories: current.categories.map((category, ci) =>
              ci === categoryIndex ? { ...category, fields: category.fields.filter((_, fi) => fi !== fieldIndex) } : category,
            ),
          }
        : current,
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? (
        <div className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
      ) : null}
      <div className="grid min-h-0 flex-1 gap-2 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-mist bg-white">
          <div className="flex items-center justify-between border-b border-mist px-2 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-graphite/60">Presets</span>
            <button
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
              onClick={newPreset}
              type="button"
            >
              <Plus size={13} />
              New
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
            {summaries.map((summary) => (
              <button
                key={summary.id}
                className={`w-full rounded-lg px-2 py-1.5 text-left text-sm transition ${
                  draft?.id === summary.id ? "bg-lavender/25 font-semibold text-ink ring-1 ring-lavender/60" : "text-graphite hover:bg-porcelain"
                }`}
                onClick={() => {
                  void select(summary.id);
                  onSelect?.(summary.id);
                }}
                type="button"
              >
                <div className="truncate">{summary.name}</div>
                <div className="text-[11px] text-graphite/70">{summary.field_count} fields</div>
              </button>
            ))}
            {summaries.length === 0 ? <p className="px-2 py-3 text-xs text-graphite">No metadata presets yet.</p> : null}
          </div>
        </aside>

        {draft ? (
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-mist bg-white">
            <div className="flex items-center justify-between gap-2 border-b border-mist px-3 py-2">
              <input
                className="h-9 min-w-0 flex-1 rounded-xl border border-mist bg-white px-3 text-sm font-semibold outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                onChange={(event) => patch({ name: event.target.value })}
                value={draft.name}
              />
              <div className="flex items-center gap-2">
                {status ? <span className="text-xs font-semibold text-emerald-600">{status}</span> : null}
                <button
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-signal px-3 text-sm font-semibold text-paper transition hover:bg-black"
                  onClick={() => void save()}
                  type="button"
                >
                  <Save size={15} />
                  Save
                </button>
                <button
                  aria-label="Delete preset"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-mist bg-white text-graphite transition hover:bg-red-50 hover:text-red-700"
                  onClick={() => void remove()}
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
              <input
                className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                onChange={(event) => patch({ description: event.target.value })}
                placeholder="Description (optional)"
                value={draft.description ?? ""}
              />

              {draft.categories.map((category, categoryIndex) => (
                <div key={category.id} className="rounded-xl border border-mist bg-porcelain/30 p-2">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      className="h-8 min-w-0 flex-1 rounded-lg border border-mist bg-white px-2 text-sm font-semibold outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                      onChange={(event) => patchCategory(categoryIndex, { name: event.target.value })}
                      value={category.name}
                    />
                    <button
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                      onClick={() => addField(categoryIndex)}
                      type="button"
                    >
                      <Plus size={13} />
                      Field
                    </button>
                    <button
                      aria-label="Remove category"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-mist bg-white text-graphite transition hover:bg-porcelain hover:text-ink"
                      onClick={() => removeCategory(categoryIndex)}
                      type="button"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {category.fields.map((field, fieldIndex) => (
                      <div key={fieldIndex} className="grid grid-cols-[1fr_130px_1fr_auto] items-center gap-2 rounded-lg bg-white p-1.5">
                        <input
                          className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                          onChange={(event) => patchField(categoryIndex, fieldIndex, { label: event.target.value, id: field.id || slugify(event.target.value) })}
                          placeholder="Label"
                          value={field.label}
                        />
                        <SelectMenu
                          onChange={(value) => patchField(categoryIndex, fieldIndex, { field_type: value as MetadataFieldType })}
                          options={FIELD_TYPE_OPTIONS}
                          size="sm"
                          value={field.field_type}
                        />
                        {field.field_type === "dropdown" || field.field_type === "multi_select" ? (
                          <input
                            className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
                            onChange={(event) =>
                              patchField(categoryIndex, fieldIndex, {
                                options: event.target.value.split(",").map((option) => option.trim()).filter(Boolean),
                              })
                            }
                            placeholder="Options, comma-separated"
                            value={field.options.join(", ")}
                          />
                        ) : (
                          <span className="truncate px-1 text-[11px] text-graphite/60">column: {field.id}</span>
                        )}
                        <button
                          aria-label="Remove field"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-graphite transition hover:bg-porcelain hover:text-ink"
                          onClick={() => removeField(categoryIndex, fieldIndex)}
                          type="button"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                    {category.fields.length === 0 ? <p className="px-1 py-1 text-[11px] text-graphite/60">No fields yet — add one.</p> : null}
                  </div>
                </div>
              ))}

              <button
                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-mist bg-white text-sm font-semibold text-graphite transition hover:bg-porcelain"
                onClick={addCategory}
                type="button"
              >
                <Plus size={15} />
                Add category
              </button>
            </div>
          </section>
        ) : (
          <section className="flex items-center justify-center rounded-2xl border border-mist bg-white p-8 text-sm text-graphite">
            Select a preset on the left, or create a new one.
          </section>
        )}
      </div>
    </div>
  );
}
