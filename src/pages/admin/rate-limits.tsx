import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Gauge, ShieldBan } from "lucide-react";

// US-890: Trust & Safety rate-limit console. The cross-tenant overview that pairs
// with the per-user "Limits" section on the user-detail page: who's hammering the
// API right now (noisiest callers in the recent window) and every active temporary
// override. Setting/lifting an override happens on the user-detail page (a link
// from here), where the full editor + MFA step-up live.

type OverrideMode = "multiplier" | "cap" | "block";

interface UserLite {
  userId: string;
  email: string | null;
  fullName: string | null;
  plan: string | null;
  suspended: boolean;
}

interface Caller {
  subject: string;
  userId: string | null;
  user: UserLite | null;
  totalRequests: number;
  scopes: number;
  topScope: string;
  topScopeCount: number;
}

interface OverrideRow {
  subjectUserId: string;
  mode: OverrideMode;
  multiplier: number | null;
  cap: number | null;
  reason: string;
  expiresAt: string;
  user: UserLite | null;
}

interface ConsoleResponse {
  windowMinutes: number;
  callers: Caller[];
  overrides: OverrideRow[];
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function describeOverride(o: OverrideRow): string {
  if (o.mode === "block") return "Block";
  if (o.mode === "cap") return `Cap ${o.cap}`;
  return `×${o.multiplier}`;
}

function userLabel(u: UserLite | null, fallback: string): string {
  if (!u) return fallback;
  return u.fullName || u.email || fallback;
}

export function AdminRateLimitsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-rate-limits-console"],
    queryFn: async (): Promise<ConsoleResponse> => {
      const res = await edgeFetch("/api/admin/safety/rate-limits?limit=25");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      return json as ConsoleResponse;
    },
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Gauge className="h-6 w-6" />
          Rate Limits
        </h1>
        <p className="text-sm text-muted-foreground">
          Live rate-limit counters and temporary per-user overrides. Set or lift an
          override from a user's detail page.
        </p>
      </div>

      {/* Active overrides */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldBan className="h-4 w-4" />
            Active overrides
          </CardTitle>
          <CardDescription>
            Temporary throttles, boosts, and blocks currently in effect. These
            auto-expire.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-24" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Override</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.overrides.length ?? 0) === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                      No active overrides.
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.overrides.map((o) => (
                    <TableRow key={o.subjectUserId}>
                      <TableCell>
                        <Link
                          to={`/admin/users/${o.subjectUserId}`}
                          className="font-medium text-brand-navy hover:underline dark:text-blue-300"
                        >
                          {userLabel(o.user, o.subjectUserId.slice(0, 8))}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={o.mode === "block" ? "destructive" : "secondary"}
                        >
                          {describeOverride(o)}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {o.reason}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatExpiry(o.expiresAt)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Noisiest callers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Noisiest callers</CardTitle>
          <CardDescription>
            Most rate-limit-counted subjects over the last {data?.windowMinutes ?? 5}{" "}
            minutes. IP subjects have no account to override.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-40" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead>Top scope</TableHead>
                  <TableHead className="text-right">Scopes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.callers.length ?? 0) === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                      No rate-limit activity in the recent window.
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.callers.map((caller) => (
                    <TableRow key={caller.subject}>
                      <TableCell>
                        {caller.userId ? (
                          <Link
                            to={`/admin/users/${caller.userId}`}
                            className="font-medium text-brand-navy hover:underline dark:text-blue-300"
                          >
                            {userLabel(caller.user, caller.userId.slice(0, 8))}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">
                            {caller.subject}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {caller.totalRequests}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {caller.topScope} ({caller.topScopeCount})
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {caller.scopes}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
