import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import type { UserRow } from "@/types/database";
import {
  type AdminAuditSearchRow,
  fetchAdminAuditFilterOptions,
  fetchAdminAuditSearch,
} from "@/lib/admin-aggregates";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ClickableRow } from "@/components/clickable-row";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Download,
  Lock,
  ScrollText,
  Search,
  Shield,
} from "lucide-react";

const PAGE_SIZE = 25;

type AuditAdmin = Pick<UserRow, "id" | "full_name" | "email" | "role">;

interface AuditData {
  logs: AdminAuditSearchRow[];
  usersById: Map<string, AuditAdmin>;
  totalCount: number;
}

interface AnomalyItem {
  id: string;
  detector: string;
  severity: string;
  event_count: number;
  last_seen_at: string;
  actor_label: string | null;
  evidence: Record<string, unknown> | null;
}

const DETECTOR_LABELS: Record<string, string> = {
  role_change_burst: "Burst of admin role changes",
  mass_refund: "Mass refund / credit activity",
  off_hours_destructive: "Off-hours destructive actions",
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAction(action: string): string {
  return action
    .split(/[._-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function AdminAuditLogPage() {
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [adminFilter, setAdminFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [targetTypeFilter, setTargetTypeFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // Free-text box (debounced into `search` on submit) — searched server-side
  // across action / target / the jsonb details. (US-905)
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // US-415: filter dropdown options come from a DISTINCT grouped query
  // (admin_audit_log_filter_options) instead of scanning every row client-side.
  const { data: filterOptions } = useQuery({
    queryKey: ["admin-audit-filter-options"],
    enabled: isSuperAdmin,
    queryFn: fetchAdminAuditFilterOptions,
    staleTime: 5 * 60 * 1000,
  });

  const adminOptions = filterOptions?.admins ?? [];
  const actionOptions = filterOptions?.actions ?? [];
  const targetTypeOptions = filterOptions?.targetTypes ?? [];

  // US-905: the log paginates + free-text searches server-side via the
  // admin_audit_log_search RPC (which casts target_id/details to text so the
  // jsonb details column is searchable). Filters + date range + search term are
  // pushed into the RPC, and only the acting users on the current page are
  // fetched (by id) rather than the whole users table.
  const toIso = toDate ? `${toDate}T23:59:59.999Z` : null;
  const { data, isLoading } = useQuery({
    queryKey: [
      "admin-audit-log",
      page,
      adminFilter,
      actionFilter,
      targetTypeFilter,
      fromDate,
      toDate,
      search,
    ],
    enabled: isSuperAdmin,
    queryFn: async (): Promise<AuditData> => {
      const { rows, totalCount } = await fetchAdminAuditSearch({
        search,
        admin: adminFilter,
        action: actionFilter,
        targetType: targetTypeFilter,
        from: fromDate || null,
        to: toIso,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });

      const adminIds = [
        ...new Set(
          rows.map((l) => l.admin_user_id).filter((id): id is string => !!id),
        ),
      ];

      const usersById = new Map<string, AuditAdmin>();
      if (adminIds.length > 0) {
        const { data: us, error: uErr } = await supabase
          .from("users")
          .select("id, full_name, email, role")
          .in("id", adminIds);
        if (uErr) throw uErr;
        for (const u of (us ?? []) as AuditAdmin[]) {
          usersById.set(u.id, u);
        }
      }

      return { logs: rows, usersById, totalCount };
    },
    staleTime: 30 * 1000,
  });

  // US-905: anomaly findings raised by the scheduled scan (read via the edge
  // endpoint — admin_audit_anomalies is service-role-only).
  const { data: anomalies } = useQuery({
    queryKey: ["admin-audit-anomalies"],
    enabled: isSuperAdmin,
    queryFn: async (): Promise<AnomalyItem[]> => {
      const res = await edgeFetch("/api/admin/audit/anomalies?status=open");
      if (!res.ok) return [];
      const json = (await res.json()) as { anomalies?: AnomalyItem[] };
      return json.anomalies ?? [];
    },
    staleTime: 60 * 1000,
  });

  // US-905: CSV/JSON export of the filtered set (super-admin; itself audited).
  async function exportLog(format: "csv" | "json") {
    setIsExporting(true);
    try {
      const params = new URLSearchParams({ format });
      if (search.trim()) params.set("search", search.trim());
      if (adminFilter !== "all") params.set("admin", adminFilter);
      if (actionFilter !== "all") params.set("action", actionFilter);
      if (targetTypeFilter !== "all") params.set("targetType", targetTypeFilter);
      if (fromDate) params.set("from", fromDate);
      if (toIso) params.set("to", toIso);

      const res = await edgeFetch(`/api/admin/audit/export?${params.toString()}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(
          (j as { error?: string }).error ?? `Export failed (${res.status})`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Audit log exported (${format.toUpperCase()})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setIsExporting(false);
    }
  }

  // An entry is super-admin-only if the acting role was super_admin. Prefer the
  // role stamped on the row at action time (actor_role); fall back to the
  // actor's current role for older rows written before that column existed.
  function isSuperAdminEntry(log: AdminAuditSearchRow): boolean {
    if (log.actor_role) return log.actor_role === "super_admin";
    return (
      !!log.admin_user_id &&
      data?.usersById.get(log.admin_user_id)?.role === "super_admin"
    );
  }

  const totalCount = data?.totalCount ?? 0;
  const pageRows = data?.logs ?? [];
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);

  function resetFilters() {
    setAdminFilter("all");
    setActionFilter("all");
    setTargetTypeFilter("all");
    setFromDate("");
    setToDate("");
    setSearchInput("");
    setSearch("");
    setPage(0);
  }

  function submitSearch() {
    setSearch(searchInput);
    setPage(0);
  }

  if (!isSuperAdmin) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <ScrollText className="h-6 w-6 text-brand-red-text" />
          <h1 className="text-2xl font-bold">Audit Log</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="rounded-full bg-muted p-3">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold">Super admin only</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              The administrative audit log is restricted to super admin
              accounts.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ScrollText}
        title="Audit Log"
        subtitle="Every administrative action taken on the platform."
      />

      {/* US-905: anomaly findings raised by the scheduled scan */}
      {anomalies && anomalies.length > 0 && (
        <Card className="border-brand-red/40 bg-brand-red/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-brand-red-text">
              <AlertTriangle className="h-4 w-4" />
              {anomalies.length} open anomal
              {anomalies.length === 1 ? "y" : "ies"} flagged
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {anomalies.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={
                      a.severity === "critical"
                        ? "rounded bg-brand-red/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-red-text"
                        : "rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600"
                    }
                  >
                    {a.severity}
                  </span>
                  <span className="font-medium">
                    {DETECTOR_LABELS[a.detector] ?? a.detector}
                  </span>
                  <span className="text-muted-foreground">
                    — {a.event_count} action{a.event_count === 1 ? "" : "s"}
                    {a.actor_label ? ` by ${a.actor_label}` : " (platform-wide)"}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatTimestamp(a.last_seen_at)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Search + export */}
      <Card>
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search audit log"
              className="pl-8"
              placeholder="Search action, target or details…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSearch();
              }}
            />
          </div>
          <Button variant="secondary" onClick={submitSearch}>
            Search
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={isExporting}
              onClick={() => exportLog("csv")}
            >
              <Download className="mr-1.5 h-4 w-4" />
              CSV
            </Button>
            <Button
              variant="outline"
              disabled={isExporting}
              onClick={() => exportLog("json")}
            >
              <Download className="mr-1.5 h-4 w-4" />
              JSON
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="space-y-1.5">
            <Label className="text-xs">Admin User</Label>
            <Select
              value={adminFilter}
              onValueChange={(v) => {
                setAdminFilter(v);
                setPage(0);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All admins</SelectItem>
                {adminOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Action</Label>
            <Select
              value={actionFilter}
              onValueChange={(v) => {
                setActionFilter(v);
                setPage(0);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {actionOptions.map((action) => (
                  <SelectItem key={action} value={action}>
                    {formatAction(action)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Target Type</Label>
            <Select
              value={targetTypeFilter}
              onValueChange={(v) => {
                setTargetTypeFilter(v);
                setPage(0);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All targets</SelectItem>
                {targetTypeOptions.map((t) => (
                  <SelectItem key={t} value={t}>
                    {formatAction(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="from-date">
              From
            </Label>
            <Input
              id="from-date"
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(0);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="to-date">
              To
            </Label>
            <Input
              id="to-date"
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(0);
              }}
            />
          </div>

          <div className="flex items-end">
            <Button
              variant="outline"
              className="w-full"
              onClick={resetFilters}
            >
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Log table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {isLoading
              ? "Audit log"
              : `${totalCount} entr${totalCount === 1 ? "y" : "ies"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingRegion label="Loading audit log">
              <SkeletonRows rows={6} />
            </LoadingRegion>
          ) : totalCount === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No audit entries match the current filters.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>Timestamp</TableHead>
                      <TableHead>Admin User</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Target Type</TableHead>
                      <TableHead>Target ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((log) => {
                      const isExpanded = expandedId === log.id;
                      const admin = log.admin_user_id
                        ? data?.usersById.get(log.admin_user_id)
                        : undefined;
                      const superAdmin = isSuperAdminEntry(log);
                      const isSystem = !log.admin_user_id;
                      return (
                        <Fragment key={log.id}>
                          <ClickableRow
                            onActivate={() =>
                              setExpandedId(isExpanded ? null : log.id)
                            }
                            activateLabel={
                              isExpanded
                                ? "Collapse entry details"
                                : "Expand entry details"
                            }
                          >
                            <TableCell>
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                aria-label={
                                  isExpanded
                                    ? "Collapse entry details"
                                    : "Expand entry details"
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedId(isExpanded ? null : log.id);
                                }}
                                className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                )}
                              </button>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-sm">
                              {formatTimestamp(log.created_at)}
                            </TableCell>
                            <TableCell className="max-w-[200px] text-sm">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate">
                                  {isSystem ? (
                                    <span className="text-muted-foreground">
                                      System
                                    </span>
                                  ) : (
                                    admin?.full_name ||
                                    admin?.email || (
                                      <span className="text-muted-foreground">
                                        {log.admin_user_id}
                                      </span>
                                    )
                                  )}
                                </span>
                                {superAdmin && (
                                  <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-brand-red/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-red-text">
                                    <Shield className="h-3 w-3" />
                                    Super
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">
                                {formatAction(log.action)}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">
                              {log.target_type}
                            </TableCell>
                            <TableCell className="max-w-[160px] truncate font-mono text-xs text-muted-foreground">
                              {log.target_id ?? "—"}
                            </TableCell>
                          </ClickableRow>
                          {isExpanded && (
                            <TableRow>
                              <TableCell colSpan={6} className="bg-muted/40">
                                <div className="space-y-2 py-1">
                                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                                    <span>
                                      Actor role:{" "}
                                      <span className="font-medium text-foreground">
                                        {log.actor_role ?? "—"}
                                      </span>
                                    </span>
                                    <span>
                                      IP:{" "}
                                      <span className="font-mono text-foreground">
                                        {log.ip ?? "—"}
                                      </span>
                                    </span>
                                    <span className="max-w-full truncate">
                                      User agent:{" "}
                                      <span className="text-foreground">
                                        {log.user_agent ?? "—"}
                                      </span>
                                    </span>
                                  </div>
                                  <p className="text-xs font-medium text-muted-foreground">
                                    Details
                                  </p>
                                  <pre className="overflow-x-auto rounded bg-background p-3 text-xs">
                                    {log.details
                                      ? JSON.stringify(log.details, null, 2)
                                      : "No additional details recorded."}
                                  </pre>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="mt-4 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Page {safePage + 1} of {pageCount}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={safePage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={safePage >= pageCount - 1}
                    onClick={() =>
                      setPage((p) => Math.min(pageCount - 1, p + 1))
                    }
                  >
                    Next
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
