// US-837: human-escalation lifecycle for the AI Support Assistant.
//
// This module owns the DECISION (when to hand off to a human) and the
// ORCHESTRATION of the side effects (flip the conversation, notify the support
// team, meter the escalation). Both halves are pure/injectable so all three
// escalation paths — explicit (the user asks for a person), out-of-scope (the
// model calls the escalate tool), and AUTO (an unresolved-turn threshold trips)
// — are unit-testable without a live DB, a real model, or an SMTP server.
//
// HOW THE THREE PATHS MAP:
//   * explicit / out-of-scope / low-confidence → the model calls the
//     escalate_to_human tool, which the engine captures as `modelEscalateCall`.
//     decideEscalation returns trigger='model'.
//   * repeated failures → the engine reports each turn's `unresolvedTurn` signal;
//     after AUTO_ESCALATION_THRESHOLD consecutive unresolved turns,
//     decideEscalation returns trigger='auto' even though the model never asked.
//   * 'user' trigger is reserved for a human-side action in US-839.

export type EscalationTrigger = "model" | "auto" | "user";

// Consecutive unresolved/uncertain turns before the assistant auto-escalates
// without the user (or the model) explicitly asking. Kept small: the bot gets a
// few honest attempts, then a human takes over rather than looping forever.
export const AUTO_ESCALATION_THRESHOLD = 3;

// Max length of a stored reason/summary (defense against an over-long model
// argument bloating the row / the admin inbox).
const REASON_MAX = 500;
const SUMMARY_MAX = 2000;

// The line streamed to the user when an escalation fires but the model didn't
// itself announce the handoff (the AUTO path). On the model path the model's own
// closing text already tells the user a human will follow up.
export const ESCALATION_HANDOFF_MESSAGE =
  "I've connected you with our human support team — someone will follow up on " +
  "this conversation soon. You won't be charged while you wait for their reply.";

// The line shown when the user keeps messaging an already-escalated (human-held)
// thread. The bot stays out of the way and the turn is NOT metered (AC: the
// idle, handed-off thread stops costing the user usage).
export const ESCALATION_IDLE_MESSAGE =
  "A human support agent is reviewing this conversation and will reply here " +
  "soon. You won't be charged while you wait — feel free to add any details and " +
  "they'll see them.";

// Conversation statuses that mean a human now owns the thread: the bot must not
// run the model (and must not meter usage) for further messages on these.
export const HUMAN_HANDLED_STATUSES: ReadonlySet<string> = new Set([
  "escalated",
  "awaiting_user",
]);

export interface ModelEscalateCall {
  reason: string;
  summary?: string;
}

export interface EscalationDecision {
  escalate: boolean;
  trigger: EscalationTrigger | null;
  reason: string;
  summary: string;
}

export interface DecideEscalationInputs {
  // The model invoked escalate_to_human this turn (with its reason/summary), or
  // null if it didn't. This is the explicit / out-of-scope / low-confidence path.
  modelEscalateCall: ModelEscalateCall | null;
  // True if THIS turn ended without a confident resolution (the tool loop hit its
  // cap, the output guard replaced the answer with a refusal, or a KB search came
  // back empty and nothing else produced an answer).
  unresolvedTurn: boolean;
  // Consecutive unresolved turns accumulated BEFORE this turn.
  priorUnresolvedTurns: number;
  // The user's latest message — used to synthesize an auto-escalation summary.
  lastUserMessage: string;
}

export interface DecideEscalationResult {
  decision: EscalationDecision;
  // The counter to persist for the NEXT turn (reset to 0 on escalation or a
  // resolved turn; incremented on an unresolved-but-below-threshold turn).
  nextUnresolvedTurns: number;
}

