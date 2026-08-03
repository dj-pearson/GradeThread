import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { ClickableRow } from "@/components/clickable-row";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ShieldCheck,
  Loader2,
  Download,
  Trash2,
  AlertTriangle,
  Ban,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

// US-903: admin compliance queue for GDPR/CCPA data-subject requests. List by
// status/type; open a request to run the export (assembles a signed-URL
// archive) or process a deletion (super_admin + a fresh MFA step-up + an
// explicit confirm — a staged anonymize/erase that retains financial/audit
// records). Every read + mutation goes through the admin-MFA-gated
// /api/admin/compliance endpoints.

type ReqType = "export" | "delete";
type ReqStatus = "received" | "processing" | "completed" | "rejected";

interface DataRequest {
  id: string;
  user_id: string;
  type: ReqType;
  status: ReqStatus;
  requested_at: string;
  completed_at: string | null;
  file_path: string | null;
  requested_by: string | null;
  source: string;
  notes: string | null;
  user_email: string | null;
  user_name: string | null;
  requested_by_email: string | null;
}

type StatusFilter = "all" | ReqStatus;
type TypeFilter = "all" | ReqType;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "received", label: "Received" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

const STATUS_STYLES: Record<ReqStatus, string> = {
  received: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  processing: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-muted text-muted-foreground",
};

const DELETE_CONFIRM = "ERASE USER DATA";
// US-2356: deliberately NOT the same phrase as the delete. One shared string
// becomes muscle memory, and the point of typing it is to notice which of the
// two irreversible things you are about to do — erase a person's data, or hand
// all of it to whoever holds the signed link.
const EXPORT_CONFIRM = "EXPORT USER DATA";

function StatusBadge({ status }: { status: ReqStatus }) {
  return (
    <Badge variant="secondary" className={STATUS_STYLES[status]}>
      {status}
    </Badge>
  );
}

