import { create } from "zustand";
import type { Update } from "../lib/updater";

type AppState = {
  lastAction: string;
  setLastAction: (value: string) => void;
  /** A pending app update discovered on launch or via a manual check. */
  pendingUpdate: Update | null;
  setPendingUpdate: (update: Update | null) => void;
};

export const useAppStore = create<AppState>((set) => ({
  lastAction: "Project scaffold created",
  setLastAction: (value) => set({ lastAction: value }),
  pendingUpdate: null,
  setPendingUpdate: (update) => set({ pendingUpdate: update }),
}));
