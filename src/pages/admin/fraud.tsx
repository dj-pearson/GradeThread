import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ShieldAlert,
  Gauge,
  Users,
  CreditCard,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { edgeFetch } from "@/lib/edge-fetch";
import { PageHeader } from "@/components/ui/page-header";

// US-591: cross-account abuse / fraud dashboard. Read-only aggregate view over
// four signal families (repeat offenders, velocity / rate-limit abuse,
// duplicate-account / shared-payment, chargebacks). Every actionable row links
// to /admin/users/:id, which hosts the audited per-user actions (suspend /
// credit / impersonate) — so this complements per-submission moderation rather
// than duplicating it. Data comes from GET /api/admin/fraud/overview.

interface UserRef {
  userId: string;
  email: string | null;
  fullName: string | null;
  plan: string | null;
  suspended: boolean;
}

interface RepeatOffender extends UserRef {
  flaggedCount: number;
  rejectedCount: number;
  chargebackCount: number;
  lastFlagAt: string | null;
  score: number;
}

interface VelocitySubmission extends UserRef {
  count24h: number;
}

interface VelocityRateLimit {
  scope: string;
  subjectType: string;
  subjectId: string;
  userId: string | null;
  count: number;
  windowStart: string;
  user: UserRef | null;
}

interface DuplicateAccountCluster {
  stripeCustomerId: string;
  accounts: {
    userId: string;
    email: string | null;
    fullName: string | null;
    suspended: boolean;
    createdAt: string | null;
  }[];
}

interface Chargeback extends UserRef {
  eventType: string;
  reason: string | null;
  submissionId: string | null;
  at: string | null;
}

interface FraudOverview {
  generatedAt: string;
  summary: {
    repeatOffenders: number;
    velocityAlerts: number;
    duplicateAccounts: number;
    chargebacks: number;
    suspendedAccountsInView: number;
  };
  repeatOffenders: RepeatOffender[];
  velocitySubmissions: VelocitySubmission[];
  velocityRateLimits: VelocityRateLimit[];
  duplicateAccounts: DuplicateAccountCluster[];
  chargebacks: Chargeback[];
  truncated: string[];
}

