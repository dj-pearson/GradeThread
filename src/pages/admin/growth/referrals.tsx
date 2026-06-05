import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { useAuth } from "@/hooks/use-auth";
import { Gift, Users, CheckCircle2, Clock } from "lucide-react";

interface ReferralOverview {
  funnel: { codes: number; total: number; pending: number; qualified: number; granted: number };
  rewards: { referrer_credits: number; referred_credits: number };
  top_referrers: { user_id: string; email: string; total: number; granted: number }[];
  queue: {
    id: string;
    code: string;
    reward_status: string;
    created_at: string;
    referrer_email: string;
    referred_email: string;
  }[];
}

function Stat({ icon: Icon, label, value }: { icon: typeof Gift; label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

export function GrowthReferralsPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);
  const [working, setWorking] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["growth-referrals"],
    queryFn: async (): Promise<ReferralOverview> => {
      const res = await edgeFetch("/api/admin/growth/referrals");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load referrals");
      return json;
    },
    refetchInterval: 30_000,
  });

  async function grant(id: string) {
    setWorking(true);
    try {
      const res = await edgeFetch(`/api/admin/growth/referrals/${id}/grant`, {
        method: "POST",
        json: {},
        silentGate: true,
      });
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if (j?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => grant(id));
          setStepUpOpen(true);
          return;
        }
        toast.error(j?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j.error ?? "Grant failed");
        return;
      }
      toast.success("Reward granted to both parties");
      qc.invalidateQueries({ queryKey: ["growth-referrals"] });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Gift className="h-6 w-6 text-brand-red" /> Referrals
        </h1>
        <p className="text-muted-foreground">
          Organic acquisition loop. Rewards are paid as grade credits to both parties on approval.
        </p>
      </div>

      {isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat icon={Users} label="Referral codes" value={data.funnel.codes} />
            <Stat icon={Gift} label="Total referred" value={data.funnel.total} />
            <Stat icon={Clock} label="Pending" value={data.funnel.pending} />
            <Stat icon={Clock} label="Qualified" value={data.funnel.qualified} />
            <Stat icon={CheckCircle2} label="Granted" value={data.funnel.granted} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top referrers</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.top_referrers.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No referrals yet.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead className="text-right">Referred</TableHead>
                        <TableHead className="text-right">Granted</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.top_referrers.map((r) => (
                        <TableRow key={r.user_id}>
                          <TableCell className="text-sm">{r.email}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.granted}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Reward queue
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    +{data.rewards.referrer_credits}/+{data.rewards.referred_credits} credits
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.queue.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Nothing awaiting a grant.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Referrer → Referred</TableHead>
                        <TableHead>Status</TableHead>
                        {isSuperAdmin && <TableHead className="text-right">Action</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.queue.map((q) => (
                        <TableRow key={q.id}>
                          <TableCell className="text-xs">
                            <div>{q.referrer_email}</div>
                            <div className="text-muted-foreground">→ {q.referred_email}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{q.reward_status}</Badge>
                          </TableCell>
                          {isSuperAdmin && (
                            <TableCell className="text-right">
                              <Button size="sm" disabled={working} onClick={() => grant(q.id)}>
                                Grant
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}
