// US-834: AI Support Assistant engine — verified, gated, streaming edge route.
// Mounted at /api/support/assistant (auth + workspace middleware applied in
// main.ts). Endpoints:
//   POST /message            — stream an assistant reply over SSE; persist the
//                              user + assistant turns and meter tokens.
//   GET  /conversations      — list the caller's own conversations.
//   GET  /conversations/:id  — one conversation + its transcript (no system rows).
//
// Pipeline per POST /message:
//   1. authMiddleware verified the JWT and set userId; workspaceMiddleware set
//      workspaceOwnerId (the tenant billing + reads are scoped to).
//   2. GATE — reject non-subscribers and locked-out users BEFORE any model call.
//   3. Load/create the conversation; append the user message.
//   4. Run the bounded Claude tool-use loop (Haiku via ai-config) with ONLY the
//      read-only + KB + escalate tools.
//   5. Stream the reply over SSE, then persist the assistant turn + token counts
//      and meter usage (streaming bypasses the limiter's create() path, so we
//      meter explicitly post-stream — US-831 incrementUsage).

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  getAnthropicClient,
  getLightweightModel,
  isCachingEnabled,
} from "../lib/ai-config.ts";
import {
  applySupportLockout,
  bumpSupportMinuteCounter,
  countHighSeverityAbuseEvents,
  getSupportLockoutCount,
  getTodaySupportUsage,
  incrementUsage,
  recordAbuseEvent,
} from "../lib/support-metering.ts";
import {
  classifyJailbreakHeuristic,
  combineVerdicts,
  evaluateLockout,
  evaluateRateLimit,
  type HeuristicVerdict,
  makeHaikuClassifier,
  SUPPORT_ABUSE_THRESHOLDS,
} from "../lib/support-abuse.ts";
import { effectivePlanFor } from "../lib/grade-pricing.ts";
import type { FlipdeskPlan } from "../lib/pricing-config.ts";
import { notifyUser } from "../lib/notify.ts";
import { sendSupportAbuseAlertEmail } from "../lib/email.ts";
import {
  ASSISTANT_TOOLS,
  type AssistantStep,
  evaluateAssistantGate,
  executeAssistantTool,
  guardAssistantOutput,
  MAX_TOOL_ITERATIONS,
  runAssistantLoop,
  SUPPORT_SYSTEM_PROMPT,
  TOOL_CAP_FALLBACK,
  type ToolContext,
} from "../lib/support-assistant-engine.ts";

export const supportAssistantRoutes = new Hono<{
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
}>();

// Max prior turns of context replayed into the model (keeps the prompt bounded).
const MAX_HISTORY_MESSAGES = 20;
// Cap a single user message length (defense against flood/abuse + prompt budget).
const MAX_MESSAGE_CHARS = 4000;

// ── Gate: resolve subscription (owner) + lockout (user), then decide ──────────
async function loadGateAndDecide(userId: string, ownerId: string) {
  // subscription_status lives on the workspace owner (billing). lockout is on
  // the chatting user (per-abuser). One read when they're the same id.
  const ids = userId === ownerId ? [userId] : [userId, ownerId];
  const { data } = await supabaseAdmin
    .from("users")
    .select("id, subscription_status, support_assistant_locked_until")
    .in("id", ids);
  const rows = (data ?? []) as Array<{
    id: string;
    subscription_status: string | null;
    support_assistant_locked_until: string | null;
  }>;
  const ownerRow = rows.find((r) => r.id === ownerId) ?? null;
  const userRow = rows.find((r) => r.id === userId) ?? null;
  return evaluateAssistantGate({
    subscription_status: ownerRow?.subscription_status ?? null,
    support_assistant_locked_until: userRow?.support_assistant_locked_until ??
      null,
  });
}

// ── Abuse controls (US-836): rate caps + jailbreak/flood detection + lockout ──

// Resolve the owner's EFFECTIVE plan tier — the per-tier caps in
// SUPPORT_ABUSE_THRESHOLDS key off this. Defaults to the strictest tier (free)
// if the row can't be read.
async function resolveEffectivePlan(ownerId: string): Promise<FlipdeskPlan> {
  const { data } = await supabaseAdmin
    .from("users")
    .select(
      "flipdesk_plan, subscription_status, trial_ends_at, past_due_since",
    )
    .eq("id", ownerId)
    .maybeSingle();
  const u = data as {
    flipdesk_plan?: string | null;
    subscription_status?: string | null;
    trial_ends_at?: string | null;
    past_due_since?: string | null;
  } | null;
  if (!u) return "free";
  return effectivePlanFor(
    u.flipdesk_plan ?? "free",
    u.subscription_status ?? null,
    u.trial_ends_at ?? null,
    new Date(),
    u.past_due_since ?? null,
  ) as FlipdeskPlan;
}

