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
