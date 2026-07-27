// US-897: Marketplace connection health console (all tenants).
//
// Cross-tenant view of every marketplace_connection's OAuth health so an
// operator can tell a seller to reconnect before their listings stop syncing.
// Reads are admin; the per-connection refresh / flag-for-reconnect actions are
// super_admin + MFA step-up (enforced server-side).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Plug,
  PlugZap,
  RefreshCw,
  Send,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

type Health = "healthy" | "expiring" | "error" | "inactive";

interface ConnectionRow {
  id: string;
  user_id: string;
  marketplace: string;
  account_handle: string | null;
  token_expires_at: string | null;
  last_synced_at: string | null;
  last_refresh_attempt_at: string | null;
  refresh_error: string | null;
  is_active: boolean;
  health: Health;
  created_at: string;
  updated_at: string;
}

interface ConnectionsResponse {
  connections: ConnectionRow[];
  summary: {
    total: number;
    healthy: number;
    expiring: number;
    error: number;
    inactive: number;
  };
  page: { page: number; limit: number; total: number };
}

const HEALTH_META: Record<
  Health,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  healthy: {
    label: "Healthy",
    className: "bg-emerald-100 text-emerald-800 border-emerald-200",
    icon: CheckCircle2,
  },
  expiring: {
    label: "Expiring",
    className: "bg-amber-100 text-amber-800 border-amber-200",
    icon: Clock,
  },
  error: {
    label: "Error",
    className: "bg-red-100 text-red-800 border-red-200",
    icon: AlertTriangle,
  },
  inactive: {
    label: "Inactive",
    className: "bg-slate-100 text-slate-600 border-slate-200",
    icon: Plug,
  },
};

const MARKETPLACE_LABELS: Record<string, string> = {
  ebay: "eBay",
  poshmark: "Poshmark",
  mercari: "Mercari",
  depop: "Depop",
  grailed: "Grailed",
  facebook: "Facebook",
  offerup: "OfferUp",
  shopify: "Shopify",
  whatnot: "Whatnot",
  other: "Other",
};

