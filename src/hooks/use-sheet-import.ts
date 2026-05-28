import { useMutation } from "@tanstack/react-query";
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
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/sheets/fetch-csv`,
        {
          method: "POST",
          headers: {
            Authorization: await authHeader(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not fetch the sheet.");
      }
      return json as FetchSheetResponse;
    },
  });
}
