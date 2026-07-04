import { create } from "zustand";
import type { Update } from "../lib/updater";

type AppState = {
  lastAction: string;
  setLastAction: (value: string) => void;
  /** A pending app update discovered on launch or via a manual check. */
  pendingUpdate: Update | null;
  setPendingUpdate: (update: Update | null) => void;
  /**
   * A view another part of the app asks App to switch to (e.g. IngestPage requests
   * "ingest" when a card is inserted while the app is backgrounded on another tab).
   * App consumes and clears it.
   */
  requestedView: string | null;
  setRequestedView: (view: string | null) => void;
  /**
   * Bumped whenever metadata presets change (created, imported, edited, deleted) so
   * other screens (e.g. the ingest fill panel) can refresh their list instead of
   * showing a stale one from mount.
   */
  metadataRev: number;
  bumpMetadataRev: () => void;
};

export const useAppStore = create<AppState>((set) => ({
  lastAction: "Project scaffold created",
  setLastAction: (value) => set({ lastAction: value }),
  pendingUpdate: null,
  setPendingUpdate: (update) => set({ pendingUpdate: update }),
  requestedView: null,
  setRequestedView: (view) => set({ requestedView: view }),
  metadataRev: 0,
  bumpMetadataRev: () => set((state) => ({ metadataRev: state.metadataRev + 1 })),
}));
