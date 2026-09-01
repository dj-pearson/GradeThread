import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Link2,
  Download,
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useFetchGoogleSheet } from "@/hooks/use-sheet-import";
import { parseSheet } from "@/lib/csv";
import {
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  guessField,
  normalizeStatus,
  normalizeCategory,
  parsePrice,
  parseDate,
  type ImportField,
} from "@/lib/import-mapping";
import {
  applyImportPreset,
  detectImportPreset,
  getImportPreset,
  IMPORT_PRESETS,
  type ImportPreset,
} from "@/lib/import-presets";
import { PageHelp } from "@/components/help/page-help";
import {
  ClosetImportCard,
  type ClosetImportStart,
} from "@/components/flipdesk/closet-import-card";
import { track } from "@/lib/analytics";

type ImportRow = {
  raw: string[];
  mapped: Partial<Record<ImportField, string>>;
};

// US-2518: the run row the server owns. The browser polls it; it no longer does
// the importing, so closing the tab costs nothing.
type ImportRun = {
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
};

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
// write now live where the writing happens —
// services/edge-functions/src/lib/inventory-import.ts. They were here because
// the import ran in the browser; keeping a second copy would be two sources of
// truth for which columns a CSV is allowed to touch.

function buildMapped(
  row: string[],
  headers: string[],
  mapping: ImportField[],
): Partial<Record<ImportField, string>> {
  const result: Partial<Record<ImportField, string>> = {};
  for (let i = 0; i < headers.length; i++) {
    const field = mapping[i];
    const value = row[i];
    if (!field || field === "skip" || !value) continue;
    result[field] = value.trim();
  }
  return result;
}

