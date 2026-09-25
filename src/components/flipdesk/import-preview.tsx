import { memo, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import {
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  MAX_IMPORT_ROWS,
  type ImportField,
  type ImportPayloadRow,
  type ImportValidation,
} from "@/lib/import-mapping";
import { IMPORT_PRESETS, type ImportPreset } from "@/lib/import-presets";

// IMP-12: step 2 (mapping) and step 3 (dry run + preview), pulled out of the
// page and memoized so typing in the page's other inputs does not re-render a
// preview built from thousands of rows.

interface MappingProps {
  headers: string[];
  mapping: ImportField[];
  sample: string[] | undefined;
  rowCount: number;
  preset: ImportPreset | null;
  duplicateFields: ImportField[];
  onPresetChange: (id: string) => void;
  onMappingChange: (index: number, field: ImportField) => void;
}

export const ImportMappingStep = memo(function ImportMappingStep({
  headers,
  mapping,
  sample,
  rowCount,
  preset,
  duplicateFields,
  onPresetChange,
  onMappingChange,
}: MappingProps) {
  const titleMapped = mapping.includes("title");
  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Confirm the mapping</CardTitle>
        <CardDescription>
          {rowCount} rows detected. Map each spreadsheet column to a FlipDesk
          field. Skipped columns aren't imported.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* US-9209: a switching seller picks (or is handed) their old tool's
            preset. "Plain spreadsheet" is the generic guess this page always
            used; an unverified preset says so rather than promising. */}
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <Label htmlFor="import-preset">Exported from</Label>
          <Select value={preset?.id ?? "none"} onValueChange={onPresetChange}>
            <SelectTrigger id="import-preset" className="w-64" aria-label="Exported from">
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
              Mapping the documented columns for {preset.name}. Nobody has
              checked it against a real file yet, so look over step 2 before
              you import.
            </span>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {headers.map((header, i) => (
            <div key={i} className="space-y-1">
              <Badge variant="outline" className="font-mono text-xs">
                {header || `(col ${i + 1})`}
              </Badge>
              {/* One per spreadsheet COLUMN, named from its header, with the
                  position as the fallback for an unnamed column. */}
              <Select
                value={mapping[i] ?? "skip"}
                onValueChange={(v) => onMappingChange(i, v as ImportField)}
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
              {/* IMP-12: the seller's real value, so a mapping is checked
                  against data rather than a header name. */}
              {sample?.[i] ? (
                <p className="truncate text-xs text-muted-foreground" title={sample[i]}>
                  e.g. {sample[i]}
                </p>
              ) : null}
            </div>
          ))}
        </div>
        {!titleMapped && (
          <div className="mt-4 flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            One column must map to <strong>Item Title</strong>.
          </div>
        )}
        {duplicateFields.length > 0 && (
          <p role="status" className="mt-3 text-sm text-amber-700 dark:text-amber-400">
            Two columns map to{" "}
            {duplicateFields.map((f) => IMPORT_FIELD_LABELS[f]).join(", ")}. Only the
            last one is kept. Set the other to Skip.
          </p>
        )}
      </CardContent>
    </Card>
  );
});

function rowList(rows: number[]): string {
  const shown = rows.slice(0, 8).join(", ");
  return rows.length > 8 ? `${shown} and ${rows.length - 8} more` : shown;
}

interface PreviewProps {
  payload: ImportPayloadRow[];
  validation: ImportValidation;
}

export const ImportPreview = memo(function ImportPreview({ payload, validation }: PreviewProps) {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const v = validation;
  const problemRows = useMemo(
    () =>
      new Set([
        ...v.noTitle,
        ...v.badDate,
        ...v.badPrice,
        ...v.unknownStatus,
        ...v.fellToOther,
        ...v.duplicateSkus,
      ]),
    [v],
  );
  const shown = (problemsOnly ? payload.filter((r) => problemRows.has(r.row)) : payload).slice(0, 10);
  const lines: Array<[number[], string]> = [
    [v.noTitle, "have no title and will be skipped"],
    [v.duplicateSkus, "repeat a SKU from an earlier row and will be skipped"],
    [v.badDate, "have a date we can't read; it will be left blank"],
    [v.badPrice, "have an amount we can't read; it will be left blank"],
    [v.unknownStatus, "have a status we don't know; they will import as Acquired"],
    [v.fellToOther, "have a category we don't know; they will import as Other"],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>3. Check before you import</CardTitle>
        <CardDescription>
          Nothing is saved until you press Import. This is what will happen.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="status" aria-live="polite" className="space-y-1 text-sm">
          <p className="font-medium">
            {v.willImport} of {v.total} rows will import.
          </p>
          {v.overCap && (
            <p className="text-destructive">
              That is more than {MAX_IMPORT_ROWS.toLocaleString()} rows, the most one import
              takes. Import the first {MAX_IMPORT_ROWS.toLocaleString()} now and the rest in a
              second file.
            </p>
          )}
          <ul className="space-y-1 text-muted-foreground">
            {lines
              .filter(([rows]) => rows.length > 0)
              .map(([rows, text]) => (
                <li key={text}>
                  {rows.length} row{rows.length === 1 ? "" : "s"} {text} (row
                  {rows.length === 1 ? "" : "s"} {rowList(rows)}).
                </li>
              ))}
          </ul>
        </div>
        {problemRows.size > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <Switch
              id="import-problems-only"
              checked={problemsOnly}
              onCheckedChange={setProblemsOnly}
            />
            <Label htmlFor="import-problems-only">Show only problem rows</Label>
          </div>
        )}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Bought</TableHead>
                <TableHead>List $</TableHead>
                <TableHead>Listed</TableHead>
                <TableHead>Sold $</TableHead>
                <TableHead>Sold</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.row} data-problem={problemRows.has(r.row) || undefined}>
                  <TableCell className="text-muted-foreground">{r.row}</TableCell>
                  <TableCell className="max-w-xs truncate">
                    {r.title ?? <span className="text-destructive">No title</span>}
                  </TableCell>
                  <TableCell>{r.sku ?? ""}</TableCell>
                  <TableCell>{r.brand ?? ""}</TableCell>
                  <TableCell>{r.size ?? ""}</TableCell>
                  <TableCell>{r.item_category ?? ""}</TableCell>
                  <TableCell>{r.acquired_price?.toFixed(2) ?? ""}</TableCell>
                  <TableCell>{r.acquired_date ?? ""}</TableCell>
                  <TableCell>{r.listing?.listing_price?.toFixed(2) ?? ""}</TableCell>
                  <TableCell>{r.listing?.listed_at ?? ""}</TableCell>
                  <TableCell>{r.sale?.sale_price?.toFixed(2) ?? ""}</TableCell>
                  <TableCell>{r.sale?.sold_at ?? ""}</TableCell>
                  <TableCell>
                    {r.status ? (
                      <Badge variant="outline" className="text-xs">
                        {r.status}
                      </Badge>
                    ) : (
                      ""
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {payload.length > 10 && (
          <p className="text-xs text-muted-foreground">
            Showing the first {shown.length} {problemsOnly ? "problem rows" : "rows"}.
          </p>
        )}
      </CardContent>
    </Card>
  );
});
