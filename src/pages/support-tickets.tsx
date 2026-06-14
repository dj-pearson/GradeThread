import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
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
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  LifeBuoy,
  Loader2,
  Send,
  Plus,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";

// US-900: user-facing support ticket inbox. A user opens a request, sees the
// thread (their messages + support replies — never operator internal notes),
// and replies. Every read/write goes through the authed /api/support-tickets
// endpoints, which tenant-scope to the caller.

type TicketStatus = "open" | "pending" | "resolved" | "closed";

interface TicketSummary {
  id: string;
  subject: string;
  status: TicketStatus;
  priority: "low" | "normal" | "high" | "urgent";
  last_message_at: string;
  resolved_at: string | null;
  created_at: string;
}

interface ThreadMessage {
  id: string;
  author: "you" | "support";
  body: string;
  created_at: string;
}

const STATUS_STYLES: Record<TicketStatus, string> = {
  open: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  resolved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground",
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

export function SupportTicketsPage() {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [reply, setReply] = useState("");
  const [acting, setActing] = useState(false);

  const listQuery = useQuery({
    queryKey: ["support-tickets", "list"],
    queryFn: async (): Promise<TicketSummary[]> => {
      const res = await edgeFetch("/api/support-tickets");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load tickets");
      return (json.tickets ?? []) as TicketSummary[];
    },
    staleTime: 30 * 1000,
  });

  const threadQuery = useQuery({
    queryKey: ["support-tickets", "thread", routeId],
    enabled: !!routeId,
    queryFn: async (): Promise<
      { ticket: TicketSummary; messages: ThreadMessage[] }
    > => {
      const res = await edgeFetch(`/api/support-tickets/${routeId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load ticket");
      return json;
    },
  });

  useEffect(() => {
    setReply("");
  }, [routeId]);

  const openTicket = (id: string) => navigate(`/dashboard/support/${id}`);
  const closeTicket = () => navigate("/dashboard/support");

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["support-tickets", "list"] }),
      queryClient.invalidateQueries({
        queryKey: ["support-tickets", "thread", routeId],
      }),
    ]);
  };

  const submitNew = async () => {
    const subject = newSubject.trim();
    const body = newBody.trim();
    if (!subject || !body) return;
    setActing(true);
    try {
      const res = await edgeFetch("/api/support-tickets", {
        method: "POST",
        json: { subject, body },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to open ticket");
      setNewSubject("");
      setNewBody("");
      setCreating(false);
      toast.success("Ticket opened — we'll get back to you soon.");
      await queryClient.invalidateQueries({
        queryKey: ["support-tickets", "list"],
      });
      if (json.ticket_id) openTicket(json.ticket_id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open ticket");
    } finally {
      setActing(false);
    }
  };

  const sendReply = async () => {
    const body = reply.trim();
    if (!body || !routeId) return;
    setActing(true);
    try {
      const res = await edgeFetch(`/api/support-tickets/${routeId}/messages`, {
        method: "POST",
        json: { body },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to send reply");
      setReply("");
      toast.success("Reply sent.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reply");
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
            <LifeBuoy className="h-6 w-6 text-brand-red" />
            Support
          </h1>
          <p className="text-sm text-muted-foreground">
            Open a request and track our replies — all in one place.
          </p>
        </div>
        {!creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New ticket
          </Button>
        )}
      </div>

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>Contact support</CardTitle>
            <CardDescription>
              Tell us what's going on and we'll get back to you.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ticket-subject">Subject</Label>
              <Input
                id="ticket-subject"
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                placeholder="Briefly, what do you need help with?"
                maxLength={200}
                disabled={acting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ticket-body">Message</Label>
              <Textarea
                id="ticket-body"
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                placeholder="Share as much detail as you can…"
                rows={5}
                maxLength={4000}
                disabled={acting}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setCreating(false)}
                disabled={acting}
              >
                Cancel
              </Button>
              <Button
                onClick={submitNew}
                disabled={acting || !newSubject.trim() || !newBody.trim()}
              >
                {acting
                  ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  : <Send className="mr-1 h-4 w-4" />}
                Open ticket
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {listQuery.isLoading
            ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 3 }).map((_, i) => (
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
                You don't have any support tickets yet.
              </p>
            )
            : (
              <ul className="divide-y">
                {tickets.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => openTicket(t.id)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{t.subject}</div>
                        <div className="text-xs text-muted-foreground">
                          Updated {relativeTime(t.last_message_at)}
                        </div>
                      </div>
                      <StatusBadge status={t.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>

      <Sheet open={!!routeId} onOpenChange={(open) => !open && closeTicket()}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
          <SheetHeader className="space-y-1 border-b pb-4">
            <SheetTitle className="flex items-center gap-2">
              {thread?.ticket.subject || "Ticket"}
              {thread && <StatusBadge status={thread.ticket.status} />}
            </SheetTitle>
            <SheetDescription>
              {thread
                ? `Opened ${relativeTime(thread.ticket.created_at)}`
                : "Loading…"}
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
                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                  {thread.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-lg border p-3 text-sm ${
                        m.author === "you"
                          ? "border-border bg-muted/40"
                          : "border-brand-navy/20 bg-brand-navy/5"
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {m.author === "you" ? "You" : "Support"}
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
                    placeholder="Add a reply…"
                    rows={3}
                    maxLength={4000}
                    disabled={acting}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <Button variant="ghost" size="sm" onClick={closeTicket}>
                      <ArrowLeft className="mr-1 h-4 w-4" />
                      Back
                    </Button>
                    <Button
                      size="sm"
                      disabled={acting || !reply.trim()}
                      onClick={sendReply}
                    >
                      {acting
                        ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        : <Send className="mr-1 h-4 w-4" />}
                      Send
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
