import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

async function authHeader(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("You must be signed in.");
  }
  return `Bearer ${session.access_token}`;
}

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
          headers: { Authorization: await authHeader() },
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
    onError: (err) => toast.error(err.message),
  });
}
