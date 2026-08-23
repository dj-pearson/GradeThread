import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { edgeFetch } from "@/lib/edge-fetch";
import type { FlipdeskPlanKey } from "@/lib/constants";
import type { BillingInterval } from "@/types/database";
import {
  AlertTriangle,
  CreditCard,
  Loader2,
  Plus,
  RefreshCcw,
  RotateCcw,
} from "lucide-react";

// ── BillingActionsCard (US-221) ─────────────────────────────────
//
// Embedded in /admin/users/:id. Three admin actions:
//   1. Change FlipDesk plan (Stripe subscription swap or cancel)
//   2. Comp grade credits (calls grant_grade_credits with reason='admin_grant')
//   3. Refund a charge (Stripe refund, webhook reverses credit pack ledger)
//
// All three audit-log automatically on the edge side.

interface AdminCharge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  refunded: boolean;
  amount_refunded: number;
  description: string | null;
  created: number;
  metadata: Record<string, string>;
  receipt_url: string | null;
}

interface AdminSubscriptionItem {
  price_id: string;
  unit_amount: number | null;
  interval: string | undefined;
  lookup_key: string | null;
}

interface AdminSubscription {
  id: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items: AdminSubscriptionItem[];
}

interface AdminPaymentsResponse {
  charges: AdminCharge[];
  /** The SELLER (FlipDesk) subscription. Unchanged meaning — US-2458. */
  subscription: AdminSubscription | null;
  /**
   * The BUYER (Guard / Connoisseur) subscription. US-2458: this card showed
   * only the seller one, so an agent opening a buyer subscriber saw no
   * subscription at all while their charges listed normally — the money half of
   * the conversation worked and the state half was blank.
   */
  buyerSubscription: AdminSubscription | null;
}

interface BillingActionsCardProps {
  userId: string;
  /** Current users.trial_ends_at (ISO) so the trial control can prefill. */
  currentTrialEndsAt?: string | null;
}

/** ISO timestamp → value for <input type="datetime-local"> (local, no seconds). */
function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

const PLAN_OPTIONS: FlipdeskPlanKey[] = ["free", "starter", "pro", "business"];

function dollars(cents: number, currency = "usd"): string {
  return `${currency.toUpperCase() === "USD" ? "$" : ""}${(cents / 100).toFixed(2)}`;
}

