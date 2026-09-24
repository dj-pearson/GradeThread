// US-3297: the buyer inbox as a table with an expandable reply row.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
//
// A stack of divs that printed every message body in full, unclipped, with a
// Reply button under each one. A buyer who pasted three paragraphs pushed the
// next four messages off the screen, and there was no ordering at all — not
// even newest first — so the inbox read in whatever order eBay's API felt like.
//
// The table shows sender, subject, a one-line preview and when it landed, newest
// first, with the full body and the reply box in a detail row. The preview is a
// line clamp rather than a substring so the seller can still see the first
// sentence of a long message without it owning the screen.
//
// ── "UNREAD" IS "UNANSWERED" ────────────────────────────────────────────────
//
// eBay does not tell us what the seller has READ, and a read/unread flag we
// invented would disagree with the eBay app they also use. `answered` is a fact
// eBay does report, and it is the one that matters: an answered message is done
// whether or not anyone re-opened it.

// ── OM-08..10 ───────────────────────────────────────────────────────────────
//
// Unsent replies live with the panel, so collapsing a row or crossing the md
// breakpoint keeps them. A paid AI draft is never discarded: with text already
// in the box it arrives as a suggestion to use or ignore. The box counts to
// eBay's 2000 characters, warns about contact details eBay flags, and sends on
// Cmd/Ctrl+Enter. Unanswered rows say how long the buyer has waited, a sent
// reply marks the row answered at once, and the inbox opens on "Needs reply"
// whenever something does.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquare,
  Reply,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pager,
  SortHeader,
  TableFilter,
} from "@/components/flipdesk/negotiation-table-parts";
import {
  resolveInventoryItemIdForEbayItem,
  useEbayMessages,
  useEbayReplyMessage,
  type EbayBuyerMessage,
} from "@/hooks/use-ebay";
import { useTenantKey } from "@/hooks/use-tenant-key";
import { useSessionDrafts } from "@/hooks/use-session-drafts";
import { useNegotiationDraft } from "@/hooks/use-ai-extract";
import {
  DEFAULT_MESSAGE_SORT,
  filterMessages,
  naturalMessageDir,
  nextSort,
  sortMessages,
  waitingLabel,
  type MessageSort,
  type MessageSortField,
} from "@/pages/flipdesk/offers-sort";
import { MEMBER_MESSAGE_MAX } from "@/lib/offer-limits";
import { describeContact, detectOffEbayContact } from "@/lib/off-ebay-contact";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

const NO_LOCAL_ITEM =
  "This listing isn't linked to a FlipDesk item, so there's nothing for the draft to read.";

/** `?filter=` values. Absent means "not decided yet": the panel picks once. */
const FILTER_NEEDS_REPLY = "needs-reply";
const FILTER_ALL = "all";

/** OM-08/09: one message's unsent reply, and an AI draft not yet used. */
export interface MessageDraft {
  text: string;
  suggestion: string | null;
}

const EMPTY_DRAFT: MessageDraft = { text: "", suggestion: null };

interface DraftSlot {
  value: MessageDraft;
  set: (next: MessageDraft) => void;
  clear: () => void;
}

/**
 * When it landed, at the precision a seller actually acts on.
 *
 * Hours for anything from today, because "2h ago" is the difference between a
 * reply that still wins the sale and one that does not. Older than a day falls
 * back to a date — "37h ago" is arithmetic, not information.
 */
function receivedLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const hours = Math.floor((now - at) / 3_600_000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
}

