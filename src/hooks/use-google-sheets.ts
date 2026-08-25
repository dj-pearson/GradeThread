import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import type { SheetMapConfig } from "@/types/database";

export type { SheetMapConfig };

// One selectable target field in the mapping UI's per-column dropdown.
export interface MappableField {
  field: string;
  table: "inventory_items" | "listings" | "sales";
  label: string;
  kind: "string" | "number" | "currency" | "date" | "enum";
  writable: boolean;
  role?: "key";
  enumValues?: string[];
}

export interface SheetMapSuggestion {
  tab: string;
  headers: string[];
  fields: MappableField[];
  map: SheetMapConfig;
}

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
  // "Bring your own sheet": the active column map, or null for classic tabs mode.
  sheet_map?: SheetMapConfig | null;
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
  /** Soft per-row data problems (bad cell values, duplicate SKUs). The sync
   *  still succeeded for every good row — the seller fixes these in the sheet. */
  warnings?: string[];
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
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
      // US-1636: a 2-way sync can push/pull item, listing and brand data — not
      // just the raw inventory list — so the derived caches must refresh too or
      // the page shows pre-sync values until they go stale.
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["items_full"] });
      qc.invalidateQueries({ queryKey: ["inventory-listings"] });
      qc.invalidateQueries({ queryKey: ["inventory-brands"] });
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
      // Soft per-row data problems don't fail the sync — surface them so the
      // seller can fix the offending cells without the run reading as broken.
      const warnings = result.warnings ?? [];
      if (warnings.length) {
        toast.warning(
          `${warnings.length} row${warnings.length === 1 ? "" : "s"} need attention in your sheet — e.g. ${warnings[0]}`,
        );
      }
    },
    onError: (err) => toastError(err),
  });
}

// ── "Bring your own sheet" mapping (00433) ───────────────────────────

// The tab titles in the connected spreadsheet (for the "pick your tab" step).
export function useSheetTabs(enabled: boolean) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["google_sheet_tabs", user?.id],
    enabled: enabled && !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<string[]> => {
      const res = await edgeFetch("/api/flipdesk/google/sheet/tabs");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not read the spreadsheet tabs.");
      return (json.tabs ?? []) as string[];
    },
  });
}

// Reads a tab's header row and auto-suggests a column map to review.
export function useSuggestSheetMap() {
  return useMutation<SheetMapSuggestion, Error, { tab: string }>({
    mutationFn: async ({ tab }) => {
      const res = await edgeFetch("/api/flipdesk/google/sheet/map/suggest", {
        method: "POST",
        json: { tab },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not read that tab.");
      return json as SheetMapSuggestion;
    },
    onError: (err) => toastError(err),
  });
}

// Saves the reviewed map (switches the sync to the user's own tab).
export function useSaveSheetMap() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { map: SheetMapConfig }>({
    mutationFn: async ({ map }) => {
      const res = await edgeFetch("/api/flipdesk/google/sheet/map", {
        method: "PUT",
        json: { map },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save the mapping.");
      return json as { ok: true };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["google_connection"] });
      toast.success("Saved your sheet mapping. The next sync uses your tab.");
    },
    onError: (err) => toastError(err),
  });
}

// Clears the map — reverts to the generated Inventory/Listings/… tabs.
export function useClearSheetMap() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/flipdesk/google/sheet/map", { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not clear the mapping.");
      return json as { ok: true };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["google_connection"] });
      toast.success("Reverted to the generated tabs.");
    },
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
  });
}
