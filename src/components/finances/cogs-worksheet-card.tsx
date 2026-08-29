import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Package } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { csvBlob, downloadBlob } from "@/lib/download";
import { escapeCsvCell } from "@/lib/items-csv";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/ledger-math";
import {
  backfillSnapshots,
  cogsConfidence,
  fetchCogsWorksheet,
  fetchItemsMissingCostBasis,
  type CogsWorksheet,
} from "@/lib/cogs";

// US-2986 — Schedule C Part III on the P&L page.
//
// It sits here rather than on a page of its own because Part III feeds line 4
// of Part I, which the statement above it already prints. Splitting them would
// make a seller navigate between two halves of one calculation.

interface Props {
  from: string;
  /** Exclusive, matching every other range in this epic. */
  to: string;
  periodLabel: string;
  fiscalYearStartMonth: number;
  businessStartedOn: string | null;
}

const PART_III_ROWS: {
  key: keyof CogsWorksheet;
  line: string;
  label: string;
}[] = [
  { key: "line_35_beginning_cents", line: "35", label: "Inventory at the start" },
  { key: "line_36_purchases_cents", line: "36", label: "What you bought" },
  { key: "line_41_ending_cents", line: "41", label: "Inventory at the end" },
  { key: "line_42_cogs_cents", line: "42", label: "Cost of goods sold" },
];

