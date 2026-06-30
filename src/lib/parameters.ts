import type { PresetVariable } from "./types";

export function mergeGlobalAndPresetParameters(
  globalParameters: PresetVariable[],
  presetParameters: PresetVariable[],
) {
  const presetIds = new Set(presetParameters.map((parameter) => parameter.id));
  return [
    ...globalParameters.filter((parameter) => !presetIds.has(parameter.id)),
    ...presetParameters,
  ];
}

export function defaultsForParameters(parameters: PresetVariable[]) {
  return Object.fromEntries(
    parameters.map((parameter) => [
      parameter.id,
      defaultValueForParameter(parameter),
    ]),
  );
}

export function defaultValueForParameter(parameter: PresetVariable) {
  if (parameter.type === "date") {
    const value = typeof parameter.default === "string" ? parameter.default.trim() : "";
    return !value || value.toLowerCase() === "today" ? currentLocalDate() : value;
  }

  return typeof parameter.default === "boolean" ? String(parameter.default) : String(parameter.default ?? "");
}

export function currentLocalDate(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}

// Build per-variable autocomplete suggestions from past ingest jobs (newest first),
// keeping the most recent distinct values per variable id. Accepts a minimal shape
// so it doesn't depend on the full IngestHistoryJob type.
export function recentValuesByVariable(
  jobs: { variable_values?: Record<string, string> }[],
  limit = 8,
): Record<string, string[]> {
  const byId: Record<string, string[]> = {};
  for (const job of jobs) {
    const values = job.variable_values ?? {};
    for (const [id, raw] of Object.entries(values)) {
      const value = (raw ?? "").trim();
      if (!value) {
        continue;
      }
      const list = byId[id] ?? (byId[id] = []);
      if (list.length < limit && !list.includes(value)) {
        list.push(value);
      }
    }
  }
  return byId;
}

export function optionsFromText(value: string) {
  return value
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean);
}

export function slugifyToken(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "parameter"
  );
}
