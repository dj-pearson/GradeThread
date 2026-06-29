import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Ticket,
  Loader2,
  Send,
  AlertTriangle,
  Lock,
  UserCheck,
} from "lucide-react";
import { toast } from "sonner";
import { AdminSavedViews } from "@/components/admin/admin-saved-views";

// US-900: admin triage queue for user-opened support tickets. List by status,
// filter to "mine"; open a ticket to read the full thread (incl. operator-only
// internal notes), reply (public or internal), set priority/status, and assign.
// Every read + mutation goes through the admin-MFA-gated
// /api/admin/support-tickets endpoints.

type TicketStatus = "open" | "pending" | "resolved" | "closed";
type Priority = "low" | "normal" | "high" | "urgent";

interface TicketSummary {
  id: string;
  user_id: string;
  subject: string;
  status: TicketStatus;
  priority: Priority;
  assigned_admin_id: string | null;
  assigned_admin_email: string | null;
  last_message_at: string;
  resolved_at: string | null;
  created_at: string;
  user_email: string | null;
  user_name: string | null;
}

interface TicketMessage {
  id: string;
  author: "user" | "admin";
  author_email: string | null;
  body: string;
  is_internal_note: boolean;
  created_at: string;
}

type StatusFilter = "all" | TicketStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const STATUS_STYLES: Record<TicketStatus, string> = {
  open: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  resolved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground",
};

const PRIORITY_STYLES: Record<Priority, string> = {
  low: "bg-muted text-muted-foreground",
  normal: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  high: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  urgent: "bg-brand-red/15 text-brand-red-text",
};

