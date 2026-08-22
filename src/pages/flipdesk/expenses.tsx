import { useId, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Wallet,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Download,
  Paperclip,
  Repeat,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TableLoadingSkeleton } from "@/components/ui/skeletons";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
} from "@/lib/constants";
import { downloadExpensesCsv } from "@/lib/csv-export";
import { todayLocalDate } from "@/lib/local-date";
import {
  MAX_RECEIPT_BYTES,
  RECEIPT_ACCEPT,
  deleteExpenseReceipt,
  expenseReceiptUrl,
  uploadExpenseReceipt,
} from "@/lib/expense-receipts";
import type { ExpenseRow, ExpenseCategory, ExpenseInsert } from "@/types/database";

function monthKey(d: string): string {
  return d.slice(0, 7); // yyyy-mm
}

/**
 * US-2228 AC2: open the receipt in a new tab.
 *
 * The blank tab is opened SYNCHRONOUSLY, before the await. The signed URL takes
 * a round trip to fetch, and by the time it arrives the click is no longer the
 * current user gesture, so a `window.open` there is treated as a popup and
 * blocked — the seller clicks View and nothing happens, with no error to explain
 * it. `opener` is nulled straight after, since the tab is about to hold a URL
 * that grants access to the file on its own.
 */
async function openReceipt(expenseId: string): Promise<void> {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  try {
    const url = await expenseReceiptUrl(expenseId);
    if (tab) tab.location.href = url;
    else window.location.href = url; // popup blocked outright — go in place
  } catch (err) {
    tab?.close();
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

/**
 * What to CALL one expense when a control has to name it (US-2450).
 *
 * An expense has no name of its own. The description is what the row prints and
 * it is optional, so the fallback is the other two things the row already
 * shows — its category and its date. Deliberately not a constant like "this
 * expense": three delete buttons in a column all announcing that is the defect
 * this exists to fix, and a column of expenses is exactly where it would land.
 *
 * Two expenses in one category on one day still sound alike. They also LOOK
 * alike, which makes that a row problem rather than a labelling one.
 */
function expenseName(e: ExpenseRow): string {
  const described = e.description?.trim();
  if (described) return described;
  return `${EXPENSE_CATEGORY_LABELS[e.category]} on ${e.spent_on}`;
}

export function FlipdeskExpensesPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  // US-2228 AC1/AC4: the row being edited (null = add), and the list filters.
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [filterCategory, setFilterCategory] = useState<ExpenseCategory | "all">("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ["expenses", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<ExpenseRow[]> => {
      const { data, error } = await supabase
        .from("flipdesk_expenses")
        .select("*")
        .order("spent_on", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ExpenseRow[];
    },
  });

  // US-2228 AC4: category + date-range filter, applied client-side over the
  // rows already loaded. `spent_on` is a plain yyyy-mm-dd date column and the
  // inputs produce the same format, so string comparison IS date comparison —
  // no parsing, and no timezone to get wrong. Both bounds are INCLUSIVE, which
  // is what "from the 1st to the 31st" means to someone doing a month's books.
  const filtered = useMemo(
    () =>
      expenses.filter((e) => {
        if (filterCategory !== "all" && e.category !== filterCategory) {
          return false;
        }
        if (fromDate && e.spent_on < fromDate) return false;
        if (toDate && e.spent_on > toDate) return false;
        return true;
      }),
    [expenses, filterCategory, fromDate, toDate],
  );

  const filterActive =
    filterCategory !== "all" || fromDate !== "" || toDate !== "";

  // Per-month totals, most recent first.
  //
  // Computed over the FILTERED rows on purpose: someone who has narrowed to a
  // category or a quarter is asking what that slice cost, and a summary that
  // kept showing the all-time figure beside a filtered table would be read as
  // the filtered total. The card is relabelled when a filter is on so the two
  // readings cannot be confused.
  const months = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) {
      const k = monthKey(e.spent_on);
      m.set(k, (m.get(k) ?? 0) + e.amount);
    }
    return Array.from(m.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const total = useMemo(
    () => filtered.reduce((s, e) => s + e.amount, 0),
    [filtered],
  );

  async function remove(id: string) {
    // US-2228 AC3: deleting a template stops the series. Say so, because the
    // months it already generated STAY (they were really paid) and a seller who
    // expected a clean sweep would otherwise think the delete had failed.
    const isTemplate = expenses.find((e) => e.id === id)?.recurs_monthly;
    const ok = await confirm({
      title: "Delete this expense?",
      description: isTemplate
        ? "This removes the entry and stops it repeating. The months already " +
          "added stay in your books. This can't be undone."
        : "This permanently removes the logged expense. This can't be undone.",
      confirmLabel: "Delete expense",
      destructive: true,
    });
    if (!ok) return;
    try {
      const { error } = await supabase
        .from("flipdesk_expenses")
        .delete()
        .eq("id", id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success("Expense deleted.");
    } catch (err) {
      toast.error(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Wallet}
        title="Operating expenses"
        subtitle="Overhead not tied to a single item — supplies, mileage, subscriptions. The real cost of running the operation."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => downloadExpensesCsv(filtered)}
              disabled={filtered.length === 0}
            >
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add expense
            </Button>
          </>
        }
      />

      {/* Monthly summary */}
      {months.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <div className="rounded-lg border bg-brand-navy/5 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {filterActive ? "Filtered total" : "All time"}
            </div>
            <div className="mt-1 text-xl font-bold tabular-nums">
              ${total.toFixed(2)}
            </div>
          </div>
          {months.slice(0, 3).map(([key, amount]) => (
            <div key={key} className="rounded-lg border p-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {monthLabel(key)}
              </div>
              <div className="mt-1 text-xl font-bold tabular-nums">
                ${amount.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* US-2228 AC4. Rendered only once there is something to filter — a
          filter bar above an empty table is furniture that teaches nothing. */}
      {expenses.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="exp-cat" className="text-xs">Category</Label>
            <Select
              value={filterCategory}
              onValueChange={(v) =>
                setFilterCategory(v as ExpenseCategory | "all")
              }
            >
              <SelectTrigger id="exp-cat" className="h-9 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {EXPENSE_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="exp-from" className="text-xs">From</Label>
            <Input
              id="exp-from"
              type="date"
              className="h-9 w-40"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="exp-to" className="text-xs">To</Label>
            <Input
              id="exp-to"
              type="date"
              className="h-9 w-40"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
          {filterActive && (
            <Button
              variant="ghost"
              className="h-9"
              onClick={() => {
                setFilterCategory("all");
                setFromDate("");
                setToDate("");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {filtered.length}
            {filterActive ? ` of ${expenses.length}` : ""} expenses
          </CardTitle>
          <CardDescription>
            Logged overhead. The Finances page subtracts this total from net
            profit in its Net After Overhead figure.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <TableLoadingSkeleton rows={6} columns={5} />
          ) : filtered.length === 0 ? (
            /* Two different empty states, because they need opposite advice.
               "Nothing logged yet" wants an Add button; "your filter matched
               nothing" wants the filter cleared, and telling that seller to log
               an expense would be answering a question they did not ask —
               worse, it reads as though their existing expenses are gone. */
            filterActive ? (
              <EmptyState
                icon={Wallet}
                title="No expenses match these filters"
                description="You have expenses logged, but none in this category or date range."
                action={{
                  label: "Clear filters",
                  onClick: () => {
                    setFilterCategory("all");
                    setFromDate("");
                    setToDate("");
                  },
                }}
              />
            ) : (
              <EmptyState
                icon={Wallet}
                title="No expenses logged"
                description="Track overhead like shipping supplies, mileage, and subscriptions to get a true profit picture."
                action={{
                  label: "Add expense",
                  onClick: () => setDialogOpen(true),
                  icon: Plus,
                }}
              />
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-sm">
                      {e.spent_on}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">
                          {EXPENSE_CATEGORY_LABELS[e.category]}
                        </Badge>
                        {/* US-2228 AC3. Two different facts, so two different
                            words: this row GENERATES copies, or this row IS
                            one. Labelling both "Recurring" would leave a seller
                            unable to tell which entry to untick to stop it. */}
                        {e.recurs_monthly && (
                          <Badge variant="secondary" title="A copy is added each month">
                            <Repeat className="mr-1 h-3 w-3" />
                            Monthly
                          </Badge>
                        )}
                        {e.recurrence_source_id && (
                          <span
                            className="text-xs text-muted-foreground"
                            title="Added automatically from a monthly expense"
                          >
                            auto
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {e.description ?? ""}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      ${e.amount.toFixed(2)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {/* Shown only when there is one to open. An always-present
                          greyed-out clip would say "receipts exist" without
                          saying whether THIS row has one, which is the only
                          question the column answers. */}
                      {e.receipt_path && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openReceipt(e.id)}
                          aria-label={`View the receipt for ${expenseName(e)}`}
                          title="View receipt"
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => {
                          setEditing(e);
                          setDialogOpen(true);
                        }}
                        aria-label={`Edit ${expenseName(e)}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => remove(e.id)}
                        aria-label={`Delete ${expenseName(e)}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ExpenseDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          // Drop the edit target on close so the next "Add" opens blank.
          if (!o) setEditing(null);
        }}
        expense={editing}
      />
    </div>
  );
}

// US-2228 AC1: one dialog for both add and edit.
//
// `expense` null = add, non-null = edit. A second dialog would have duplicated
// the validation, the permission check and the category list, and bookkeeping
// is exactly where those must not drift — an edit that skipped the
// manage_inventory check would let a workspace member rewrite the owner's
// numbers, and an edit that skipped the amount validation would let a typo
// through that the add path rejects.
function ExpenseDialog({
  open,
  onOpenChange,
  expense,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  expense: ExpenseRow | null;
}) {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId, can } = useWorkspace();
  const qc = useQueryClient();
  const [category, setCategory] = useState<ExpenseCategory>(
    "shipping_supplies",
  );
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  // US-2335: ids for this dialog's four label/control pairs. useId rather
  // than slugs — "Amount", "Date" and "Description" are common enough field
  // names to collide with another form on the same page.
  const categoryId = useId();
  const amountId = useId();
  const dateId = useId();
  const descriptionId = useId();
  const receiptId = useId();
  const [date, setDate] = useState(todayLocalDate());
  const [saving, setSaving] = useState(false);
  // US-2228 AC2. `pendingFile` is a receipt chosen but not yet uploaded — on the
  // ADD path there is no row to attach it to until the insert returns an id, so
  // the file waits here and goes up straight after. `receiptPath` mirrors the
  // row's column so the dialog can flip between "choose a file" and "attached"
  // without a refetch.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);
  // US-2228 AC3.
  const [recurs, setRecurs] = useState(false);
  const recursId = useId();
  // A generated copy is a real expense in its own right and can be corrected,
  // but it may not itself become a template — the database refuses that, and
  // offering the checkbox would be offering a save that fails.
  const isGeneratedCopy = Boolean(expense?.recurrence_source_id);

  // Seed from the row being edited, or reset to a blank add form. Keyed on the
  // dialog OPENING rather than on `expense` alone: reopening the add form after
  // an edit has to clear the previous row's values, and `expense` going null is
  // not on its own enough to distinguish that from a re-render.
  useEffect(() => {
    if (!open) return;
    setCategory(expense?.category ?? "shipping_supplies");
    setAmount(expense ? String(expense.amount) : "");
    setDescription(expense?.description ?? "");
    setDate(expense?.spent_on ?? todayLocalDate());
    setPendingFile(null);
    setReceiptPath(expense?.receipt_path ?? null);
    setRecurs(expense?.recurs_monthly ?? false);
  }, [open, expense]);

  function chooseFile(file: File | null) {
    if (file && file.size > MAX_RECEIPT_BYTES) {
      // The server enforces this too. Catching it here just saves the seller a
      // slow upload that was always going to be refused.
      toast.error("That file is over 10MB. Try a smaller photo or a PDF.");
      setPendingFile(null);
      return;
    }
    setPendingFile(file);
  }

  async function removeReceipt() {
    if (!expense) return;
    if (!can("manage_inventory")) {
      toast.error("You don't have permission to change expenses in this workspace.");
      return;
    }
    setReceiptBusy(true);
    try {
      await deleteExpenseReceipt(expense.id);
      setReceiptPath(null);
      await qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success("Receipt removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setReceiptBusy(false);
    }
  }

  async function save() {
    if (!user || !workspaceOwnerId) return;
    if (!can("manage_inventory")) {
      toast.error("You don't have permission to log expenses in this workspace.");
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    setSaving(true);
    try {
      const fields = {
        category,
        amount: amt,
        description: description.trim() || null,
        spent_on: date,
        // Never true on a generated copy — the CHECK constraint would reject the
        // write, and the checkbox is not offered there.
        recurs_monthly: isGeneratedCopy ? false : recurs,
      };
      let savedId = expense?.id ?? null;
      if (expense) {
        // No user_id in the patch: the row's owner never changes, and RLS
        // scopes the update by it. Sending it would be a chance to move a row
        // between workspaces, which nothing here should be able to do.
        const { error } = await supabase
          .from("flipdesk_expenses")
          .update(fields as never)
          .eq("id", expense.id);
        if (error) throw error;
      } else {
        const insert: ExpenseInsert = {
          user_id: workspaceOwnerId,
          ...fields,
        };
        // `.select("id").single()` so a receipt chosen during Add has something
        // to attach to. The insert used to discard the new row entirely.
        const { data, error } = await supabase
          .from("flipdesk_expenses")
          .insert(insert as never)
          .select("id")
          .single();
        if (error) throw error;
        savedId = (data as { id: string } | null)?.id ?? null;
      }

      // The receipt goes up AFTER the row is saved, and a failure here does not
      // undo the save. Losing a correctly entered expense because the upload
      // timed out would be the worse outcome: the number is the record, the
      // receipt is the proof, and the seller can re-attach the proof.
      if (pendingFile && savedId) {
        try {
          await uploadExpenseReceipt(savedId, pendingFile);
        } catch (err) {
          toast.error(
            `Expense saved, but the receipt didn't attach: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      await qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success(expense ? "Expense updated." : "Expense logged.");
      setAmount("");
      setDescription("");
      setPendingFile(null);
      onOpenChange(false);
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{expense ? "Edit expense" : "Add expense"}</DialogTitle>
          <DialogDescription>
            {expense
              ? "Correct a logged overhead cost."
              : "Log a business overhead cost."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={categoryId}>Category</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as ExpenseCategory)}
            >
              <SelectTrigger id={categoryId}>
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
          </div>
          <div className="space-y-1">
            <Label htmlFor={amountId}>Amount</Label>
            <Input
              id={amountId}
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={dateId}>Date</Label>
            <Input
              id={dateId}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={descriptionId}>Description</Label>
            <Input
              id={descriptionId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="optional"
            />
          </div>
          {/* US-2228 AC3. Hidden on a generated copy — see isGeneratedCopy. */}
          {!isGeneratedCopy && (
            <div className="flex items-start gap-2 rounded-md border px-3 py-2">
              <Checkbox
                id={recursId}
                checked={recurs}
                onCheckedChange={(v) => setRecurs(v === true)}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor={recursId} className="font-normal">
                  Repeats every month
                </Label>
                <p className="text-xs text-muted-foreground">
                  {/* Said plainly because the alternative reading — that this
                      row is a schedule rather than a real expense — would make
                      a seller think their books were double-counting. */}
                  This entry stays as it is. A copy is added each month on the
                  same day, starting next month. Untick to stop.
                </p>
              </div>
            </div>
          )}
          {isGeneratedCopy && (
            <p className="text-xs text-muted-foreground">
              Added automatically from a monthly expense. Edits here apply to
              this month only.
            </p>
          )}
          {/* US-2228 AC2. Two states, not a toggle: a row either has proof
              attached or it is waiting for one. */}
          {receiptPath ? (
            <div className="space-y-1">
              <span className="text-sm font-medium">Receipt</span>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">Attached</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() => expense && openReceipt(expense.id)}
                >
                  View
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-destructive"
                  onClick={removeReceipt}
                  disabled={receiptBusy}
                >
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor={receiptId}>Receipt</Label>
              <Input
                id={receiptId}
                type="file"
                accept={RECEIPT_ACCEPT}
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                Photo or PDF, up to 10MB. Uploaded when you save. Only you can
                open it.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
