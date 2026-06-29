// Design-mode mock for "@tauri-apps/plugin-dialog".
// Returns plausible fake paths instead of opening a native picker.
type OpenOptions = {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  filters?: unknown;
};

export async function open(options: OpenOptions = {}): Promise<string | string[] | null> {
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (options.directory) {
    const path = "E:/MediaServer";
    return options.multiple ? [path] : path;
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
