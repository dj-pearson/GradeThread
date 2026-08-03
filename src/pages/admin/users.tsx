import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { supabase } from "@/lib/supabase";
import type { UserRow } from "@/types/database";
import { fetchAdminUserListStats } from "@/lib/admin-aggregates";
import { getPlanBadgeClasses, getRoleBadgeClasses, legacyPlanConfig } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Users, Loader2, Crosshair } from "lucide-react";
import { SearchInput } from "@/components/search-input";
import { edgeFetch } from "@/lib/edge-fetch";
import { AdminSavedViews } from "@/components/admin/admin-saved-views";
import { toast } from "sonner";

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function formatRole(role: string): string {
  if (role === "super_admin") return "Super Admin";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const PAGE_SIZE = 20;

interface LookupMatch {
  user_id: string;
  email: string;
  full_name: string | null;
  matched_on:
    | "email"
    | "user_id"
    | "stripe_customer_id"
    | "submission_id"
    | "certificate_id";
}

const MATCHED_ON_LABEL: Record<LookupMatch["matched_on"], string> = {
  email: "Email",
  user_id: "User ID",
  stripe_customer_id: "Stripe customer",
  submission_id: "Submission ID",
  certificate_id: "Certificate ID",
};

type UserListColumns = Pick<
  UserRow,
  "id" | "email" | "full_name" | "plan" | "role" | "grades_used_this_month" | "created_at"
>;

interface UserListRow extends UserListColumns {
  submission_count: number;
  last_active: string;
}

// PostgREST `.or()` parses commas/parens as syntax — strip them from the raw
// search term so a stray character can't break the filter (ilike still matches
// the remaining substring).
function sanitizeSearch(value: string): string {
  return value.replace(/[,()*]/g, " ").trim();
}

export function AdminUsersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  // US-1562: row multi-select -> hand the ids to /admin/bulk prefilled.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // US-581: global account lookup by email / Stripe customer / submission id /
  // certificate id. Resolves to the owning user and jumps to their detail page.
  const [lookupQ, setLookupQ] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResults, setLookupResults] = useState<LookupMatch[] | null>(null);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    const q = lookupQ.trim();
    if (q.length < 3) {
      toast.error("Enter at least 3 characters to look up.");
      return;
    }
    setLookupLoading(true);
    setLookupResults(null);
    try {
      const res = await edgeFetch(
        `/api/admin/users/lookup?q=${encodeURIComponent(q)}`,
        { silentGate: true },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const matches = (body.matches ?? []) as LookupMatch[];
      if (matches.length === 0) {
        toast.error("No account found for that identifier.");
        setLookupResults([]);
        return;
      }
      if (matches.length === 1) {
        navigate(`/admin/users/${matches[0]!.user_id}`);
        return;
      }
      setLookupResults(matches);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  }

  // US-415: the users list paginates server-side via `.range()` + an exact
  // count. Filters/search are pushed into the query, and the per-user
  // submission stats are fetched only for the ~20 ids on the current page (the
  // `admin_user_list_stats` RPC) instead of downloading the submissions table.
  const { data, isLoading } = useQuery({
    queryKey: ["admin-users", page, search, planFilter, roleFilter, dateFrom, dateTo],
    queryFn: async () => {
      let query = supabase
        .from("users")
        .select(
          "id, email, full_name, plan, role, grades_used_this_month, created_at",
          { count: "exact" },
        );

      const term = sanitizeSearch(search);
      if (term) {
        query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`);
      }
      if (planFilter !== "all") query = query.eq("plan", planFilter);
      if (roleFilter !== "all") query = query.eq("role", roleFilter);
      if (dateFrom) query = query.gte("created_at", dateFrom);
      if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59.999Z`);

      query = query
        .order("created_at", { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

      const { data: rows, error, count } = await query;
      if (error) throw error;

      const userRows = (rows ?? []) as UserListColumns[];
      const stats = await fetchAdminUserListStats(userRows.map((u) => u.id));

      const enriched: UserListRow[] = userRows.map((u) => ({
        ...u,
        submission_count: stats[u.id]?.count ?? 0,
        last_active: stats[u.id]?.last ?? u.created_at,
      }));

      return { rows: enriched, totalCount: count ?? 0 };
    },
    staleTime: 30 * 1000,
  });

  const paginated = data?.rows ?? [];
  const totalCount = data?.totalCount ?? 0;

  // Pagination (server-side)
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-brand-red-text" />
        <h1 className="text-2xl font-bold">User Management</h1>
        <Badge variant="secondary" className="ml-2">
          {totalCount} user{totalCount !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Global lookup (US-581) — jump to any account by a unique identifier. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Crosshair className="h-4 w-4 text-brand-red-text" />
            Global account lookup
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLookup} className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Account lookup"
              placeholder="Email, Stripe customer (cus_…), submission ID, or certificate ID"
              value={lookupQ}
              onChange={(e) => setLookupQ(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" disabled={lookupLoading} className="sm:w-32">
              {lookupLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Crosshair className="mr-2 h-4 w-4" />
              )}
              Find account
            </Button>
          </form>
          {lookupResults && lookupResults.length > 0 && (
            <div className="mt-3 divide-y rounded-md border">
              {lookupResults.map((m) => (
                <button
                  key={`${m.user_id}-${m.matched_on}`}
                  onClick={() => navigate(`/admin/users/${m.user_id}`)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
                >
                  <span>
                    <span className="font-medium">{m.full_name || m.email}</span>
                    <span className="ml-2 text-muted-foreground">{m.email}</span>
                  </span>
                  <Badge variant="secondary">{MATCHED_ON_LABEL[m.matched_on]}</Badge>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Search and Filters */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
          <CardTitle className="text-sm font-medium">Search & Filter</CardTitle>
          <AdminSavedViews
            surface="users"
            currentFilter={{ search, planFilter, roleFilter, dateFrom, dateTo }}
            onApply={(f) => {
              setSearch(asString(f.search, ""));
              setPlanFilter(asString(f.planFilter, "all"));
              setRoleFilter(asString(f.roleFilter, "all"));
              setDateFrom(asString(f.dateFrom, ""));
              setDateTo(asString(f.dateTo, ""));
              setPage(1);
            }}
          />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {/* Search */}
            <SearchInput
              label="Search users"
              placeholder="Search name or email..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              containerClassName="sm:col-span-2 lg:col-span-1"
            />

            {/* Plan filter */}
            <Select
              value={planFilter}
              onValueChange={(v) => {
                setPlanFilter(v);
                setPage(1);
              }}
            >
              {/* US-2335: without a name this announces its VALUE — "All
                  Plans" unset, "Professional" once chosen — so the control
                  renames itself as you use it. */}
              <SelectTrigger aria-label="Filter by plan">
                <SelectValue placeholder="All Plans" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Plans</SelectItem>
                <SelectItem value="free">Free</SelectItem>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="professional">Professional</SelectItem>
                <SelectItem value="enterprise">Enterprise</SelectItem>
              </SelectContent>
            </Select>

            {/* Role filter */}
            <Select
              value={roleFilter}
              onValueChange={(v) => {
                setRoleFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter by role">
                <SelectValue placeholder="All Roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Roles</SelectItem>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="reviewer">Reviewer</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="super_admin">Super Admin</SelectItem>
              </SelectContent>
            </Select>

            {/* Date from */}
            <Input
              type="date"
              aria-label="Signed up from"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              placeholder="Signup from"
            />

            {/* Date to */}
            <Input
              type="date"
              aria-label="Signed up until"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              placeholder="Signup to"
            />
          </div>
        </CardContent>
      </Card>

      {/* Users table */}
      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          {/* US-1562: selection toolbar — hands the picked ids to /admin/bulk. */}
          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
              <span className="text-sm">
                {selectedIds.size} user{selectedIds.size === 1 ? "" : "s"} selected
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    navigate(`/admin/bulk?ids=${[...selectedIds].join(",")}`)}
                >
                  Bulk actions…
                </Button>
              </div>
            </div>
          )}
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all on page"
                      className="h-4 w-4 accent-primary"
                      checked={paginated.length > 0 && paginated.every((u) => selectedIds.has(u.id))}
                      onChange={(e) => {
                        const next = new Set(selectedIds);
                        for (const u of paginated) {
                          if (e.target.checked) next.add(u.id);
                          else next.delete(u.id);
                        }
                        setSelectedIds(next);
                      }}
                    />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Grades Used</TableHead>
                  <TableHead>Signup Date</TableHead>
                  <TableHead>Last Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                      No users found matching your filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((user) => (
                    <ClickableRow
                      key={user.id}
                      className="hover:bg-muted/50"
                      onActivate={() => navigate(`/admin/users/${user.id}`)}
                      activateLabel={`View ${user.email}`}
                    >
                      <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${user.email}`}
                          className="h-4 w-4 accent-primary"
                          checked={selectedIds.has(user.id)}
                          onChange={(e) => {
                            const next = new Set(selectedIds);
                            if (e.target.checked) next.add(user.id);
                            else next.delete(user.id);
                            setSelectedIds(next);
                          }}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        {user.full_name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {user.email}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={getPlanBadgeClasses(user.plan)}
                        >
                          {legacyPlanConfig(user.plan)?.name ?? user.plan}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={getRoleBadgeClasses(user.role)}
                        >
                          {formatRole(user.role)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {user.grades_used_this_month}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(user.created_at)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(user.last_active)}
                      </TableCell>
                    </ClickableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, totalCount)} of{" "}
                {totalCount}
              </p>
              <div className="flex gap-2">
                <button
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}
                >
                  Previous
                </button>
                <button
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
