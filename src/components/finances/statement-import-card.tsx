import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Link2, Link2Off, Upload } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { cn } from "@/lib/utils";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCents } from "@/lib/ledger-math";
import {
  guessColumnMap,
  parseStatementCsv,
  splitCsvLine,
  type ColumnMap,
  type ParseResult,
} from "@/lib/statement-import";
import {
  createExpenseFromRow,
  fetchCandidates,
  fetchRows,
  fetchSources,
  fetchSummary,
  ignoreRow,
  importRows,
  linkRow,
  saveSource,
  unlinkRow,
  type StatementRow,
} from "@/lib/statement-db";

// US-2994 — bank and card CSV import.
//
// A live feed means Plaid, which is a paid dependency and not this story's
// decision to make. A CSV is most of the value: every bank exports one, and
// matching it against the books catches both the expense logged twice and the
// one never logged at all.

export function StatementImportCard() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [map, setMap] = useState<Partial<ColumnMap>>({});
  const [busy, setBusy] = useState(false);

  const { data: sources = [] } = useQuery({
    queryKey: ["statement-sources", user?.id],
    enabled: !!user,
    queryFn: fetchSources,
  });

  const active = sourceId ?? sources[0]?.id ?? null;

  const { data: summary } = useQuery({
    queryKey: ["statement-summary", active],
    enabled: !!active,
    queryFn: () => fetchSummary(active as string),
  });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["statement-rows", active],
    enabled: !!active,
    queryFn: () => fetchRows(active as string, "unreviewed"),
  });

  async function onFile(file: File | null) {
    if (!file) return;
    const text = await file.text();
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    const headers = splitCsvLine(firstLine);
    // Remembered mapping wins; a guess only fills what is missing (AC1).
    const remembered = sources.find((s) => s.id === active)?.column_map ?? {};
    const guessed = guessColumnMap(headers);
    const merged = { ...guessed, ...remembered };
    setMap(merged);
    setParsed(
      merged.date && merged.description && (merged.amount || merged.debitColumn)
        ? parseStatementCsv(text, merged as ColumnMap)
        : { rows: [], skipped: [], headers },
    );
    // Keep the raw text so a mapping change can re-parse without re-picking.
    setRawText(text);
  }

  const [rawText, setRawText] = useState<string>("");

  function reparse(next: Partial<ColumnMap>) {
    setMap(next);
    if (!rawText) return;
    if (next.date && next.description && (next.amount || next.debitColumn)) {
      setParsed(parseStatementCsv(rawText, next as ColumnMap));
    }
  }

  async function doImport() {
    if (!user || !parsed) return;
    setBusy(true);
    try {
      let id = active;
      if (!id) {
        if (newName.trim() === "") {
          toast.error("Name the account first, so the mapping is remembered.");
          return;
        }
        id = await saveSource(user.id, newName.trim(), map);
        setSourceId(id);
      } else {
        // Remember the mapping for next time (AC1).
        const src = sources.find((s) => s.id === id);
        if (src) await saveSource(user.id, src.name, map, id);
      }

      const outcome = await importRows(user.id, id, parsed.rows);
      await qc.invalidateQueries({ queryKey: ["statement-sources"] });
      await qc.invalidateQueries({ queryKey: ["statement-rows"] });
      await qc.invalidateQueries({ queryKey: ["statement-summary"] });

      // AC4. Three counts, plus the skipped lines, which are the ones a seller
      // would otherwise never know about.
      const bits = [`${outcome.inserted} new`];
      if (outcome.alreadyKnown > 0) {
        bits.push(`${outcome.alreadyKnown} already imported`);
      }
      if (parsed.skipped.length > 0) {
        bits.push(`${parsed.skipped.length} skipped`);
      }
      toast.success(bits.join(", ") + ".");
      setParsed(null);
      setRawText("");
    } catch (err) {
      toastError(err, "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import from your bank</CardTitle>
        <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Export a CSV from your bank or card and drop it here. We match it
          against what you have already logged, so you can see what is missing
          and what got entered twice.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-end gap-3">
          {sources.length > 0 && (
            <div className="space-y-1">
              <Label htmlFor="si-source" className="text-xs">
                Account
              </Label>
              <Select
                value={active ?? ""}
                onValueChange={(v) => setSourceId(v)}
              >
                <SelectTrigger id="si-source" className="h-9 w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {sources.length === 0 && (
            <div className="space-y-1">
              <Label htmlFor="si-name" className="text-xs">
                Name this account
              </Label>
              <Input
                id="si-name"
                className="h-9 w-52"
                placeholder="Chase business card"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="si-file" className="text-xs">
              CSV file
            </Label>
            <Input
              id="si-file"
              type="file"
              accept=".csv,text/csv"
              className="h-9 w-64"
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>

        {parsed && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium">
              {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} read
            </p>

            {/* AC1: mapped once and remembered. Shown always, because a wrong
                guess produces a plausible-looking import rather than an error. */}
            <div className="grid gap-2 sm:grid-cols-3">
              {(["date", "description", "amount"] as const).map((field) => (
                <div key={field} className="space-y-1">
                  <Label className="text-xs capitalize">{field}</Label>
                  <Select
                    value={map[field] ?? ""}
                    onValueChange={(v) => reparse({ ...map, [field]: v })}
                  >
                    <SelectTrigger className="h-8" aria-label={`Which column holds ${field}`}>
                      <SelectValue placeholder="Pick a column" />
                    </SelectTrigger>
                    <SelectContent>
                      {parsed.headers.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {parsed.skipped.length > 0 && (
              <div>
                <p className="text-[13px] text-amber-700 dark:text-amber-400">
                  {parsed.skipped.length} line
                  {parsed.skipped.length === 1 ? "" : "s"} skipped
                </p>
                <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                  {parsed.skipped.slice(0, 5).map((s) => (
                    <li key={s.line}>
                      Line {s.line}: {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button onClick={doImport} disabled={busy || parsed.rows.length === 0}>
              <Upload className="mr-2 h-4 w-4" />
              {busy ? "Importing" : `Import ${parsed.rows.length}`}
            </Button>
          </div>
        )}

        {summary && (
          <p className="text-[13px] text-muted-foreground">
            {summary.total} row{summary.total === 1 ? "" : "s"} imported
            {" · "}
            {summary.matched} matched
            {" · "}
            {summary.unreviewed} to review
            {" · "}
            {summary.ignored} ignored
            {summary.unreviewed_spend_cents > 0 && (
              <>
                {" · "}
                {formatCents(summary.unreviewed_spend_cents)} unaccounted for
              </>
            )}
          </p>
        )}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length > 0 ? (
          <ul className="space-y-2">
            {rows.slice(0, 30).map((row) => (
              <StatementRowItem key={row.id} row={row} />
            ))}
          </ul>
        ) : active ? (
          <p className="text-[13px] text-muted-foreground">
            Nothing left to review on this account.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatementRowItem({ row }: { row: StatementRow }) {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("shipping_supplies");
  const [busy, setBusy] = useState(false);

  const { data: candidates = [] } = useQuery({
    queryKey: ["statement-candidates", row.id],
    enabled: open,
    queryFn: () => fetchCandidates(row.id),
  });

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["statement-rows"] });
    await qc.invalidateQueries({ queryKey: ["statement-summary"] });
  }

  async function doLink(expenseId: string) {
    setBusy(true);
    try {
      await linkRow(row.id, expenseId);
      await refresh();
      toast.success("Matched.");
    } catch (err) {
      toastError(err, "Couldn't match that.");
    } finally {
      setBusy(false);
    }
  }

  async function doCreate() {
    if (!user) return;
    setBusy(true);
    try {
      await createExpenseFromRow(user.id, row, category);
      await refresh();
      await qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success("Logged as an expense.");
    } catch (err) {
      toastError(err, "Couldn't log that.");
    } finally {
      setBusy(false);
    }
  }

  async function doIgnore() {
    setBusy(true);
    try {
      await ignoreRow(row.id, "Not a business expense");
      await refresh();
      toast.success("Ignored.");
    } catch (err) {
      toastError(err, "Couldn't ignore that.");
    } finally {
      setBusy(false);
    }
  }

  const isSpend = row.amount_cents < 0;

  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm">{row.description || "No description"}</p>
          <p className="text-[13px] text-muted-foreground">{row.posted_on}</p>
        </div>
        <span
          className={cn(
            "whitespace-nowrap text-sm font-medium tabular-nums",
            !isSpend && "text-emerald-700 dark:text-emerald-400",
          )}
        >
          {formatCents(row.amount_cents)}
        </span>
      </div>

      {!isSpend && (
        <p className="mt-1 text-[13px] text-muted-foreground">
          Money coming in. Probably a refund or a card payment, not an expense.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {isSpend && (
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            {open ? "Hide matches" : "Find a match"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={doIgnore} disabled={busy}>
          <Ban className="mr-1.5 h-3.5 w-3.5" />
          Not a business expense
        </Button>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          {candidates.length > 0 ? (
            <>
              <p className="text-[13px] text-muted-foreground">
                Already logged, same amount:
              </p>
              <ul className="space-y-1">
                {candidates.map((c) => (
                  <li
                    key={c.expense_id}
                    className="flex flex-wrap items-center justify-between gap-2 text-[13px]"
                  >
                    <span>
                      {c.spent_on} &middot; {c.description ?? "No description"}
                      {c.day_gap > 0 && (
                        <span className="ml-1 text-muted-foreground">
                          ({c.day_gap} day{c.day_gap === 1 ? "" : "s"} apart)
                        </span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Confirm the match for ${c.description ?? "the expense"} on ${c.spent_on}`}
                      disabled={busy}
                      onClick={() => doLink(c.expense_id)}
                    >
                      That's it
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Matching only records the link. It never changes what you
                entered.
              </p>
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Nothing logged with this amount. Add it:
            </p>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-8 w-52" aria-label="Category for the selected rows">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {EXPENSE_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={doCreate} disabled={busy}>
              Log it as new
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Undo control, used from the matched list. */
export function UnlinkButton({ rowId }: { rowId: string }) {
  const qc = useQueryClient();
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await unlinkRow(rowId);
          await qc.invalidateQueries({ queryKey: ["statement-rows"] });
          await qc.invalidateQueries({ queryKey: ["statement-summary"] });
          toast.success("Unmatched.");
        } catch (err) {
          toastError(err, "Couldn't unmatch.");
        }
      }}
    >
      <Link2Off className="mr-1.5 h-3.5 w-3.5" />
      Unmatch
    </Button>
  );
}
