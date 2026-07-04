import { useEffect, useRef, useState } from "react";
import { edgeFetch } from "@/lib/edge-fetch";

// US-623: condition-aware sell-through forecast for a candidate price. Debounced
// so it doesn't fire on every keystroke; degrades silently to null.

export interface SellThroughForecast {
  sellThroughPct: number;
  daysLow: number;
  daysHigh: number;
  label: "fast" | "moderate" | "slow" | "unknown";
  sampleSize: number;
}

export function useSellThroughForecast(params: {
  brand?: string | null;
  q?: string | null;
  grade: number | null;
  priceCents: number;
  enabled: boolean;
}): { forecast: SellThroughForecast | null; loading: boolean } {
  const [forecast, setForecast] = useState<SellThroughForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { enabled, brand, q, grade, priceCents } = params;

  useEffect(() => {
    if (!enabled || priceCents <= 0 || (!brand && !q)) {
      setForecast(null);
      return;
    }
    // US-1636: guard against a stale in-flight response landing after the
    // params changed — without this, a slow older request could resolve after a
    // newer one and overwrite the forecast with data for the wrong price/query.
    let cancelled = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await edgeFetch("/api/flipdesk/pricing/forecast", {
          method: "POST",
          json: { brand: brand ?? undefined, q: q ?? undefined, grade, priceCents },
          silentGate: true,
        });
        const data = (await res.json().catch(() => null)) as { forecast?: SellThroughForecast } | null;
        if (!cancelled) setForecast(data?.forecast ?? null);
      } catch {
        if (!cancelled) setForecast(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 700);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, brand, q, grade, priceCents]);

  return { forecast, loading };
}
