// Design-mode mock for "@tauri-apps/plugin-process".
// Swapped in via a Vite alias only in `--mode design` (see vite.config.ts) so
// the full UI runs in a plain browser with no Rust backend. The real desktop
// build never imports this file.

export async function relaunch(): Promise<void> {
  console.info("[design-mock] relaunch() — the real app would restart here.");
}

export async function exit(code = 0): Promise<void> {
  console.info(`[design-mock] exit(${code}) called.`);
}