function snippet(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

export function BuyerMessagesPanel() {
  const {
    data: fetched = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useEbayMessages();
  const qc = useQueryClient();
  const tenantKey = useTenantKey();
  const drafts = useSessionDrafts<MessageDraft>("message-drafts");
  const [searchParams, setSearchParams] = useSearchParams();

  // OM-10: a reply the seller just sent is answered NOW, whatever eBay's copy
  // says. eBay catches up on its own schedule, and a row that still said
  // "Needs reply" after Send invited a second reply.
  const [repliedIds, setRepliedIds] = useState<Set<string>>(new Set());
  const messages = useMemo(
    () =>
      repliedIds.size === 0
        ? fetched
        : fetched.map((m) => (repliedIds.has(m.messageId) ? { ...m, answered: true } : m)),
    [fetched, repliedIds],
  );

  // OM-10: one clock for every "Waiting" label on the page.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const filterParam = searchParams.get("filter");
  const unansweredOnly = filterParam === FILTER_NEEDS_REPLY;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MessageSort>(DEFAULT_MESSAGE_SORT);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const unansweredCount = messages.filter((m) => !m.answered).length;

  function setUnansweredOnly(next: boolean) {
    const params = new URLSearchParams(searchParams);
    params.set("filter", next ? FILTER_NEEDS_REPLY : FILTER_ALL);
    setSearchParams(params, { replace: true });
  }

  // OM-10: the inbox opens on the work. Decided ONCE, after the first load,
  // and only when the URL has not already said; a seller who turned the
  // filter off keeps it off.
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || isLoading || error) return;
    decided.current = true;
    if (filterParam == null && unansweredCount > 0) setUnansweredOnly(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on first load
  }, [isLoading, error]);

  const rows = useMemo(() => {
    const base = unansweredOnly ? messages.filter((m) => !m.answered) : messages;
    return sortMessages(filterMessages(base, query), sort);
  }, [messages, unansweredOnly, query, sort]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [unansweredOnly, query, sort]);

  // OM-08: a draft for a message that has left the inbox is nobody's draft.
  const { retain } = drafts;
  useEffect(() => {
    if (isLoading || error) return;
    retain(fetched.map((m) => m.messageId));
  }, [fetched, isLoading, error, retain]);

  function toggleSort(field: MessageSortField) {
    setSort((s) => nextSort(s, field, naturalMessageDir(field)));
  }

  function toggleExpanded(id: string) {
    setExpanded((cur) => (cur === id ? null : id));
  }

  function slotFor(id: string): DraftSlot {
    return {
      value: drafts.get(id) ?? EMPTY_DRAFT,
      set: (next) => drafts.set(id, next),
      clear: () => drafts.clear(id),
    };
  }

  function onSent(message: EbayBuyerMessage, text: string) {
    setRepliedIds((prev) => new Set(prev).add(message.messageId));
    // The tab badge reads the same query, so it drops by one too.
    qc.setQueryData<EbayBuyerMessage[]>(["ebay_messages", tenantKey], (old) =>
      old?.map((m) => (m.messageId === message.messageId ? { ...m, answered: true } : m)),
    );
    setExpanded((cur) => (cur === message.messageId ? null : cur));
    toast.success(`You replied: "${snippet(text)}"`);
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4 text-brand-red-text" />
          Buyer messages
          {messages.length > 0 && (
            <Badge variant="secondary" className="ml-1 tabular-nums">
              {messages.length.toLocaleString()}
            </Badge>
          )}
        </CardTitle>
        {!isLoading && !error && messages.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <TableFilter
              value={query}
              onChange={setQuery}
              label="Filter messages"
              placeholder="Filter by buyer or text"
            />
            <Button
              size="sm"
              className="h-8"
              variant={unansweredOnly ? "default" : "outline"}
              aria-pressed={unansweredOnly}
              onClick={() => setUnansweredOnly(!unansweredOnly)}
            >
              Needs reply
              {unansweredCount > 0 && (
                <Badge variant="secondary" className="ml-1.5 tabular-nums">
                  {unansweredCount.toLocaleString()}
                </Badge>
              )}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : error ? (
          <ErrorState
            className="py-6"
            hideSupport
            title="Couldn't load messages"
            description={(error as Error).message}
            onRetry={() => refetch()}
            retrying={isFetching}
          />
        ) : messages.length === 0 ? (
          // US-2541: "no messages" reads as coverage the page does not have, so
          // the empty state says which marketplace it is speaking for.
          <EmptyState
            className="py-8"
            icon={MessageSquare}
            title="No recent buyer messages"
            description="eBay messages from the last 30 days appear here. Messages on your other marketplaces are not read by GradeThread."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={Check}
            title={unansweredOnly ? "Nothing needs a reply" : "No messages match that"}
            description={
              unansweredOnly
                ? "Every recent message has been answered. Turn off the filter to see them all."
                : "Clear the filter to see every recent message."
            }
          />
        ) : (
          <>
            <div className="space-y-2 md:hidden">
              {pageRows.map((m) => (
                <MessageCard
                  key={m.messageId}
                  message={m}
                  open={expanded === m.messageId}
                  onToggle={() => toggleExpanded(m.messageId)}
                  draft={slotFor(m.messageId)}
                  now={now}
                  onSent={onSent}
                />
              ))}
            </div>

            <div className="hidden rounded-md border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <SortHeader field="buyer" sort={sort} onSort={toggleSort}>
                      Buyer
                    </SortHeader>
                    <TableHead>Message</TableHead>
                    <SortHeader field="received" sort={sort} onSort={toggleSort}>
                      Received
                    </SortHeader>
                    <SortHeader field="status" sort={sort} onSort={toggleSort}>
                      Status
                    </SortHeader>
                    <TableHead className="text-right">Reply</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((m) => (
                    <MessageRows
                      key={m.messageId}
                      message={m}
                      open={expanded === m.messageId}
                      onToggle={() => toggleExpanded(m.messageId)}
                      draft={slotFor(m.messageId)}
                      now={now}
                      onSent={onSent}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            <Pager
              page={safePage}
              pageCount={pageCount}
              total={rows.length}
              noun={rows.length === 1 ? "message" : "messages"}
              onPage={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Whether eBay gave us enough to answer this at all. */
function canReplyTo(message: EbayBuyerMessage): boolean {
  return !!message.itemId && !!message.senderUsername;
}

const WAITING_DOT: Record<"neutral" | "amber" | "red", string> = {
  neutral: "bg-muted-foreground/50",
  amber: "bg-amber-500",
  red: "bg-brand-red",
};

function StatusBadge({ message, now }: { message: EbayBuyerMessage; now: number }) {
  if (message.answered) {
    return (
      <Badge variant="secondary" className="text-[10px] font-normal">
        Replied
      </Badge>
    );
  }
  // OM-10: a two-day-old question must not look like a new one. A dot and
  // weight carry the urgency; the absolute time is in the title.
  const waiting = waitingLabel(message.creationDate, now);
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Badge variant="outline" className="text-[10px] font-normal">
        Needs reply
      </Badge>
      {waiting && (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs tabular-nums",
            waiting.tone === "neutral" ? "text-muted-foreground" : "font-medium",
            waiting.tone === "red" && "text-brand-red-text",
          )}
          title={message.creationDate ? new Date(message.creationDate).toLocaleString() : undefined}
        >
          <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", WAITING_DOT[waiting.tone])} />
          {waiting.label}
        </span>
      )}
    </span>
  );
}

function DraftChip() {
  return (
    <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-xs font-normal">
      Draft
    </Badge>
  );
}

interface RowProps {
  message: EbayBuyerMessage;
  open: boolean;
  onToggle: () => void;
  draft: DraftSlot;
  now: number;
  onSent: (message: EbayBuyerMessage, text: string) => void;
}

function MessageRows({ message, open, onToggle, draft, now, onSent }: RowProps) {
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const canReply = canReplyTo(message);

  function openAndFocusReply() {
    if (!open) onToggle();
    setTimeout(() => replyRef.current?.focus(), 0);
  }

  function collapseToChevron() {
    if (open) onToggle();
    setTimeout(() => chevronRef.current?.focus(), 0);
  }

  return (
    <>
      <TableRow
        className="cursor-pointer align-top"
        data-state={open ? "selected" : undefined}
        onClick={onToggle}
      >
        <TableCell className="pr-0">
          <button
            ref={chevronRef}
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide message" : "Show message"}
            className="text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {open ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </TableCell>
        <TableCell className="text-sm font-medium">
          {message.senderUsername || "Buyer"}
          {!open && draft.value.text.trim() !== "" && <DraftChip />}
        </TableCell>
        <TableCell className="max-w-[28rem] whitespace-normal">
          {message.subject && (
            <span className="block truncate text-sm">{message.subject}</span>
          )}
          {message.body && (
            <span className="line-clamp-1 text-xs text-muted-foreground">
              {message.body}
            </span>
          )}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {receivedLabel(message.creationDate, now)}
        </TableCell>
        <TableCell>
          <StatusBadge message={message} now={now} />
        </TableCell>
        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={!canReply}
            title={canReply ? undefined : "This message can't be replied to here."}
            onClick={openAndFocusReply}
          >
            <Reply className="mr-1 h-3.5 w-3.5" /> Reply
          </Button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={6} className="whitespace-normal p-4">
            <MessageDetail
              message={message}
              replyRef={replyRef}
              draft={draft}
              onSent={onSent}
              onEscape={collapseToChevron}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function MessageCard({ message, open, onToggle, draft, now, onSent }: RowProps) {
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const canReply = canReplyTo(message);

  function openAndFocusReply() {
    if (!open) onToggle();
    setTimeout(() => replyRef.current?.focus(), 0);
  }

  function collapseToToggle() {
    if (open) onToggle();
    setTimeout(() => toggleRef.current?.focus(), 0);
  }

  return (
    <div className="rounded-md border">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium">
            {message.senderUsername || "Buyer"}
            {message.subject ? ` · ${message.subject}` : ""}
            {!open && draft.value.text.trim() !== "" && <DraftChip />}
          </span>
          <StatusBadge message={message} now={now} />
        </div>
        {message.body && (
          <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
            {message.body}
          </span>
        )}
        <span className="mt-1 block text-xs text-muted-foreground">
          {receivedLabel(message.creationDate, now)}
        </span>
      </button>
      <div className="px-3 pb-3">
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={!canReply}
          title={canReply ? undefined : "This message can't be replied to here."}
          onClick={openAndFocusReply}
        >
          <Reply className="mr-1 h-3.5 w-3.5" /> Reply
        </Button>
      </div>
      {open && (
        <div className="border-t bg-muted/30 p-3">
          <MessageDetail
            message={message}
            replyRef={replyRef}
            draft={draft}
            onSent={onSent}
            onEscape={collapseToToggle}
          />
        </div>
      )}
    </div>
  );
}

function MessageDetail({
  message,
  replyRef,
  draft,
  onSent,
  onEscape,
}: {
  message: EbayBuyerMessage;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  draft: DraftSlot;
  onSent: (message: EbayBuyerMessage, text: string) => void;
  onEscape: () => void;
}) {
  const reply = useEbayReplyMessage();
  const ai = useNegotiationDraft();
  const { text, suggestion } = draft.value;
  const canReply = canReplyTo(message);
  const trimmed = text.trim();
  const tooLong = trimmed.length > MEMBER_MESSAGE_MAX;
  const contact = useMemo(() => detectOffEbayContact(text), [text]);
  const countId = `reply-count-${message.messageId}`;
  const contactId = `reply-contact-${message.messageId}`;
  const canSend = canReply && trimmed !== "" && !tooLong && !reply.isPending;

  function setText(next: string) {
    draft.set({ ...draft.value, text: next });
  }

  // US-2494: one AI action per press. The message carries eBay's item id; the
  // drafter reads the local inventory row, so resolve one to the other first.
  async function draftReply() {
    if (!message.itemId) return;
    let itemId: string | null;
    try {
      itemId = await resolveInventoryItemIdForEbayItem(message.itemId);
    } catch (error) {
      toastError(error, "Couldn't load the linked inventory item. Try again.");
      return;
    }
    if (!itemId) {
      toast.error(NO_LOCAL_ITEM);
      return;
    }
    const result = await ai
      .mutateAsync({
        item_id: itemId,
        mode: "reply",
        buyer_message: message.body ?? undefined,
      })
      .catch(() => null); // toasted by the hook's shared AI error mapping
    if (!result?.message) return;
    // OM-09: the seller paid for this draft. An empty box takes it; a box with
    // text keeps the text and holds the draft beside it as a suggestion.
    if (trimmed === "") draft.set({ text: result.message, suggestion: null });
    else draft.set({ text, suggestion: result.message });
  }

  async function send() {
    if (!canSend || !message.itemId || !message.senderUsername) return;
    try {
      await reply.mutateAsync({
        messageId: message.messageId,
        itemId: message.itemId,
        recipientId: message.senderUsername,
        body: trimmed,
      });
      draft.clear();
      onSent(message, trimmed);
    } catch (err) {
      toastError(err, "Couldn't reply.");
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // The contact warning still needs its own click; the shortcut does not
      // skip it.
      if (contact.length === 0) void send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
    }
  }

  return (
    <div className="space-y-3">
      {message.body && (
        <blockquote className="whitespace-pre-wrap rounded-md bg-background p-3 text-sm text-muted-foreground">
          {message.body}
        </blockquote>
      )}
      {!canReply ? (
        <p className="text-sm text-muted-foreground">
          eBay didn't send a listing or a sender for this one, so it can't be
          answered from here. Reply in the eBay app.
        </p>
      ) : (
        <>
          {suggestion && (
            <div className="space-y-2 rounded-md bg-background p-3">
              <p className="text-xs font-medium">AI suggestion</p>
              <p className="whitespace-pre-wrap text-sm">{suggestion}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => draft.set({ text: suggestion, suggestion: null })}
                >
                  Replace
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() =>
                    draft.set({ text: `${text.trimEnd()}\n\n${suggestion}`, suggestion: null })}
                >
                  Insert below
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => draft.set({ text, suggestion: null })}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          <Textarea
            ref={replyRef}
            aria-label="Reply to this buyer"
            aria-describedby={contact.length > 0 ? `${countId} ${contactId}` : countId}
            aria-invalid={tooLong ? true : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder="Your reply"
          />
          <p
            id={countId}
            className={cn(
              "text-right text-xs tabular-nums",
              tooLong ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            {trimmed.length.toLocaleString()} / {MEMBER_MESSAGE_MAX.toLocaleString()}
          </p>
          {contact.length > 0 && (
            <div
              id={contactId}
              className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                This reply has {describeContact(contact)}. eBay can block messages
                that move a sale off eBay.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7"
                disabled={!canSend}
                onClick={() => void send()}
              >
                Send anyway
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void send()}
              disabled={!canSend || contact.length > 0}
            >
              {reply.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Reply className="mr-2 h-3.5 w-3.5" />
              )}
              Send reply
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={reply.isPending || ai.isPending}
              onClick={draftReply}
            >
              {ai.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-3.5 w-3.5" />
              )}
              Draft with AI
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Drafting spends one AI action. If you have already typed, the draft
            shows as a suggestion and your text stays as it is. Cmd or Ctrl +
            Enter sends.
          </p>
        </>
      )}
    </div>
  );
}
