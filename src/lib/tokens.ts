import type { PresetVariable } from "./types";

export type TokenScope = "folder" | "filename";

export type TokenDefinition = {
  id: string;
  label: string;
  scope: "global" | "variable" | "clip" | "folder";
};

export type PatternPart =
  | {
      type: "text";
      value: string;
      start: number;
      end: number;
    }
  | {
      type: "token";
      value: string;
      start: number;
      end: number;
    };

const globalTokens: TokenDefinition[] = [
  { id: "date", label: "Date", scope: "global" },
  { id: "year", label: "Year", scope: "global" },
  { id: "month", label: "Month", scope: "global" },
  { id: "day", label: "Day", scope: "global" },
  { id: "preset_name", label: "Preset", scope: "global" },
];

const clipTokens: TokenDefinition[] = [
  { id: "camera", label: "Camera", scope: "clip" },
  { id: "clip#", label: "Clip #", scope: "clip" },
  { id: "original_name", label: "Original", scope: "clip" },
  { id: "capture_date", label: "Capture Date", scope: "clip" },
  { id: "ext", label: "Extension", scope: "clip" },
];

const folderTokens: TokenDefinition[] = [
  { id: "folder_name", label: "Folder", scope: "folder" },
];

export function getTokenDefinitions(scope: TokenScope, variables: PresetVariable[]) {
  const variableTokens = variables.map((variable) => ({
    id: variable.id,
    label: variable.name,
    scope: "variable" as const,
  }));

  if (scope === "folder") {
    return [...globalTokens, ...variableTokens];
  }

  return [...globalTokens, ...variableTokens, ...clipTokens, ...folderTokens];
}

export function parsePattern(pattern: string): PatternPart[] {
  const parts: PatternPart[] = [];
  let cursor = 0;
  const tokenPattern = /\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(pattern))) {
    if (match.index > cursor) {
      parts.push({
        type: "text",
        value: pattern.slice(cursor, match.index),
        start: cursor,
        end: match.index,
      });
    }

    parts.push({
      type: "token",
      value: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < pattern.length) {
    parts.push({
      type: "text",
      value: pattern.slice(cursor),
      start: cursor,
      end: pattern.length,
    });
  }

  return parts.length > 0 ? parts : [{ type: "text", value: "", start: 0, end: 0 }];
}
