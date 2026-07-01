// Design-mode mock for "@tauri-apps/plugin-updater".
// Swapped in via a Vite alias only in `--mode design` (see vite.config.ts).
// Returns a fake pending update so the UpdateModal (changelog + progress) can be
// previewed with no Rust backend. The real desktop build never imports this file.

export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished"; data?: unknown };

export type Update = {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
  close?: () => Promise<void>;
};

const SAMPLE_NOTES = `## Ingest Pilot 0.2.0

New
- Auto-update: the app now checks for updates on launch and shows these notes before installing.
- Offload proof PDFs include a per-reel checksum summary.

Improved
- Faster verification pass on large cards (xxHash3 streaming).
- Clearer disk-space warnings before an ingest starts.

Fixed
- Sidecar files are no longer double-counted in report totals.`;

export async function check(): Promise<Update | null> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    version: "0.2.0",
    currentVersion: "0.1.3",
    body: SAMPLE_NOTES,
    date: "2026-07-01",
    async downloadAndInstall(onEvent) {
      const total = 24_000_000;
      const chunk = total / 20;
      onEvent?.({ event: "Started", data: { contentLength: total } });
      for (let sent = 0; sent < total; sent += chunk) {
        await new Promise((resolve) => setTimeout(resolve, 90));
        onEvent?.({ event: "Progress", data: { chunkLength: chunk } });
      }
      onEvent?.({ event: "Finished", data: {} });
    },
    async close() {},
  };
}
