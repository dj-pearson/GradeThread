import { useMutation } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

export interface FetchSheetResponse {
  csv: string;
  gid: string | null;
  spreadsheet_id: string;
}

// Fetches a publicly-shared Google Sheet as CSV via the edge proxy. The
// server validates the URL (docs.google.com only) and rebuilds the export
// URL itself, so this is safe to call with any user-pasted link.
export function useFetchGoogleSheet() {
  return useMutation<FetchSheetResponse, Error, { url: string }>({
    mutationFn: async ({ url }) => {
      // US-1634: edgeFetch mints a fresh token + retries once on 401, instead of
      // getSession()'s possibly-expired token with no retry.
      const res = await edgeFetch("/api/flipdesk/sheets/fetch-csv", {
        method: "POST",
        json: { url },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not fetch the sheet.");
      }
      return json as FetchSheetResponse;
    },
  });
}
