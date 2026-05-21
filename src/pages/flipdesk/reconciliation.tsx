import { Scale } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const STEPS = [
  {
    title: "Ingest payout rows",
    body: "Two ingestion paths: live eBay webhooks via the edge service and CSV upload from the eBay seller dashboard. Both land in payout_imports.",
  },
  {
    title: "Auto-match to sales",
    body: "The reconciliation-matcher edge function matches payout rows to listings by listing ID and timestamp window. Matched rows update the linked sale row with per-fee breakdowns.",
  },
  {
    title: "Manual review queue",
    body: "Anything unmatched stays in a review queue with a side-by-side compare UI. Matches are an explicit user action — never silent.",
  },
  {
    title: "Per-item P&L",
    body: "Sale + shipping_collected − marketplace_fees − payment_processing_fees − shipping_cost − grading_cost − other_costs − cost_basis = net_profit.",
  },
];

export function FlipdeskReconciliationPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <Scale className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Close the loop between marketplace payouts and per-item profit.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How reconciliation works</CardTitle>
          <CardDescription>
            The flow runs in the consolidated edge service. Imports never
            auto-apply without a recorded match.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-xs font-bold text-white">
                  {i + 1}
                </div>
                <div>
                  <div className="font-semibold">{step.title}</div>
                  <div className="text-sm text-muted-foreground">{step.body}</div>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
