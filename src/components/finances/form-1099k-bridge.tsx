import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Plus, Printer, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { escapeHtml } from "@/lib/escape-html";
import { cn } from "@/lib/utils";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCents } from "@/lib/ledger-math";
import { dollarInputToCents } from "@/lib/tax-profile";
import {
  bridgeAddsUp,
  bridgeRows,
  deleteForm,
  fetchBridge,
  fetchForms,
  fetchPlatformsWithSales,
  saveForm,
  varianceCauses,
} from "@/lib/form-1099k";

// US-2988 — the bridge from the number on the form to what it actually left.
//
// A 1099-K is ALWAYS a calendar year, whatever the seller's fiscal year, so
// this screen takes a year and never a fiscal period. Mixing the two produces a
// variance that is pure artefact and sends a seller hunting for sales that were
// never missing.

function platformLabel(p: string): string {
  return (MARKETPLACE_LABELS as Record<string, string>)[p] ?? p;
}

export function Form1099kBridge() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const confirm = useConfirm();
  // Default to LAST year: a 1099-K arrives in January for the year just ended,
  // which is the only year anyone opens this screen to reconcile.
  const [year, setYear] = useState(() => new Date().getFullYear() - 1);
  const [platform, setPlatform] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: platforms = [], isLoading: platformsLoading } = useQuery({
    queryKey: ["1099k-platforms", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchPlatformsWithSales(year),
  });

  const active = platform ?? platforms[0]?.platform ?? null;

  const { data: bridge, isLoading } = useQuery({
    queryKey: ["1099k-bridge", user?.id, active, year],
    enabled: !!user && !!active,
    queryFn: () => fetchBridge(active as string, year),
  });

  const { data: forms = [] } = useQuery({
    queryKey: ["1099k-forms", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchForms(year),
  });

  const rows = bridge ? bridgeRows(bridge) : [];
  const causes = bridge ? varianceCauses(bridge) : [];
  const existingForm = forms.find((f) => f.platform === active);

  async function removeForm(id: string) {
    const ok = await confirm({
      title: "Remove this 1099-K?",
      description:
        "This removes what you typed in. Your sales and the rest of your books are untouched.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteForm(id);
      await qc.invalidateQueries({ queryKey: ["1099k-forms"] });
      await qc.invalidateQueries({ queryKey: ["1099k-bridge"] });
      toast.success("1099-K removed.");
    } catch (err) {
      toastError(err, "Couldn't remove it.");
    }
  }

  function printBridge() {
    if (!bridge) return;
    const win = window.open("", "_blank");
    if (!win) {
      toast.error("Allow popups to print this.");
      return;
    }
    const body = rows
      .map(
        (r) => `<tr class="${r.kind}">
          <td>${escapeHtml(r.label)}<div class="src">${escapeHtml(r.source)}</div></td>
          <td class="num">${escapeHtml(formatCents(r.cents))}</td>
        </tr>`,
      )
      .join("");
    const causeHtml = causes.length
      ? `<h2>What the difference could be</h2><ul>${causes
          .map(
            (c) =>
              `<li><strong>${escapeHtml(c.title)}</strong><br>${escapeHtml(c.body)}</li>`,
          )
          .join("")}</ul>`
      : "";
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>1099-K reconciliation</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:40px;color:#1A1A2E;max-width:44em}
h1{color:#0F3460;margin:0 0 4px}h2{color:#0F3460;font-size:15px;margin-top:28px}
.period{color:#666;margin-bottom:20px}
table{width:100%;border-collapse:collapse}
td{padding:8px 10px;border-bottom:1px solid #e5e5e5;font-size:13px;vertical-align:top}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.src{color:#777;font-size:11px;margin-top:2px}
tr.start td,tr.total td{font-weight:700}
tr.total td{border-top:2px solid #0F3460}
tr.variance td{color:#8a5a00}
ul{padding-left:18px}li{font-size:13px;margin-bottom:8px}
.footer{margin-top:32px;font-size:11px;color:#888;border-top:1px solid #ddd;padding-top:10px}
@media print{body{margin:16px}}
</style></head><body>
<h1>1099-K reconciliation</h1>
<div class="period">${escapeHtml(platformLabel(bridge.platform))} &middot; tax year ${bridge.tax_year} (January to December)${
      bridge.payer_name ? ` &middot; ${escapeHtml(bridge.payer_name)}` : ""
    }${bridge.payer_tin_last4 ? ` (TIN ending ${escapeHtml(bridge.payer_tin_last4)})` : ""}</div>
<table>${body}</table>
${causeHtml}
<div class="footer">Running costs that are not tied to one platform are on the profit and loss statement, not here.<br>
Generated by GradeThread on ${escapeHtml(new Date().toLocaleDateString())}. GradeThread does the arithmetic. It does not give tax advice.</div>
</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 500);
  }

  const years = [0, 1, 2, 3].map((n) => new Date().getFullYear() - n);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">1099-K reconciliation</CardTitle>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            The form shows everything buyers paid, before a single fee. This
            walks from that number down to what you actually kept.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="h-9 w-28" aria-label="Tax year for the 1099-K reconciliation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {existingForm ? "Edit form" : "Add a 1099-K"}
          </Button>
          {bridge && (
            <Button size="sm" variant="outline" onClick={printBridge}>
              <Printer className="mr-2 h-4 w-4" />
              Print
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {platformsLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : platforms.length === 0 ? (
          <EmptyState
            title={`No sales recorded in ${year}`}
            description="There is nothing to reconcile a 1099-K against for this year. Pick another year, or import your sales first."
          />
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {platforms.map((p) => (
                <Button
                  key={p.platform}
                  size="sm"
                  variant={active === p.platform ? "default" : "outline"}
                  onClick={() => setPlatform(p.platform)}
                >
                  {platformLabel(p.platform)}
                  <span className="ml-2 text-xs opacity-70">{p.sale_count}</span>
                </Button>
              ))}
            </div>

            {isLoading || !bridge ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <>
                {!bridge.form_present && (
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    You have not entered a 1099-K for {platformLabel(bridge.platform)}{" "}
                    yet. This shows what your own records add up to, which is
                    what the form should say.
                  </p>
                )}

                <table className="w-full text-sm">
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.key}
                        className={cn(
                          "border-b last:border-b-0",
                          (r.kind === "start" || r.kind === "total") &&
                            "font-semibold",
                          r.kind === "variance" &&
                            "text-amber-700 dark:text-amber-400",
                        )}
                      >
                        <td className="py-2.5 pr-3">
                          {r.label}
                          <span className="mt-0.5 block max-w-prose text-[11px] font-normal leading-relaxed text-muted-foreground">
                            {r.source}
                          </span>
                        </td>
                        <td className="py-2.5 text-right align-top tabular-nums">
                          {formatCents(r.cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* The screen checks its own arithmetic before asking anyone to
                    trust it. A bridge that does not reach its own total is how
                    a seller stops believing every other number in the app. */}
                {!bridgeAddsUp(rows) && (
                  <p className="text-[13px] leading-relaxed text-brand-red-text">
                    These lines do not add up to the total, which is a bug on our
                    side. Don't use this figure. Please tell us.
                  </p>
                )}

                {causes.length > 0 ? (
                  <div className="rounded-md border p-4">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400" />
                      {formatCents(Math.abs(bridge.variance_cents))} we cannot
                      account for
                    </p>
                    <ul className="mt-3 space-y-3">
                      {causes.map((c) => (
                        <li key={c.title}>
                          <p className="text-[13px] font-medium">{c.title}</p>
                          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
                            {c.body}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : bridge.form_present ? (
                  <p className="flex items-center gap-2 text-[13px] text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    The form and your records agree to the cent.
                  </p>
                ) : null}

                {existingForm && (
                  <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
                    <span>
                      Form from {existingForm.payer_name ?? "unnamed payer"}
                      {existingForm.payer_tin_last4
                        ? `, TIN ending ${existingForm.payer_tin_last4}`
                        : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeForm(existingForm.id)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Running costs that are not tied to one platform live on the profit and
          loss statement, not here. GradeThread does the arithmetic. It does not
          give tax advice.
        </p>
      </CardContent>

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        year={year}
        platform={active}
        existing={existingForm}
      />
    </Card>
  );
}

function FormDialog({
  open,
  onOpenChange,
  year,
  platform,
  existing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  year: number;
  platform: string | null;
  existing: { gross_cents: number; payer_name: string | null; payer_tin_last4: string | null; transaction_count: number | null; received_on: string | null } | undefined;
}) {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [gross, setGross] = useState("");
  const [payer, setPayer] = useState("");
  const [tin, setTin] = useState("");
  const [count, setCount] = useState("");
  const [saving, setSaving] = useState(false);

  // Seed from the existing form each time the dialog opens, so re-opening after
  // a save shows what was saved rather than a blank.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const key = `${platform}-${year}`;
  if (open && seededFor !== key) {
    setSeededFor(key);
    setGross(existing ? (existing.gross_cents / 100).toFixed(2) : "");
    setPayer(existing?.payer_name ?? "");
    setTin(existing?.payer_tin_last4 ?? "");
    setCount(existing?.transaction_count ? String(existing.transaction_count) : "");
  }
  if (!open && seededFor !== null) setSeededFor(null);

  const grossCents = dollarInputToCents(gross);
  const tinValid = tin === "" || /^[0-9]{4}$/.test(tin);

  async function save() {
    if (!user || !platform || grossCents === null) return;
    setSaving(true);
    try {
      await saveForm(user.id, {
        platform,
        tax_year: year,
        gross_cents: grossCents,
        payer_name: payer.trim() || null,
        payer_tin_last4: tin.trim() || null,
        transaction_count: count.trim() ? Number(count) : null,
        received_on: null,
        notes: null,
      });
      await qc.invalidateQueries({ queryKey: ["1099k-forms"] });
      await qc.invalidateQueries({ queryKey: ["1099k-bridge"] });
      toast.success("1099-K saved.");
      onOpenChange(false);
    } catch (err) {
      toastError(err, "Couldn't save the form.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {platform ? platformLabel(platform) : ""} 1099-K for {year}
          </DialogTitle>
          <DialogDescription>
            Copy the figures off the form. Box 1a is the gross amount.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="k-gross">Gross amount (box 1a)</Label>
            <Input
              id="k-gross"
              inputMode="decimal"
              placeholder="0.00"
              value={gross}
              onChange={(e) => setGross(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="k-count">Number of transactions (box 3)</Label>
            <Input
              id="k-count"
              inputMode="numeric"
              placeholder="Optional"
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Worth entering. If this disagrees with our sale count, it tells you
              straight away whether the difference is missing sales or wrong
              amounts.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="k-payer">Payer name</Label>
            <Input
              id="k-payer"
              placeholder="Optional"
              value={payer}
              onChange={(e) => setPayer(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="k-tin">Payer TIN, last four digits</Label>
            <Input
              id="k-tin"
              inputMode="numeric"
              maxLength={4}
              placeholder="Optional"
              value={tin}
              onChange={(e) => setTin(e.target.value)}
            />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Four digits only, for your own records. We never ask for the full
              number and could not store it if you typed it.
            </p>
            {!tinValid && (
              <p className="text-[13px] text-brand-red-text">
                Four digits, or leave it blank.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving || grossCents === null || !tinValid || !platform}
          >
            {saving ? "Saving" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
