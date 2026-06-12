import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import type { UserRow } from "@/types/database";
import { fetchAdminUserListStats } from "@/lib/admin-aggregates";
import { PLANS } from "@/lib/constants";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Search } from "lucide-react";

const ROLE_COLORS: Record<string, string> = {
  user: "bg-muted text-muted-foreground",
  reviewer: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  admin: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
  super_admin: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
};

const PLAN_COLORS: Record<string, string> = {
  free: "bg-muted text-muted-foreground",
  starter: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  professional: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  enterprise: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
};

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

      {/* Search and Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Search & Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {/* Search */}
            <div className="relative sm:col-span-2 lg:col-span-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search name or email..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-9"
              />
            </div>

            {/* Plan filter */}
            <Select
              value={planFilter}
              onValueChange={(v) => {
                setPlanFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger>
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
              <SelectTrigger>
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
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
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
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      No users found matching your filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((user) => (
                    <TableRow
                      key={user.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate(`/admin/users/${user.id}`)}
                    >
                      <TableCell className="font-medium">
                        {user.full_name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {user.email}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={PLAN_COLORS[user.plan] ?? ""}
                        >
                          {PLANS[user.plan]?.name ?? user.plan}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={ROLE_COLORS[user.role] ?? ""}
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
                    </TableRow>
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