export function FlipdeskImportPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId, can } = useWorkspace();

  const [text, setText] = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ImportField[]>([]);
  // US-9209: the competitor export the file looks like, so the mapping is
  // already done when the seller reaches step 2. Null means a plain sheet.
  const [preset, setPreset] = useState<ImportPreset | null>(null);
  const [importing, setImporting] = useState(false);
  // US-2518: the server's run, polled. `run` is the whole progress and result
  // surface now — a browser refresh mid-import picks it back up.
  const [run, setRun] = useState<ImportRun | null>(null);
  const [undoing, setUndoing] = useState(false);
  const pollRef = useRef<number | null>(null);
  // US-9201: the extension's install time, handed over with the run so the
  // completion event can carry install-to-first-imported-item. A duration
  // only; the timestamp itself is never sent.
  const closetInstalledAtRef = useRef<string | null>(null);
  const fetchSheet = useFetchGoogleSheet();

  async function handleFetchSheet() {
    if (!sheetUrl.trim()) return;
    try {
      const { csv } = await fetchSheet.mutateAsync({ url: sheetUrl.trim() });
      setText(csv);
      detectFromText(csv);
    } catch (err) {
      toastError(err, "Could not read that file.", { duration: 12_000 });
    }
  }

  function detectFromText(raw: string) {
    if (!raw.trim()) {
      toast.error("No data found.");
      return;
    }
    const { headers: h, rows: r } = parseSheet(raw);
    if (h.length === 0) {
      toast.error("Could not detect headers — first row appears empty.");
      return;
    }
    setHeaders(h);
    setRows(r);
    const found = detectImportPreset(h);
    setPreset(found);
    setMapping(found ? applyImportPreset(h, found) : h.map(guessField));
    setRun(null);
    toast.success(
      found
        ? `Looks like a ${found.name}. ${h.length} columns mapped, ${r.length} rows.`
        : `Detected ${h.length} columns, ${r.length} rows.`,
    );
  }

  function handleDetect() {
    detectFromText(text);
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    try {
      const raw = await file.text();
      setText(raw);
      detectFromText(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to read file: ${msg}`);
    }
  }

  const mappedRows: ImportRow[] = useMemo(
    () =>
      rows.map((row) => ({
        raw: row,
        mapped: buildMapped(row, headers, mapping),
      })),
    [rows, headers, mapping],
  );

  const previewRows = mappedRows.slice(0, 10);
  const titleFieldMapped = mapping.includes("title");

  // US-2518 — build the payload the durable worker consumes. The browser still
  // owns the parsing and the mapping (that is a UI), but it hands over resolved
  // values so the server never has to guess at a date format.
  function buildPayload() {
    return mappedRows.map((r, i) => {
      const m = r.mapped;
      const listPrice = parsePrice(m.list_price ?? "");
      const listDate = m.list_date ? parseDate(m.list_date) : null;
      const salePrice = parsePrice(m.sale_price ?? "");
      const saleDate = m.sale_date ? parseDate(m.sale_date) : null;
      return {
        row: i + 2,
        title: m.title ?? null,
        sku: m.sku ?? null,
        container: m.container ?? null,
        description: m.description ?? null,
        brand: m.brand ?? null,
        style: m.style ?? null,
        size: m.size ?? null,
        condition_notes: m.condition_notes ?? null,
        comps_note: m.comps ?? null,
        item_category: m.item_category ? normalizeCategory(m.item_category) : null,
        status: m.status ? normalizeStatus(m.status) : null,
        source_name: m.source ?? null,
        sourced_by: m.sourced_by ?? null,
        acquired_price: parsePrice(m.purchase_price ?? ""),
        acquired_date: m.purchase_date ? parseDate(m.purchase_date) : null,
        listing:
          listPrice !== null || listDate !== null || m.link
            ? {
                listing_price: listPrice,
                listing_url: m.link ?? null,
                listed_at: listDate,
              }
            : null,
        sale:
          salePrice !== null || saleDate !== null
            ? {
                sale_price: salePrice,
                platform_fees: parsePrice(m.fees ?? ""),
                tax: parsePrice(m.tax ?? ""),
                shipping_cost: parsePrice(m.shipping_cost ?? ""),
                net_profit: parsePrice(m.net_profit ?? ""),
                payout_amount: parsePrice(m.payout ?? ""),
                tracking_number: m.tracking ?? null,
                sold_at: saleDate,
              }
            : null,
      };
    });
  }

  async function handleImport() {
    if (!user || !workspaceOwnerId) {
      toast.error("You must be signed in.");
      return;
    }
    if (!can("manage_inventory")) {
      toast.error("You don't have permission to import inventory in this workspace.");
      return;
    }
    if (!titleFieldMapped) {
      toast.error("At least one column must map to Item Title.");
      return;
    }

    setImporting(true);
    setRun(null);
    try {
      const res = await edgeFetch("/api/flipdesk/import/runs", {
        method: "POST",
        json: { rows: buildPayload(), origin: sheetUrl.trim() ? "sheet" : "csv" },
      });
      const json = (await res.json().catch(() => ({}))) as {
        run_id?: string;
        total_rows?: number;
        error?: string;
      };
      if (!res.ok || !json.run_id) {
        throw new Error(json.error || "Could not start the import.");
      }
      setRun({
        id: json.run_id,
        status: "pending",
        total_rows: json.total_rows ?? mappedRows.length,
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

  // US-9201: a closet import run started by the extension. Same polling, same
  // results card, same undo; only the origin differs.
  function handleClosetStarted(start: ClosetImportStart) {
    closetInstalledAtRef.current = start.installedAt;
    setImporting(true);
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
  const userId = user?.id;
  const recordClosetCompletion = useCallback((finished: ImportRun) => {
    const origin = finished.origin;
    if (origin !== "poshmark" && origin !== "mercari") return;
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
  useEffect(() => {
    const id = run?.id;
    const open = run?.status === "pending" || run?.status === "running";
    if (!id || !open) {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await edgeFetch(`/api/flipdesk/import/runs/${id}`, {
          silentGate: true,
        });
        if (!res.ok) return;
        const json = (await res.json()) as { run?: ImportRun };
        if (cancelled || !json.run) return;
        setRun(json.run);
        if (json.run.status !== "pending" && json.run.status !== "running") {
          setImporting(false);
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
        }
      } catch {
        // A failed poll is not a failed import — the run keeps going.
      }
    };
    void tick();
    pollRef.current = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [run?.id, run?.status, recordClosetCompletion]);

  // US-2518 — put the catalog back. Items the run created are deleted, columns
  // it filled are restored to what they held, and anything since published to a
  // marketplace is left alone and reported.
  async function handleUndo() {
    if (!run) return;
    setUndoing(true);
    try {
      const res = await edgeFetch(`/api/flipdesk/import/runs/${run.id}/undo`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        deleted_items?: number;
        restored_items?: number;
        kept_published?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Undo failed.");
      setRun({ ...run, status: "undone", undone_at: new Date().toISOString() });
      const kept = json.kept_published ?? 0;
      toast.success(
        `Undone: ${json.deleted_items ?? 0} deleted, ${json.restored_items ?? 0} restored.`,
        kept > 0
          ? {
              description: `${kept} item${kept === 1 ? "" : "s"} kept — already published to a marketplace.`,
              duration: 12_000,
            }
          : undefined,
      );
    } catch (err) {
      toastError(err);
    } finally {
      setUndoing(false);
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

      {/* US-9201: the extension-channel import. Renders only when the
          extension is installed and the account has an active paid plan. */}
      <ClosetImportCard
        disabled={importing || !can("manage_inventory")}
        onStarted={handleClosetStarted}
      />

      {/* Step 1: input — upload OR paste */}
      <Card>
        <CardHeader>
          <CardTitle>1. Load your data</CardTitle>
          <CardDescription>
            Upload a CSV file (recommended for 200+ rows — more reliable than
            paste), or paste from Google Sheets (handles tabs or commas).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Google Sheet link — paste a share URL and we pull it directly */}
          <div className="rounded-md border bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Link2 className="h-4 w-4" />
              Connect a Google Sheet
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Paste a share link. The sheet must be shared with{" "}
              <strong>Anyone with the link</strong> (Viewer). We pull the first
              tab — add <code>#gid=…</code> to target a specific tab.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Input
                aria-label="Google Sheet share link"
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                className="min-w-[260px] flex-1 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleFetchSheet();
                }}
              />
              <Button
                variant="outline"
                onClick={handleFetchSheet}
                disabled={!sheetUrl.trim() || fetchSheet.isPending}
              >
                {fetchSheet.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="mr-2 h-4 w-4" />
                )}
                Fetch sheet
              </Button>
            </div>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-card px-2 text-muted-foreground">
                or upload a file
              </span>
            </div>
          </div>

          <div className="rounded-md border-2 border-dashed border-muted-foreground/30 p-4 text-center">
            <input
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              className="hidden"
              id="csv-file-input"
            />
            <label
              htmlFor="csv-file-input"
              className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-brand-navy px-4 py-2 text-sm font-medium text-white hover:bg-brand-navy/90"
            >
              <Upload className="h-4 w-4" />
              Choose CSV file
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              In Google Sheets: File → Download → Comma-separated values (.csv)
            </p>
            {/* US-2518: a seller with no spreadsheet yet had nothing to start
                from, and had to guess at column names. These headers are the
                ones guessField() recognises, so a file built on this maps
                itself. */}
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={downloadTemplate}
            >
              <Download className="mr-2 h-4 w-4" />
              Download the CSV template
            </Button>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-card px-2 text-muted-foreground">
                or paste
              </span>
            </div>
          </div>

          {/* US-2335: the only text near this is a divider reading "or paste",
              and its placeholder is a sample table that stops being announced on
              the first keystroke. */}
          <Textarea
            aria-label="Paste rows to import"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="Container	Item #	Item Title	...
A1	GT-0001	Lululemon Align Pant	..."
            className="font-mono text-xs"
          />
          <div className="flex justify-end">
            <Button onClick={handleDetect} disabled={!text.trim()}>
              Detect columns
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Step 2: mapping */}
      {headers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>2. Confirm the mapping</CardTitle>
            <CardDescription>
              {rows.length} rows detected. Map each spreadsheet column to a
              FlipDesk field. Skipped columns aren't imported.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* US-9209: a switching seller picks (or is handed) their old tool's
                preset. "Plain spreadsheet" is the generic guess this page always
                used; an unverified preset says so rather than promising. */}
            <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
              <Label htmlFor="import-preset">Exported from</Label>
              <Select
                value={preset?.id ?? "none"}
                onValueChange={(v) => {
                  const next = getImportPreset(v) ?? null;
                  setPreset(next);
                  setMapping(next ? applyImportPreset(headers, next) : headers.map(guessField));
                }}
              >
                <SelectTrigger id="import-preset" className="w-56" aria-label="Exported from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Plain spreadsheet</SelectItem>
                  {IMPORT_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {preset && !preset.verified ? (
                <span className="text-xs text-muted-foreground">
                  Mapping from {preset.name.replace(" export", "")}'s documented columns, not yet checked against a real file. Look over step 2 before you import.
                </span>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {headers.map((header, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      {header || `(col ${i + 1})`}
                    </Badge>
                  </div>
                  {/* One per spreadsheet COLUMN. Named from the column header
                      — stable source data, not something being edited — with the
                      position as the fallback for an unnamed column, matching
                      what the Badge above already shows. */}
                  <Select
                    value={mapping[i] ?? "skip"}
                    onValueChange={(v) => {
                      const next = [...mapping];
                      next[i] = v as ImportField;
                      setMapping(next);
                    }}
                  >
                    <SelectTrigger aria-label={`Map column ${header || i + 1} to`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {IMPORT_FIELDS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {IMPORT_FIELD_LABELS[f]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {!titleFieldMapped && (
              <div className="mt-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                One column must map to <strong>Item Title</strong>.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3: preview */}
      {previewRows.length > 0 && titleFieldMapped && (
        <Card>
          <CardHeader>
            <CardTitle>3. Preview (first 10 rows)</CardTitle>
            <CardDescription>
              How rows will land after mapping. Numbers are parsed; dates
              normalized to ISO; status normalized to FlipDesk enum.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>List $</TableHead>
                  <TableHead>Sold $</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {previewRows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="max-w-xs truncate">
                      {r.mapped.title ?? <span className="text-destructive">—</span>}
                    </TableCell>
                    <TableCell>{r.mapped.brand ?? ""}</TableCell>
                    <TableCell>{r.mapped.size ?? ""}</TableCell>
                    <TableCell>{parsePrice(r.mapped.purchase_price ?? "")?.toFixed(2) ?? ""}</TableCell>
                    <TableCell>{parsePrice(r.mapped.list_price ?? "")?.toFixed(2) ?? ""}</TableCell>
                    <TableCell>{parsePrice(r.mapped.sale_price ?? "")?.toFixed(2) ?? ""}</TableCell>
                    <TableCell>
                      {r.mapped.status ? (
                        <Badge variant="outline" className="text-xs">
                          {normalizeStatus(r.mapped.status) ?? r.mapped.status}
                        </Badge>
                      ) : (
                        ""
                      )}
                    </TableCell>
                    <TableCell>{r.mapped.source ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Step 4: import */}
      {rows.length > 0 && titleFieldMapped && (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={importing}
            onClick={() => {
              setText("");
              setHeaders([]);
              setRows([]);
              setMapping([]);
              setRun(null);
            }}
          >
            Reset
          </Button>
          <Button onClick={handleImport} disabled={importing}>
            {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Import {rows.length} items
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
                    onClick={handleUndo}
                    disabled={undoing}
                  >
                    {undoing ? (
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
                values it filled in. Anything you have already published to a
                marketplace is left alone.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
