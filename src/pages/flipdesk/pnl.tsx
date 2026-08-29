import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FileSpreadsheet, Printer, RefreshCw, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { csvBlob, downloadBlob } from "@/lib/download";
import { escapeCsvCell } from "@/lib/items-csv";
import { escapeHtml } from "@/lib/escape-html";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  ensureLedgerBuilt,
  fetchLedgerEntries,
  rebuildMyLedger,
  type LedgerEntryRow,
} from "@/lib/ledger";
import { formatCents } from "@/lib/ledger-math";
import {
  buildStatement,
  statementDelta,
  statementTotals,
  type StatementEntry,
  type StatementLine,
} from "@/lib/pnl-statement";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  periodRange,
  priorRange,
  ymd,
  type DateRange,
  type PnlGranularity,
} from "@/lib/tax-profile";

// US-2985 — the profit and loss statement.
//
// This is also the entry point src/lib/ledger.ts never had (US-3006). The
// module shipped with seven exports and no importer, which the unwired-code
// check caught: an implementation nobody calls is a feature that does not run.
//
// The statement reads ledger_entries and nothing else (AC6). It does not touch
// sales, inventory_items or flipdesk_expenses -- putting a second derivation
// here is exactly what US-2984 existed to stop.

const GRANULARITIES: { value: PnlGranularity; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
  { value: "custom", label: "Custom" },
];

function toStatementEntries(rows: LedgerEntryRow[]): StatementEntry[] {
  return rows.map((r) => ({
    account: r.ledger_accounts?.code ?? "__missing_account",
    amount_cents: r.amount_cents,
  }));
}

/** A cost prints as a positive number under a subtracted heading. */
function displayCents(line: { cents: number }, section: string): number {
  return section === "income" || section === "excluded"
    ? line.cents
    : Math.abs(line.cents);
}