function userLabel(u: { fullName: string | null; email: string | null }): string {
  return u.fullName || u.email || "Unknown user";
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

// Link to the per-user surface where the audited actions live.
function UserLink({
  userId,
  label,
  suspended,
}: {
  userId: string;
  label: string;
  suspended?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link
        to={`/admin/users/${userId}`}
        className="font-medium text-brand-navy hover:underline dark:text-foreground"
      >
        {label}
      </Link>
      {suspended && (
        <Badge variant="outline" className="border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300">
          Suspended
        </Badge>
      )}
    </span>
  );
}

export function AdminFraudPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-fraud-overview"],
    queryFn: async (): Promise<FraudOverview> => {
      const res = await edgeFetch("/api/admin/fraud/overview");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load fraud overview.");
      return json as FraudOverview;
    },
    staleTime: 60 * 1000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Abuse &amp; Fraud"
        subtitle="Cross-account view of repeat offenders, velocity abuse, duplicate / shared-payment accounts, and chargebacks. Each account links to its per-user actions."
        icon={ShieldAlert}
      />

      {isError ? (
        <Card>
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load fraud signals"
            description="The overview endpoint returned an error. Try again shortly."
          />
        </Card>
      ) : isLoading || !data ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-muted-foreground">Repeat offenders</p>
                <p className="text-2xl font-bold text-red-600 dark:text-red-400">
                  {data.summary.repeatOffenders}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-muted-foreground">Velocity alerts</p>
                <p className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                  {data.summary.velocityAlerts}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-muted-foreground">Duplicate / shared payment</p>
                <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">
                  {data.summary.duplicateAccounts}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-muted-foreground">Chargebacks</p>
                <p className="text-2xl font-bold text-red-600 dark:text-red-400">
                  {data.summary.chargebacks}
                </p>
              </CardContent>
            </Card>
          </div>

          {data.truncated.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Some signals hit their scan cap and may be partial:{" "}
                {data.truncated.join(", ")}. Counts shown are a lower bound.
              </span>
            </div>
          )}

          <Tabs defaultValue="offenders">
            <TabsList>
              <TabsTrigger value="offenders">
                <ShieldAlert className="mr-1.5 h-4 w-4" />
                Repeat offenders
              </TabsTrigger>
              <TabsTrigger value="velocity">
                <Gauge className="mr-1.5 h-4 w-4" />
                Velocity
              </TabsTrigger>
              <TabsTrigger value="duplicates">
                <Users className="mr-1.5 h-4 w-4" />
                Duplicate accounts
              </TabsTrigger>
              <TabsTrigger value="chargebacks">
                <CreditCard className="mr-1.5 h-4 w-4" />
                Chargebacks
              </TabsTrigger>
            </TabsList>

            {/* ── Repeat offenders ── */}
            <TabsContent value="offenders" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Repeat offenders</CardTitle>
                  <CardDescription>
                    Accounts with a pattern of flagged / rejected submissions or
                    chargebacks — worst first.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {data.repeatOffenders.length === 0 ? (
                    <EmptyState
                      icon={CheckCircle2}
                      title="No repeat offenders"
                      description="No account currently shows a repeated pattern of abuse."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Account</TableHead>
                          <TableHead className="text-right">Flagged</TableHead>
                          <TableHead className="text-right">Rejected</TableHead>
                          <TableHead className="text-right">Chargebacks</TableHead>
                          <TableHead>Last flag</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.repeatOffenders.map((o) => (
                          <TableRow key={o.userId}>
                            <TableCell>
                              <UserLink userId={o.userId} label={userLabel(o)} suspended={o.suspended} />
                            </TableCell>
                            <TableCell className="text-right">{o.flaggedCount}</TableCell>
                            <TableCell className="text-right">{o.rejectedCount}</TableCell>
                            <TableCell className="text-right">
                              {o.chargebackCount > 0 ? (
                                <span className="font-semibold text-red-600 dark:text-red-400">
                                  {o.chargebackCount}
                                </span>
                              ) : (
                                0
                              )}
                            </TableCell>
                            <TableCell>{fmtDate(o.lastFlagAt)}</TableCell>
                            <TableCell className="text-right">
                              <Button asChild size="sm" variant="outline">
                                <Link to={`/admin/users/${o.userId}`}>
                                  Review
                                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                                </Link>
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Velocity ── */}
            <TabsContent value="velocity" className="mt-4 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Submission bursts (last 24h)</CardTitle>
                  <CardDescription>
                    Accounts creating an unusually high number of submissions in a
                    24-hour window.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {data.velocitySubmissions.length === 0 ? (
                    <EmptyState
                      icon={CheckCircle2}
                      title="No submission bursts"
                      description="No account is submitting at an abnormal rate right now."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Account</TableHead>
                          <TableHead className="text-right">Submissions / 24h</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.velocitySubmissions.map((v) => (
                          <TableRow key={v.userId}>
                            <TableCell>
                              <UserLink userId={v.userId} label={userLabel(v)} suspended={v.suspended} />
                            </TableCell>
                            <TableCell className="text-right font-semibold">{v.count24h}</TableCell>
                            <TableCell className="text-right">
                              <Button asChild size="sm" variant="outline">
                                <Link to={`/admin/users/${v.userId}`}>Review</Link>
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Rate-limit hotspots</CardTitle>
                  <CardDescription>
                    Active rate-limit buckets over threshold, by subject (user / IP
                    / API key).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {data.velocityRateLimits.length === 0 ? (
                    <EmptyState
                      icon={CheckCircle2}
                      title="No rate-limit hotspots"
                      description="No subject is hammering a rate-limited endpoint."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Subject</TableHead>
                          <TableHead>Scope</TableHead>
                          <TableHead className="text-right">Hits</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.velocityRateLimits.map((h, i) => (
                          <TableRow key={`${h.subjectType}:${h.subjectId}:${h.scope}:${i}`}>
                            <TableCell>
                              {h.user ? (
                                <UserLink
                                  userId={h.user.userId}
                                  label={userLabel(h.user)}
                                  suspended={h.user.suspended}
                                />
                              ) : (
                                <span className="font-mono text-xs">
                                  <Badge variant="outline" className="mr-1.5">
                                    {h.subjectType}
                                  </Badge>
                                  {h.subjectId}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{h.scope}</TableCell>
                            <TableCell className="text-right font-semibold">{h.count}</TableCell>
                            <TableCell className="text-right">
                              {h.userId ? (
                                <Button asChild size="sm" variant="outline">
                                  <Link to={`/admin/users/${h.userId}`}>Review</Link>
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Duplicate accounts ── */}
            <TabsContent value="duplicates" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Duplicate / shared-payment accounts</CardTitle>
                  <CardDescription>
                    Distinct accounts sharing one Stripe customer — a sock-puppet /
                    shared-payment signal.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {data.duplicateAccounts.length === 0 ? (
                    <EmptyState
                      icon={CheckCircle2}
                      title="No shared-payment clusters"
                      description="No Stripe customer is linked to more than one account."
                    />
                  ) : (
                    data.duplicateAccounts.map((cluster) => (
                      <div
                        key={cluster.stripeCustomerId}
                        className="rounded-md border bg-muted/30 p-3"
                      >
                        <div className="mb-2 flex items-center gap-2 text-sm">
                          <CreditCard className="h-4 w-4 text-muted-foreground" />
                          <span className="font-mono text-xs text-muted-foreground">
                            {cluster.stripeCustomerId}
                          </span>
                          <Badge variant="outline">{cluster.accounts.length} accounts</Badge>
                        </div>
                        <ul className="space-y-1.5">
                          {cluster.accounts.map((a) => (
                            <li
                              key={a.userId}
                              className="flex flex-wrap items-center justify-between gap-2 text-sm"
                            >
                              <UserLink
                                userId={a.userId}
                                label={a.fullName || a.email || "Unknown user"}
                                suspended={a.suspended}
                              />
                              <span className="text-xs text-muted-foreground">
                                joined {fmtDate(a.createdAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Chargebacks ── */}
            <TabsContent value="chargebacks" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Chargebacks</CardTitle>
                  <CardDescription>
                    Stripe disputes opened against accounts. Disputes can still be
                    won — review before acting.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {data.chargebacks.length === 0 ? (
                    <EmptyState
                      icon={CheckCircle2}
                      title="No chargebacks"
                      description="No payment disputes have been opened."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Account</TableHead>
                          <TableHead>Reason</TableHead>
                          <TableHead>Opened</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.chargebacks.map((cb, i) => (
                          <TableRow key={`${cb.userId}:${cb.at ?? i}`}>
                            <TableCell>
                              {cb.userId ? (
                                <UserLink userId={cb.userId} label={userLabel(cb)} suspended={cb.suspended} />
                              ) : (
                                <span className="text-muted-foreground">Unknown user</span>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {cb.reason ?? "—"}
                            </TableCell>
                            <TableCell>{fmtDate(cb.at)}</TableCell>
                            <TableCell className="text-right">
                              {cb.userId ? (
                                <Button asChild size="sm" variant="outline">
                                  <Link to={`/admin/users/${cb.userId}`}>Review</Link>
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <p className="text-xs text-muted-foreground">
            Generated {new Date(data.generatedAt).toLocaleString()}.
          </p>
        </>
      )}
    </div>
  );
}
