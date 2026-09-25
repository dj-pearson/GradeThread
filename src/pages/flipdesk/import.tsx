import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import {
  CLOSET_IMPORT_PLATFORMS,
  isClosetImportPlatform,
} from "@/lib/marketplace-disclosure";
import {
  presetIdForAnswer,
  readExistingListings,
  type ExistingListingsAnswer,
} from "@/lib/existing-listings";
import { useWorkspace } from "@/hooks/use-workspace";
import { parseSheet } from "@/lib/csv";
import { decidePoll, nextPollDelay } from "@/lib/import-poll";
import {
  MAX_IMPORT_ROWS,
  buildImportPayload,
  buildMapped,
  guessField,
  importableRows,
  validateImportRows,
  type ImportField,
  type MappedRow,
} from "@/lib/import-mapping";
import { ImportMappingStep, ImportPreview } from "@/components/flipdesk/import-preview";
import {
  applyImportPreset,
  detectImportPreset,
  getImportPreset,
  type ImportPreset,
} from "@/lib/import-presets";
import { PageHelp } from "@/components/help/page-help";
import {
  ClosetImportCard,
  type ClosetImportStart,
} from "@/components/flipdesk/closet-import-card";
import { track } from "@/lib/analytics";
import {
  IMPORT_RUNS_KEY,
  isOpenRun,
  useImportRuns,
  type ImportRun,
} from "@/hooks/use-import-runs";
import { RecentImportsCard } from "@/components/flipdesk/recent-imports-card";
import {
  ImportSourcePicker,
  type ImportSource,
  type LoadedSource,
} from "@/components/flipdesk/import-source-picker";

// IMP-07: shown when the server refuses a file for its size or row count.
type UndoResult = {
  deleted_items?: number;
  restored_items?: number;
  kept_published?: number;
  kept_edited?: number;
  kept_modified?: number;
};

const NO_IMPORT_PERMISSION =
  "Importing and undoing need inventory access in this workspace. Ask a workspace admin.";

const TOO_BIG_MESSAGE =
  "This file is too big for one import. Split it into files of 5,000 rows or fewer.";

// The header row of the downloadable template. Header text matches what
// guessField() recognises, so a seller who starts here gets every column mapped
// without touching a dropdown.
const TEMPLATE_HEADERS = [
  "Item #",
  "Container",
  "Item Title",
  "Item Description",
  "Brand",
  "Style",
  "Size",
  "Notes",
  "Category",
  "Source",
  "Sourced By",
  "Purchase Date",
  "Purchase Price",
  "List Date",
  "List Price",
  "Link",
  "Sale Date",
  "Sale Price",
  "Fees",
  "Tax",
  "Shipping Cost",
  "Net Profit",
  "Payout",
  "Status",
  "Tracking",
];

