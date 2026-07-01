import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"),
) as { version: string };

// `--mode design` swaps the Tauri APIs for browser-safe mocks so the full UI
// can run with no Rust backend (for Claude Design / standalone preview). The
// real `npm run tauri:dev` / `tauri:build` use the default mode, so they are
// unaffected.
export default defineConfig(({ mode }) => {
  const designMode = mode === "design";

  const designAliases = designMode
    ? {
        "@tauri-apps/api/core": fileURLToPath(new URL("./src/mocks/tauri-core.ts", import.meta.url)),
        "@tauri-apps/api/event": fileURLToPath(new URL("./src/mocks/tauri-event.ts", import.meta.url)),
        "@tauri-apps/api/webview": fileURLToPath(new URL("./src/mocks/tauri-webview.ts", import.meta.url)),
        "@tauri-apps/plugin-dialog": fileURLToPath(new URL("./src/mocks/tauri-dialog.ts", import.meta.url)),
        "@tauri-apps/plugin-updater": fileURLToPath(new URL("./src/mocks/tauri-updater.ts", import.meta.url)),
        "@tauri-apps/plugin-process": fileURLToPath(new URL("./src/mocks/tauri-process.ts", import.meta.url)),
      }
    : {};

  return {
    plugins: [react()],
    base: "./",
    clearScreen: false,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: designAliases,
    },
    server: {
      strictPort: true,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
