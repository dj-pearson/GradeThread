import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
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
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
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
  failed: number;
  errors: { row: number; message: string }[];
};

function buildMapped(
  row: string[],
  headers: string[],
  mapping: ImportField[],
): Partial<Record<ImportField, string>> {
  const result: Partial<Record<ImportField, string>> = {};
  for (let i = 0; i < headers.length; i++) {
    const field = mapping[i];
    if (field === "skip" || !row[i]) continue;
    result[field] = row[i].trim();
  }
  return result;
}

export function FlipdeskImportPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const [text, setText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ImportField[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function handleDetect() {
    if (!text.trim()) {
      toast.error("Paste some data first.");
      return;
    }
    const { headers: h, rows: r } = parseSheet(text);
    if (h.length === 0) {
      toast.error("Could not detect headers — first row appears empty.");
      return;
    }
    setHeaders(h);
    setRows(r);
    setMapping(h.map(guessField));
    setResult(null);
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
    if (!user) {
      toast.error("You must be signed in.");
      return;
    }
    if (!titleFieldMapped) {
      toast.error("At least one column must map to Item Title.");
      return;
    }

    setImporting(true);
    const errors: { row: number; message: string }[] = [];
    let inserted = 0;
    const sourceCache = new Map<string, string>();

    for (let i = 0; i < mappedRows.length; i++) {
      const { mapped } = mappedRows[i];
      const title = mapped.title;
      if (!title) {
        errors.push({ row: i + 2, message: "Missing item title" });
        continue;
      }

      try {
        // 1) Resolve source via RPC (creates if missing)
        let sourceId: string | null = null;
        const sourceName = mapped.source;
        if (sourceName) {
          if (sourceCache.has(sourceName)) {
            sourceId = sourceCache.get(sourceName) ?? null;
          } else {
            const { data: sid, error: sErr } = await supabase.rpc(
              "get_or_create_source",
              {
                p_user_id: user.id,
                p_name: sourceName,
                p_source_type: "other",
              },
            );
            if (sErr) throw sErr;
            sourceId = (sid as string) ?? null;
            if (sourceId) sourceCache.set(sourceName, sourceId);
          }
        }

        // 2) Parse comps cell into ItemComp[] (one comp with raw text in notes)
        const comp_set: ItemComp[] = mapped.comps
          ? [{ price: 0, notes: mapped.comps }]
          : [];

        // 3) Build inventory item insert
        const purchaseDate = mapped.purchase_date
          ? parseDate(mapped.purchase_date)
          : null;
        const status = mapped.status ? normalizeStatus(mapped.status) : null;
        const category = mapped.item_category
          ? normalizeCategory(mapped.item_category)
          : null;

        const itemInsert: InventoryItemInsert = {
          user_id: user.id,
          title,
          sku: mapped.sku ?? null,
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

        const { data: itemRow, error: itemErr } = await supabase
          .from("inventory_items")
          .insert(itemInsert)
          .select("id")
          .single();

        if (itemErr) throw itemErr;
        const itemId = itemRow.id;

        // 4) Optional listing row
        const listPrice = parsePrice(mapped.list_price ?? "");
        const listDate = mapped.list_date ? parseDate(mapped.list_date) : null;
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
            .insert(listingInsert);
          if (lErr) throw lErr;
        }

        // 5) Optional sale row
        const salePrice = parsePrice(mapped.sale_price ?? "");
        const saleDate = mapped.sale_date ? parseDate(mapped.sale_date) : null;
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
            .insert(saleInsert);
          if (sErr) throw sErr;
        }

        inserted++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ row: i + 2, message });
      }
    }

    setImporting(false);
    setResult({ inserted, failed: errors.length, errors });
    if (errors.length === 0) {
      toast.success(`Imported ${inserted} items.`);
    } else {
      toast.warning(`Imported ${inserted}, failed ${errors.length}.`);
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

      {/* Step 1: paste */}
      <Card>
        <CardHeader>
          <CardTitle>1. Paste your data</CardTitle>
          <CardDescription>
            In Google Sheets, select your data (including the header row) and
            copy. Paste here. Tabs or commas — both work.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
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
            onClick={() => {
              setText("");
              setHeaders([]);
              setRows([]);
              setMapping([]);
              setResult(null);
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
              {result.inserted} imported · {result.failed} failed
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