function TypeBadge({ type }: { type: ReqType }) {
  return (
    <Badge
      variant="secondary"
      className={type === "delete"
        ? "bg-brand-red/15 text-brand-red-text"
        : "bg-slate-500/15 text-slate-700 dark:text-slate-300"}
    >
      {type}
    </Badge>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
}

export function AdminCompliancePage() {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  // US-2197: pause the 60s poll while the tab is backgrounded.
  const visible = useDocumentVisible();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("received");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [acting, setActing] = useState(false);
  const [confirmErase, setConfirmErase] = useState("");
  const [confirmExport, setConfirmExport] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  // New-request form.
  const [newUserId, setNewUserId] = useState("");
  const [newType, setNewType] = useState<ReqType>("export");

  const listQuery = useQuery({
    queryKey: ["admin-compliance", "list", statusFilter, typeFilter],
    queryFn: async (): Promise<DataRequest[]> => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("type", typeFilter);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await edgeFetch(`/api/admin/compliance/data-requests${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load requests");
      return (json.requests ?? []) as DataRequest[];
    },
    staleTime: 30 * 1000,
    refetchInterval: visible ? 60 * 1000 : false,
  });

  const detailQuery = useQuery({
    queryKey: ["admin-compliance", "detail", routeId],
    enabled: !!routeId,
    queryFn: async (): Promise<DataRequest> => {
      const res = await edgeFetch(`/api/admin/compliance/data-requests/${routeId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load request");
      return json.request as DataRequest;
    },
  });

  useEffect(() => {
    setConfirmErase("");
    setRejectReason("");
  }, [routeId]);

  const open = (id: string) => navigate(`/admin/compliance/${id}`);
  const close = () => navigate("/admin/compliance");

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-compliance", "list"] }),
      queryClient.invalidateQueries({
        queryKey: ["admin-compliance", "detail", routeId],
      }),
    ]);
  };

  const createRequest = async () => {
    const userId = newUserId.trim();
    if (!userId) {
      toast.error("Enter the subject user's id.");
      return;
    }
    setActing(true);
    try {
      const res = await edgeFetch("/api/admin/compliance/data-requests", {
        method: "POST",
        json: { user_id: userId, type: newType },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to create request");
      toast.success("Request created.");
      setNewUserId("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create request");
    } finally {
      setActing(false);
    }
  };

  const runExport = async () => {
    if (!routeId) return;
    setActing(true);
    try {
      const res = await edgeFetch(
        `/api/admin/compliance/data-requests/${routeId}/process`,
        { method: "POST", json: { confirm: EXPORT_CONFIRM } },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to run export");
      toast.success("Export assembled.");
      if (json.signed_url) window.open(json.signed_url as string, "_blank", "noopener");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to run export");
    } finally {
      setActing(false);
    }
  };

  const download = async () => {
    if (!routeId) return;
    setActing(true);
    try {
      const res = await edgeFetch(
        `/api/admin/compliance/data-requests/${routeId}/download`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to get download link");
      if (json.signed_url) window.open(json.signed_url as string, "_blank", "noopener");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to get download link");
    } finally {
      setActing(false);
    }
  };

  const runErase = async () => {
    if (!routeId || confirmErase !== DELETE_CONFIRM) return;
    setActing(true);
    try {
      const res = await edgeFetch(
        `/api/admin/compliance/data-requests/${routeId}/process`,
        { method: "POST", json: { confirm: DELETE_CONFIRM } },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to process erasure");
      toast.success("User data erased (financial/audit records retained).");
      setConfirmErase("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to process erasure");
    } finally {
      setActing(false);
    }
  };

  const reject = async () => {
    if (!routeId || !rejectReason.trim()) return;
    setActing(true);
    try {
      const res = await edgeFetch(
        `/api/admin/compliance/data-requests/${routeId}/reject`,
        { method: "POST", json: { reason: rejectReason.trim() } },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to reject request");
      toast.success("Request rejected.");
      setRejectReason("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reject request");
    } finally {
      setActing(false);
    }
  };

  const requests = listQuery.data ?? [];
  const detail = detailQuery.data;
  const actionable = detail &&
    (detail.status === "received" || detail.status === "processing");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data subject requests"
        subtitle={
          <>
            GDPR/CCPA export &amp; deletion queue. Exports are delivered via a
            short-lived signed link; deletions are a staged anonymize/erase that
            retains financial &amp; audit records.
          </>
        }
        icon={ShieldCheck}
      />

      {/* New request */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex-1 min-w-[240px] space-y-1">
            <Label htmlFor="new-user-id">Subject user id</Label>
            <Input
              id="new-user-id"
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
              placeholder="user UUID"
            />
          </div>
          <div className="space-y-1">
            <Label>Type</Label>
            <Select value={newType} onValueChange={(v) => setNewType(v as ReqType)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="export">Export</SelectItem>
                <SelectItem value="delete">Delete</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={createRequest} disabled={acting}>
            <Plus className="mr-1 h-4 w-4" />
            Create request
          </Button>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusFilter)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={typeFilter}
          onValueChange={(v) => setTypeFilter(v as TypeFilter)}
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="export">Export</SelectItem>
            <SelectItem value="delete">Delete</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {listQuery.isLoading
            ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            )
            : listQuery.isError
            ? (
              <div className="flex items-center gap-2 p-6 text-sm text-brand-red-text">
                <AlertTriangle className="h-4 w-4" />
                {(listQuery.error as Error)?.message ?? "Failed to load."}
              </div>
            )
            : requests.length === 0
            ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No requests in this view.
              </p>
            )
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Requested</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((r) => (
                    <ClickableRow
                      key={r.id}
                      onActivate={() => open(r.id)}
                      activateLabel={`View request from ${r.user_email ?? r.user_id.slice(0, 8)}`}
                    >
                      <TableCell className="text-sm">
                        {r.user_email ?? r.user_id.slice(0, 8)}
                      </TableCell>
                      <TableCell><TypeBadge type={r.type} /></TableCell>
                      <TableCell><StatusBadge status={r.status} /></TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.source}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {fmtDate(r.requested_at)}
                      </TableCell>
                    </ClickableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      <Sheet open={!!routeId} onOpenChange={(o) => !o && close()}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
          <SheetHeader className="space-y-1 border-b pb-4">
            <SheetTitle className="flex items-center gap-2">
              {detail ? <TypeBadge type={detail.type} /> : "Request"}
              {detail && <StatusBadge status={detail.status} />}
            </SheetTitle>
            <SheetDescription>
              {detail?.user_email ?? detail?.user_id ?? "—"}
            </SheetDescription>
          </SheetHeader>

          {detailQuery.isLoading
            ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )
            : detailQuery.isError
            ? (
              <div className="flex flex-1 items-center gap-2 p-4 text-sm text-brand-red-text">
                <AlertTriangle className="h-4 w-4" />
                {(detailQuery.error as Error)?.message ?? "Failed to load."}
              </div>
            )
            : detail
            ? (
              <div className="flex-1 space-y-5 overflow-y-auto p-4">
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">User id</dt>
                    <dd className="font-mono text-xs">{detail.user_id}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Source</dt>
                    <dd>{detail.source}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Requested by</dt>
                    <dd>{detail.requested_by_email ?? detail.requested_by ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Requested at</dt>
                    <dd>{fmtDate(detail.requested_at)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Completed at</dt>
                    <dd>{fmtDate(detail.completed_at)}</dd>
                  </div>
                  {detail.notes && (
                    <div className="space-y-1">
                      <dt className="text-muted-foreground">Notes</dt>
                      <dd className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs">
                        {detail.notes}
                      </dd>
                    </div>
                  )}
                </dl>

                {/* Export actions */}
                {detail.type === "export" && (
                  <div className="space-y-2 border-t pt-4">
                    {actionable && (
                      !isSuperAdmin
                        ? (
                          <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Ban className="h-4 w-4" />
                            Assembling an export requires super admin.
                          </p>
                        )
                        : (
                          <>
                            <Label htmlFor="confirm-export" className="text-sm">
                              Type <span className="font-mono">{EXPORT_CONFIRM}</span> to confirm
                            </Label>
                            <Input
                              id="confirm-export"
                              value={confirmExport}
                              onChange={(e) => setConfirmExport(e.target.value)}
                              placeholder={EXPORT_CONFIRM}
                            />
                            <Button
                              onClick={runExport}
                              disabled={acting || confirmExport !== EXPORT_CONFIRM}
                              className="w-full"
                            >
                              {acting
                                ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                                : <Download className="mr-1 h-4 w-4" />}
                              Assemble &amp; download export
                            </Button>
                            <p className="text-xs text-muted-foreground">
                              Produces a signed link to this user's complete archive —
                              submissions, inventory, listings, sales and stored files.
                              Anyone with the link can read all of it.
                            </p>
                          </>
                        )
                    )}
                    {detail.status === "completed" && detail.file_path && (
                      <Button
                        variant="outline"
                        onClick={download}
                        disabled={acting}
                        className="w-full"
                      >
                        <Download className="mr-1 h-4 w-4" />
                        Download archive (fresh link)
                      </Button>
                    )}
                  </div>
                )}

                {/* Delete actions — super_admin + step-up + confirm string */}
                {detail.type === "delete" && actionable && (
                  <div className="space-y-2 border-t pt-4">
                    {!isSuperAdmin
                      ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Ban className="h-4 w-4" />
                          Processing a deletion requires super admin.
                        </p>
                      )
                      : (
                        <>
                          <Label htmlFor="confirm-erase" className="text-sm">
                            Type <span className="font-mono">{DELETE_CONFIRM}</span> to confirm
                          </Label>
                          <Input
                            id="confirm-erase"
                            value={confirmErase}
                            onChange={(e) => setConfirmErase(e.target.value)}
                            placeholder={DELETE_CONFIRM}
                          />
                          <Button
                            variant="destructive"
                            onClick={runErase}
                            disabled={acting || confirmErase !== DELETE_CONFIRM}
                            className="w-full"
                          >
                            {acting
                              ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                              : <Trash2 className="mr-1 h-4 w-4" />}
                            Erase user data
                          </Button>
                          <p className="text-xs text-muted-foreground">
                            Staged anonymize/erase. Purges photos, tokens &amp; API
                            keys; anonymizes &amp; bans the account. Sales, payouts
                            &amp; audit logs are retained per policy.
                          </p>
                        </>
                      )}
                  </div>
                )}

                {/* Reject */}
                {actionable && (
                  <div className="space-y-2 border-t pt-4">
                    <Label htmlFor="reject-reason" className="text-sm">
                      Reject request
                    </Label>
                    <Textarea
                      id="reject-reason"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Reason (recorded on the request)…"
                      rows={2}
                      disabled={acting}
                    />
                    <Button
                      variant="outline"
                      onClick={reject}
                      disabled={acting || !rejectReason.trim()}
                      className="w-full"
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            )
            : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