export function BillingActionsCard({
  userId,
  currentTrialEndsAt,
}: BillingActionsCardProps) {
  const qc = useQueryClient();
  const payments = useQuery({
    queryKey: ["admin-payments", userId],
    queryFn: async (): Promise<AdminPaymentsResponse> => {
      const res = await edgeFetch(`/api/admin/users/${userId}/payments`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load payments.");
      return json;
    },
    staleTime: 60_000,
  });

  // ── Plan change form ──
  const [newPlan, setNewPlan] = useState<FlipdeskPlanKey>("pro");
  const [newInterval, setNewInterval] = useState<BillingInterval>("monthly");
  // US-2335: ids for the plan-change pair.
  const newPlanId = useId();
  const newIntervalId = useId();

  const changePlan = useMutation({
    mutationFn: async () => {
      const res = await edgeFetch(`/api/admin/users/${userId}/change-plan`, {
        method: "POST",
        json: { plan: newPlan, interval: newInterval },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to change plan.");
      return json;
    },
    onSuccess: () => {
      toast.success(`Plan changed to ${newPlan}.`);
      qc.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
      qc.invalidateQueries({ queryKey: ["admin-payments", userId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Comp credits form ──
  const [credits, setCredits] = useState("");
  const [creditReason, setCreditReason] = useState("");

  const compCredits = useMutation({
    mutationFn: async () => {
      const num = Number.parseInt(credits, 10);
      const res = await edgeFetch(`/api/admin/users/${userId}/comp-credits`, {
        method: "POST",
        json: { credits: num, reason: creditReason },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to comp credits.");
      return json as { ok: true; newBalance: number };
    },
    onSuccess: (data) => {
      toast.success(`Granted ${credits} credits. New balance: ${data.newBalance}.`);
      setCredits("");
      setCreditReason("");
      qc.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Trial control (US-221: rare-exception trial_ends_at override) ──
  const [trialInput, setTrialInput] = useState(toDatetimeLocal(currentTrialEndsAt));

  const setTrial = useMutation({
    mutationFn: async (clear: boolean) => {
      const trial_ends_at = clear
        ? null
        : trialInput
          ? new Date(trialInput).toISOString()
          : null;
      const res = await edgeFetch(`/api/admin/users/${userId}/set-trial`, {
        method: "POST",
        json: { trial_ends_at },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to update trial.");
      return json as { ok: true; trial_ends_at: string | null };
    },
    onSuccess: (data) => {
      toast.success(
        data.trial_ends_at
          ? `Trial set to ${new Date(data.trial_ends_at).toLocaleString()}.`
          : "Trial cleared.",
      );
      setTrialInput(toDatetimeLocal(data.trial_ends_at));
      qc.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Refund mutation ──
  const refund = useMutation({
    mutationFn: async ({ chargeId, reason }: { chargeId: string; reason?: string }) => {
      const res = await edgeFetch(`/api/admin/charges/${chargeId}/refund`, {
        method: "POST",
        json: { reason },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Refund failed.");
      return json;
    },
    onSuccess: () => {
      toast.success("Refund issued.");
      qc.invalidateQueries({ queryKey: ["admin-payments", userId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5" />
          Billing actions
        </CardTitle>
        <CardDescription>
          Change plan, comp credits, or refund charges. All actions are logged
          to admin_audit_log + flipdesk_subscription_events.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── Change FlipDesk plan ── */}
        <section className="space-y-3">
          <div className="text-sm font-semibold">Change FlipDesk plan</div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={newPlanId}>New plan</Label>
              <Select value={newPlan} onValueChange={(v) => setNewPlan(v as FlipdeskPlanKey)}>
                <SelectTrigger id={newPlanId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={newIntervalId}>Interval</Label>
              <Select
                value={newInterval}
                onValueChange={(v) => setNewInterval(v as BillingInterval)}
                disabled={newPlan === "free"}
              >
                <SelectTrigger id={newIntervalId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                onClick={() => changePlan.mutate()}
                disabled={changePlan.isPending}
              >
                {changePlan.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Apply
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Free → paid is blocked (no card on file). Send the user a magic
            link to /dashboard/billing instead.
          </p>
        </section>

        <Separator />

        {/* ── Comp credits ── */}
        <section className="space-y-3">
          <div className="text-sm font-semibold">Comp grade credits</div>
          <div className="grid gap-2 sm:grid-cols-[120px_1fr_auto]">
            <div className="space-y-1">
              <Label htmlFor="bac-credits" className="text-xs">Credits</Label>
              <Input id="bac-credits"
                type="number"
                min="1"
                max="1000"
                value={credits}
                onChange={(e) => setCredits(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bac-reason-required" className="text-xs">Reason (required)</Label>
              <Input id="bac-reason-required"
                value={creditReason}
                onChange={(e) => setCreditReason(e.target.value)}
                placeholder="e.g. comp for stuck grade #..."
              />
            </div>
            <div className="flex items-end">
              <Button
                variant="outline"
                onClick={() => compCredits.mutate()}
                disabled={
                  compCredits.isPending ||
                  !credits ||
                  !creditReason.trim()
                }
              >
                {compCredits.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                <Plus className="mr-2 h-4 w-4" />
                Grant
              </Button>
            </div>
          </div>
        </section>

        <Separator />

        {/* ── Trial override (rare exception) ── */}
        <section className="space-y-3">
          <div className="text-sm font-semibold">Trial end date</div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <div className="space-y-1">
              <Label htmlFor="bac-trialendsat" className="text-xs">trial_ends_at</Label>
              <Input id="bac-trialendsat"
                type="datetime-local"
                value={trialInput}
                onChange={(e) => setTrialInput(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button
                variant="outline"
                onClick={() => setTrial.mutate(false)}
                disabled={setTrial.isPending || !trialInput}
              >
                {setTrial.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Set
              </Button>
            </div>
            <div className="flex items-end">
              <Button
                variant="ghost"
                onClick={() => setTrial.mutate(true)}
                disabled={setTrial.isPending}
              >
                Clear
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Rare exception — extends or clears the Pro trial window for this user.
          </p>
        </section>

        <Separator />

        {/* ── Recent charges + refund ── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Recent Stripe charges</div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => payments.refetch()}
              disabled={payments.isFetching}
            >
              <RefreshCcw
                className={`mr-2 h-3.5 w-3.5 ${
                  payments.isFetching ? "animate-spin" : ""
                }`}
              />
              Refresh
            </Button>
          </div>

          {payments.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : payments.error ? (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
              {(payments.error as Error).message}
            </div>
          ) : !payments.data || payments.data.charges.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No charges on file.
            </p>
          ) : (
            <ChargeList
              charges={payments.data.charges}
              refunding={refund.isPending}
              refundingChargeId={refund.variables?.chargeId}
              onRefund={(chargeId, reason) => refund.mutate({ chargeId, reason })}
            />
          )}

          {/* US-2458: BOTH products, each labelled. One shared block so the two
              cannot drift — an agent is comparing them, and a field rendered
              for one and not the other reads as "the buyer has no renewal
              date" rather than as a bug. */}
          {payments.data?.subscription && (
            <SubscriptionSummary
              label="FlipDesk subscription"
              subscription={payments.data.subscription}
            />
          )}
          {payments.data?.buyerSubscription && (
            <SubscriptionSummary
              label="Buyer subscription"
              subscription={payments.data.buyerSubscription}
            />
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * One subscription, labelled by product (US-2458).
 *
 * The label is REQUIRED rather than defaulted. Two subscriptions can be on
 * screen at once, and an unlabelled one is worse than none here — the agent is
 * about to act on whichever they believe they are looking at.
 */
function SubscriptionSummary({
  label,
  subscription,
}: {
  label: string;
  subscription: AdminSubscription;
}) {
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs">
      <div className="font-semibold">{label}</div>
      <div className="mt-1 text-muted-foreground">
        Status: <Badge variant="outline">{subscription.status}</Badge> · Renews{" "}
        {new Date(subscription.current_period_end * 1000).toLocaleDateString()}
        {subscription.cancel_at_period_end && (
          <Badge variant="destructive" className="ml-2">
            Canceling at period end
          </Badge>
        )}
      </div>
      {subscription.items.map((it) => (
        <div key={it.price_id} className="mt-0.5 text-muted-foreground">
          {it.lookup_key ?? it.price_id} · {dollars(it.unit_amount ?? 0)}/{it.interval}
        </div>
      ))}
    </div>
  );
}

interface ChargeListProps {
  charges: AdminCharge[];
  refunding: boolean;
  refundingChargeId?: string;
  onRefund: (chargeId: string, reason?: string) => void;
}

function ChargeList({ charges, refunding, refundingChargeId, onRefund }: ChargeListProps) {
  const [refundOpen, setRefundOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-2">
      {charges.map((ch) => {
        const refundable = ch.status === "succeeded" && !ch.refunded;
        const partiallyRefunded = ch.amount_refunded > 0 && !ch.refunded;
        const isOpen = refundOpen === ch.id;
        const isRefunding = refunding && refundingChargeId === ch.id;

        return (
          <div
            key={ch.id}
            className="rounded-md border border-border p-3 text-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">
                    {dollars(ch.amount, ch.currency)}
                  </span>
                  <Badge
                    variant={ch.refunded ? "destructive" : "outline"}
                    className="text-xs"
                  >
                    {ch.refunded
                      ? "Refunded"
                      : partiallyRefunded
                        ? "Partial refund"
                        : ch.status}
                  </Badge>
                  {ch.metadata?.product && (
                    <Badge variant="secondary" className="text-xs">
                      {ch.metadata.product}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(ch.created * 1000).toLocaleString()}
                </div>
                {ch.description && (
                  <div className="text-xs text-muted-foreground">
                    {ch.description}
                  </div>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                {ch.receipt_url && (
                  <a
                    href={ch.receipt_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-brand-navy underline hover:text-brand-navy/80 dark:text-foreground"
                  >
                    Receipt
                  </a>
                )}
                {refundable && !isOpen && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRefundOpen(ch.id)}
                    aria-label={`Refund the ${dollars(ch.amount, ch.currency)} charge`}
                    disabled={isRefunding}
                  >
                    <RotateCcw className="mr-1 h-3 w-3" />
                    Refund
                  </Button>
                )}
              </div>
            </div>
            {isOpen && (
              <div className="mt-3 space-y-2 border-t border-border pt-3">
                <Label htmlFor="bac-reason-optional" className="text-xs">Reason (optional)</Label>
                <Textarea id="bac-reason-optional"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Internal note — shown in Stripe metadata only."
                  rows={2}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRefundOpen(null);
                      setReason("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      onRefund(ch.id, reason || undefined);
                      setRefundOpen(null);
                      setReason("");
                    }}
                    disabled={isRefunding}
                  >
                    {isRefunding && (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    )}
                    Confirm refund
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
