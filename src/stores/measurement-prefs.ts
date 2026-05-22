import { create } from "zustand";
import { persist } from "zustand/middleware";

// User's preferred length unit for measurements. Persisted per device.
interface MeasurementPrefs {
  unit: "in" | "cm";
  setUnit: (u: "in" | "cm") => void;
}

export const useMeasurementPrefs = create<MeasurementPrefs>()(
  persist(
    (set) => ({
      unit: "in",
      setUnit: (unit) => set({ unit }),
    }),
    { name: "flipdesk-measurement-unit" },
  ),
);
