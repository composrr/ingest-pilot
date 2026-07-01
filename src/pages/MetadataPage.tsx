import { MetadataPresetsManager } from "../components/MetadataPresetsManager";

export function MetadataPage() {
  return (
    <div className="tool-density flex min-h-full w-full min-w-0 flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2">
        <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">Metadata</p>
        <h1 className="text-xl font-semibold tracking-normal">Metadata Presets</h1>
        <p className="mt-0.5 max-w-2xl text-xs text-graphite">
          Reusable shoot-level metadata (categories &amp; fields) applied to every clip at ingest and exported as a CSV
          manifest for iconik. Attach one to a folder preset so it's chosen automatically.
        </p>
      </header>
      <MetadataPresetsManager />
    </div>
  );
}
