import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";

// US-146: Google Sheets connection hooks. The connection grant + sync sheet live
// under the workspace owner; edgeFetch attaches the X-Workspace-Owner header so
// every call scopes to the active workspace (mirrors use-ebay).

export interface GoogleConnection {
  connected: boolean;
  google_email?: string | null;
  sheet_id?: string | null;
  sheet_url?: string | null;
  has_sheet?: boolean;
  last_sync_at?: string | null;
  sync_status?: "never" | "idle" | "syncing" | "error";
  sync_error?: string | null;
}

// US-1083: a sheet edit not applied because eBay owns the field on an
// eBay-originated (locked) listing — surfaced so the user sees what was skipped.
export interface SyncSkippedItem {
  tab: string;
  flipdesk_id: string;
  item: string;
  field: string;
  reason: string;
}

export interface SyncNowResult {
  ok: true;
  skipped?: boolean;
  reason?: string;
  pushed?: number;
  pulled?: number;
  conflicts?: number;
  errors?: string[];
  skippedItems?: SyncSkippedItem[];
}

// Whether the server has Google OAuth credentials configured. Lets the UI show
// a "not configured on this server" state instead of a broken connect button.
export function useGoogleConfig() {
  return useQuery({
    queryKey: ["google_config"],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<{ configured: boolean }> => {
      const res = await edgeFetch("/api/flipdesk/google/config");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not check Google config.");
      return json as { configured: boolean };
    },
  });
}

// Current Google connection status for the active workspace.
export function useGoogleConnection() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["google_connection", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<GoogleConnection> => {
      const res = await edgeFetch("/api/flipdesk/google/connection");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load Google connection.");
      return json as GoogleConnection;
    },
  });
}

// Kicks off the OAuth dance: GET /oauth/start, then redirect the browser to the
// returned consent URL. On return Google bounces to /oauth/callback, which
// redirects back to the setup wizard with ?google=<status>.
export function useStartGoogleOauth() {
  return useMutation<void, Error, { redirectTo?: string } | void>({
    mutationFn: async (input) => {
      const qs =
        input && input.redirectTo
          ? `?redirect_to=${encodeURIComponent(input.redirectTo)}`
          : "";
      const res = await edgeFetch(`/api/flipdesk/google/oauth/start${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not start Google sign-in.");
      if (!json.consent_url) throw new Error("Server did not return a consent URL.");
      window.location.href = json.consent_url as string;
    },
    onError: (err) => toast.error(err.message),
  });
}

// Creates a brand-new "FlipDesk Sync" spreadsheet in the user's Drive.
export function useCreateSyncSheet() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; sheet_id: string; sheet_url: string }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/flipdesk/google/sheet/create", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not create the sync sheet.");
      return json as { ok: true; sheet_id: string; sheet_url: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["google_connection"] });
      toast.success("Created your FlipDesk Sync sheet.");
    },
    onError: (err) => toast.error(err.message),
  });
}

// Designates an existing spreadsheet (picked via the Drive Picker, or by id).
export function useUseExistingSheet() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; sheet_id: string; sheet_url: string }, Error, { sheetId: string }>({
    mutationFn: async ({ sheetId }) => {
      const res = await edgeFetch("/api/flipdesk/google/sheet/use", {
        method: "POST",
        json: { sheet_id: sheetId },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not use that sheet.");
      return json as { ok: true; sheet_id: string; sheet_url: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["google_connection"] });
      toast.success("Linked your existing sheet.");
    },
    onError: (err) => toast.error(err.message),
  });
}

// US-147: manual "Sync now" — runs the full 2-way merge for this workspace.
export function useSyncNow() {
  const qc = useQueryClient();
  return useMutation<SyncNowResult, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/flipdesk/google/sync/now", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Sync failed.");
      return json as SyncNowResult;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["google_connection"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      if (result.skipped) {
        toast.info("A sync is already running — try again in a moment.");
        return;
      }
      const conflictNote = result.conflicts
        ? ` ${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"} flagged in the Conflicts tab.`
        : "";
      // US-1083: eBay-owned cells on eBay-originated listings are locked — tell
      // the user what was skipped (detail is on the Conflicts tab).
      const skippedCount = result.skippedItems?.length ?? 0;
      const skippedNote = skippedCount
        ? ` ${skippedCount} eBay-owned field${skippedCount === 1 ? "" : "s"} skipped (edit on eBay).`
        : "";
      toast.success(
        `Synced: ${result.pushed ?? 0} pushed, ${result.pulled ?? 0} pulled.${conflictNote}${skippedNote}`,
      );
    },
    onError: (err) => toast.error(err.message),
  });
}

// Revokes the grant upstream at Google and deactivates it locally.
export function useDisconnectGoogle() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/flipdesk/google/disconnect", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not disconnect Google.");
      return json as { ok: true };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["google_connection"] });
      toast.success("Disconnected Google.");
    },
    onError: (err) => toast.error(err.message),
  });
}
