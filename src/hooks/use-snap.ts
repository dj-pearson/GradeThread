import { useMutation } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// Snap-to-Value (US-612/614): upload a photo → instant condition grade estimate
// + condition-adjusted resale value range. Free, signup-gated, monthly-capped.

export interface SnapValue {
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  sampleSize: number;
  confidence: number;
  sufficient: boolean;
  currency: string;
}

export interface SnapResult {
  grade: {
    overall_score: number;
    grade_tier: string;
    confidence: number;
    factor_scores: Record<string, number>;
  };
  value: SnapValue | null;
  estimate: true;
  disclaimer: string;
}

export interface SnapInput {
  imageDataUri: string; // data:image/...;base64,...
  brand?: string;
  keyword?: string;
}

export interface SnapError extends Error {
  code?: string;
  action?: string;
}

export function useSnap() {
  return useMutation<SnapResult, SnapError, SnapInput>({
    mutationFn: async (input) => {
      const res = await edgeFetch("/api/grade/snap", {
        method: "POST",
        json: { image: input.imageDataUri, brand: input.brand, keyword: input.keyword },
        // The endpoint returns its own 429 with an upgrade CTA; surface it to the
        // page rather than the generic gate dialog.
        silentGate: true,
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<SnapResult>
        & { error?: string; code?: string; action?: string };
      if (!res.ok) {
        const err = new Error(data.error ?? "Couldn't value that photo") as SnapError;
        err.code = data.code;
        err.action = data.action;
        throw err;
      }
      return data as SnapResult;
    },
  });
}
