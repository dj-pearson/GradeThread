import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeAuthHeaders } from "@/lib/edge-fetch";
import { itemPhotoQueryKeys } from "@/lib/photo-query-keys";

/**
 * US-3196: copy an item's eBay-hosted photos into GradeThread.
 *
 * The eBay sync mirrors a listing's pictures by reference — they render from
 * i.ebayimg.com and GradeThread stores nothing. That is deliberate and it has
 * three costs the seller feels the moment they want to work on the item: the
 * photos cannot be edited, cannot be sent to another marketplace, and vanish if
 * the eBay listing ends. This is the action that pays those off, per item.
 *
 * Partial success is the normal case, not an error state: eBay purges images
 * from ended listings, so an old item can adopt nine of twelve. The route
 * reports each photo's outcome and this reports the total honestly rather than
 * rounding a partial run up to a success.
 */
export interface AdoptRemotePhotosResponse {
  adopted: number;
  failures: Array<{ photo_id: string; message: string }>;
  message?: string;
}

export function useAdoptRemotePhotos() {
  const qc = useQueryClient();
  return useMutation<
    AdoptRemotePhotosResponse,
    Error & { status?: number },
    { itemId: string }
  >({
    mutationFn: async ({ itemId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/images/adopt-remote`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
          body: JSON.stringify({ item_id: itemId }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.error || "Could not copy the eBay photos.",
        );
        err.status = res.status;
        throw err;
      }
      return json as AdoptRemotePhotosResponse;
    },
    onSuccess: (data, vars) => {
      // Every surface that renders a photo or a cover thumbnail, not just this
      // grid — the same key list the photo manager uses for its own writes.
      for (const queryKey of itemPhotoQueryKeys(vars.itemId)) {
        void qc.invalidateQueries({ queryKey });
      }
      if (data.adopted === 0 && data.failures.length === 0) {
        toast.info(data.message ?? "Nothing to copy — these photos are already yours.");
        return;
      }
      const copied = `Copied ${data.adopted} photo${data.adopted === 1 ? "" : "s"}`;
      if (data.failures.length === 0) {
        toast.success(`${copied} into GradeThread.`);
        return;
      }
      // Name the first reason. "3 failed" tells the seller nothing they can act
      // on; "eBay no longer has this image" tells them the listing ended.
      toast.warning(
        `${copied}. ${data.failures.length} could not be copied: ` +
          `${data.failures[0]?.message ?? "unknown reason"}`,
        { duration: 12_000 },
      );
    },
    onError: (err) => toastError(err),
  });
}
