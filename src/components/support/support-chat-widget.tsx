import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  MessageCircle,
  Send,
  Sparkles,
  History,
  Plus,
  UserRound,
  Loader2,
  ChevronLeft,
  LifeBuoy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownPreview } from "@/components/admin/markdown-preview";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { usePlanPickerStore } from "@/stores/plan-picker-store";
import {
  fetchSupportConversation,
  isHumanHandled,
  streamSupportMessage,
  useSupportAssistantEligibility,
  useSupportConversations,
  type SupportConversationStatus,
  type SupportGateError,
  type SupportMessage,
  type SupportMessageRole,
} from "@/hooks/use-support-assistant";

// US-838 — in-app, tier-gated AI support chat. A floating launcher opens a Sheet
// with streaming assistant replies, conversation history, an explicit
// "Talk to a human" escalation, and live human-agent replies via the
// notifications Realtime channel. Backend: /api/support/assistant/*.

// Canned message that reliably trips the model's escalate_to_human tool — the
// system prompt escalates whenever "the user asks for a person" (US-837).
const TALK_TO_HUMAN_MESSAGE =
  "I'd like to talk to a human support agent, please.";

interface DisplayMessage {
  id: string;
  role: SupportMessageRole;
  content: string;
}

function toDisplay(m: SupportMessage): DisplayMessage {
  return { id: m.id, role: m.role, content: m.content };
}

function statusBannerText(status: SupportConversationStatus): string | null {
  switch (status) {
    case "escalated":
      return "Connected to our human support team — someone will reply here soon.";
    case "awaiting_user":
      return "A support agent replied. Add anything else and they'll follow up.";
    case "resolved":
      return "This conversation was marked resolved. Send a message to reopen it.";
    case "closed":
      return "This conversation is closed.";
    default:
      return null;
  }
}

