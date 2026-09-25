import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useWorkspace } from "@/hooks/use-workspace";
import { MARKETPLACE_LABELS } from "@/lib/constants";

// US-2518: the run row the server owns. The page polls it; it does not do the
// importing, so closing the tab costs nothing.
export type ImportRun = {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "undone";
  // US-9201: 'csv' | 'sheet' | 'paste' for a spreadsheet, or the marketplace a
  // closet read came from. Present on polled runs; absent on the stub the page
  // seeds while the first poll is in flight.
  origin?: string;
  total_rows: number;
  processed_rows: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  failed_count: number;
  errors?: { row: number; message: string }[];
  error?: string | null;
  undone_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

// IMP-10: what the Recent imports list calls where a run came from.
const SPREADSHEET_ORIGINS: Record<string, string> = {
  csv: "CSV file",
  sheet: "Google Sheet",
  paste: "Pasted rows",
};

export function importOriginLabel(origin: string | undefined): string {
  if (!origin) return "Import";
  if (origin in SPREADSHEET_ORIGINS) return SPREADSHEET_ORIGINS[origin]!;
  const market = MARKETPLACE_LABELS[origin as keyof typeof MARKETPLACE_LABELS];
  return market ? `${market} closet` : origin;
}

export const IMPORT_RUNS_KEY = "flipdesk-import-runs";

export function isOpenRun(run: Pick<ImportRun, "status"> | null | undefined): boolean {
  return run?.status === "pending" || run?.status === "running";
}

/** A finished run that still has something to put back. */
/** Mirrors UNDO_CLAIM_STALE_MS in the edge import route. */
export const UNDO_CLAIM_STALE_MS = 10 * 60 * 1000;

export function canUndoRun(run: ImportRun, nowMs: number = Date.now()): boolean {
  // undone_at set while status is not "undone" is an undo in progress, or a
  // dead one the server lets a retry take over once it is stale.
  const claimFree =
    !run.undone_at || nowMs - Date.parse(run.undone_at) > UNDO_CLAIM_STALE_MS;
  return (
    claimFree &&
    (run.status === "completed" || run.status === "failed") &&
    run.inserted_count + run.updated_count > 0
  );
}

/**
 * IMP-10: the seller's recent imports (GET /api/flipdesk/import/runs, newest
 * first, last 10). This includes the extension's automatic closet reads, which
 * the page never started and so had no Undo anywhere until this list existed.
 */
export function useImportRuns(opts: { refetchWhileOpen?: boolean } = {}) {
  const { workspaceOwnerId } = useWorkspace();
  return useQuery<ImportRun[], Error>({
    queryKey: [IMPORT_RUNS_KEY, workspaceOwnerId],
    enabled: Boolean(workspaceOwnerId),
    queryFn: async () => {
      const res = await edgeFetch("/api/flipdesk/import/runs", { silentGate: true });
      const json = (await res.json().catch(() => ({}))) as {
        runs?: ImportRun[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Could not load recent imports.");
      return json.runs ?? [];
    },
    // A run started by the extension shows up without a reload.
    refetchInterval: (q) =>
      opts.refetchWhileOpen && (q.state.data ?? []).some(isOpenRun) ? 10_000 : false,
  });
}