export function CogsWorksheetCard({
  from,
  to,
  periodLabel,
  fiscalYearStartMonth,
  businessStartedOn,
}: Props) {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [backfilling, setBackfilling] = useState(false);

  const { data: worksheet, isLoading } = useQuery({
    queryKey: ["cogs-worksheet", user?.id, from, to],
    enabled: !!user,
    queryFn: () => fetchCogsWorksheet(from, to),
    staleTime: 5 * 60 * 1000,
  });

  const confidence = worksheet ? cogsConfidence(worksheet) : null;

  // Only fetched when there is something to explain. The list is the answer to
  // "which items", and asking for it when the books are clean is a wasted round
  // trip on every page load.
  const { data: missing = [] } = useQuery({
    queryKey: ["cogs-missing-basis", user?.id, from, to],
    enabled:
      !!user && (confidence === "missing_cost" || confidence === "variance"),
    queryFn: () => fetchItemsMissingCostBasis(from, to),
    staleTime: 5 * 60 * 1000,
  });

  async function runBackfill() {
    setBackfilling(true);
    try {
      const { created, skipped } = await backfillSnapshots(
        fiscalYearStartMonth,
        businessStartedOn,
        new Date(),
      );
      await qc.invalidateQueries({ queryKey: ["cogs-worksheet"] });
      toast.success(
        created > 0
          ? `Valued your inventory at ${created} year boundar${created === 1 ? "y" : "ies"}. ${skipped} already had one.`
          : "Every year boundary already has a valuation.",
      );
    } catch (err) {
      toastError(err, "Couldn't value your inventory.");
    } finally {
      setBackfilling(false);
    }
  }

  function exportCsv() {
    if (!worksheet) return;
    const lines: string[] = [];
    lines.push("SCHEDULE C PART III - COST OF GOODS SOLD");
    lines.push(`Period,${escapeCsvCell(periodLabel)}`);
    lines.push(`From,${from}`);
    lines.push(`Through (exclusive),${to}`);
    lines.push("");
    lines.push("Line,Description,Amount");
    for (const r of PART_III_ROWS) {
      lines.push(
        [
          r.line,
          escapeCsvCell(r.label),
          ((worksheet[r.key] as number) / 100).toFixed(2),
        ].join(","),
      );
    }
    lines.push("");
    lines.push("CROSS-CHECK");
    lines.push(
      `Cost basis of items sold (from the ledger),${(worksheet.sold_cost_basis_cents / 100).toFixed(2)}`,
    );
    lines.push(
      `Difference,${(worksheet.variance_cents / 100).toFixed(2)}`,
    );
    lines.push(
      `Items valued at zero,${
        worksheet.items_without_cost.beginning +
        worksheet.items_without_cost.purchases +
        worksheet.items_without_cost.ending
      }`,
    );
    if (worksheet.line_35_reconstructed || worksheet.line_41_reconstructed) {
      lines.push("");
      lines.push(
        escapeCsvCell(
          "One or both inventory figures were RECONSTRUCTED after the fact from surviving data, not recorded at the time.",
        ),
      );
    }
    if (missing.length > 0) {
      lines.push("");
      lines.push("ITEMS SOLD WITH NO COST BASIS");
      lines.push("Sold on,Item,Sale price");
      for (const m of missing) {
        lines.push(
          [
            m.sale_date,
            escapeCsvCell(m.title ?? "Untitled"),
            (m.sale_price_cents / 100).toFixed(2),
          ].join(","),
        );
      }
    }
    lines.push("");
    lines.push(
      escapeCsvCell(
        "GradeThread does the arithmetic. It does not give tax advice.",
      ),
    );
    downloadBlob(csvBlob(lines.join("\n")), `cogs-part-iii-${from}-to-${to}.csv`);
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost of goods sold</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!worksheet) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Cost of goods sold</CardTitle>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Schedule C Part III. Your tax return asks for these four numbers.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          CSV
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <table className="w-full text-sm">
          <tbody>
            {PART_III_ROWS.map((r) => (
              <tr
                key={r.line}
                className={cn(
                  "border-b last:border-b-0",
                  r.line === "42" && "font-semibold",
                )}
              >
                <td className="w-12 p-3 text-xs text-muted-foreground">
                  {r.line}
                </td>
                <td className="p-3">{r.label}</td>
                <td className="p-3 text-right tabular-nums">
                  {formatCents(worksheet[r.key] as number)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="px-6 pb-6">
          {confidence === "no_snapshot" ? (
            <Notice
              tone="warn"
              title="We have not valued your inventory yet"
              body="Lines 35 and 41 need a count of what you were holding on the first and last day. Without them, line 42 is arithmetic on a hole."
              action={
                <Button size="sm" onClick={runBackfill} disabled={backfilling}>
                  <Package className="mr-2 h-4 w-4" />
                  {backfilling ? "Counting" : "Value my inventory"}
                </Button>
              }
            />
          ) : confidence === "variance" ? (
            <Notice
              tone="warn"
              title={`Two ways of working this out disagree by ${formatCents(Math.abs(worksheet.variance_cents))}`}
              body={
                `Adding up your inventory gives ${formatCents(worksheet.line_42_cogs_cents)}. ` +
                `Adding up what the items you sold cost gives ${formatCents(worksheet.sold_cost_basis_cents)}. ` +
                "The usual cause is an item whose purchase date is wrong, so it lands in the wrong year."
              }
            />
          ) : confidence === "missing_cost" ? (
            <Notice
              tone="warn"
              title="Some items are counted as costing nothing"
              body={
                `${
                  worksheet.items_without_cost.beginning +
                  worksheet.items_without_cost.purchases +
                  worksheet.items_without_cost.ending
                } item(s) have no purchase price recorded. ` +
                "They count as $0, which makes your inventory look smaller and your profit look bigger than it was. The two totals above still agree, because both of them read the same blank."
              }
            />
          ) : (
            <Notice
              tone="ok"
              title="These numbers reconcile"
              body={`Both ways of working out cost of goods sold give ${formatCents(worksheet.line_42_cogs_cents)}, and every item has a purchase price.`}
            />
          )}

          {(worksheet.line_35_reconstructed || worksheet.line_41_reconstructed) && (
            <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
              At least one of these inventory figures was rebuilt after the fact
              from what survived, rather than counted on the day. It is the best
              available answer, not a record. Your export says so too.
            </p>
          )}

          {missing.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[13px] font-medium">
                Sold with no purchase price ({missing.length})
              </p>
              <ul className="space-y-1 text-[13px] text-muted-foreground">
                {missing.slice(0, 10).map((m) => (
                  <li key={m.item_id} className="flex flex-wrap gap-x-2">
                    <span>{m.sale_date}</span>
                    <span className="text-foreground">
                      {m.title ?? "Untitled"}
                    </span>
                    <span>sold for {formatCents(m.sale_price_cents)}</span>
                  </li>
                ))}
              </ul>
              {missing.length > 10 && (
                <p className="mt-2 text-[13px] text-muted-foreground">
                  And {missing.length - 10} more. The CSV has all of them.
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Notice({
  tone,
  title,
  body,
  action,
}: {
  tone: "ok" | "warn";
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const Icon = tone === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <div className="flex gap-3">
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          tone === "ok"
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-amber-700 dark:text-amber-400",
        )}
      />
      <div className="space-y-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          {body}
        </p>
        {action}
      </div>
    </div>
  );
}
