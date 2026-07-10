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
   * Revision counters bumped whenever a shared data domain changes, so the
   * permanently-mounted Ingest screen (which loads its data once) can re-fetch
   * instead of showing a stale copy until a full reload. Pages reached via
   * navigation already remount + re-fetch, so they don't need these.
   */
  metadataRev: number;
  bumpMetadataRev: () => void;
  presetsRev: number;
  bumpPresetsRev: () => void;
  settingsRev: number;
  bumpSettingsRev: () => void;
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
  presetsRev: 0,
  bumpPresetsRev: () => set((state) => ({ presetsRev: state.presetsRev + 1 })),
  settingsRev: 0,
  bumpSettingsRev: () => set((state) => ({ settingsRev: state.settingsRev + 1 })),
}));
