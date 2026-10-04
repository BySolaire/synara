import { create } from "zustand";

export const useFeatureTourStore = create<{
  replay: boolean;
  open: () => void;
  close: () => void;
}>((set) => ({
  replay: false,
  open: () => set({ replay: true }),
  close: () => set({ replay: false }),
}));
