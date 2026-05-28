import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Link2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { supabase } from "@/lib/supabase";
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
import type {
  InventoryItemInsert,
  ListingInsert,
  SaleInsert,
  ItemComp,
} from "@/types/database";

type ImportRow = {
  raw: string[];
  mapped: Partial<Record<ImportField, string>>;
};

type ImportResult = {
  inserted: number;
  skipped: number;
  failed: number;
  errors: { row: number; message: string }[];
};

type Progress =
  | { phase: "idle" }
  | { phase: "preflight"; message: string }
  | { phase: "running"; current: number; total: number; message: string }
  | { phase: "done" };

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
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<Progress>({ phase: "idle" });
  const [result, setResult] = useState<ImportResult | null>(null);
  const fetchSheet = useFetchGoogleSheet();

  async function handleFetchSheet() {
    if (!sheetUrl.trim()) return;
    try {
      const { csv } = await fetchSheet.mutateAsync({ url: sheetUrl.trim() });
      setText(csv);
      detectFromText(csv);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), {
        duration: 12_000,
      });
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
    setMapping(h.map(guessField));
    setResult(null);
    toast.success(`Detected ${h.length} columns, ${r.length} rows.`);
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
    setResult(null);
    const errors: { row: number; message: string }[] = [];
    let inserted = 0;
    let skipped = 0;

    try {
      // ── Phase 1: pre-resolve all unique sources in one pass ─────────
      setProgress({ phase: "preflight", message: "Resolving sources…" });
      const sourceCache = new Map<string, string>();
      const uniqueSources = Array.from(
        new Set(
          mappedRows
            .map((r) => r.mapped.source?.trim())
            .filter((s): s is string => !!s),
        ),
      );
      // Call rpc as a method on `supabase` — extracting it as a standalone
      // function loses `this` and the client crashes reading `this.rest`.
      const supabaseAny = supabase as unknown as {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: string | null; error: Error | null }>;
      };
      for (const name of uniqueSources) {
        const { data: sid, error: sErr } = await supabaseAny.rpc(
          "get_or_create_source",
          {
            p_user_id: workspaceOwnerId,
            p_name: name,
            p_source_type: "other",
          },
        );
        if (sErr) {
          errors.push({ row: 0, message: `Source "${name}": ${sErr.message}` });
          continue;
        }
        if (sid) sourceCache.set(name, sid);
      }

      // ── Phase 2: pre-fetch existing SKUs so we route INSERT vs UPDATE ─
      setProgress({ phase: "preflight", message: "Checking for duplicates…" });
      const skus = Array.from(
        new Set(
          mappedRows
            .map((r) => r.mapped.sku?.trim())
            .filter((s): s is string => !!s),
        ),
      );

      type ExistingRow = { id: string; sku: string | null };
      const existingMap = new Map<string, string>(); // sku → id
      // Chunk small to stay well under PostgREST URL length even with
      // unusual chars in SKUs that need percent-encoding.
      const CHUNK = 50;
      for (let i = 0; i < skus.length; i += CHUNK) {
        const chunk = skus.slice(i, i + CHUNK);
        const { data, error: lookupErr } = await supabase
          .from("inventory_items")
          .select("id, sku")
          .eq("user_id", workspaceOwnerId)
          .in("sku", chunk);
        if (lookupErr) throw lookupErr;
        for (const row of (data ?? []) as ExistingRow[]) {
          if (row.sku) existingMap.set(row.sku, row.id);
        }
      }

      // ── Phase 3: process rows sequentially with live progress ─────
      for (let i = 0; i < mappedRows.length; i++) {
        const item = mappedRows[i];
        if (!item) continue;
        const { mapped } = item;
        const title = mapped.title;
        if (!title) {
          errors.push({ row: i + 2, message: "Missing item title" });
          continue;
        }

        setProgress({
          phase: "running",
          current: i + 1,
          total: mappedRows.length,
          message: `Row ${i + 1} of ${mappedRows.length}`,
        });

        try {
          const sourceName = mapped.source?.trim();
          const sourceId = sourceName
            ? sourceCache.get(sourceName) ?? null
            : null;

          const comp_set: ItemComp[] = mapped.comps
            ? [{ price: 0, notes: mapped.comps }]
            : [];

          const purchaseDate = mapped.purchase_date
            ? parseDate(mapped.purchase_date)
            : null;
          const status = mapped.status ? normalizeStatus(mapped.status) : null;
          const category = mapped.item_category
            ? normalizeCategory(mapped.item_category)
            : null;

          const sku = mapped.sku?.trim() ?? null;
          const itemPayload: InventoryItemInsert = {
            user_id: workspaceOwnerId,
            title,
            sku,
            container: mapped.container ?? null,
            description: mapped.description ?? null,
            brand: mapped.brand ?? null,
            style: mapped.style ?? null,
            size: mapped.size ?? null,
            condition_notes: mapped.condition_notes ?? null,
            item_category: category,
            source_id: sourceId,
            sourced_by: mapped.sourced_by ?? null,
            acquired_date: purchaseDate,
            acquired_price: parsePrice(mapped.purchase_price ?? "") ?? null,
            status: status ?? "acquired",
            comp_set,
          };

          // Skip rows whose SKU already exists — don't even attempt INSERT.
          if (sku && existingMap.has(sku)) {
            skipped++;
            continue;
          }

          const { data: itemRow, error: itemErr } = await supabase
            .from("inventory_items")
            .insert(itemPayload as never)
            .select("id")
            .single();

          if (itemErr) {
            // Defensive 409 fallback: if INSERT conflicts on SKU unique index
            // (pre-flight missed it, e.g., a concurrent import in another
            // tab), treat as already existing and skip.
            const errObj = itemErr as { code?: string };
            if (errObj.code === "23505" && sku) {
              existingMap.set(sku, "skipped"); // mark so future dupes also skip
              skipped++;
              continue;
            }
            throw itemErr;
          }

          const newId = (itemRow as { id: string } | null)?.id;
          if (!newId) throw new Error("Insert returned no id");
          const itemId: string = newId;
          inserted++;
          if (sku) existingMap.set(sku, itemId);

          // Only insert listings/sales for NEW items. Re-imports skip these.
          const listPrice = parsePrice(mapped.list_price ?? "");
          const listDate = mapped.list_date
            ? parseDate(mapped.list_date)
            : null;
          if (listPrice !== null || listDate !== null || mapped.link) {
            const listingInsert: ListingInsert = {
              inventory_item_id: itemId,
              platform: "ebay",
              listing_price: listPrice ?? 0,
              listing_url: mapped.link ?? null,
              listed_at: listDate ?? undefined,
              is_active: status === "listed",
            };
            const { error: lErr } = await supabase
              .from("listings")
              .insert(listingInsert as never);
            if (lErr) throw lErr;
          }

          const salePrice = parsePrice(mapped.sale_price ?? "");
          const saleDate = mapped.sale_date
            ? parseDate(mapped.sale_date)
            : null;
          if (salePrice !== null || saleDate !== null) {
            const saleInsert: SaleInsert = {
              inventory_item_id: itemId,
              sale_price: salePrice ?? 0,
              platform_fees: parsePrice(mapped.fees ?? "") ?? 0,
              tax: parsePrice(mapped.tax ?? "") ?? 0,
              shipping_cost: parsePrice(mapped.shipping_cost ?? "") ?? 0,
              net_profit: parsePrice(mapped.net_profit ?? "") ?? null,
              payout_amount: parsePrice(mapped.payout ?? "") ?? null,
              tracking_number: mapped.tracking ?? null,
              sold_at: saleDate,
              sale_date: saleDate ?? undefined,
            };
            const { error: sErr } = await supabase
              .from("sales")
              .insert(saleInsert as never);
            if (sErr) throw sErr;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ row: i + 2, message });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log full error to console so it's visible in DevTools even if the
      // result panel is collapsed.
      console.error("[FlipDesk import] pre-flight failed:", err);
      errors.push({ row: 0, message: `Pre-flight failed: ${message}` });
    }

    setImporting(false);
    setProgress({ phase: "done" });
    setResult({
      inserted,
      skipped,
      failed: errors.length,
      errors,
    });
    if (errors.length === 0) {
      toast.success(
        `Imported ${inserted} new${
          skipped > 0 ? `, skipped ${skipped} existing` : ""
        }.`,
      );
    } else {
      // Surface the first error message in the toast so the user doesn't
      // have to dig into the result panel for the diagnostic.
      const first = errors[0];
      const firstMsg = first?.message ?? "unknown error";
      toast.warning(
        `Imported ${inserted}, skipped ${skipped}, failed ${errors.length}. First error: ${firstMsg}`,
        { duration: 12_000 },
      );
      // Log each error to console for easy copy-paste.
      for (const e of errors) {
        console.error(`[FlipDesk import] row ${e.row}: ${e.message}`);
      }
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <Upload className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Import from spreadsheet</h1>
          <p className="text-sm text-muted-foreground">
            Paste your Google Sheets data below. We'll auto-detect columns and
            you confirm the mapping before import.
          </p>
        </div>
      </div>

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

          <Textarea
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {headers.map((header, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      {header || `(col ${i + 1})`}
                    </Badge>
                  </div>
                  <Select
                    value={mapping[i] ?? "skip"}
                    onValueChange={(v) => {
                      const next = [...mapping];
                      next[i] = v as ImportField;
                      setMapping(next);
                    }}
                  >
                    <SelectTrigger>
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
              setResult(null);
              setProgress({ phase: "idle" });
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

      {/* Progress */}
      {importing && progress.phase !== "idle" && progress.phase !== "done" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Importing…
            </CardTitle>
            <CardDescription>
              {progress.phase === "preflight"
                ? progress.message
                : `${progress.message} (${Math.round(
                    (progress.current / progress.total) * 100,
                  )}%)`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-brand-navy transition-all"
                style={{
                  width:
                    progress.phase === "running"
                      ? `${(progress.current / progress.total) * 100}%`
                      : "10%",
                }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Don't close this tab — re-imports of the same SKUs will update
              existing items, but it's faster to let this finish.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {result.failed === 0 ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              ) : (
                <AlertCircle className="h-5 w-5 text-destructive" />
              )}
              Import complete
            </CardTitle>
            <CardDescription>
              {result.inserted} new · {result.skipped} already existed ·{" "}
              {result.failed} failed
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.errors.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs">
                {result.errors.map((e, i) => (
                  <div key={i} className="font-mono">
                    Row {e.row}: {e.message}
                  </div>
                ))}
              </div>
            )}
            <Button onClick={() => navigate("/dashboard/flipdesk/items")}>
              View items
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
