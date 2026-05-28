import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Wallet, Plus, Trash2, Loader2, Download } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
} from "@/lib/constants";
import { downloadExpensesCsv } from "@/lib/csv-export";
import type { ExpenseRow, ExpenseCategory, ExpenseInsert } from "@/types/database";

function monthKey(d: string): string {
  return d.slice(0, 7); // yyyy-mm
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

export function FlipdeskExpensesPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

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

  // Per-month totals, most recent first.
  const months = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of expenses) {
      const k = monthKey(e.spent_on);
      m.set(k, (m.get(k) ?? 0) + e.amount);
    }
    return Array.from(m.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [expenses]);

  const total = useMemo(
    () => expenses.reduce((s, e) => s + e.amount, 0),
    [expenses],
  );

  async function remove(id: string) {
    try {
      const { error } = await supabase
        .from("flipdesk_expenses")
        .delete()
        .eq("id", id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["expenses"] });
    } catch (err) {
      toast.error(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
            <Wallet className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Operating expenses
            </h1>
            <p className="text-sm text-muted-foreground">
              Overhead not tied to a single item — supplies, mileage,
              subscriptions. The real cost of running the operation.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => downloadExpensesCsv(expenses)}
            disabled={expenses.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add expense
          </Button>
        </div>
      </div>

      {/* Monthly summary */}
      {months.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <div className="rounded-lg border bg-brand-navy/5 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              All time
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

      <Card>
        <CardHeader>
          <CardTitle>{expenses.length} expenses</CardTitle>
          <CardDescription>
            Logged overhead. These reduce true net profit beyond per-item P&amp;L.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : expenses.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No expenses logged. Click <strong>Add expense</strong> to start
              tracking overhead.
            </div>
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
                {expenses.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-sm">
                      {e.spent_on}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {EXPENSE_CATEGORY_LABELS[e.category]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {e.description ?? ""}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      ${e.amount.toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => remove(e.id)}
                        aria-label="Delete expense"
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

      <AddExpenseDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

function AddExpenseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId, can } = useWorkspace();
  const qc = useQueryClient();
  const [category, setCategory] = useState<ExpenseCategory>(
    "shipping_supplies",
  );
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

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
      const insert: ExpenseInsert = {
        user_id: workspaceOwnerId,
        category,
        amount: amt,
        description: description.trim() || null,
        spent_on: date,
      };
      const { error } = await supabase
        .from("flipdesk_expenses")
        .insert(insert as never);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success("Expense logged.");
      setAmount("");
      setDescription("");
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
          <DialogTitle>Add expense</DialogTitle>
          <DialogDescription>
            Log a business overhead cost.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Category</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as ExpenseCategory)}
            >
              <SelectTrigger>
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
            <Label>Amount</Label>
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label>Date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="optional"
            />
          </div>
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