export function PnlPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [granularity, setGranularity] = useState<PnlGranularity>("year");
  const [customFrom, setCustomFrom] = useState(() =>
    ymd(new Date(new Date().getFullYear(), 0, 1)),
  );
  const [customTo, setCustomTo] = useState(() => ymd(new Date()));
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const { data: taxProfile } = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
    staleTime: 30 * 60 * 1000,
  });
  const fyStart =
    taxProfile?.fiscal_year_start_month ??
    TAX_PROFILE_DEFAULTS.fiscal_year_start_month;

  const range: DateRange = useMemo(() => {
    if (granularity === "custom") {
      // The input's `to` is what a person means by "through this date", so it
      // is made exclusive here rather than asking them to think about it.
      const to = new Date(
        Number(customTo.slice(0, 4)),
        Number(customTo.slice(5, 7)) - 1,
        Number(customTo.slice(8, 10)) + 1,
      );
      return { from: customFrom, to: ymd(to), label: `${customFrom} to ${customTo}` };
    }
    return periodRange(granularity, fyStart, new Date());
  }, [granularity, fyStart, customFrom, customTo]);

  const prior = useMemo(
    () => priorRange(granularity, fyStart, range),
    [granularity, fyStart, range],
  );

  const {
    data: currentRows,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["pnl-entries", user?.id, range.from, range.to],
    enabled: !!user,
    queryFn: async () => {
      // The ledger is derived, so an account that has never built one shows an
      // empty statement rather than an error. Build it once, then read.
      await ensureLedgerBuilt();
      return fetchLedgerEntries(range.from, range.to);
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: priorRows } = useQuery({
    queryKey: ["pnl-entries", user?.id, prior.from, prior.to],
    enabled: !!user && !isLoading,
    queryFn: () => fetchLedgerEntries(prior.from, prior.to),
    staleTime: 5 * 60 * 1000,
  });

  const statement = useMemo(
    () => buildStatement(toStatementEntries(currentRows ?? [])),
    [currentRows],
  );
  const priorStatement = useMemo(
    () => buildStatement(toStatementEntries(priorRows ?? [])),
    [priorRows],
  );

  /** The entries behind one account, for the drill-through. */
  const entriesFor = useMemo(() => {
    const map = new Map<string, LedgerEntryRow[]>();
    for (const r of currentRows ?? []) {
      const code = r.ledger_accounts?.code ?? "__missing_account";
      const list = map.get(code);
      if (list) list.push(r);
      else map.set(code, [r]);
    }
    return map;
  }, [currentRows]);

  const priorByCode = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of priorStatement.sections) {
      for (const l of s.lines) map.set(l.code, l.cents);
    }
    return map;
  }, [priorStatement]);

  async function rebuild() {
    setRebuilding(true);
    try {
      const n = await rebuildMyLedger();
      await qc.invalidateQueries({ queryKey: ["pnl-entries"] });
      toast.success(`Books rebuilt. ${n} entries.`);
    } catch (err) {
      toastError(err, "Couldn't rebuild your books.");
    } finally {
      setRebuilding(false);
    }
  }

  function exportCsv() {
    const lines: string[] = [];
    lines.push("PROFIT AND LOSS");
    lines.push(`Period,${escapeCsvCell(range.label)}`);
    lines.push(`From,${range.from}`);
    lines.push(`Through (exclusive),${range.to}`);
    lines.push("");
    // SIGNED, deliberately, and said so. The screen prints a cost as a positive
    // number under a subtracted heading, which reads better; a spreadsheet
    // summing a column needs the sign or the total is nonsense. Rather than
    // pick one and leave the seller to notice the difference, the file says
    // which convention it uses.
    lines.push(
      escapeCsvCell(
        "Amounts are signed: income positive, costs negative, so a column sums to the total.",
      ),
    );
    lines.push("Account,Schedule C line,Amount,Prior period");
    for (const section of statement.sections) {
      lines.push(escapeCsvCell(section.title));
      for (const l of section.lines) {
        lines.push(
          [
            escapeCsvCell(l.label),
            escapeCsvCell(l.scheduleCLine ?? "none"),
            (l.cents / 100).toFixed(2),
            ((priorByCode.get(l.code) ?? 0) / 100).toFixed(2),
          ].join(","),
        );
      }
    }
    lines.push("");
    lines.push("TOTALS");
    for (const t of statementTotals(statement)) {
      lines.push(
        [
          escapeCsvCell(t.label),
          escapeCsvCell(t.hint ?? ""),
          (t.cents / 100).toFixed(2),
        ].join(","),
      );
    }
    lines.push("");
    lines.push(
      escapeCsvCell(
        "GradeThread does the arithmetic. It does not give tax advice.",
      ),
    );
    downloadBlob(
      csvBlob(lines.join("\n")),
      `profit-and-loss-${range.from}-to-${range.to}.csv`,
    );
  }

  function exportPdf() {
    const win = window.open("", "_blank");
    if (!win) {
      toast.error("Allow popups to print the statement.");
      return;
    }
    const sectionHtml = statement.sections
      .map(
        (s) => `
        <tr class="section"><td colspan="3">${escapeHtml(s.title)}</td></tr>
        ${s.lines
          .map(
            (l) => `<tr>
              <td>${escapeHtml(l.label)}</td>
              <td class="line">${escapeHtml(l.scheduleCLine ? `Line ${l.scheduleCLine}` : "no line")}</td>
              <td class="num">${escapeHtml(formatCents(displayCents(l, s.key)))}</td>
            </tr>`,
          )
          .join("")}`,
      )
      .join("");
    const totalsHtml = statementTotals(statement)
      .map(
        (t) => `<tr class="${t.emphasis ? "emph" : ""}">
          <td>${escapeHtml(t.label)}</td>
          <td class="line">${escapeHtml(t.hint ?? "")}</td>
          <td class="num">${escapeHtml(formatCents(t.cents))}</td>
        </tr>`,
      )
      .join("");
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Profit and loss</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:40px;color:#1A1A2E}
h1{color:#0F3460;margin:0 0 4px}
.period{color:#666;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin-top:16px}
td{padding:6px 10px;border-bottom:1px solid #e5e5e5;font-size:13px}
.section td{background:#f5f5f5;font-weight:700;color:#0F3460}
.num{text-align:right;font-variant-numeric:tabular-nums}
.line{color:#777;font-size:11px}
.emph td{font-weight:700;border-top:2px solid #0F3460}
.footer{margin-top:32px;font-size:11px;color:#888;border-top:1px solid #ddd;padding-top:10px}
@media print{body{margin:16px}}
</style></head><body>
<h1>Profit and loss</h1>
<div class="period">${escapeHtml(range.label)} &middot; ${escapeHtml(range.from)} through ${escapeHtml(range.to)} (exclusive)</div>
<table>${sectionHtml}</table>
<table>${totalsHtml}</table>
<div class="footer">Generated by GradeThread on ${escapeHtml(new Date().toLocaleDateString())}. GradeThread does the arithmetic. It does not give tax advice.</div>
</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 500);
  }

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load your books"
        description="Something went wrong reading the ledger. This is usually temporary."
        onRetry={() => refetch()}
        retrying={isFetching}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={TrendingUp}
        title="Profit and loss"
        subtitle="The statement an accountant asks for by name, in the order they read it."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={rebuild} disabled={rebuilding}>
              <RefreshCw className={cn("mr-2 h-4 w-4", rebuilding && "animate-spin")} />
              {rebuilding ? "Rebuilding" : "Rebuild"}
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <FileSpreadsheet className="mr-2 h-4 w-4" />
              CSV
            </Button>
            <Button variant="outline" size="sm" onClick={exportPdf}>
              <Printer className="mr-2 h-4 w-4" />
              Print
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2">
          {GRANULARITIES.map((g) => (
            <Button
              key={g.value}
              size="sm"
              variant={granularity === g.value ? "default" : "outline"}
              onClick={() => setGranularity(g.value)}
            >
              {g.label}
            </Button>
          ))}
        </div>
        {granularity === "custom" && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="pnl-from" className="text-xs">
                From
              </Label>
              <Input
                id="pnl-from"
                type="date"
                className="h-9 w-40"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pnl-to" className="text-xs">
                Through
              </Label>
              <Input
                id="pnl-to"
                type="date"
                className="h-9 w-40"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      <p className="text-[13px] text-muted-foreground">
        {range.label}, compared with {prior.label.toLowerCase()}.
      </p>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-3 text-left font-medium">Account</th>
                    <th className="hidden p-3 text-left font-medium sm:table-cell">
                      Schedule C
                    </th>
                    <th className="p-3 text-right font-medium">
                      {range.label}
                    </th>
                    <th className="hidden p-3 text-right font-medium md:table-cell">
                      {prior.label}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {statement.sections.map((section) => (
                    <SectionRows
                      key={section.key}
                      title={section.title}
                      sectionKey={section.key}
                      lines={section.lines}
                      priorByCode={priorByCode}
                      entriesFor={entriesFor}
                      openLine={openLine}
                      onToggle={(code) =>
                        setOpenLine((c) => (c === code ? null : code))
                      }
                    />
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">The bottom line</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {statementTotals(statement).map((t) => {
                    const priorTotal =
                      statementTotals(priorStatement).find(
                        (p) => p.key === t.key,
                      )?.cents ?? 0;
                    const d = statementDelta(t.cents, priorTotal);
                    return (
                      <tr
                        key={t.key}
                        className={cn(
                          "border-b last:border-b-0",
                          t.emphasis && "font-semibold",
                        )}
                      >
                        <td className="p-3">
                          {t.label}
                          {t.hint && (
                            <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                              {t.hint}
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          {formatCents(t.cents)}
                        </td>
                        <td className="hidden p-3 text-right text-xs tabular-nums text-muted-foreground md:table-cell">
                          {formatCents(priorTotal)}
                          {d.percent !== null && (
                            <span
                              className={cn(
                                "ml-2",
                                d.cents > 0
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : d.cents < 0
                                    ? "text-brand-red"
                                    : "",
                              )}
                            >
                              {d.cents > 0 ? "+" : ""}
                              {d.percent.toFixed(0)}%
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Every figure here comes from your ledger, which is built from your
            sales, expenses and payouts. GradeThread does the arithmetic. It
            does not give tax advice.
          </p>
        </>
      )}
    </div>
  );
}

function SectionRows({
  title,
  sectionKey,
  lines,
  priorByCode,
  entriesFor,
  openLine,
  onToggle,
}: {
  title: string;
  sectionKey: string;
  lines: StatementLine[];
  priorByCode: Map<string, number>;
  entriesFor: Map<string, LedgerEntryRow[]>;
  openLine: string | null;
  onToggle: (code: string) => void;
}) {
  return (
    <>
      <tr className="border-b bg-muted/40">
        <td colSpan={4} className="p-2.5 text-xs font-semibold uppercase tracking-wide">
          {title}
        </td>
      </tr>
      {lines.map((l) => {
        const rows = entriesFor.get(l.code) ?? [];
        const open = openLine === l.code;
        return (
          // Fragment, not <>, because this map returns a fragment and the key
          // has to sit on the outermost returned element. On the shorthand it
          // cannot, and React re-keys the whole section on every expand.
          <Fragment key={l.code}>
            <tr
              className={cn(
                "border-b",
                rows.length > 0 && "cursor-pointer hover:bg-muted/30",
              )}
              onClick={() => rows.length > 0 && onToggle(l.code)}
            >
              <td className="p-3">
                <span className="flex items-center gap-1.5">
                  {rows.length > 0 && (
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-90",
                      )}
                    />
                  )}
                  <span className={cn(rows.length === 0 && "pl-5")}>{l.label}</span>
                </span>
                {l.noLineReason && (
                  <span className="mt-1 block max-w-prose text-[11px] leading-relaxed text-muted-foreground">
                    {l.noLineReason}
                  </span>
                )}
              </td>
              <td className="hidden p-3 text-xs text-muted-foreground sm:table-cell">
                {l.scheduleCLine ? `Line ${l.scheduleCLine}` : "No line"}
              </td>
              <td className="p-3 text-right tabular-nums">
                {formatCents(displayCents(l, sectionKey))}
              </td>
              <td className="hidden p-3 text-right text-xs tabular-nums text-muted-foreground md:table-cell">
                {formatCents(
                  sectionKey === "income" || sectionKey === "excluded"
                    ? (priorByCode.get(l.code) ?? 0)
                    : Math.abs(priorByCode.get(l.code) ?? 0),
                )}
              </td>
            </tr>
            {open &&
              rows.slice(0, 100).map((r) => (
                <tr key={r.id} className="border-b bg-muted/20 text-xs">
                  <td className="py-1.5 pl-10 pr-3 text-muted-foreground">
                    {r.entry_date} &middot; {r.memo ?? r.source_kind}
                  </td>
                  <td className="hidden sm:table-cell" />
                  <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                    {formatCents(r.amount_cents)}
                  </td>
                  <td className="hidden md:table-cell" />
                </tr>
              ))}
            {open && rows.length > 100 && (
              <tr className="border-b bg-muted/20 text-xs">
                <td colSpan={4} className="py-1.5 pl-10 text-muted-foreground">
                  Showing the first 100 of {rows.length}. Export the CSV for all
                  of them.
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
