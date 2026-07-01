import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

export type UpdateProgress = {
  downloaded: number;
  contentLength: number | null;
  /** 0..1 download fraction, or null when the total size is unknown. */
  fraction: number | null;
};

/**
 * Check the configured updater endpoint for a newer signed release.
 *
 * Returns the pending {@link Update} (carrying `.version`, `.currentVersion`,
 * and the changelog in `.body`) or `null` when the app is already up to date.
 *
 * May reject on network / endpoint errors. Callers decide how to handle that:
 * the on-launch check swallows failures (a flaky connection must never block
 * startup or nag), while a manual "Check for updates" surfaces the error.
 */
export async function checkForUpdate(): Promise<Update | null> {
  return check();
}

/**
 * Download and install a pending update, reporting byte progress, then relaunch
 * into the new version. On Windows the installer takes over and the app exits
 * before `relaunch()` is reached; on macOS/Linux `relaunch()` restarts the app.
 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  let contentLength: number | null = null;
  let downloaded = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        contentLength = event.data.contentLength ?? null;
        onProgress?.({ downloaded: 0, contentLength, fraction: contentLength ? 0 : null });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({
          downloaded,
          contentLength,
          fraction: contentLength ? Math.min(downloaded / contentLength, 1) : null,
        });
        break;
      case "Finished":
        onProgress?.({ downloaded, contentLength, fraction: 1 });
        break;
    }
  });

  await relaunch();
}
