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

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
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
import { useNegotiationDraft } from "@/hooks/use-ai-extract";
import { applyNegotiationDraft } from "@/pages/flipdesk/negotiation-draft-prefill";
import {
  DEFAULT_MESSAGE_SORT,
  filterMessages,
  naturalMessageDir,
  nextSort,
  sortMessages,
  type MessageSort,
  type MessageSortField,
} from "@/pages/flipdesk/offers-sort";

const PAGE_SIZE = 25;

const NO_LOCAL_ITEM =
  "This listing isn't linked to a FlipDesk item, so there's nothing for the draft to read.";

/**
 * When it landed, at the precision a seller actually acts on.
 *
 * Hours for anything from today, because "2h ago" is the difference between a
 * reply that still wins the sale and one that does not. Older than a day falls
 * back to a date — "37h ago" is arithmetic, not information.
 */
function receivedLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const hours = Math.floor((Date.now() - at) / 3_600_000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
}

export function BuyerMessagesPanel() {
  const {
    data: messages = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useEbayMessages();

  const [unansweredOnly, setUnansweredOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MessageSort>(DEFAULT_MESSAGE_SORT);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const unansweredCount = messages.filter((m) => !m.answered).length;
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

  function toggleSort(field: MessageSortField) {
    setSort((s) => nextSort(s, field, naturalMessageDir(field)));
  }

  function toggleExpanded(id: string) {
    setExpanded((cur) => (cur === id ? null : id));
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
              onClick={() => setUnansweredOnly((v) => !v)}
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

function StatusBadge({ message }: { message: EbayBuyerMessage }) {
  return message.answered ? (
    <Badge variant="secondary" className="text-[10px] font-normal">
      Replied
    </Badge>
  ) : (
    <Badge variant="outline" className="text-[10px] font-normal">
      Needs reply
    </Badge>
  );
}

function MessageRows({
  message,
  open,
  onToggle,
}: {
  message: EbayBuyerMessage;
  open: boolean;
  onToggle: () => void;
}) {
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const canReply = canReplyTo(message);

  function openAndFocusReply() {
    if (!open) onToggle();
    setTimeout(() => replyRef.current?.focus(), 0);
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
          {receivedLabel(message.creationDate)}
        </TableCell>
        <TableCell>
          <StatusBadge message={message} />
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
            <MessageDetail message={message} replyRef={replyRef} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function MessageCard({
  message,
  open,
  onToggle,
}: {
  message: EbayBuyerMessage;
  open: boolean;
  onToggle: () => void;
}) {
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const canReply = canReplyTo(message);

  function openAndFocusReply() {
    if (!open) onToggle();
    setTimeout(() => replyRef.current?.focus(), 0);
  }

  return (
    <div className="rounded-md border">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium">
            {message.senderUsername || "Buyer"}
            {message.subject ? ` · ${message.subject}` : ""}
          </span>
          <StatusBadge message={message} />
        </div>
        {message.body && (
          <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
            {message.body}
          </span>
        )}
        <span className="mt-1 block text-xs text-muted-foreground">
          {receivedLabel(message.creationDate)}
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
          <MessageDetail message={message} replyRef={replyRef} />
        </div>
      )}
    </div>
  );
}

function MessageDetail({
  message,
  replyRef,
}: {
  message: EbayBuyerMessage;
  replyRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const qc = useQueryClient();
  const reply = useEbayReplyMessage();
  const draft = useNegotiationDraft();
  const [text, setText] = useState("");
  const canReply = canReplyTo(message);

  // US-2494: one AI action per press. The message carries eBay's item id; the
  // drafter reads the local inventory row, so resolve one to the other first.
  async function draftReply() {
    if (!message.itemId) return;
    const itemId = await resolveInventoryItemIdForEbayItem(message.itemId);
    if (!itemId) {
      toast.error(NO_LOCAL_ITEM);
      return;
    }
    const result = await draft
      .mutateAsync({
        item_id: itemId,
        mode: "reply",
        buyer_message: message.body ?? undefined,
      })
      .catch(() => null); // toasted by the hook's shared AI error mapping
    if (!result) return;
    setText(applyNegotiationDraft({ price: "", note: text }, result).note);
  }

  async function send() {
    if (!text.trim()) {
      toast.error("Enter a reply.");
      return;
    }
    if (!message.itemId || !message.senderUsername) return;
    try {
      await reply.mutateAsync({
        messageId: message.messageId,
        itemId: message.itemId,
        recipientId: message.senderUsername,
        body: text.trim(),
      });
      await qc.invalidateQueries({ queryKey: ["ebay_messages"] });
      toast.success("Reply sent.");
      setText("");
    } catch (err) {
      toastError(err, "Couldn't reply.");
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
          <Textarea
            ref={replyRef}
            aria-label="Reply to this buyer"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Your reply"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={send} disabled={reply.isPending}>
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
              disabled={reply.isPending || draft.isPending}
              onClick={draftReply}
            >
              {draft.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-3.5 w-3.5" />
              )}
              Draft with AI
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Drafting spends one AI action and never overwrites what you typed.
          </p>
        </>
      )}
    </div>
  );
}
