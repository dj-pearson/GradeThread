import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LineChart, Trophy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

// US-547 (AC3): listing_gen prompt-version performance. Shows, per version, how
// many listings it produced, the per-field keep-rate sellers gave it, and its
// sell-through — the signals that drive A/B auto-promotion (AC2).

interface ListingPromptStat {
  promptVersion: string;
  isActive: boolean;
  inTrial: boolean;
  evalPassed: boolean | null;
  listings: number;
  sold: number;
  sellThrough: number;
  keptFields: number;
  totalFields: number;
  keepRate: number;
  score: number;
  perField: Record<string, { kept: number; total: number; keepRate: number }>;
}

interface AutoPromoteDecision {
  action: "promoted" | "trial_ended" | "insufficient_data" | "no_challenger";
  reason: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

export function ListingPromptPerformancePanel() {
  const queryClient = useQueryClient();
  const [promoting, setPromoting] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-listing-prompt-performance"],
    queryFn: async (): Promise<ListingPromptStat[]> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/admin/grading/listing-prompts/performance`,
        { headers: await authHeaders() },
      );
      if (!res.ok) throw new Error(`Performance data unavailable (${res.status})`);
      const body = (await res.json()) as { stats?: ListingPromptStat[] };
      return body.stats ?? [];
    },
    staleTime: 60 * 1000,
  });

  const stats = data ?? [];
  const hasChallenger = stats.some((s) => s.inTrial);

  async function runAutoPromote() {
    setPromoting(true);
    try {
      const res = await fetch(
        `${edgeApiUrl()}/api/admin/grading/listing-prompts/auto-promote`,
        { method: "POST", headers: await authHeaders() },
      );
      const body = (await res.json().catch(() => ({}))) as AutoPromoteDecision & {
        error?: string;
      };
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      const promoted = body.action === "promoted";
      toast[promoted ? "success" : "info"](
        promoted ? "Challenger promoted" : "Auto-promote evaluated",
        { description: body.reason },
      );
      queryClient.invalidateQueries({ queryKey: ["admin-listing-prompt-performance"] });
      queryClient.invalidateQueries({ queryKey: ["admin-ai-models"] });
    } catch (err) {
      toast.error("Auto-promote failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPromoting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <LineChart className="h-4 w-4 text-brand-navy dark:text-foreground" />
          Listing prompt performance
          {hasChallenger && <Badge variant="secondary">A/B trial live</Badge>}
        </CardTitle>
        <CardDescription>
          Each listing_gen prompt version, scored by the fields sellers keep vs
          change on publish and by sell-through. A trialed challenger that beats
          the champion on this combined score is auto-promoted (eval-gated).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Performance data is temporarily unavailable.
          </p>
        ) : stats.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No listing-prompt data yet. Acceptance is captured when an
            AI-generated draft is published.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Listings</TableHead>
                  <TableHead className="text-right">Keep rate</TableHead>
                  <TableHead className="text-right">Sell-through</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.map((s) => (
                  <TableRow key={s.promptVersion}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{s.promptVersion}</span>
                        {s.isActive && (
                          <Badge className="gap-1">
                            <Trophy className="h-3 w-3" /> Champion
                          </Badge>
                        )}
                        {s.inTrial && <Badge variant="secondary">Challenger</Badge>}
                        {s.evalPassed === false && (
                          <Badge variant="destructive">Eval failed</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.listings}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.totalFields > 0 ? pct(s.keepRate) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.listings > 0 ? `${pct(s.sellThrough)} (${s.sold})` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {s.score.toFixed(3)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            {hasChallenger
              ? "A challenger is in trial. Run auto-promote to resolve it once it has enough listings."
              : "No challenger in trial. Create a listing_gen candidate, pass its eval, then start a trial."}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={promoting || !hasChallenger}
            onClick={runAutoPromote}
          >
            <RefreshCw className={`mr-1 h-4 w-4 ${promoting ? "animate-spin" : ""}`} />
            Run auto-promote
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
