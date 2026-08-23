import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Headset,
  Loader2,
  Wrench,
  CheckCircle2,
  Archive,
  Send,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

// US-839: admin inbox for escalated AI-assistant conversations. Lists threads
// by status with the AI escalation summary + reason; opens a thread to read the
// full transcript (incl. which tools the assistant used); lets a human reply
// (notifies the user + sets awaiting_user) and resolve/close. Every read +
// mutation goes through the admin-MFA-gated /api/admin/support endpoints.

type ConversationStatus =
  | "open"
  | "awaiting_user"
  | "escalated"
  | "resolved"
  | "closed";

interface ConversationSummary {
  id: string;
  user_id: string;
  status: ConversationStatus;
  subject: string | null;
  escalation_reason: string | null;
  escalation_summary: string | null;
  escalation_trigger: "model" | "auto" | "user" | "crisis" | null;
  assigned_admin_id: string | null;
  assigned_admin_email: string | null;
  last_message_at: string;
  escalated_at: string | null;
  resolved_at: string | null;
  created_at: string;
  user_email: string | null;
  user_name: string | null;
}

interface ToolCall {
  id?: string;
  name?: string;
  input?: unknown;
}

interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "human_agent";
  content: string;
  tool_calls: ToolCall[] | null;
  model: string | null;
  flagged: boolean;
  flag_reason: string | null;
  created_at: string;
}

