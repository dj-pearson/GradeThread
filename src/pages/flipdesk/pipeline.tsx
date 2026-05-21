import { LayoutGrid } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FLIPDESK_PIPELINE } from "@/lib/constants";

export function FlipdeskPipelinePage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <LayoutGrid className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">FlipDesk Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Kanban view of every item moving from sourced to completed.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            Drag-and-drop Kanban with WIP limits, aging indicators, batch
            operations, and per-status filters. Statuses below are the
            canonical pipeline.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {FLIPDESK_PIPELINE.map((step) => (
              <div
                key={step.status}
                className="rounded-lg border bg-card p-4"
              >
                <div className="mb-2 flex items-center justify-between">
                  <Badge variant="outline" className="font-mono text-xs">
                    {step.status}
                  </Badge>
                </div>
                <div className="text-sm font-semibold">{step.label}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Next: {step.nextAction}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