// Alert the platform admins that a user was auto-locked: in-app to every
// admin/super_admin + an email to the configured abuse-alert inbox. Best-effort
// — never throws (an alert failure must not change the enforcement outcome).
async function alertAdminsOfLockout(
  userId: string,
  reason: string,
  cooldownMs: number,
  lockoutCount: number,
): Promise<void> {
  const cooldownMinutes = Math.max(1, Math.round(cooldownMs / 60000));
  try {
    const { data: locked } = await supabaseAdmin
      .from("users")
      .select("email")
      .eq("id", userId)
      .maybeSingle();
    const userEmail = (locked as { email?: string } | null)?.email ?? userId;

    // In-app: notify every admin / super_admin (mirrors the dispute-filed flow).
    const { data: admins } = await supabaseAdmin
      .from("users")
      .select("id")
      .in("role", ["admin", "super_admin"]);
    for (const a of (admins ?? []) as Array<{ id: string }>) {
      await notifyUser(a.id, {
        type: "system",
        title: "Support assistant abuse lockout",
        message:
          `${userEmail} was locked out of the support assistant for ` +
          `${cooldownMinutes}m (${reason}).`,
        link: "/admin",
      });
    }

    // Email the abuse-alert inbox (categorized → durable retry).
    const to = Deno.env.get("SUPPORT_ABUSE_ALERT_EMAIL") ||
      Deno.env.get("SMTP_ADMIN_EMAIL") || "";
    if (to) {
      await sendSupportAbuseAlertEmail(to, {
        userEmail,
        userId,
        reason,
        cooldownMinutes,
        lockoutCount,
      });
    }
  } catch (e) {
    console.error(
      "[support-assistant] lockout alert failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

export type AbuseControlResult =
  | { ok: true }
  | {
    ok: false;
    status: 403 | 429;
    code: string;
    message: string;
    retryAfterSeconds?: number;
  };

// The pre-turn abuse pipeline. Runs AFTER the gate, BEFORE any conversation
// write or model call, so an abusive/over-cap turn never costs a token:
//   1. per-minute + per-day message/token caps (per plan tier),
//   2. jailbreak/injection classification (heuristic + best-effort Haiku),
//   3. accumulation → graduated lockout (sets support_assistant_locked_until,
//      which the gate honors) + admin alert.
async function runPreTurnAbuseControls(
  userId: string,
  ownerId: string,
  message: string,
  conversationId: string | null,
  now: Date = new Date(),
): Promise<AbuseControlResult> {
  const plan = await resolveEffectivePlan(ownerId);

  // (1) Rate caps. Bump the per-minute counter first, then read today's rollup.
  const minuteCount = await bumpSupportMinuteCounter(userId, now);
  const today = await getTodaySupportUsage(userId);
  const rate = evaluateRateLimit({
    plan,
    minuteCount,
    dayMessageCount: today.messageCount,
    dayTokenCount: today.inputTokens + today.outputTokens,
  }, now);

  let dailyCapExceeded = false;
  if (!rate.allowed) {
    if (rate.code === "rate_limited_minute") {
      // Record the burst as a flood event (HIGH when it's a hard burst — that
      // severity counts toward the lockout threshold).
      await recordAbuseEvent(
        userId,
        "flood",
        rate.flood ? "high" : "medium",
        `per-minute burst: ${minuteCount} msgs/min (cap ${
          SUPPORT_ABUSE_THRESHOLDS.perMinuteMessageCap[plan]
        })`,
        conversationId ?? undefined,
      );
    } else {
      dailyCapExceeded = true;
    }
  } else {
    // (2) Classifier — only worth running on a turn we'd otherwise process.
    const heuristic = classifyJailbreakHeuristic(message);
    let model: HeuristicVerdict = { flagged: false };
    try {
      const classify = makeHaikuClassifier(
        getAnthropicClient(),
        getLightweightModel(),
      );
      model = await classify(message);
    } catch {
      model = { flagged: false };
    }
    const verdict = combineVerdicts(heuristic, model);
    if (verdict.flagged && verdict.type && verdict.severity) {
      await recordAbuseEvent(
        userId,
        verdict.type,
        verdict.severity,
        `classifier flag (${verdict.marker ?? "unknown"})`,
        conversationId ?? undefined,
      );
    }
  }

  // (3) Accumulation → graduated lockout. Count high-severity events INCLUDING
  // any just recorded this turn, then decide.
  const sinceIso = new Date(now.getTime() - SUPPORT_ABUSE_THRESHOLDS.abuseWindowMs)
    .toISOString();
  const highSeverityEventsInWindow = await countHighSeverityAbuseEvents(
    userId,
    sinceIso,
  );
  const priorLockouts = await getSupportLockoutCount(userId);
  const lockout = evaluateLockout({
    highSeverityEventsInWindow,
    dailyCapExceeded,
    priorLockouts,
  }, now);

  if (lockout.lock) {
    const newCount = await applySupportLockout(
      userId,
      lockout.lockedUntil.toISOString(),
    );
    await alertAdminsOfLockout(
      userId,
      lockout.reason,
      lockout.cooldownMs,
      newCount ?? priorLockouts + 1,
    );
    return {
      ok: false,
      status: 403,
      code: "locked",
      message:
        "Access to the support assistant has been temporarily paused due to " +
        "unusual activity. Please try again later, or contact support if you " +
        "think this is a mistake.",
    };
  }

  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      code: rate.code,
      message: rate.message,
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }

  return { ok: true };
}

// ── Build the live streaming step (one model turn, relaying text deltas) ───────
function makeStreamingStep(
  onText: (text: string) => Promise<void>,
  signal: AbortSignal,
): (messages: Anthropic.MessageParam[]) => Promise<AssistantStep> {
  const client = getAnthropicClient();
  const model = getLightweightModel();
  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? {
      type: "text",
      text: SUPPORT_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    }
    : { type: "text", text: SUPPORT_SYSTEM_PROMPT };

  return async (messages) => {
    const stream = client.messages.stream({
      model,
      max_tokens: 1024,
      system: [systemBlock],
      tools: ASSISTANT_TOOLS,
      messages,
    }, signal ? { signal } : undefined);

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        await onText(event.delta.text);
      }
    }

    const final = await stream.finalMessage();
    const text = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolUses = final.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      text,
      toolUses,
      stopReason: final.stop_reason,
      usage: {
        inputTokens: final.usage.input_tokens +
          (final.usage.cache_read_input_tokens ?? 0) +
          (final.usage.cache_creation_input_tokens ?? 0),
        outputTokens: final.usage.output_tokens,
      },
      assistantContent: final.content as Anthropic.ContentBlockParam[],
    };
  };
}

