import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";

// US-3541: Reseller Swap. Stale eBay listings from sellers who opted in to
// sharing, shown to sellers whose own sales say they move that brand fast.
// The buyer clicks through to the other seller's eBay listing and buys there;
// GradeThread is not part of the sale. Contract: vault/20-domain/reseller-swap.md.

export interface SwapSettings {
  share_stale: boolean;
  receive_tips: boolean;
  stale_after_days: number;
}

export interface SwapTip {
  item_id: string;
  title: string;
  brand: string;
  size: string | null;
  price_cents: number | null;
  days_listed: number;
  grade_value: number | null;
  grade_label: string | null;
  photo_url: string | null;
  url: string;
  fit: { sold: number; median_days: number | null };
}

export interface SwapFitBrand {
  brand: string;
  sold: number;
  median_days: number | null;
}

export interface SwapTipsPayload {
  enabled: boolean;
  tips: SwapTip[];
  fit_brands: SwapFitBrand[];
}

const SETTINGS_KEY = ["reseller_swap_settings"];
const TIPS_KEY = ["reseller_swap_tips"];

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? fallback);
  return data;
}

export function useSwapSettings() {
  return useQuery<SwapSettings>({
    queryKey: SETTINGS_KEY,
    queryFn: async () => {
      const res = await edgeFetch("/api/flipdesk/swap/settings");
      const data = await readJson<{ settings: SwapSettings }>(
        res,
        "Failed to load swap settings",
      );
      return data.settings;
    },
  });
}

export function useUpdateSwapSettings() {
  const qc = useQueryClient();
  return useMutation<SwapSettings, Error, Partial<SwapSettings>>({
    mutationFn: async (patch) => {
      const res = await edgeFetch("/api/flipdesk/swap/settings", {
        method: "PUT",
        json: patch,
      });
      const data = await readJson<{ settings: SwapSettings }>(
        res,
        "Failed to save swap settings",
      );
      return data.settings;
    },
    onSuccess: (settings) => {
      qc.setQueryData(SETTINGS_KEY, settings);
      void qc.invalidateQueries({ queryKey: TIPS_KEY });
    },
    onError: (e) => toast.error(e.message),
  });
}

export function useSwapTips(enabled: boolean) {
  return useQuery<SwapTipsPayload>({
    queryKey: TIPS_KEY,
    enabled,
    queryFn: async () => {
      const res = await edgeFetch("/api/flipdesk/swap/tips");
      const data = await readJson<Partial<SwapTipsPayload>>(
        res,
        "Failed to load swap tips",
      );
      return {
        enabled: data.enabled ?? false,
        tips: data.tips ?? [],
        fit_brands: data.fit_brands ?? [],
      };
    },
  });
}

export function useDismissSwapTip() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (itemId) => {
      const res = await edgeFetch(
        `/api/flipdesk/swap/tips/${encodeURIComponent(itemId)}/dismiss`,
        { method: "POST", json: {} },
      );
      await readJson<{ ok: boolean }>(res, "Failed to hide that tip");
    },
    onSuccess: (_v, itemId) => {
      qc.setQueryData<SwapTipsPayload>(TIPS_KEY, (prev) =>
        prev ? { ...prev, tips: prev.tips.filter((t) => t.item_id !== itemId) } : prev,
      );
    },
    onError: (e) => toast.error(e.message),
  });
}
