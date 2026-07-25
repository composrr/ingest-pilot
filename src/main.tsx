import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/index.css";

// Last-resort net. The per-screen boundaries in App.tsx catch a page; this catches a throw
// in App itself, the sidebar, the walkthrough, or the update modal. Without it any of those
// unmounts the entire root and leaves an empty #root — which paints as a uniform #121314
// window, because styles/index.css sets the background on both :root and body. That is
// indistinguishable to the user from the app being dead.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="Ingest Pilot">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Error boundaries structurally cannot see throws in event handlers or rejected promises,
// so these two listeners are the only coverage those get. They double as the diagnostic
// that tells the two "black window" causes apart: a JS failure leaves a record in the
// webview console, whereas a WebKit content-process kill leaves nothing here at all — only
// a new crash report under ~/Library/Logs/DiagnosticReports.
window.addEventListener("error", (event) => {
  console.error("[window.onerror]", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[unhandledrejection]", event.reason);
});