// Rebuild the model message history from the stored transcript. Only user +
// assistant TEXT turns are replayed (tool_use/tool_result blocks are transient
// within a turn and never persisted as replayable context).
async function loadHistory(
  conversationId: string,
): Promise<Anthropic.MessageParam[]> {
  const { data } = await supabaseAdmin
    .from("support_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY_MESSAGES);
  const rows = (data ?? []) as Array<{ role: string; content: string }>;
  return rows
    .filter((r) => r.content && r.content.trim().length > 0)
    .map((r) => ({
      role: r.role === "assistant" ? "assistant" : "user",
      content: r.content,
    } as Anthropic.MessageParam));
}

// ── POST /message ─────────────────────────────────────────────────────────────
supportAssistantRoutes.post("/message", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;

  // GATE — before anything that costs a token.
  const gate = await loadGateAndDecide(userId, ownerId);
  if (!gate.allowed) {
    return c.json({ error: gate.message, code: gate.code }, gate.status);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    message?: unknown;
    conversationId?: unknown;
  };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return c.json(
      { error: `message exceeds ${MAX_MESSAGE_CHARS} characters` },
      400,
    );
  }
  const conversationIdArg = typeof body.conversationId === "string"
    ? body.conversationId
    : null;

  // ABUSE CONTROLS (US-836) — rate caps + jailbreak/flood detection + graduated
  // lockout — BEFORE any conversation write or model call. A tripped limit
  // returns a clear, non-leaking message (and an abusive turn never costs a
  // token). Lockout is set here; the gate (above) honors it on the next turn.
  const abuse = await runPreTurnAbuseControls(
    userId,
    ownerId,
    message,
    conversationIdArg,
  );
  if (!abuse.ok) {
    if (abuse.retryAfterSeconds !== undefined) {
      c.header("Retry-After", String(abuse.retryAfterSeconds));
    }
    return c.json({ error: abuse.message, code: abuse.code }, abuse.status);
  }

  // Load (must be the caller's own) or create the conversation.
  let conversationId: string;
  if (conversationIdArg) {
    const { data: conv } = await supabaseAdmin
      .from("support_conversations")
      .select("id")
      .eq("id", conversationIdArg)
      .eq("user_id", userId) // tenant scope: caller's own thread only
      .maybeSingle();
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
    conversationId = (conv as { id: string }).id;
  } else {
    const { data: created, error } = await supabaseAdmin
      .from("support_conversations")
      .insert({
        user_id: userId,
        workspace_owner_id: ownerId,
        status: "open",
        subject: message.slice(0, 80),
      } as never)
      .select("id")
      .single();
    if (error || !created) {
      return c.json({ error: "Could not start conversation" }, 500);
    }
    conversationId = (created as { id: string }).id;
  }

  // Persist the user turn before the model runs (so an aborted stream still
  // leaves the question on record).
  await supabaseAdmin
    .from("support_messages")
    .insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
    } as never);

  const history = await loadHistory(conversationId);
  const ctx: ToolContext = { ownerId, userId, conversationId };
  const model = getLightweightModel();

  return streamSSE(c, async (stream) => {
    // Let the client correlate the (possibly new) conversation immediately.
    await stream.writeSSE({
      event: "meta",
      data: JSON.stringify({ conversationId }),
    });

    // US-835: the model's text is BUFFERED, not forwarded live — the output
    // guard must run on the complete answer BEFORE any of it reaches the client,
    // so a leak can never be returned (not even transiently as a delta). We
    // collect the model deltas here and stream only the guarded result below.
    const onText = (_text: string) => Promise.resolve();

    try {
      const step = makeStreamingStep(onText, c.req.raw.signal);
      const result = await runAssistantLoop(history, {
        step,
        executeTool: (name, input) => executeAssistantTool(name, input, ctx),
        maxIterations: MAX_TOOL_ITERATIONS,
      });

      // US-835 OUTPUT GUARD — deterministic backstop on the model's answer.
      const guard = guardAssistantOutput(result.finalText);
      let finalText: string;
      if (!guard.safe) {
        // Leakage detected: discard the offending content, return ONLY the
        // standard refusal, and record the abuse event (US-831). Never escalate
        // the user's lockout here — that's US-836's threshold logic.
        finalText = guard.text;
        await recordAbuseEvent(
          userId,
          guard.abuseType ?? "prompt_injection",
          "high",
          guard.detail ?? "output guard tripped",
          conversationId,
        );
      } else {
        finalText = guard.text;
        if (result.hitCap) {
          // Model still wanted tools at the cap — close out gracefully.
          finalText = (finalText ? finalText + "\n\n" : "") + TOOL_CAP_FALLBACK;
        }
      }

      // Stream the guarded answer to the client (single delta — the SSE contract
      // is unchanged; the client still accumulates `delta.text`).
      if (finalText) {
        await stream.writeSSE({
          event: "delta",
          data: JSON.stringify({ text: finalText }),
        });
      }

      // Persist the assistant turn + token accounting.
      if (finalText) {
        await supabaseAdmin
          .from("support_messages")
          .insert({
            conversation_id: conversationId,
            role: "assistant",
            content: finalText,
            model,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            tool_calls: result.toolCalls.length > 0 ? result.toolCalls : null,
          } as never);
      }

      // Bump the thread and meter usage (1 user message + token totals).
      await supabaseAdmin
        .from("support_conversations")
        .update({ last_message_at: new Date().toISOString() } as never)
        .eq("id", conversationId)
        .eq("user_id", userId);

      await incrementUsage(userId, {
        messages: 1,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });

      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          conversationId,
          hitCap: result.hitCap,
          guarded: !guard.safe,
        }),
      });
    } catch (e) {
      if (c.req.raw.signal.aborted) return; // client hit Stop — quiet exit
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[support-assistant] message stream failed:", msg);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: "The assistant hit an error." }),
      });
    }
  });
});

// ── GET /conversations — the caller's own threads ─────────────────────────────
supportAssistantRoutes.get("/conversations", async (c) => {
  const userId = c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("support_conversations")
    .select(
      "id, status, subject, last_message_at, escalated_at, resolved_at, created_at",
    )
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(50);
  if (error) return c.json({ error: "Could not load conversations" }, 500);
  return c.json({ conversations: data ?? [] });
});

// ── GET /conversations/:id — one thread + transcript (no system rows) ─────────
supportAssistantRoutes.get("/conversations/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const { data: conv } = await supabaseAdmin
    .from("support_conversations")
    .select(
      "id, status, subject, escalation_reason, last_message_at, escalated_at, resolved_at, created_at",
    )
    .eq("id", id)
    .eq("user_id", userId) // tenant scope
    .maybeSingle();
  if (!conv) return c.json({ error: "Conversation not found" }, 404);

  const { data: messages } = await supabaseAdmin
    .from("support_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", id)
    .neq("role", "system") // never surface system rows to a client
    .order("created_at", { ascending: true })
    .limit(200);

  return c.json({ conversation: conv, messages: messages ?? [] });
});
