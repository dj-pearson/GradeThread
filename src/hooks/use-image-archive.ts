import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/toast-error";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeAuthHeaders } from "@/lib/edge-fetch";

export interface ArchiveResponse {
  archived: number;
  freed_bytes: number;
  errors: Array<{ photo_id: string; message: string }>;
  remaining: number | "unknown";
}

// Manually trigger one sweep of the photo-archive job. Server processes up
// to ARCHIVE_BATCH (50) photos per call; if more remain the user can run
// it again.
export function useArchivePhotos() {
  const qc = useQueryClient();
  return useMutation<ArchiveResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/images/archive`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Archive failed.");
      }
      return json as ArchiveResponse;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item_photos"] });
      qc.invalidateQueries({ queryKey: ["items_full"] });
    },
    onError: (err) => toastError(err),
  });
}
