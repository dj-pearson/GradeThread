import { useSearchParams } from "react-router";
import { isPreset, type Preset } from "@/lib/analytics-range";

// US-2234: the period preset lives in the URL so an analytics view is
// shareable and survives a refresh, instead of resetting to all-time. A10:
// its own module so the Community tab reads the same value as the page.
export function usePresetParam(): [Preset, (p: Preset) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("preset");
  const preset: Preset = isPreset(raw) ? raw : "all";
  const setPreset = (p: Preset) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (p === "all") next.delete("preset");
        else next.set("preset", p);
        return next;
      },
      { replace: true },
    );
  return [preset, setPreset];
}