const REFRESHABLE = new Set(["ebay", "depop"]);

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function HealthBadge({ health }: { health: Health }) {
  const meta = HEALTH_META[health];
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={`gap-1 ${meta.className}`}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

export function AdminMarketplaceConnectionsPage() {
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";
  const qc = useQueryClient();
  const confirm = useConfirm();

  const [healthFilter, setHealthFilter] = useState<Health | "all">("all");
  const [page, setPage] = useState(1);
  const limit = 25;

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const queryKey = ["admin-marketplace-connections", healthFilter, page];
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: async (): Promise<ConnectionsResponse> => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (healthFilter !== "all") params.set("health", healthFilter);
      const res = await edgeFetch(`/api/admin/marketplace-connections?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load connections.");
      return json;
    },
    staleTime: 30_000,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["admin-marketplace-connections"] });

  // Step-up-aware mutation runner (mirrors the AI budgets card).
  async function run(id: string, doFetch: () => Promise<Response>, onOk: () => void) {
    setWorkingId(id);
    try {
      const res = await doFetch();
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => run(id, doFetch, onOk));
          setStepUpOpen(true);
          return;
        }
        toast.error((j as { error?: string })?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string }).error ?? "Action failed");
        // The refresh action may have recorded a new error — reflect it.
        invalidate();
        return;
      }
      onOk();
    } finally {
      setWorkingId(null);
    }
  }

  const refreshConnection = (conn: ConnectionRow) =>
    run(
      conn.id,
      () =>
        edgeFetch(`/api/admin/marketplace-connections/${conn.id}/refresh`, {
          method: "POST",
          silentGate: true,
        }),
      () => {
        toast.success("Token refreshed");
        invalidate();
      },
    );

  const flagReconnect = async (conn: ConnectionRow) => {
    const label = MARKETPLACE_LABELS[conn.marketplace] ?? conn.marketplace;
    const ok = await confirm({
      title: `Flag this ${label} connection?`,
      description:
        "Notifies the seller to reconnect. Their listings keep syncing until the token expires.",
      confirmLabel: "Flag connection",
      destructive: true,
    });
    if (!ok) {
      return;
    }
    run(
      conn.id,
      () =>
        edgeFetch(`/api/admin/marketplace-connections/${conn.id}/flag-reconnect`, {
          method: "POST",
          silentGate: true,
        }),
      () => {
        toast.success("Seller notified to reconnect");
        invalidate();
      },
    );
  };

  const summary = data?.summary;
  const connections = data?.connections ?? [];
  const total = data?.page.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketplace Connections"
        subtitle="Cross-tenant health of every marketplace OAuth connection — token expiry, last refresh error and last sync. Encrypted tokens are never shown."
      />

      {/* Health summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {(
          [
            { key: "total", label: "Total", value: summary?.total },
            { key: "healthy", label: "Healthy", value: summary?.healthy },
            { key: "expiring", label: "Expiring", value: summary?.expiring },
            { key: "error", label: "Errors", value: summary?.error },
            { key: "inactive", label: "Inactive", value: summary?.inactive },
          ] as const
        ).map((s) => (
          <Card key={s.key}>
            <CardContent className="p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {s.label}
              </div>
              <div className="mt-1 text-2xl font-bold">
                {isLoading ? <Skeleton className="h-7 w-12" /> : s.value ?? 0}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <PlugZap className="h-5 w-5" />
              Connections
            </CardTitle>
            <CardDescription>
              At-risk connections (soonest to expire) appear first.
            </CardDescription>
          </div>
          <Select
            value={healthFilter}
            onValueChange={(v) => {
              setHealthFilter(v as Health | "all");
              setPage(1);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Filter health" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All health</SelectItem>
              <SelectItem value="healthy">Healthy</SelectItem>
              <SelectItem value="expiring">Expiring</SelectItem>
              <SelectItem value="error">Errors</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {isError ? (
            <div className="py-8 text-center text-sm text-destructive">
              Failed to load connections.
            </div>
          ) : isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : connections.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No connections match this filter.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Marketplace</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Token expires</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((conn) => {
                  const busy = workingId === conn.id;
                  return (
                    <TableRow key={conn.id}>
                      <TableCell className="font-medium">
                        {MARKETPLACE_LABELS[conn.marketplace] ?? conn.marketplace}
                      </TableCell>
                      <TableCell>
                        <div>{conn.account_handle ?? "—"}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {conn.user_id.slice(0, 8)}…
                        </div>
                      </TableCell>
                      <TableCell>
                        <HealthBadge health={conn.health} />
                      </TableCell>
                      <TableCell>{fmtDate(conn.token_expires_at)}</TableCell>
                      <TableCell>{fmtDate(conn.last_synced_at)}</TableCell>
                      <TableCell className="max-w-[16rem]">
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={conn.refresh_error ?? undefined}
                        >
                          {conn.refresh_error ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              !isSuperAdmin || busy || !REFRESHABLE.has(conn.marketplace)
                            }
                            title={
                              !isSuperAdmin
                                ? "Super admin required"
                                : !REFRESHABLE.has(conn.marketplace)
                                  ? "Refresh not supported for this marketplace"
                                  : "Trigger a token refresh"
                            }
                            onClick={() => refreshConnection(conn)}
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                            <span className="ml-1 hidden sm:inline">Refresh</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!isSuperAdmin || busy}
                            title={
                              isSuperAdmin
                                ? "Notify the seller to reconnect"
                                : "Super admin required"
                            }
                            onClick={() => flagReconnect(conn)}
                          >
                            <Send className="h-3.5 w-3.5" />
                            <span className="ml-1 hidden sm:inline">Reconnect</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {/* Pagination */}
          {total > limit && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages} · {total} connection{total === 1 ? "" : "s"}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => retry?.()}
      />
    </div>
  );
}
