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
  type NeedsYouItem,
} from "@/pages/flipdesk/needs-you";
import { deadlineBucket, deadlineLabel } from "@/pages/flipdesk/post-sale-state";
import { useNeedsYou } from "@/hooks/use-needs-you";

// US-2934: one ranked list of everything eBay is waiting on.
//
// Six queues — returns, cancellations, inquiries, cases, payment disputes,
// expiring offers — each with its own clock, and no single place that said what
// runs out first. The cards below this one are still where the work gets done;
// this is the answer to "what do I open".
//
// US-3077 moved the merge into useNeedsYou() so the overview widget shows the
// same list from the same code. What is left here is this card's markup, and
// the relative anchors that only work on the page it renders on.
//
// ── DEADLINE, THEN MONEY ──────────────────────────────────────────────
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
  const { items, queues } = useNeedsYou();

  // The five case queues only. Offers refresh on a 90s interval against eBay
  // and can be slow; making the whole card wait on them would put a skeleton
  // over five queues that are already answered.
  const loading =
    queues.returns.isLoading ||
    queues.cancellations.isLoading ||
    queues.inquiries.isLoading ||
    queues.cases.isLoading ||
    queues.disputes.isLoading;

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
