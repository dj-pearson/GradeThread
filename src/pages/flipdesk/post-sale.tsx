import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Loader2,
  PackageX,
  Paperclip,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useEbayCancellations,
  useEbayConnection,
  useEbayDecideCancellation,
  useEbayAddDisputeEvidence,
  useEbayDecideReturn,
  useEbayPaymentDisputes,
  useEbayRefundReturn,
  useEbayResolveDispute,
  useEbayReturns,
  type EbayCancellation,
  type EbayPaymentDispute,
  type EbayReturn,
} from "@/hooks/use-ebay";

// US-1043 + US-1049: web surface for post-sale issues — returns, cancellations,
// and payment disputes — with the accept/decline/refund/contest actions.
export function FlipdeskPostSalePage() {
  const { data: connection, isLoading: connLoading } = useEbayConnection();
  const connected = !!connection;

  if (connLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 py-12 text-center">
        <h1 className="text-xl font-semibold">Returns & Disputes</h1>
        <p className="text-sm text-muted-foreground">
          Connect your eBay account to manage returns, cancellations, and payment
          disputes.
        </p>
        <Button asChild variant="outline">
          <a href="/dashboard/flipdesk/marketplaces">Go to Marketplaces</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Returns & Disputes</h1>
        <p className="text-sm text-muted-foreground">
          Handle eBay returns, buyer cancellations, and payment disputes before
          their deadlines — responses are pushed straight to eBay.
        </p>
      </div>
      <DisputesCard />
      <ReturnsCard />
      <CancellationsCard />
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

// Days until a deadline (negative = overdue). null when no date.
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

function EmptyRow({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

// ── Payment disputes (most urgent — deadline-driven) ────────────────

function DisputesCard() {
  const qc = useQueryClient();
  const { data: disputes = [], isLoading } = useEbayPaymentDisputes();
  const resolve = useEbayResolveDispute();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(d: EbayPaymentDispute, action: "accept" | "contest") {
    setBusy(`${d.paymentDisputeId}:${action}`);
    try {
      let note: string | undefined;
      if (action === "contest") {
        note = window.prompt(
          "Add a short note for eBay explaining why you're contesting:",
        ) ?? undefined;
        if (note === undefined) {
          setBusy(null);
          return;
        }
      }
      await resolve.mutateAsync({
        disputeId: d.paymentDisputeId,
        action,
        note,
        orderId: d.orderId ?? undefined,
      });
      toast.success(
        action === "accept" ? "Dispute accepted (buyer refunded)." : "Dispute contested.",
      );
      await qc.invalidateQueries({ queryKey: ["ebay_payment_disputes"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="border-brand-red/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4 text-brand-red" />
          Payment disputes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : disputes.length === 0 ? (
          <EmptyRow text="No open payment disputes." />
        ) : (
          disputes.map((d) => {
            const days = daysUntil(d.respondByDate);
            const overdue = days != null && days < 0;
            return (
              <div
                key={d.paymentDisputeId}
                className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {d.reason?.replace(/_/g, " ") ?? "Payment dispute"}
                    </span>
                    {d.amount != null && (
                      <Badge variant="secondary">
                        {d.currency ?? "$"} {d.amount.toFixed(2)}
                      </Badge>
                    )}
                    {d.respondByDate && (
                      <Badge variant={overdue ? "destructive" : "outline"}>
                        {overdue
                          ? "Overdue"
                          : `Respond by ${fmtDate(d.respondByDate)}${
                              days != null ? ` (${days}d)` : ""
                            }`}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Order {d.orderId ?? "—"}
                    {d.buyerUsername ? ` · ${d.buyerUsername}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <EvidenceUploader disputeId={d.paymentDisputeId} disabled={!!busy} />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => act(d, "contest")}
                  >
                    {busy === `${d.paymentDisputeId}:contest` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <AlertTriangle className="mr-1 h-4 w-4" />
                    )}
                    Contest
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() => act(d, "accept")}
                  >
                    {busy === `${d.paymentDisputeId}:accept` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-1 h-4 w-4" />
                    )}
                    Accept &amp; refund
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

// Uploads a supporting-evidence image (e.g. a delivery scan) and attaches it to
// the dispute on eBay. The seller can attach evidence and then Contest.
function EvidenceUploader({
  disputeId,
  disabled,
}: {
  disputeId: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addEvidence = useEbayAddDisputeEvidence();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      await addEvidence.mutateAsync({ disputeId, file });
      toast.success("Evidence uploaded to eBay.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Evidence upload failed.");
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        onChange={onPick}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || addEvidence.isPending}
        onClick={() => inputRef.current?.click()}
      >
        {addEvidence.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Paperclip className="mr-1 h-4 w-4" />
        )}
        Evidence
      </Button>
    </>
  );
}

// ── Returns ─────────────────────────────────────────────────────────

function ReturnsCard() {
  const qc = useQueryClient();
  const { data: returns = [], isLoading } = useEbayReturns();
  const decide = useEbayDecideReturn();
  const refund = useEbayRefundReturn();
  const [busy, setBusy] = useState<string | null>(null);

  async function decideReturn(r: EbayReturn, decision: "approve" | "decline") {
    setBusy(`${r.returnId}:${decision}`);
    try {
      await decide.mutateAsync({
        returnId: r.returnId,
        decision,
        orderId: r.orderId ?? undefined,
      });
      toast.success(decision === "approve" ? "Return approved." : "Return declined.");
      await qc.invalidateQueries({ queryKey: ["ebay_returns"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function refundReturn(r: EbayReturn) {
    setBusy(`${r.returnId}:refund`);
    try {
      await refund.mutateAsync({ returnId: r.returnId, orderId: r.orderId ?? undefined });
      toast.success("Refund issued.");
      await qc.invalidateQueries({ queryKey: ["ebay_returns"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refund failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RotateCcw className="h-4 w-4" />
          Returns
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : returns.length === 0 ? (
          <EmptyRow text="No open returns." />
        ) : (
          returns.map((r) => (
            <div
              key={r.returnId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {r.reason?.replace(/_/g, " ") ?? "Return request"}
                  </span>
                  {r.state && <Badge variant="outline">{r.state.replace(/_/g, " ")}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Return {r.returnId} · opened {fmtDate(r.creationDate)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => decideReturn(r, "decline")}
                >
                  {busy === `${r.returnId}:decline` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="mr-1 h-4 w-4" />
                  )}
                  Decline
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => decideReturn(r, "approve")}
                >
                  {busy === `${r.returnId}:approve` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-1 h-4 w-4" />
                  )}
                  Approve
                </Button>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => refundReturn(r)}
                >
                  {busy === `${r.returnId}:refund` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-1 h-4 w-4" />
                  )}
                  Refund
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Cancellations ───────────────────────────────────────────────────

function CancellationsCard() {
  const qc = useQueryClient();
  const { data: cancellations = [], isLoading } = useEbayCancellations();
  const decide = useEbayDecideCancellation();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(ca: EbayCancellation, action: "approve" | "reject") {
    setBusy(`${ca.cancelId}:${action}`);
    try {
      await decide.mutateAsync({
        cancelId: ca.cancelId,
        action,
        orderId: ca.orderId ?? undefined,
      });
      toast.success(action === "approve" ? "Cancellation approved." : "Cancellation rejected.");
      await qc.invalidateQueries({ queryKey: ["ebay_cancellations"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackageX className="h-4 w-4" />
          Cancellation requests
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : cancellations.length === 0 ? (
          <EmptyRow text="No open cancellation requests." />
        ) : (
          cancellations.map((ca) => (
            <div
              key={ca.cancelId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {ca.reason?.replace(/_/g, " ") ?? "Cancellation"}
                  </span>
                  {ca.requestorType && (
                    <Badge variant="outline">{ca.requestorType.toLowerCase()}</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Order {ca.orderId ?? "—"} · {fmtDate(ca.creationDate)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => act(ca, "reject")}
                >
                  {busy === `${ca.cancelId}:reject` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="mr-1 h-4 w-4" />
                  )}
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!!busy}
                  onClick={() => act(ca, "approve")}
                >
                  {busy === `${ca.cancelId}:approve` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-1 h-4 w-4" />
                  )}
                  Approve &amp; cancel
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
