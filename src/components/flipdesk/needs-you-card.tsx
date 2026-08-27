import { useMemo } from "react";
import { Inbox } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  KIND_LABEL,
  needsYouKey,
  rankNeedsYou,
  type NeedsYouItem,
} from "@/pages/flipdesk/needs-you";
import { deadlineBucket, deadlineLabel } from "@/pages/flipdesk/post-sale-state";
import {
  useEbayBestOffers,
  useEbayCancellations,
  useEbayCases,
  useEbayInquiries,
  useEbayPaymentDisputes,
  useEbayReturns,
} from "@/hooks/use-ebay";
import { isClosedCase, splitByOpenState } from "@/pages/flipdesk/post-sale-state";

// US-2934: one ranked list of everything eBay is waiting on.
//
// Six queues — returns, cancellations, inquiries, cases, payment disputes,
// expiring offers — each with its own clock, and no single place that said what
// runs out first. The cards below this one are still where the work gets done;
// this is the answer to "what do I open".
//
// ── DEADLINE, THEN MONEY ────────────────────────────────────────────────────
//
// The ranking lives in a pure module with its own tests. The rule worth
// repeating here is the one every "sort by value" version of this screen gets
// backwards: a $200 dispute due next week is less urgent than a $12 return due
// today, because only the deadline can be lost by waiting.

const KIND_HREF: Record<NeedsYouItem["kind"], string> = {
  case: "#ebay-cases",
  inquiry: "#item-not-received",
  dispute: "#payment-disputes",
  return: "#returns",
  cancellation: "#cancellations",
  offer: "/dashboard/flipdesk/offers",
};

function money(cents: number | null): string | null {
  return cents == null ? null : `$${(cents / 100).toFixed(2)}`;
}

export function NeedsYouCard() {
  const returns = useEbayReturns();
  const cancellations = useEbayCancellations();
  const inquiries = useEbayInquiries();
  const cases = useEbayCases();
  const disputes = useEbayPaymentDisputes();
  const offers = useEbayBestOffers();

  const loading =
    returns.isLoading ||
    cancellations.isLoading ||
    inquiries.isLoading ||
    cases.isLoading ||
    disputes.isLoading;

  const items = useMemo(() => {
    const out: NeedsYouItem[] = [];
    for (const r of splitByOpenState(returns.data ?? []).open) {
      out.push({
        kind: "return",
        id: r.returnId,
        subject: r.reason?.replace(/_/g, " ") ?? `Return ${r.returnId}`,
        deadline: r.respondBy ?? null,
        amountCents: null,
        action: "Approve, decline or refund",
      });
    }
    for (const ca of splitByOpenState(cancellations.data ?? []).open) {
      out.push({
        kind: "cancellation",
        id: ca.cancelId,
        subject: ca.reason?.replace(/_/g, " ") ?? `Order ${ca.orderId ?? ca.cancelId}`,
        // eBay's cancellation summary carries no deadline. Null rather than an
        // invented one — see the ranking module's undated-last rule.
        deadline: null,
        amountCents: null,
        action: "Approve or reject",
      });
    }
    for (const q of splitByOpenState(inquiries.data ?? []).open) {
      out.push({
        kind: "inquiry",
        id: q.inquiryId,
        subject: `Order ${q.orderId ?? q.inquiryId}`,
        deadline: q.respondBy,
        amountCents: null,
        action: "Add tracking",
      });
    }
    for (const k of splitByOpenState(cases.data ?? []).open) {
      out.push({
        kind: "case",
        id: k.caseId,
        subject: k.reason?.replace(/_/g, " ") ?? `Case ${k.caseId}`,
        deadline: k.respondBy,
        amountCents: k.amountCents,
        action: "Respond before eBay decides",
      });
    }
    for (const d of splitByOpenState(disputes.data ?? []).open) {
      out.push({
        kind: "dispute",
        id: d.paymentDisputeId,
        subject: d.reason?.replace(/_/g, " ") ?? `Order ${d.orderId ?? d.paymentDisputeId}`,
        deadline: d.respondByDate ?? null,
        amountCents: d.amount != null ? Math.round(d.amount * 100) : null,
        action: "Accept or contest",
      });
    }
    // Offers belong here for one reason: they expire, and an unanswered offer
    // is not a deferred decision, it is a lost sale.
    for (const o of offers.data ?? []) {
      if (o.status && isClosedCase({ state: o.status })) continue;
      out.push({
        kind: "offer",
        id: o.bestOfferId,
        subject: o.itemTitle || o.itemId,
        deadline: o.expiresAt ?? null,
        amountCents: o.price != null ? Math.round(o.price * 100) : null,
        action: "Accept, counter or decline",
      });
    }
    return rankNeedsYou(out);
  }, [
    returns.data,
    cancellations.data,
    inquiries.data,
    cases.data,
    disputes.data,
    offers.data,
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Inbox className="h-4 w-4" />
          Needs you
          {items.length > 0 && <Badge variant="secondary">{items.length}</Badge>}
        </CardTitle>
        <CardDescription>
          Everything eBay is waiting on, soonest deadline first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : items.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={Inbox}
            title="Nothing is waiting on you."
            description="eBay cases only — GradeThread does not read your other marketplaces."
          />
        ) : (
          <ul className="space-y-1">
            {items.map((it) => {
              const bucket = deadlineBucket(it.deadline);
              const label = deadlineLabel(it.deadline);
              const amount = money(it.amountCents);
              return (
                <li key={needsYouKey(it)}>
                  <a
                    href={KIND_HREF[it.kind]}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm hover:bg-muted/50"
                  >
                    <Badge variant="outline" className="text-[10px]">
                      {KIND_LABEL[it.kind]}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{it.subject}</span>
                    {amount && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {amount}
                      </span>
                    )}
                    {/* Text, never colour alone — and nothing at all when we
                        cannot read a deadline, so a parse failure can't look
                        like a case already lost. */}
                    {label && (
                      <Badge
                        variant={
                          bucket === "overdue" || bucket === "imminent"
                            ? "destructive"
                            : "outline"
                        }
                        className="text-[10px]"
                      >
                        {label}
                      </Badge>
                    )}
                    <span className="w-full text-xs text-muted-foreground">{it.action}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
