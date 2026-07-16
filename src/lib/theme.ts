// App theme (light / dark). Dark is the default (chosen at onboarding, toggled
// in Settings). The value is persisted in localStorage and applied to
// <html data-theme="…"> — the same attribute the no-FOUC bootstrap in
// index.html sets before React mounts, and the selector the CSS token values in
// src/styles/index.css key off of.

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "ingest-pilot:theme";

/** The theme to start with: whatever the bootstrap already applied to <html>,
 *  falling back to the stored value, else dark. */
export function getInitialTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") {
      return attr;
    }
  }
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return "dark";
}

/** Reflect a theme onto <html> and persist it. */
export function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Non-fatal: the attribute still drives the current session.
  }
}
