import { create } from "zustand";

type AppState = {
  lastAction: string;
  setLastAction: (value: string) => void;
};

export const useAppStore = create<AppState>((set) => ({
  lastAction: "Project scaffold created",
  setLastAction: (value) => set({ lastAction: value }),
}));