function clamp(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

// A short, human-readable summary synthesized for the AUTO path (the model never
// wrote one). Centers on what the user last asked so the human agent has context.
function synthesizeAutoSummary(lastUserMessage: string, turns: number): string {
  const q = clamp(lastUserMessage, 400);
  const tail = q ? ` Their latest message: "${q}"` : "";
  return clamp(
    `Auto-escalated after ${turns} consecutive turns the assistant could not ` +
      `confidently resolve.${tail}`,
    SUMMARY_MAX,
  );
}

const AUTO_REASON =
  "The assistant could not resolve this after several attempts and handed it to " +
  "a human.";

const NO_DECISION: EscalationDecision = {
  escalate: false,
  trigger: null,
  reason: "",
  summary: "",
};

// Pure escalation decision. Deterministic and DB/model-free so every path is
// directly unit-testable. The engine feeds it this turn's signals + the running
// unresolved-turn counter and acts on the returned decision.
export function decideEscalation(
  inputs: DecideEscalationInputs,
): DecideEscalationResult {
  // (1) Model-driven escalation always wins (explicit, out-of-scope, the user
  // asked for a person, the KB had no answer). The counter resets — a human now
  // owns it.
  if (inputs.modelEscalateCall) {
    const reason = clamp(inputs.modelEscalateCall.reason, REASON_MAX) ||
      "The user needs help the assistant could not provide.";
    const summary = clamp(inputs.modelEscalateCall.summary ?? "", SUMMARY_MAX) ||
      reason;
    return {
      decision: { escalate: true, trigger: "model", reason, summary },
      nextUnresolvedTurns: 0,
    };
  }

  // (2) Auto-escalation: accumulate consecutive unresolved turns and trip the
  // threshold even though the model never called the escalate tool.
  if (inputs.unresolvedTurn) {
    const next = inputs.priorUnresolvedTurns + 1;
    if (next >= AUTO_ESCALATION_THRESHOLD) {
      return {
        decision: {
          escalate: true,
          trigger: "auto",
          reason: AUTO_REASON,
          summary: synthesizeAutoSummary(inputs.lastUserMessage, next),
        },
        nextUnresolvedTurns: 0,
      };
    }
    return { decision: { ...NO_DECISION }, nextUnresolvedTurns: next };
  }

  // (3) Resolved turn — reset the counter, no escalation.
  return { decision: { ...NO_DECISION }, nextUnresolvedTurns: 0 };
}

// ── Side-effect orchestration (injectable sink) ─────────────────────────────
//
// performEscalation does the three durable side effects of a handoff, in order,
// best-effort (a notification/metering failure must never undo the status flip).
// The route satisfies EscalationSink with the real service-role DB + notify +
// email + metering helpers; tests pass a fake sink and assert the calls.

export interface SetEscalatedInput {
  conversationId: string;
  userId: string;
  reason: string;
  summary: string;
  trigger: EscalationTrigger;
  escalatedAtIso: string;
}

export interface NotifyOwnerInput {
  conversationId: string;
  userId: string;
  reason: string;
  summary: string;
  trigger: EscalationTrigger;
}

export interface EscalationSink {
  // Flip the conversation to status='escalated' and persist reason/summary/
  // trigger/escalated_at — scoped to the caller's OWN conversation.
  setConversationEscalated(input: SetEscalatedInput): Promise<void>;
  // In-app + email the human support owner with a deep link to the admin thread.
  notifyOwner(input: NotifyOwnerInput): Promise<void>;
  // Meter the escalation (US-831 usage rollup).
  meterEscalation(userId: string): Promise<void>;
}

export interface PerformEscalationCtx {
  conversationId: string;
  userId: string;
}

// Run the handoff. The status flip happens first (it's the user-visible truth);
// notification + metering follow and never throw out (best-effort).
export async function performEscalation(
  sink: EscalationSink,
  decision: EscalationDecision,
  ctx: PerformEscalationCtx,
  now: Date = new Date(),
): Promise<void> {
  if (!decision.escalate || !decision.trigger) return;

  await sink.setConversationEscalated({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    reason: decision.reason,
    summary: decision.summary,
    trigger: decision.trigger,
    escalatedAtIso: now.toISOString(),
  });

  await sink.notifyOwner({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    reason: decision.reason,
    summary: decision.summary,
    trigger: decision.trigger,
  });

  await sink.meterEscalation(ctx.userId);
}

// Deep link to the escalated thread in the admin support inbox (US-839).
export function adminThreadPath(conversationId: string): string {
  return `/admin/support/${conversationId}`;
}
