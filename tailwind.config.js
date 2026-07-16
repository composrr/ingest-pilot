/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Dark theme is driven by a `data-theme="dark"` attribute on <html> (see
  // src/styles/index.css for the token values and index.html for the no-FOUC
  // bootstrap). Colors below resolve to CSS variables, so `dark:` variants are
  // rarely needed — the token values simply flip under the attribute — but the
  // selector strategy keeps `dark:` working for the odd one-off.
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Role tokens. Each maps to an rgb-channel CSS variable so the same
        // class themes in both light and dark (values in src/styles/index.css).
        ink: "rgb(var(--c-ink) / <alpha-value>)", // primary text
        graphite: "rgb(var(--c-graphite) / <alpha-value>)", // secondary text
        paper: "rgb(var(--c-paper) / <alpha-value>)", // main content panel surface
        porcelain: "rgb(var(--c-porcelain) / <alpha-value>)", // inset wells / chips
        mist: "rgb(var(--c-mist) / <alpha-value>)", // borders + dividers
        lavender: "rgb(var(--c-lavender) / <alpha-value>)", // accent (focus, preset dots)
        signal: "rgb(var(--c-signal) / <alpha-value>)", // primary action background
        card: "rgb(var(--c-card) / <alpha-value>)", // cards / tiles (was bg-white)
        app: "rgb(var(--c-app) / <alpha-value>)", // app/desktop background behind panels
        primaryfg: "rgb(var(--c-primaryfg) / <alpha-value>)", // text/icon on a colored button
        // `white` is remapped to the card surface so the ~260 existing `bg-white`
        // card usages theme automatically. Genuine light-on-color text uses
        // `text-primaryfg`, not `text-white`.
        white: "rgb(var(--c-card) / <alpha-value>)",
        // Status accents tuned for both themes (used by the run-screen redesign).
        ok: "rgb(var(--c-ok) / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
      },
    },
  },
  plugins: [],
};