const TEMPLATE_EXAMPLE = [
  "GT-0001",
  "A1",
  "Lululemon Align Pant",
  "Barely worn, no pilling",
  "Lululemon",
  "Align",
  "6",
  "Small mark on left cuff",
  "clothing",
  "Goodwill on 5th",
  "Dj",
  "2026-01-14",
  "6.99",
  "2026-01-20",
  "68.00",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "listed",
  "",
];

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function downloadTemplate(): void {
  const csv = [TEMPLATE_HEADERS, TEMPLATE_EXAMPLE]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "gradethread-inventory-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// US-2518: the fill-only rule (US-1082) and the list of columns a re-import may
// write live where the writing happens:
// services/edge-functions/src/lib/inventory-import.ts. IMP-12: building the
// payload and the dry run lives in src/lib/import-mapping.ts, so what the
// summary promises is exactly what is sent.

export function FlipdeskImportPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId, can } = useWorkspace();
  // IMP-09: the server refuses an import, an undo and a closet read below
  // listing_manager, so the buttons say so before the click, not after.
  const canImport = can("manage_inventory");

  // IMP-13: what is loaded and where it came from (sent as the run's origin).
  // The file's text is parsed, not held in a controlled textarea.
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  // Bumped by Reset to remount the picker, which clears its link and paste.
  const [pickerKey, setPickerKey] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ImportField[]>([]);
  // US-9209: the competitor export the file looks like, so the mapping is
  // already done when the seller reaches step 2. Null means a plain sheet.
  const [preset, setPreset] = useState<ImportPreset | null>(null);
  // US-3264: what this seller said at signup about the listings they already
  // have. Read once; it only ever pre-selects, and a detected preset or the
  // seller's own choice always wins over it.
  const [signupAnswer] = useState<ExistingListingsAnswer | null>(() =>
    readExistingListings(user?.id),
  );
  const [importing, setImporting] = useState(false);
  // US-2518: the server's run, polled. `run` is the LAST RUN, and it is kept
  // apart from the loaded file (headers/rows/mapping): loading a new file never
  // clears it, so its Undo survives. IMP-10: it is also seeded on mount from
  // ?run= or from the newest open run, which is what makes "refresh or close
  // the tab and it picks back up" true.
  const [run, setRun] = useState<ImportRun | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const recentRuns = useImportRuns({ refetchWhileOpen: true });
  const seededRef = useRef(false);
  // The run this page watched while it was open. Only its completion toasts;
  // a run resumed already finished just shows its results.
  const watchedOpenRef = useRef<string | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [lastUndo, setLastUndo] = useState<UndoResult | null>(null);
  const runOpen = isOpenRun(run);
  // IMP-02: set when polling stops because the run can no longer be read.
  const [pollError, setPollError] = useState<string | null>(null);
  // US-9201: the extension's install time, handed over with the run so the
  // completion event can carry install-to-first-imported-item. A duration
  // only; the timestamp itself is never sent.
  const closetInstalledAtRef = useRef<string | null>(null);

  // IMP-10: the open run lives in the URL, so a refresh resumes it.
  function rememberRun(id: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("run", id);
        return next;
      },
      { replace: true },
    );
  }

  // IMP-10: on mount, pick up ?run= or the newest run that is still going.
  const runParam = searchParams.get("run");
  const recentData = recentRuns.data;
  useEffect(() => {
    if (seededRef.current || run) return;
    if (runParam) {
      seededRef.current = true;
      const known = recentData?.find((r) => r.id === runParam);
      setRun(
        known ?? {
          id: runParam,
          status: "pending",
          total_rows: 0,
          processed_rows: 0,
          inserted_count: 0,
          updated_count: 0,
          skipped_count: 0,
          failed_count: 0,
        },
      );
      return;
    }
    if (!recentData) return;
    seededRef.current = true;
    const open = recentData.find(isOpenRun);
    if (open) setRun(open);
  }, [runParam, recentData, run]);

  useEffect(() => {
    setImporting(runOpen);
  }, [runOpen]);

  function detectFromText(raw: string, from: ImportSource, name: string): number | null {
    if (!raw.trim()) {
      toast.error("No data found.");
      return null;
    }
    const { headers: h, rows: r } = parseSheet(raw);
    if (h.length === 0) {
      toast.error("Could not detect headers — first row appears empty.");
      return null;
    }
    setLoaded({ from, name, rows: r.length });
    setHeaders(h);
    setRows(r);
    // The file itself is the better evidence, so detection wins. The signup
    // answer only fills the gap where detection found nothing -- which is
    // exactly the case that used to leave a switching seller mapping columns
    // by hand.
    const detected = detectImportPreset(h);
    const found = detected ?? getImportPreset(presetIdForAnswer(signupAnswer) ?? "") ?? null;
    setPreset(found);
    setMapping(found ? applyImportPreset(h, found) : h.map(guessField));
    toast.success(
      found
        ? `Looks like a ${found.name}. ${h.length} columns mapped, ${r.length} rows.`
        : `Detected ${h.length} columns, ${r.length} rows.`,
    );
    return r.length;
  }

  const mappedRows: MappedRow[] = useMemo(
    () => rows.map((row) => buildMapped(row, headers, mapping)),
    [rows, headers, mapping],
  );
  const payload = useMemo(() => buildImportPayload(mappedRows), [mappedRows]);
  const validation = useMemo(
    () => validateImportRows(mappedRows, payload, mapping),
    [mappedRows, payload, mapping],
  );
  const titleFieldMapped = mapping.includes("title");
  const importCount = Math.min(validation.willImport, MAX_IMPORT_ROWS);

  const handlePresetChange = useCallback(
    (v: string) => {
      const next = getImportPreset(v) ?? null;
      setPreset(next);
      setMapping(next ? applyImportPreset(headers, next) : headers.map(guessField));
    },
    [headers],
  );
  const handleMappingChange = useCallback((index: number, field: ImportField) => {
    setMapping((prev) => {
      const next = [...prev];
      next[index] = field;
      return next;
    });
  }, []);

  async function handleImport() {
    if (!user || !workspaceOwnerId) {
      toast.error("You must be signed in.");
      return;
    }
    if (!canImport) {
      toast.error(NO_IMPORT_PERMISSION);
      return;
    }
    if (!titleFieldMapped) {
      toast.error("At least one column must map to Item Title.");
      return;
    }

    setImporting(true);
    setRun(null);
    setPollError(null);
    try {
      const res = await edgeFetch("/api/flipdesk/import/runs", {
        method: "POST",
        // IMP-12: titled rows only, capped; the count the button showed.
        json: {
          rows: importableRows(payload, MAX_IMPORT_ROWS),
          origin: loaded?.from ?? "csv",
        },
      });
      const json = (await res.json().catch(() => ({}))) as {
        run_id?: string;
        total_rows?: number;
        error?: string;
      };
      // IMP-07: a body over the import tier, or a file over the row cap, gets
      // one sentence that says what to do rather than a status code.
      if (res.status === 413 || (res.status === 400 && /capped at/i.test(json.error ?? ""))) {
        throw new Error(TOO_BIG_MESSAGE);
      }
      if (!res.ok || !json.run_id) {
        throw new Error(json.error || "Could not start the import.");
      }
      watchedOpenRef.current = json.run_id;
      rememberRun(json.run_id);
      setRun({
        id: json.run_id,
        status: "pending",
        origin: loaded?.from ?? "csv",
        total_rows: json.total_rows ?? importCount,
        processed_rows: 0,
        inserted_count: 0,
        updated_count: 0,
        skipped_count: 0,
        failed_count: 0,
      });
      toast.success("Import started. You can close this tab — it keeps going.");
    } catch (err) {
      setImporting(false);
      toastError(err);
    }
  }

  // IMP-14: the extension timed out but may still be starting the run. Look
  // for it a few times, and attach to it so progress and Undo show here.
  async function attachNewestOpenRun() {
    for (let i = 0; i < 6; i++) {
      const { data } = await recentRuns.refetch();
      const open = data?.find(isOpenRun);
      if (open) {
        watchedOpenRef.current = open.id;
        rememberRun(open.id);
        setRun(open);
        return;
      }
      await new Promise((r) => window.setTimeout(r, 5_000));
    }
  }

  // US-9201: a closet import run started by the extension. Same polling, same
  // results card, same undo; only the origin differs.
  function handleClosetStarted(start: ClosetImportStart) {
    closetInstalledAtRef.current = start.installedAt;
    setImporting(true);
    setPollError(null);
    watchedOpenRef.current = start.runId;
    rememberRun(start.runId);
    setRun({
      id: start.runId,
      status: "pending",
      origin: start.platform,
      total_rows: start.totalRows,
      processed_rows: 0,
      inserted_count: 0,
      updated_count: 0,
      skipped_count: 0,
      failed_count: 0,
    });
  }

  // US-9201: the two closet-import events. `closet_import_first_item` fires
  // once per account per device, the first time a closet import creates an
  // item, and carries only the seconds since the extension was installed.
  //
  // US-3154: the gate reads the SHARED list. It used to name poshmark and
  // mercari inline, which were the only two when it was written, and nothing
  // updated it when Grailed shipped -- so every Grailed closet import has been
  // invisible to both events since US-3155.
  const userId = user?.id;
  const recordClosetCompletion = useCallback((finished: ImportRun) => {
    const origin = finished.origin;
    if (!isClosetImportPlatform(origin)) return;
    track("closet_import_completed", {
      platform: origin,
      status: finished.status,
      inserted: finished.inserted_count,
      updated: finished.updated_count,
      failed: finished.failed_count,
    });
    if (finished.inserted_count <= 0 || !userId) return;
    const key = `gt.closet_import.first_item:${userId}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, new Date().toISOString());
    } catch {
      return; // no storage: skip rather than fire on every completion
    }
    const installedAt = closetInstalledAtRef.current
      ? Date.parse(closetInstalledAtRef.current)
      : NaN;
    track("closet_import_first_item", {
      platform: origin,
      seconds_since_extension_install: Number.isFinite(installedAt)
        ? Math.max(0, Math.round((Date.now() - installedAt) / 1000))
        : null,
    });
  }, [userId]);

  // Poll the run until it terminalizes. The run is the source of truth, so a
  // refresh, a flaky connection or a closed laptop lid changes nothing about
  // whether the import finishes.
  //
  // IMP-02: every 2s for the first 10s, then every 5s; paused while the tab is
  // hidden; a 429 waits for Retry-After; a 403 or 404 stops and says why.
  useEffect(() => {
    const id = run?.id;
    const open = run?.status === "pending" || run?.status === "running";
    if (!id || !open) return;
    let cancelled = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    const schedule = (delayMs: number) => {
      if (cancelled) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), delayMs);
    };
    const tick = async () => {
      timer = null;
      if (cancelled) return;
      // A hidden tab stops asking; visibilitychange below picks it back up.
      if (document.hidden) return;
      const normal = nextPollDelay(Date.now() - startedAt);
      try {
        const res = await edgeFetch(`/api/flipdesk/import/runs/${id}`, {
          silentGate: true,
        });
        if (cancelled) return;
        const decision = decidePoll(res.status, res.headers.get("Retry-After"), normal);
        if (decision.kind === "stop") {
          setPollError(decision.message);
          setImporting(false);
          return;
        }
        if (decision.kind === "retry") {
          schedule(decision.delayMs);
          return;
        }
        const json = (await res.json()) as { run?: ImportRun };
        if (cancelled) return;
        if (!json.run) {
          schedule(normal);
          return;
        }
        setPollError(null);
        setRun(json.run);
        if (isOpenRun(json.run)) watchedOpenRef.current = json.run.id;
        if (json.run.status !== "pending" && json.run.status !== "running") {
          setImporting(false);
          void queryClient.invalidateQueries({ queryKey: [IMPORT_RUNS_KEY] });
          // A run that had already finished before this page saw it open is
          // shown, not announced again.
          if (watchedOpenRef.current !== json.run.id) return;
          watchedOpenRef.current = null;
          recordClosetCompletion(json.run);
          if (json.run.failed_count > 0 || json.run.status === "failed") {
            toast.warning(
              `Imported ${json.run.inserted_count}, filled ${json.run.updated_count}, failed ${json.run.failed_count}.`,
              { duration: 12_000 },
            );
          } else {
            toast.success(
              `Imported ${json.run.inserted_count} new${
                json.run.updated_count > 0
                  ? `, filled ${json.run.updated_count} existing`
                  : ""
              }.`,
            );
          }
          return;
        }
        schedule(normal);
      } catch {
        // A failed poll is not a failed import — the run keeps going.
        schedule(normal);
      }
    };
    const onVisible = () => {
      if (!document.hidden && timer === null) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [run?.id, run?.status, recordClosetCompletion, queryClient]);

  // US-2518 — put the catalog back. Items the run created are deleted, columns
  // it filled are restored to what they held, and anything since published to a
  // marketplace is left alone and reported. IMP-10: any recent run, not only
  // the one this page started.
  async function handleUndo(target: ImportRun) {
    setUndoingId(target.id);
    try {
      const res = await edgeFetch(`/api/flipdesk/import/runs/${target.id}/undo`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as UndoResult & { error?: string };
      if (!res.ok) throw new Error(json.error || "Undo failed.");
      if (run?.id === target.id) {
        setRun({ ...run, status: "undone", undone_at: new Date().toISOString() });
      }
      setLastUndo(json);
      const kept = (json.kept_published ?? 0) + (json.kept_edited ?? 0) + (json.kept_modified ?? 0);
      toast.success(
        `Undone: ${json.deleted_items ?? 0} deleted, ${json.restored_items ?? 0} restored.`,
        kept > 0
          ? {
              description: `${kept} item${kept === 1 ? "" : "s"} kept because you changed, sold or published them since.`,
              duration: 12_000,
            }
          : undefined,
      );
    } catch (err) {
      toastError(err);
    } finally {
      setUndoingId(null);
      void queryClient.invalidateQueries({ queryKey: [IMPORT_RUNS_KEY] });
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Upload}
        title="Import from spreadsheet"
        subtitle="Paste your Google Sheets data below. We'll auto-detect columns and you confirm the mapping before import."
              actions={<PageHelp slug="importing-your-inventory" />}
      />

      {/* US-3264: what the seller told us at signup, and which door each of
          those channels comes through. Without this the pre-selected preset
          below looks like the page guessing. */}
      {signupAnswer && signupAnswer.volume !== "none" && signupAnswer.channels.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              You said your listings are on{" "}
              {signupAnswer.channels
                .map((c) => MARKETPLACE_LABELS[c as keyof typeof MARKETPLACE_LABELS] ?? c)
                .join(", ")}
            </CardTitle>
            <CardDescription>
              {signupAnswer.channels.some((c) =>
                (CLOSET_IMPORT_PLATFORMS as readonly string[]).includes(c),
              )
                ? "Those closets can be read straight from your own tab below. For the rest, export a CSV from the marketplace and drop it in."
                : "Export a CSV from the marketplace and drop it in below. Where we know that export's columns, the mapping is already filled in."}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* US-9201 / US-3263: the extension-channel import. Renders whenever the
          extension has answered a ping — an install step when it is missing,
          and the free bound stated when the account has no plan. */}
      <ClosetImportCard
        disabled={importing || !canImport}
        onStarted={handleClosetStarted}
        onStillReading={() => void attachNewestOpenRun()}
      />

      {/* Step 1: where the data comes from (IMP-13). */}
      <ImportSourcePicker
        key={pickerKey}
        disabled={runOpen}
        loaded={loaded}
        onLoad={detectFromText}
        onDownloadTemplate={downloadTemplate}
      />

      {/* Step 2: mapping */}
      {headers.length > 0 && (
        <ImportMappingStep
          headers={headers}
          mapping={mapping}
          sample={rows[0]}
          rowCount={rows.length}
          preset={preset}
          duplicateFields={validation.duplicateFields}
          onPresetChange={handlePresetChange}
          onMappingChange={handleMappingChange}
        />
      )}

      {/* Step 3: the dry run and preview */}
      {rows.length > 0 && titleFieldMapped && (
        <ImportPreview payload={payload} validation={validation} />
      )}

      {/* IMP-09: one line saying why Import, Reset and Undo are disabled. */}
      {!canImport && (
        <p className="text-sm text-muted-foreground">{NO_IMPORT_PERMISSION}</p>
      )}

      {/* Step 4: import */}
      {rows.length > 0 && titleFieldMapped && (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={importing || !canImport}
            onClick={() => {
              setLoaded(null);
              setPickerKey((k) => k + 1);
              setHeaders([]);
              setRows([]);
              setMapping([]);
            }}
          >
            Reset
          </Button>
          <Button
            onClick={handleImport}
            disabled={importing || !canImport || importCount === 0}
          >
            {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {validation.overCap
              ? `Import the first ${MAX_IMPORT_ROWS.toLocaleString()}`
              : `Import ${importCount} item${importCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}

      {/* Progress — the server's counters, not the browser's. */}
      {run && (run.status === "pending" || run.status === "running") && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Importing…
            </CardTitle>
            <CardDescription>
              {run.processed_rows} of {run.total_rows} rows
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Progress
              value={
                run.total_rows > 0
                  ? (run.processed_rows / run.total_rows) * 100
                  : 5
              }
            />
            {/* US-2518: this used to warn the seller to keep the tab open. The
                worker holds the rows now, so leaving is genuinely safe. */}
            <p className="mt-2 text-xs text-muted-foreground">
              This runs on our servers. You can close this tab or leave the
              page; the import keeps going and you can undo the whole thing
              afterwards.
            </p>
            {pollError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {pollError}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {run && run.status !== "pending" && run.status !== "running" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {run.failed_count === 0 && run.status !== "failed" ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <AlertCircle className="h-5 w-5 text-destructive" />
              )}
              {run.status === "undone"
                ? "Import undone"
                : run.status === "failed"
                  ? "Import stopped"
                  : "Import complete"}
            </CardTitle>
            <CardDescription>
              {run.inserted_count} new · {run.updated_count} filled ·{" "}
              {run.skipped_count} unchanged · {run.failed_count} failed
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {run.error && (
              <p className="text-sm text-destructive">{run.error}</p>
            )}
            {(run.errors ?? []).length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs">
                {(run.errors ?? []).map((e, i) => (
                  <div key={i} className="font-mono">
                    Row {e.row}: {e.message}
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate("/dashboard/flipdesk/items")}>
                View items
              </Button>
              {/* US-2518: a wrong column mapping used to be permanent. */}
              {run.status !== "undone" &&
                run.inserted_count + run.updated_count > 0 && (
                  <Button
                    variant="outline"
                    onClick={() => void handleUndo(run)}
                    disabled={undoingId !== null || !canImport}
                  >
                    {undoingId === run.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Undo2 className="mr-2 h-4 w-4" />
                    )}
                    Undo this import
                  </Button>
                )}
            </div>
            {run.status !== "undone" && (
              <p className="text-xs text-muted-foreground">
                Undo deletes the items this import created and puts back the
                values it filled in. Anything you have since published, sold or
                edited is left alone.
              </p>
            )}
            {run.status === "undone" && lastUndo && (
              <p role="status" className="text-sm text-muted-foreground">
                {lastUndo.deleted_items ?? 0} deleted, {lastUndo.restored_items ?? 0} restored
                {(lastUndo.kept_published ?? 0) > 0 &&
                  `, ${lastUndo.kept_published} kept because published`}
                {(lastUndo.kept_modified ?? 0) > 0 &&
                  `, ${lastUndo.kept_modified} kept because sold since`}
                {(lastUndo.kept_edited ?? 0) > 0 &&
                  `, ${lastUndo.kept_edited} with your later edits kept`}
                .
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* IMP-10: every recent run, including the extension's own closet
          reads, each with its own Undo. */}
      <RecentImportsCard
        runs={recentRuns.data ?? []}
        onUndo={(r) => void handleUndo(r)}
        undoingId={undoingId}
        canUndo={canImport}
      />
    </div>
  );
}