export function SupportChatWidget() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  // US-844: the launch + tier-eligibility config lives server-side (the SPA
  // can't read feature_flags). The edge tells us whether the assistant is
  // launched at all (`enabled`) and whether this caller may chat (`eligible`).
  const eligibilityQuery = useSupportAssistantEligibility(Boolean(user?.id));
  const launched = eligibilityQuery.data?.enabled ?? false;
  const eligible = eligibilityQuery.data?.eligible ?? false;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [status, setStatus] = useState<SupportConversationStatus>("open");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [loadingConv, setLoadingConv] = useState(false);
  const [gate, setGate] = useState<{ code?: string; message: string } | null>(
    null,
  );

  // Latest active conversation id for use inside async callbacks/subscriptions.
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const scrollAnchor = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamingText, sending]);

  const conversationsQuery = useSupportConversations(open && eligible);

  const startNew = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setStatus("open");
    setGate(null);
    setView("chat");
  }, []);

  const openConversation = useCallback(async (id: string) => {
    setLoadingConv(true);
    setGate(null);
    setView("chat");
    try {
      const detail = await fetchSupportConversation(id);
      setActiveId(id);
      setMessages(detail.messages.map(toDisplay));
      setStatus(detail.conversation.status);
    } catch {
      setGate({ message: "Couldn't load that conversation. Please try again." });
    } finally {
      setLoadingConv(false);
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setGate(null);
      setView("chat");
      setMessages((m) => [
        ...m,
        { id: `u-${Date.now()}`, role: "user", content: trimmed },
      ]);
      setInput("");
      setSending(true);
      setStreamingText("");

      let assistantText = "";
      const gateErr = await streamSupportMessage(
        { message: trimmed, conversationId: activeIdRef.current },
        {
          onMeta: (id) => {
            activeIdRef.current = id;
            setActiveId(id);
          },
          onDelta: (t) => {
            assistantText += t;
            setStreamingText(assistantText);
          },
          onDone: (d) => {
            if (d.status) setStatus(d.status);
          },
        },
      ).catch(
        (): SupportGateError => ({
          status: 0,
          message:
            "Couldn't reach support right now. Check your connection and try again.",
        }),
      );

      setSending(false);
      setStreamingText("");

      if (gateErr) {
        setGate({ code: gateErr.code, message: gateErr.message });
      } else if (assistantText) {
        setMessages((m) => [
          ...m,
          { id: `a-${Date.now()}`, role: "assistant", content: assistantText },
        ]);
      }
      queryClient.invalidateQueries({ queryKey: ["support", "conversations"] });
    },
    [sending, queryClient],
  );

  // Live human-agent replies: an admin reply inserts a notifications row
  // (in the supabase_realtime publication). On any notification, refresh the
  // open conversation so a human reply appears without a manual refresh.
  useEffect(() => {
    if (!open || !user?.id) return;
    const channel = supabase
      .channel("support-chat-notifications")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${user.id}`,
        },
        async () => {
          const id = activeIdRef.current;
          queryClient.invalidateQueries({
            queryKey: ["support", "conversations"],
          });
          if (!id) return;
          try {
            const detail = await fetchSupportConversation(id);
            setMessages(detail.messages.map(toDisplay));
            setStatus(detail.conversation.status);
          } catch {
            /* best-effort live refresh */
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [open, user?.id, queryClient]);

  const humanHandled = isHumanHandled(status);
  const banner = statusBannerText(status);
  const notSubscribedGate = gate?.code === "not_subscribed" || !eligible;

  // Flipping the launch kill-switch off (or any signed-out / fetch-failed
  // state) fully removes the assistant — no launcher, no Sheet.
  if (!launched) return null;

  return (
    <>
      {/* Floating launcher */}
      <Button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open support assistant"
        className="fixed bottom-4 right-4 z-40 h-12 w-12 rounded-full bg-brand-navy p-0 shadow-lg hover:bg-brand-navy/90"
      >
        <MessageCircle className="h-5 w-5" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
        >
          <SheetHeader className="border-b">
            <div className="flex items-center gap-2 pr-8">
              {view === "history" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Back to chat"
                  onClick={() => setView("chat")}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              ) : (
                <Sparkles className="h-5 w-5 text-brand-navy" />
              )}
              <SheetTitle className="flex-1">
                {view === "history" ? "Your conversations" : "Support assistant"}
              </SheetTitle>
              {view === "chat" && eligible && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Conversation history"
                    title="Conversation history"
                    onClick={() => setView("history")}
                  >
                    <History className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="New conversation"
                    title="New conversation"
                    onClick={startNew}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
            <SheetDescription className="sr-only">
              Chat with the GradeThread support assistant.
            </SheetDescription>
          </SheetHeader>

          {/* Body */}
          {notSubscribedGate ? (
            <UpsellPanel />
          ) : view === "history" ? (
            <div className="flex-1 overflow-y-auto p-3">
              {conversationsQuery.isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (conversationsQuery.data?.length ?? 0) === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No conversations yet.
                </p>
              ) : (
                <ul className="space-y-1">
                  {conversationsQuery.data?.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => openConversation(c.id)}
                        className={cn(
                          "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                          c.id === activeId && "border-brand-navy bg-muted",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">
                            {c.subject || "Support conversation"}
                          </span>
                          <StatusBadge status={c.status} />
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(c.last_message_at).toLocaleString()}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4">
              {loadingConv ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : messages.length === 0 && !sending ? (
                <EmptyState />
              ) : (
                <div className="space-y-4">
                  {banner && (
                    <div className="flex items-start gap-2 rounded-md bg-brand-navy/5 px-3 py-2 text-xs text-brand-navy">
                      <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{banner}</span>
                    </div>
                  )}
                  {messages.map((m) => (
                    <MessageBubble key={m.id} message={m} />
                  ))}
                  {sending && (
                    <MessageBubble
                      message={{
                        id: "streaming",
                        role: "assistant",
                        content: streamingText,
                      }}
                      streaming
                    />
                  )}
                  <div ref={scrollAnchor} />
                </div>
              )}
            </div>
          )}

          {/* Composer */}
          {!notSubscribedGate && view === "chat" && (
            <div className="border-t p-3">
              {gate && (
                <div className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {gate.message}
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(input);
                }}
                className="flex items-end gap-2"
              >
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(input);
                    }
                  }}
                  placeholder={
                    humanHandled
                      ? "Add details for the support agent…"
                      : "Ask about grading, listings, billing…"
                  }
                  rows={1}
                  maxLength={4000}
                  disabled={sending}
                  className="max-h-32 min-h-[2.5rem] flex-1 resize-none"
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={sending || !input.trim()}
                  aria-label="Send message"
                  className="h-10 w-10 shrink-0"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </form>
              {!humanHandled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={sending}
                  onClick={() => void send(TALK_TO_HUMAN_MESSAGE)}
                  className="mt-2 h-auto px-1 py-1 text-xs text-muted-foreground hover:text-brand-navy"
                >
                  <LifeBuoy className="mr-1 h-3.5 w-3.5" />
                  Talk to a human
                </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function MessageBubble({
  message,
  streaming,
}: {
  message: DisplayMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isHuman = message.role === "human_agent";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-brand-navy text-white"
            : isHuman
              ? "border border-brand-navy/30 bg-brand-navy/5"
              : "bg-muted",
        )}
      >
        {isHuman && (
          <div className="mb-1 flex items-center gap-1 text-xs font-medium text-brand-navy">
            <UserRound className="h-3 w-3" />
            Support agent
          </div>
        )}
        {isUser ? (
          <span className="whitespace-pre-wrap break-words">
            {message.content}
          </span>
        ) : streaming && !message.content ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Thinking…
          </span>
        ) : (
          <MarkdownPreview source={message.content} />
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: SupportConversationStatus }) {
  const map: Record<
    SupportConversationStatus,
    { label: string; variant: "default" | "secondary" | "outline" }
  > = {
    open: { label: "Open", variant: "secondary" },
    awaiting_user: { label: "Reply ready", variant: "default" },
    escalated: { label: "With a human", variant: "default" },
    resolved: { label: "Resolved", variant: "outline" },
    closed: { label: "Closed", variant: "outline" },
  };
  const { label, variant } = map[status];
  return (
    <Badge variant={variant} className="shrink-0 text-[10px]">
      {label}
    </Badge>
  );
}

function EmptyState() {
  return (
    <div className="space-y-4 py-2 text-sm">
      <div className="flex items-center gap-2 text-brand-navy">
        <Sparkles className="h-5 w-5" />
        <span className="font-semibold">How can I help?</span>
      </div>
      <p className="text-muted-foreground">
        I'm GradeThread's support assistant. I can help with:
      </p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>Condition grading and reading your reports</li>
        <li>FlipDesk listings, sourcing, and reconciliation</li>
        <li>Your account, plan, and billing</li>
      </ul>
      <p className="text-muted-foreground">
        I can't access other users' data or take actions outside your account.
        If I can't help, I'll connect you with a human.
      </p>
    </div>
  );
}

function UpsellPanel() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="rounded-full bg-brand-navy/10 p-3">
        <Sparkles className="h-6 w-6 text-brand-navy" />
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold">Get the support assistant</h3>
        <p className="text-sm text-muted-foreground">
          In-app AI support is included with an active subscription. Upgrade to
          chat about grading, listings, and your account anytime — or reach a
          human when you need one.
        </p>
      </div>
      <Button
        onClick={() => usePlanPickerStore.getState().show()}
        className="bg-brand-navy hover:bg-brand-navy/90"
      >
        See plans
      </Button>
    </div>
  );
}
