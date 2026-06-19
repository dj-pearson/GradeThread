import { useMutation } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1104: Garment Passport longitudinal resale-value & depreciation forecast.
// Distinct from the US-623 sell-through hook (use-forecast.ts): this returns a
// list price + days-to-sell + 12-month resale projection derived from the
// reseller's own SKU-class sale ledger. Mirrors the edge DepreciationForecast
// (services/edge-functions/src/lib/passport-forecast.ts).

export interface ResaleForecastInterval {
  lowCents: number;
  highCents: number;
}

export type ResaleForecastDataQuality = "sufficient" | "sparse" | "insufficient";

export interface ResaleForecast {
  dataQuality: ResaleForecastDataQuality;
  sampleSize: number;
  listPriceCents: number | null;
  listPriceInterval: ResaleForecastInterval | null;
  expectedDaysToSell: number | null;
  resaleValue12moCents: number | null;
  resaleValue12moInterval: ResaleForecastInterval | null;
  annualDepreciationPct: number | null;
  confidence: number;
  basis: string;
  isEstimate: true;
}

export interface ResaleForecastInput {
  brand?: string;
  garment_type?: string;
  category?: string;
  grade?: number;
}

/** Ad-hoc SKU-class resale forecast from the caller's own sale ledger (POST). */
export function useResaleForecast() {
  return useMutation<ResaleForecast, Error, ResaleForecastInput>({
    mutationFn: async (input) => {
      const res = await edgeFetch("/api/flipdesk/forecast", {
        method: "POST",
        json: input,
        silentGate: true,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Forecast failed");
      return data.forecast as ResaleForecast;
    },
  });
}
