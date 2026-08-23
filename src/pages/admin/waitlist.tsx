import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
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
import { edgeFetch } from "@/lib/edge-fetch";
import {
  AlertTriangle,
  CheckCircle2,
  Send,
  UserPlus,
  XCircle,
  ShieldCheck,
} from "lucide-react";

type WaitlistStatus = "pending" | "approved" | "invited" | "rejected";

interface WaitlistEntry {
  id: string;
  email: string;
  full_name: string | null;
  cohort: string | null;
  status: WaitlistStatus;
  source: string | null;
  user_id: string | null;
  notes: string | null;
  requested_at: string;
  approved_at: string | null;
  invited_at: string | null;
  created_at: string;
}

interface WaitlistResponse {
  entries: WaitlistEntry[];
  summary: { pending: number; approved: number; invited: number; rejected: number; total: number };
  cohorts: Record<string, number>;
  gatingActive: boolean;
}

const STATUS_STYLES: Record<WaitlistStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  approved: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  invited: "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300",
  rejected: "bg-muted text-muted-foreground",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function AdminWaitlistPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [cohortFilter, setCohortFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);

  // Manual-add form
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newCohort, setNewCohort] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-waitlist", statusFilter, cohortFilter, search],
    queryFn: async (): Promise<WaitlistResponse> => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (cohortFilter !== "all") params.set("cohort", cohortFilter);
      if (search.trim()) params.set("q", search.trim());
      const res = await edgeFetch(`/api/admin/waitlist?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load waitlist.");
      return json;
    },
    staleTime: 30_000,
  });

  const cohortNames = useMemo(() => Object.keys(data?.cohorts ?? {}).sort(), [data]);

  async function run(doFetch: () => Promise<Response>, okMsg: string) {
    setWorking(true);
    try {
      const res = await doFetch();
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string }).error ?? "Action failed");
        return false;
      }
      toast.success(okMsg);
      qc.invalidateQueries({ queryKey: ["admin-waitlist"] });
      return true;
    } finally {
      setWorking(false);
    }
  }

  const patchEntry = (id: string, body: Record<string, unknown>, msg: string) =>
    run(() => edgeFetch(`/api/admin/waitlist/${id}`, { method: "PATCH", json: body, silentGate: true }), msg);

  const addEntry = async () => {
    if (!newEmail.trim()) {
      toast.error("Email is required");
      return;
    }
    const ok = await run(
      () =>
        edgeFetch("/api/admin/waitlist", {
          method: "POST",
          json: { email: newEmail.trim(), full_name: newName.trim() || undefined, cohort: newCohort.trim() || undefined },
          silentGate: true,
        }),
      "Entry added",
    );
    if (ok) {
      setNewEmail("");
      setNewName("");
      setNewCohort("");
    }
  };

  const inviteSelected = () => {
    if (selected.size === 0) {
      toast.error("Select at least one entry to invite");
      return;
    }
    run(
      () =>
        edgeFetch("/api/admin/waitlist/invite", {
          method: "POST",
          json: { ids: Array.from(selected) },
          silentGate: true,
        }),
      `Invited ${selected.size} ${selected.size === 1 ? "person" : "people"}`,
    ).then((ok) => ok && setSelected(new Set()));
  };

  const inviteCohort = (cohort: string) =>
    run(
      () => edgeFetch("/api/admin/waitlist/invite", { method: "POST", json: { cohort }, silentGate: true }),
      `Invited everyone in "${cohort}"`,
    );

  const toggleGating = (enabled: boolean) =>
    run(
      () => edgeFetch("/api/admin/waitlist/gating", { method: "PUT", json: { enabled }, silentGate: true }),
      enabled ? "Gating ON — only approved accounts have access" : "Gating OFF — open access",
    );

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const entries = data?.entries ?? [];
  const s = data?.summary;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Waitlist & Early Access"
        subtitle="Review signups, approve and invite sellers in cohorts, and control the launch gate."
      />

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="h-4 w-4" />
          {(error as Error).message}
        </div>
      )}

      {/* Master gating switch */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Access gate
          </CardTitle>
          <CardDescription>
            When ON, only approved/invited accounts (and staff) can grade, list, or
            run AI flows. Everyone else sees the waitlist page. Off = open access.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div className="text-sm">
            Gate is currently{" "}
            <span className={data?.gatingActive ? "font-semibold text-green-600" : "font-semibold text-muted-foreground"}>
              {data?.gatingActive ? "ON" : "OFF"}
            </span>
          </div>
          {/* US-2335: the words beside this are a sentence ("Gate is currently
              ON"), not a label, so unnamed it announces "switch, on" with
              nothing saying what is gated. */}
          <Switch
            aria-label="Waitlist gating"
            checked={Boolean(data?.gatingActive)}
            disabled={working || isLoading}
            onCheckedChange={toggleGating}
          />
        </CardContent>
      </Card>

      {/* Summary chips */}
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {(["total", "pending", "approved", "invited", "rejected"] as const).map((k) => (
            <Card key={k}>
              <CardContent className="py-4">
                <div className="text-2xl font-bold">{s[k]}</div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{k}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Manual add */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Add to waitlist
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="wl-email">Email</Label>
              <Input id="wl-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="seller@example.com" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-name">Name</Label>
              <Input id="wl-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Optional" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-cohort">Cohort</Label>
              <Input id="wl-cohort" value={newCohort} onChange={(e) => setNewCohort(e.target.value)} placeholder="e.g. beta" />
            </div>
            <div className="flex items-end">
              <Button onClick={addEntry} disabled={working} className="w-full">
                Add
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Cohort quick-invite */}
      {cohortNames.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Cohorts</CardTitle>
            <CardDescription>Bulk-invite an entire cohort (pending + approved only).</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {cohortNames.map((name) => (
              <Button key={name} variant="outline" size="sm" disabled={working} onClick={() => inviteCohort(name)}>
                <Send className="mr-1 h-3.5 w-3.5" />
                {name} ({data?.cohorts[name]})
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Filters + list */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <CardTitle>Entries</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Search waitlist"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search email…"
                className="h-9 w-44"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-36" aria-label="Filter by status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="invited">Invited</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
              <Select value={cohortFilter} onValueChange={setCohortFilter}>
                <SelectTrigger className="h-9 w-36" aria-label="Filter by cohort"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All cohorts</SelectItem>
                  {cohortNames.map((n) => (
                    <SelectItem key={n} value={n}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={working || selected.size === 0} onClick={inviteSelected}>
                <Send className="mr-1 h-3.5 w-3.5" /> Invite selected ({selected.size})
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6"><Skeleton className="h-48 w-full" /></div>
          ) : entries.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No waitlist entries match your filters.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Cohort</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={selected.has(e.id)}
                        onChange={() => toggleSelect(e.id)}
                        aria-label={`Select ${e.email}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{e.email}</TableCell>
                    <TableCell>{e.full_name ?? "—"}</TableCell>
                    <TableCell>{e.cohort ?? "—"}</TableCell>
                    <TableCell>
                      <Badge className={STATUS_STYLES[e.status]} variant="secondary">{e.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(e.requested_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {e.status !== "approved" && e.status !== "invited" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={working}
                            aria-label={`Approve ${e.email}`}
                            onClick={() => patchEntry(e.id, { status: "approved" }, "Approved")}
                          >
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Approve
                          </Button>
                        )}
                        {e.status !== "invited" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={working}
                            aria-label={`Invite ${e.email}`}
                            onClick={() => run(() => edgeFetch("/api/admin/waitlist/invite", { method: "POST", json: { ids: [e.id] }, silentGate: true }), "Invited")}
                          >
                            <Send className="mr-1 h-3.5 w-3.5" /> Invite
                          </Button>
                        )}
                        {e.status !== "rejected" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={working}
                            aria-label={`Reject ${e.email}`}
                            onClick={() => patchEntry(e.id, { status: "rejected" }, "Rejected")}
                          >
                            <XCircle className="mr-1 h-3.5 w-3.5" /> Reject
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
