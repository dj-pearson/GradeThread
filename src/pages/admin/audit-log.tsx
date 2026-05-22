import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { AdminAuditLogRow, UserRow } from "@/types/database";
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
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Lock,
  ScrollText,
} from "lucide-react";

const PAGE_SIZE = 25;

interface AuditData {
  logs: AdminAuditLogRow[];
  usersById: Map<string, UserRow>;
}

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
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-audit-log"],
    enabled: isSuperAdmin,
    queryFn: async (): Promise<AuditData> => {
      const [logsRes, usersRes] = await Promise.all([
        supabase
          .from("admin_audit_log")
          .select("*")
          .order("created_at", { ascending: false }),
        supabase.from("users").select("*"),
      ]);
      if (logsRes.error) throw logsRes.error;
      if (usersRes.error) throw usersRes.error;

      const usersById = new Map<string, UserRow>();
      for (const u of (usersRes.data ?? []) as UserRow[]) {
        usersById.set(u.id, u);
      }
      return {
        logs: (logsRes.data ?? []) as AdminAuditLogRow[],
        usersById,
      };
    },
    staleTime: 30 * 1000,
  });

  const adminOptions = useMemo(() => {
    if (!data) return [];
    const ids = new Set(data.logs.map((l) => l.admin_user_id));
    return Array.from(ids).map((id) => ({
      id,
      label:
        data.usersById.get(id)?.full_name ||
        data.usersById.get(id)?.email ||
        id,
    }));
  }, [data]);

  const actionOptions = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.logs.map((l) => l.action))).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const fromMs = fromDate ? new Date(fromDate).getTime() : null;
    const toMs = toDate ? new Date(toDate).getTime() + 86400000 : null;
    return data.logs.filter((log) => {
      if (adminFilter !== "all" && log.admin_user_id !== adminFilter) {
        return false;
      }
      if (actionFilter !== "all" && log.action !== actionFilter) {
        return false;
      }
      const ts = new Date(log.created_at).getTime();
      if (fromMs !== null && ts < fromMs) return false;
      if (toMs !== null && ts >= toMs) return false;
      return true;
    });
  }, [data, adminFilter, actionFilter, fromDate, toDate]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE
  );

  function resetFilters() {
    setAdminFilter("all");
    setActionFilter("all");
    setFromDate("");
    setToDate("");
    setPage(0);
  }

  if (!isSuperAdmin) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <ScrollText className="h-6 w-6 text-brand-red" />
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
      <div className="flex items-center gap-3">
        <ScrollText className="h-6 w-6 text-brand-red" />
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-sm text-muted-foreground">
            Every administrative action taken on the platform.
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
              ? "Loading…"
              : `${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
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
                      const admin = data?.usersById.get(log.admin_user_id);
                      return (
                        <Fragment key={log.id}>
                          <TableRow
                            className="cursor-pointer"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : log.id)
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
                            <TableCell className="max-w-[180px] truncate text-sm">
                              {admin?.full_name || admin?.email || (
                                <span className="text-muted-foreground">
                                  {log.admin_user_id}
                                </span>
                              )}
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
                          </TableRow>
                          {isExpanded && (
                            <TableRow>
                              <TableCell colSpan={6} className="bg-muted/40">
                                <div className="space-y-1 py-1">
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
