import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
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
import { PageHeader } from "@/components/ui/page-header";
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
  ArrowLeft,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { ErrorState } from "@/components/ui/error-state";
import {
  AttachmentPicker,
  type PickedAttachment,
} from "@/components/support/attachment-picker";
import { TicketDeflector } from "@/components/help/ticket-deflector";
import { EmptyState } from "@/components/ui/empty-state";

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
  // US-2525. `url` is a signed URL minted per read and short-lived, so it is
  // never stored or cached anywhere but this response.
  attachments?: {
    path: string;
    name: string;
    content_type: string;
    bytes: number;
    url: string | null;
  }[];
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
  // US-2525: images staged for the next message, on either form.
  const [newAttachments, setNewAttachments] = useState<PickedAttachment[]>([]);
  const [replyAttachments, setReplyAttachments] = useState<PickedAttachment[]>([]);

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
    // US-2525: an open thread refetches while the user is looking at it. There
    // was neither a poll nor realtime here, so a support reply appeared only if
    // the user happened to reload the page — while iOS has offered
    // pull-to-refresh since it shipped.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    setReply("");
    setReplyAttachments([]);
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

  // US-2585: what the deflector offered, and what they opened before filing
  // anyway. A ticket that carries an opened slug is a WRONG article, not a
  // missing one, and nothing else tells the two apart.
  const [helpSuggested, setHelpSuggested] = useState<{
    shown: string[];
    opened: string | null;
  }>({ shown: [], opened: null });

  const submitNew = async () => {
    const subject = newSubject.trim();
    const body = newBody.trim();
    if (!subject || !body) return;
    setActing(true);
    try {
      const res = await edgeFetch("/api/support-tickets", {
        method: "POST",
        json: {
          subject,
          body,
          help_articles_shown: helpSuggested.shown,
          help_article_opened: helpSuggested.opened,
          attachments: newAttachments.map((a) => ({
            data_url: a.dataUrl,
            name: a.name,
          })),
        },
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
        json: {
          body,
          attachments: replyAttachments.map((a) => ({
            data_url: a.dataUrl,
            name: a.name,
          })),
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to send reply");
      setReply("");
      setReplyAttachments([]);
      toast.success("Reply sent.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setActing(false);
    }
  };

  // US-2525: a user could open a ticket and reply to it but never end it, so
  // the queue carried conversations both sides had finished with.
  const closeOwnTicket = async () => {
    if (!routeId) return;
    setActing(true);
    try {
      const res = await edgeFetch(`/api/support-tickets/${routeId}/close`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to close ticket");
      toast.success("Ticket closed.", {
        description: "Replying to it reopens it any time.",
      });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to close ticket");
    } finally {
      setActing(false);
    }
  };

  const tickets = listQuery.data ?? [];
  const thread = threadQuery.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Support"
        subtitle="Open a request and track our replies — all in one place."
        icon={LifeBuoy}
        actions={
          !creating && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" />
              New ticket
            </Button>
          )
        }
      />

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
            {/* US-2585: above the submit button, because a suggestion below it
                is a suggestion nobody reads. */}
            <TicketDeflector subject={newSubject} onSuggestions={setHelpSuggested} />
            {/* US-2525: the reason someone opens a ticket is often a picture. */}
            <AttachmentPicker
              attachments={newAttachments}
              onChange={setNewAttachments}
              disabled={acting}
            />
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
              // US-2525: a bare red line with no way to try again. US-436's
              // rule is one shared error state, with a retry, everywhere.
              <ErrorState
                title="Couldn't load your tickets"
                description={(listQuery.error as Error)?.message}
                onRetry={() => listQuery.refetch()}
                retrying={listQuery.isFetching}
              />
            )
            : tickets.length === 0
            ? (
              <EmptyState
                icon={LifeBuoy}
                title="No support tickets yet"
                description="Open one when something is wrong or you are stuck. You will get an email when we reply, and the whole thread stays here."
                action={{ label: "New ticket", onClick: () => setCreating(true) }}
              />
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
              <ErrorState
                title="Couldn't load this ticket"
                description={(threadQuery.error as Error)?.message}
                onRetry={() => threadQuery.refetch()}
                retrying={threadQuery.isFetching}
              />
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
                      {/* US-2525. The URLs are signed and short-lived, so they
                          are used straight from this response and never
                          stored anywhere. */}
                      {(m.attachments ?? []).length > 0 && (
                        <ul className="mt-2 flex flex-wrap gap-2">
                          {(m.attachments ?? []).map((a) => (
                            <li key={a.path}>
                              {a.url
                                ? (
                                  <a
                                    href={a.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={a.name}
                                  >
                                    <img
                                      src={a.url}
                                      alt={a.name}
                                      loading="lazy"
                                      className="h-20 w-20 rounded border object-cover"
                                    />
                                  </a>
                                )
                                : (
                                  <span className="flex h-20 w-20 items-center justify-center rounded border p-1 text-center text-[10px] text-muted-foreground">
                                    Link expired — reload
                                  </span>
                                )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>

                <div className="space-y-2 border-t p-4">
                  <Textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    aria-label="Reply to support"
                placeholder="Add a reply…"
                    rows={3}
                    maxLength={4000}
                    disabled={acting}
                  />
                  <AttachmentPicker
                    attachments={replyAttachments}
                    onChange={setReplyAttachments}
                    disabled={acting}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button variant="ghost" size="sm" onClick={closeTicket}>
                      <ArrowLeft className="mr-1 h-4 w-4" />
                      Back
                    </Button>
                    {/* US-2525: the user ends their own conversation. Closed,
                        not resolved — resolved is support's verdict that the
                        problem was fixed. A reply reopens it either way. */}
                    {thread.ticket.status !== "closed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={acting}
                        onClick={closeOwnTicket}
                      >
                        <Check className="mr-1 h-4 w-4" />
                        Close ticket
                      </Button>
                    )}
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
