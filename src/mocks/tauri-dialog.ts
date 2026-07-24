// Design-mode mock for "@tauri-apps/plugin-dialog".
// Returns plausible fake paths instead of opening a native picker.
type OpenOptions = {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  filters?: { name: string; extensions: string[] }[];
};

function filterHasExtension(filters: OpenOptions["filters"], ext: string): boolean {
  return Boolean(filters?.some((filter) => filter.extensions?.some((e) => e.toLowerCase() === ext)));
}

let directoryPickCount = 0;

export async function open(options: OpenOptions = {}): Promise<string | string[] | null> {
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (options.directory) {
    // Rotate folder names so repeated picks (e.g. queue cards) look distinct.
    const cards = ["CARD_A", "CARD_B", "CARD_C", "CARD_D"];
    const path = `E:/${cards[directoryPickCount % cards.length]}`;
    directoryPickCount += 1;
    return options.multiple ? [path] : path;
  }
  // A JSON multi-pick (e.g. the Naming tab's template import) returns several distinct
  // fake .json paths so the import flow produces multiple distinct templates in design mode.
  if (filterHasExtension(options.filters, "json")) {
    const files = [
      "C:/Users/jondr/Documents/Ingest Pilot/Naming Templates/baptism_couple.json",
      "C:/Users/jondr/Documents/Ingest Pilot/Naming Templates/wedding_film.json",
      "C:/Users/jondr/Documents/Ingest Pilot/Naming Templates/interview_series.json",
    ];
    return options.multiple ? files : files[0];
  }
  const file = "D:/A001_SONY/example.preset";
  return options.multiple ? [file] : file;
}

export async function save(options: { defaultPath?: string } = {}): Promise<string | null> {
  await new Promise((resolve) => setTimeout(resolve, 80));
  return options.defaultPath ?? "E:/Exports/preset-export.preset";
}

export async function message(): Promise<void> {}
export async function ask(): Promise<boolean> {
  return true;
}
export async function confirm(): Promise<boolean> {
  return true;
}
