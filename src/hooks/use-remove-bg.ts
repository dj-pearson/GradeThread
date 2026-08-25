import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeAuthHeaders } from "@/lib/edge-fetch";

// US-1114: whether server-backed background removal is configured (REMOVE_BG_API_KEY
// present). The UI hides the control when false so it never offers an action that
// 503s on click. Cached for the session — it doesn't change between deploys.
export function useRemoveBgCapability() {
  return useQuery({
    queryKey: ["flipdesk_image_capabilities"],
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async (): Promise<{ remove_bg: boolean }> => {
      try {
        const res = await fetch(`${edgeApiUrl()}/api/flipdesk/images/capabilities`, {
          headers: await edgeAuthHeaders(),
        });
        if (!res.ok) return { remove_bg: false };
        const json = (await res.json().catch(() => ({}))) as { remove_bg?: boolean };
        return { remove_bg: !!json.remove_bg };
      } catch {
        return { remove_bg: false };
      }
    },
  });
}

export interface RemoveBgResponse {
  ok: true;
  new_photo_id: string | null;
  photo_url: string;
  storage_path: string;
  bytes: number;
}

// Sends a photo to remove.bg via the edge service and creates a new
// `flatlay`-tagged item_photo row with the result. The original stays put.
// 402 → remove.bg quota exhausted (paid plan needed); surfaced clearly.
export function useRemoveBackground() {
  const qc = useQueryClient();
  return useMutation<
    RemoveBgResponse,
    Error & { status?: number },
    { itemPhotoId: string; itemId: string }
  >({
    mutationFn: async ({ itemPhotoId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/images/remove-bg`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
          body: JSON.stringify({ item_photo_id: itemPhotoId }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.detail || json.error || "Background removal failed.",
        );
        err.status = res.status;
        throw err;
      }
      return json as RemoveBgResponse;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["item_photos", vars.itemId] });
    },
    onError: (err) => {
      if (err.status === 402) {
        toast.error(
          "remove.bg quota exhausted for this month. Top up your plan to continue.",
          { duration: 12_000 },
        );
      } else if (err.status === 503) {
        toast.error(
          "Background removal isn't enabled on this server (REMOVE_BG_API_KEY missing).",
          { duration: 12_000 },
        );
      } else {
        toastError(err);
      }
    },
  });
}
