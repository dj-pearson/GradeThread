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
        setForecast(data?.forecast ?? null);
      } catch {
        setForecast(null);
      } finally {
        setLoading(false);
      }
    }, 700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, brand, q, grade, priceCents]);

  return { forecast, loading };
}