type StatusFilter = "all" | ConversationStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "escalated", label: "Escalated" },
  { value: "open", label: "Open" },
  { value: "awaiting_user", label: "Awaiting user" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const STATUS_STYLES: Record<ConversationStatus, string> = {
  escalated: "bg-brand-red/15 text-brand-red-text",
  open: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  awaiting_user: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  resolved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground",
};

// US-2667: a crisis handoff needs to be identifiable without opening it. The
// edge already sorts these to the top; this is what says WHY the top row is the
// top row. Deliberately not a colour change on the status badge - the status is
// still "escalated" and overloading it would lose that.
function CrisisBadge() {
  return (
    <Badge
      variant="secondary"
      className="bg-brand-red text-white"
      title="Possible crisis / self-harm language. Open this first."
    >
      urgent
    </Badge>
  );
}

function StatusBadge({ status }: { status: ConversationStatus }) {
  const label = status.replace("_", " ");
  return (
    <Badge variant="secondary" className={STATUS_STYLES[status]}>
      {label}
    </Badge>
  );
}

// Compact relative time (e.g. "3m ago", "2h ago", "5d ago").
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

const ROLE_LABEL: Record<TranscriptMessage["role"], string> = {
  user: "User",
  assistant: "Assistant",
  human_agent: "Support agent",
};

const ROLE_STYLES: Record<TranscriptMessage["role"], string> = {
  user: "border-border bg-muted/40",
  assistant: "border-brand-navy/20 bg-brand-navy/5",
  human_agent: "border-brand-red/20 bg-brand-red/5",
};

export function AdminSupportPage() {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>("escalated");
  const [reply, setReply] = useState("");
  const [acting, setActing] = useState(false);

  // ── List ──────────────────────────────────────────────────────────────────
  const listQuery = useQuery({
    queryKey: ["admin-support", "list", filter],
    queryFn: async (): Promise<ConversationSummary[]> => {
      const qs = filter === "all" ? "" : `?status=${filter}`;
      const res = await edgeFetch(`/api/admin/support/conversations${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load conversations");
      return (json.conversations ?? []) as ConversationSummary[];
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });

  // ── Open thread (driven by the route param so the escalation deep link
  //    /admin/support/:id opens the thread directly) ──────────────────────────
  const threadQuery = useQuery({
    queryKey: ["admin-support", "thread", routeId],
    enabled: !!routeId,
    queryFn: async (): Promise<
      { conversation: ConversationSummary; messages: TranscriptMessage[] }
    > => {
      const res = await edgeFetch(`/api/admin/support/conversations/${routeId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load conversation");
      return json;
    },
  });

  useEffect(() => {
    // Reset the draft whenever the open thread changes.
    setReply("");
  }, [routeId]);

  const openThread = (id: string) => navigate(`/admin/support/${id}`);
  const closeThread = () => navigate("/admin/support");

  const refreshThread = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-support", "thread", routeId] }),
      queryClient.invalidateQueries({ queryKey: ["admin-support", "list"] }),
    ]);
  };

  const sendReply = async () => {
    const body = reply.trim();
    if (!body || !routeId) return;
    setActing(true);
    try {
      const res = await edgeFetch(
        `/api/admin/support/conversations/${routeId}/reply`,
        { method: "POST", json: { message: body } },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Failed to send reply");
      }
      setReply("");
      toast.success("Reply sent — the user has been notified.");
      await refreshThread();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setActing(false);
    }
  };

  const resolveThread = async (close: boolean) => {
    if (!routeId) return;
    setActing(true);
    try {
      const res = await edgeFetch(
        `/api/admin/support/conversations/${routeId}/resolve`,
        { method: "POST", json: { close } },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Failed to update conversation");
      }
      toast.success(close ? "Conversation closed." : "Conversation resolved.");
      await refreshThread();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update conversation");
    } finally {
      setActing(false);
    }
  };

  const conversations = listQuery.data ?? [];
  const thread = threadQuery.data;
  const escalatedCount =
    conversations.filter((c) => c.status === "escalated").length;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Headset}
        title="AI Escalations"
        subtitle={
          <>
            Escalated AI-assistant conversations awaiting a human.
            {filter === "escalated" && escalatedCount > 0
              ? ` ${escalatedCount} escalated.`
              : ""}
          </>
        }
        actions={
          <Select value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
            <SelectTrigger className="w-48" aria-label="Filter conversations by status">
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
        }
      />

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
            : conversations.length === 0
            ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No conversations in this view.
              </p>
            )
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject / summary</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last activity</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {conversations.map((conv) => (
                    <ClickableRow
                      key={conv.id}
                      onActivate={() => openThread(conv.id)}
                      activateLabel={`Open ${conv.subject || "conversation"}`}
                    >
                      <TableCell className="max-w-md">
                        <div className="font-medium">
                          {conv.subject || "(no subject)"}
                        </div>
                        {(conv.escalation_summary || conv.escalation_reason) && (
                          <div className="line-clamp-2 text-xs text-muted-foreground">
                            {conv.escalation_summary || conv.escalation_reason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {conv.user_email ?? conv.user_id.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {conv.escalation_trigger === "crisis" && <CrisisBadge />}
                          <StatusBadge status={conv.status} />
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {relativeTime(conv.last_message_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                        aria-label={`Open ${conv.subject || "the untitled conversation"}`}
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            openThread(conv.id);
                          }}
                        >
                          Open
                        </Button>
                      </TableCell>
                    </ClickableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      {/* Thread detail — opened via the route param so the escalation
          notification's /admin/support/:id deep link lands here. */}
      <Sheet open={!!routeId} onOpenChange={(open) => !open && closeThread()}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 sm:max-w-xl"
        >
          <SheetHeader className="space-y-1 border-b pb-4">
            <SheetTitle className="flex items-center gap-2">
              {thread?.conversation.subject || "Conversation"}
              {thread?.conversation.escalation_trigger === "crisis" && (
                <CrisisBadge />
              )}
              {thread && <StatusBadge status={thread.conversation.status} />}
            </SheetTitle>
            <SheetDescription>
              {thread?.conversation.user_email ?? "—"}
              {thread?.conversation.escalation_trigger
                ? ` · escalated by ${thread.conversation.escalation_trigger}`
                : ""}
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
                {(thread.conversation.escalation_reason ||
                  thread.conversation.escalation_summary) && (
                  <div className="border-b bg-muted/30 p-4 text-sm">
                    {thread.conversation.escalation_reason && (
                      <p className="font-medium">
                        {thread.conversation.escalation_reason}
                      </p>
                    )}
                    {thread.conversation.escalation_summary && (
                      <p className="mt-1 text-muted-foreground">
                        {thread.conversation.escalation_summary}
                      </p>
                    )}
                  </div>
                )}

                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                  {thread.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-lg border p-3 text-sm ${ROLE_STYLES[m.role]}`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {ROLE_LABEL[m.role]}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {relativeTime(m.created_at)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap">{m.content}</p>
                      {m.tool_calls && m.tool_calls.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {m.tool_calls.map((t, i) => (
                            <span
                              key={t.id ?? i}
                              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                            >
                              <Wrench className="h-3 w-3" />
                              {t.name ?? "tool"}
                            </span>
                          ))}
                        </div>
                      )}
                      {m.flagged && (
                        <div className="mt-2 flex items-center gap-1 text-[11px] text-brand-red-text">
                          <AlertTriangle className="h-3 w-3" />
                          Flagged{m.flag_reason ? `: ${m.flag_reason}` : ""}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Reply + resolve controls */}
                <div className="space-y-2 border-t p-4">
                  <Textarea
                    aria-label="Reply to conversation"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Reply as a human support agent…"
                    rows={3}
                    maxLength={4000}
                    disabled={acting}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={acting}
                        onClick={() => resolveThread(false)}
                      >
                        <CheckCircle2 className="mr-1 h-4 w-4" />
                        Resolve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={acting}
                        onClick={() => resolveThread(true)}
                      >
                        <Archive className="mr-1 h-4 w-4" />
                        Close
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      disabled={acting || !reply.trim()}
                      onClick={sendReply}
                    >
                      {acting
                        ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        : <Send className="mr-1 h-4 w-4" />}
                      Send reply
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
