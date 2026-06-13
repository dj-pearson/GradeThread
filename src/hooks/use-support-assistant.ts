import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-838 — client for the AI Support Assistant edge endpoints
// (services/edge-functions/src/routes/support-assistant.ts, mounted at
// /api/support/assistant). All calls go through edgeFetch with `silentGate`
// so the widget renders gate/limit responses as friendly inline states rather
// than letting the global 402/X-Plan-Warning UI take over.

export type SupportMessageRole = "user" | "assistant" | "human_agent";
export type SupportConversationStatus =
  | "open"
  | "awaiting_user"
  | "escalated"
  | "resolved"
  | "closed";

export interface SupportMessage {
  id: string;
  role: SupportMessageRole;
  content: string;
  created_at: string;
}

export interface SupportConversationSummary {
  id: string;
  status: SupportConversationStatus;
  subject: string | null;
  last_message_at: string;
  escalated_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface SupportConversationDetail {
  conversation: SupportConversationSummary & {
    escalation_reason?: string | null;
    escalation_summary?: string | null;
    escalation_trigger?: string | null;
  };
  messages: SupportMessage[];
}

// A human-handled thread: the bot stays out of the way and the user waits for
// a person. Mirrors HUMAN_HANDLED_STATUSES on the server.
export function isHumanHandled(status: SupportConversationStatus): boolean {
  return status === "escalated" || status === "awaiting_user";
}

// ── Conversation history ────────────────────────────────────────────────────

export function useSupportConversations(enabled: boolean) {
  return useQuery({
    queryKey: ["support", "conversations"],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<SupportConversationSummary[]> => {
      const res = await edgeFetch("/api/support/assistant/conversations", {
        silentGate: true,
      });
      if (!res.ok) throw new Error("Failed to load conversations");
      const data = (await res.json()) as {
        conversations?: SupportConversationSummary[];
      };
      return data.conversations ?? [];
    },
  });
}

export async function fetchSupportConversation(
  id: string,
): Promise<SupportConversationDetail> {
  const res = await edgeFetch(`/api/support/assistant/conversations/${id}`, {
    silentGate: true,
  });
  if (!res.ok) throw new Error("Failed to load conversation");
  return (await res.json()) as SupportConversationDetail;
}

// ── Streaming a message turn (SSE) ───────────────────────────────────────────

// A gate/limit/refusal that came back as a non-200 (403 not_subscribed/locked,
// 429 rate_limited_*/daily_*_cap). Surfaced inline, never as a raw error.
export interface SupportGateError {
  status: number;
  code?: string;
  message: string;
}

export interface SupportStreamDone {
  conversationId: string;
  escalated?: boolean;
  status?: SupportConversationStatus;
  guarded?: boolean;
  hitCap?: boolean;
  metered?: boolean;
}

export interface SupportStreamCallbacks {
  onMeta?: (conversationId: string) => void;
  onDelta?: (text: string) => void;
  onDone?: (done: SupportStreamDone) => void;
  onError?: (message: string) => void;
}

function dispatchEvent(raw: string, cb: SupportStreamCallbacks) {
  // Each SSE record is one or more `event:`/`data:` lines.
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  switch (event) {
    case "meta":
      if (typeof payload.conversationId === "string") {
        cb.onMeta?.(payload.conversationId);
      }
      break;
    case "delta":
      if (typeof payload.text === "string") cb.onDelta?.(payload.text);
      break;
    case "done":
      cb.onDone?.(payload as unknown as SupportStreamDone);
      break;
    case "error":
      cb.onError?.(
        typeof payload.message === "string"
          ? payload.message
          : "Something went wrong.",
      );
      break;
  }
}

// POSTs a turn and consumes the SSE stream, invoking callbacks as tokens land.
// Returns a SupportGateError when the request was rejected before streaming
// (subscription/lockout/rate-limit); returns null on a normal streamed turn.
export async function streamSupportMessage(
  args: { message: string; conversationId: string | null },
  cb: SupportStreamCallbacks,
  signal?: AbortSignal,
): Promise<SupportGateError | null> {
  const res = await edgeFetch("/api/support/assistant/message", {
    method: "POST",
    json: {
      message: args.message,
      conversationId: args.conversationId ?? undefined,
    },
    silentGate: true,
    signal,
  });

  if (!res.ok || !res.body) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON error body */
    }
    const message =
      (typeof body.error === "string" && body.error) ||
      (typeof body.message === "string" && body.message) ||
      "Something went wrong. Please try again.";
    return {
      status: res.status,
      code: typeof body.code === "string" ? body.code : undefined,
      message,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const record = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (record.trim()) dispatchEvent(record, cb);
    }
  }
  if (buffer.trim()) dispatchEvent(buffer, cb);
  return null;
}