function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <Badge variant="secondary" className={STATUS_STYLES[status]}>
      {status}
    </Badge>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function AdminSupportTicketsPage() {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [mineOnly, setMineOnly] = useState(false);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [acting, setActing] = useState(false);

  const listQuery = useQuery({
    queryKey: ["admin-tickets", "list", filter, mineOnly],
    queryFn: async (): Promise<TicketSummary[]> => {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      if (mineOnly) params.set("assignee", "me");
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await edgeFetch(`/api/admin/support-tickets${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load tickets");
      return (json.tickets ?? []) as TicketSummary[];
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });

  const threadQuery = useQuery({
    queryKey: ["admin-tickets", "thread", routeId],
    enabled: !!routeId,
    queryFn: async (): Promise<
      { ticket: TicketSummary; messages: TicketMessage[] }
    > => {
      const res = await edgeFetch(`/api/admin/support-tickets/${routeId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load ticket");
      return json;
    },
  });

  useEffect(() => {
    setReply("");
    setInternal(false);
  }, [routeId]);

  const openTicket = (id: string) => navigate(`/admin/support-tickets/${id}`);
  const closeTicket = () => navigate("/admin/support-tickets");

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-tickets", "list"] }),
      queryClient.invalidateQueries({
        queryKey: ["admin-tickets", "thread", routeId],
      }),
    ]);
  };

  const sendReply = async () => {
    const body = reply.trim();
    if (!body || !routeId) return;
    setActing(true);
    try {
      const res = await edgeFetch(
        `/api/admin/support-tickets/${routeId}/reply`,
        { method: "POST", json: { body, internal } },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to send reply");
      setReply("");
      toast.success(
        internal ? "Internal note added." : "Reply sent — the user was notified.",
      );
      setInternal(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setActing(false);
    }
  };

  const patchTicket = async (
    updates: { status?: TicketStatus; priority?: Priority; assignee?: string | null },
    successMsg: string,
  ) => {
    if (!routeId) return;
    setActing(true);
    try {
      const res = await edgeFetch(`/api/admin/support-tickets/${routeId}`, {
        method: "PATCH",
        json: updates,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to update ticket");
      toast.success(successMsg);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update ticket");
    } finally {
      setActing(false);
    }
  };

  const tickets = listQuery.data ?? [];
  const thread = threadQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Ticket className="h-6 w-6 text-brand-red" />
            Support tickets
          </h1>
          <p className="text-sm text-muted-foreground">
            User-opened requests. Triage, reply, and resolve.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="st-mine-only" className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              id="st-mine-only"
              checked={mineOnly}
              onCheckedChange={(v) => setMineOnly(v === true)}
            />
            Assigned to me
          </label>
          <Select
            value={filter}
            onValueChange={(v) => setFilter(v as StatusFilter)}
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
          <AdminSavedViews
            surface="tickets"
            currentFilter={{ filter, mineOnly }}
            onApply={(f) => {
              if (typeof f.filter === "string") setFilter(f.filter as StatusFilter);
              setMineOnly(f.mineOnly === true);
            }}
          />
        </div>
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
            : tickets.length === 0
            ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No tickets in this view.
              </p>
            )
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Assignee</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tickets.map((t) => (
                    <TableRow
                      key={t.id}
                      className="cursor-pointer"
                      onClick={() => openTicket(t.id)}
                    >
                      <TableCell className="max-w-xs">
                        <div className="truncate font-medium">{t.subject}</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {t.user_email ?? t.user_id.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={PRIORITY_STYLES[t.priority]}
                        >
                          {t.priority}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {t.assigned_admin_email ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {relativeTime(t.last_message_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      <Sheet open={!!routeId} onOpenChange={(open) => !open && closeTicket()}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
          <SheetHeader className="space-y-1 border-b pb-4">
            <SheetTitle className="flex items-center gap-2">
              {thread?.ticket.subject || "Ticket"}
              {thread && <StatusBadge status={thread.ticket.status} />}
            </SheetTitle>
            <SheetDescription>
              {thread?.ticket.user_email ?? "—"}
            </SheetDescription>
          </SheetHeader>

          {threadQuery.isLoading
            ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )
            : threadQuery.isError
            ? (
              <div className="flex flex-1 items-center gap-2 p-4 text-sm text-brand-red-text">
                <AlertTriangle className="h-4 w-4" />
                {(threadQuery.error as Error)?.message ?? "Failed to load."}
              </div>
            )
            : thread
            ? (
              <>
                {/* Triage controls */}
                <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 p-3">
                  <Select
                    value={thread.ticket.status}
                    onValueChange={(v) =>
                      patchTicket({ status: v as TicketStatus }, "Status updated.")}
                  >
                    <SelectTrigger className="h-8 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["open", "pending", "resolved", "closed"] as TicketStatus[]).map(
                        (s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <Select
                    value={thread.ticket.priority}
                    onValueChange={(v) =>
                      patchTicket({ priority: v as Priority }, "Priority updated.")}
                  >
                    <SelectTrigger className="h-8 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["low", "normal", "high", "urgent"] as Priority[]).map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    disabled={acting}
                    onClick={() =>
                      patchTicket({ assignee: "me" }, "Assigned to you.")}
                  >
                    <UserCheck className="mr-1 h-3.5 w-3.5" />
                    Assign to me
                  </Button>
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                  {thread.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-lg border p-3 text-sm ${
                        m.is_internal_note
                          ? "border-amber-500/30 bg-amber-500/10"
                          : m.author === "user"
                          ? "border-border bg-muted/40"
                          : "border-brand-navy/20 bg-brand-navy/5"
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {m.is_internal_note && <Lock className="h-3 w-3" />}
                          {m.is_internal_note
                            ? "Internal note"
                            : m.author === "user"
                            ? "User"
                            : "Support"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {relativeTime(m.created_at)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                    </div>
                  ))}
                </div>

                <div className="space-y-2 border-t p-4">
                  <Textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder={internal
                      ? "Add an internal note (the user never sees this)…"
                      : "Reply to the user…"}
                    rows={3}
                    maxLength={4000}
                    disabled={acting}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="st-internal" className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                      <Checkbox
                        id="st-internal"
                        checked={internal}
                        onCheckedChange={(v) => setInternal(v === true)}
                      />
                      Internal note
                    </label>
                    <Button
                      size="sm"
                      disabled={acting || !reply.trim()}
                      onClick={sendReply}
                    >
                      {acting
                        ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        : internal
                        ? <Lock className="mr-1 h-4 w-4" />
                        : <Send className="mr-1 h-4 w-4" />}
                      {internal ? "Add note" : "Send reply"}
                    </Button>
                  </div>
                </div>
              </>
            )
            : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
