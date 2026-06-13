// US-837: human-escalation lifecycle tests. Cover the three acceptance-criteria
// paths — EXPLICIT (the user asks for a person), OUT-OF-SCOPE (the model calls
// the escalate tool), and AUTO (an unresolved-turn threshold trips) — plus the
// side-effect orchestration (status flip + owner notification + metering) via an
// injected fake sink. Pure/injectable → no live DB, model, or SMTP needed.

import { assert, assertEquals } from "@std/assert";
import {
  adminThreadPath,
  AUTO_ESCALATION_THRESHOLD,
  decideEscalation,
  type EscalationSink,
  type NotifyOwnerInput,
  performEscalation,
  type SetEscalatedInput,
} from "../lib/support-escalation.ts";

// ── decideEscalation: EXPLICIT / OUT-OF-SCOPE (model calls the tool) ──────────

Deno.test("decide: explicit user request → escalate now, trigger 'model'", () => {
  const r = decideEscalation({
    modelEscalateCall: {
      reason: "User asked to speak to a human agent.",
      summary: "Wants help with a billing question the bot couldn't answer.",
    },
    unresolvedTurn: false,
    priorUnresolvedTurns: 1,
    lastUserMessage: "Can I talk to a real person?",
  });
  assertEquals(r.decision.escalate, true);
  assertEquals(r.decision.trigger, "model");
  assertEquals(r.decision.reason, "User asked to speak to a human agent.");
  assert(r.decision.summary.includes("billing"));
  // A model-driven handoff resets the auto counter — a human now owns it.
  assertEquals(r.nextUnresolvedTurns, 0);
});

Deno.test("decide: out-of-scope model escalation with no summary falls back to the reason", () => {
  const r = decideEscalation({
    modelEscalateCall: { reason: "Out-of-scope request (legal advice)." },
    unresolvedTurn: false,
    priorUnresolvedTurns: 0,
    lastUserMessage: "Draft me a lawsuit.",
  });
  assertEquals(r.decision.escalate, true);
  assertEquals(r.decision.trigger, "model");
  // summary defaults to the reason when the model omitted one.
  assertEquals(r.decision.summary, "Out-of-scope request (legal advice).");
});

// ── decideEscalation: AUTO (repeated unresolved turns) ───────────────────────

Deno.test("decide: unresolved turns accumulate until the threshold, then auto-escalate", () => {
  let prior = 0;
  // Below the threshold: counter climbs, no escalation yet.
  for (let i = 1; i < AUTO_ESCALATION_THRESHOLD; i++) {
    const r = decideEscalation({
      modelEscalateCall: null,
      unresolvedTurn: true,
      priorUnresolvedTurns: prior,
      lastUserMessage: "still stuck",
    });
    assertEquals(r.decision.escalate, false, `turn ${i} should not escalate`);
    assertEquals(r.nextUnresolvedTurns, i);
    prior = r.nextUnresolvedTurns;
  }
  // The threshold-tripping turn auto-escalates without the user asking.
  const trip = decideEscalation({
    modelEscalateCall: null,
    unresolvedTurn: true,
    priorUnresolvedTurns: prior,
    lastUserMessage: "I give up, this isn't working",
  });
  assertEquals(trip.decision.escalate, true);
  assertEquals(trip.decision.trigger, "auto");
  assert(trip.decision.summary.includes("isn't working"));
  assertEquals(trip.nextUnresolvedTurns, 0);
});

Deno.test("decide: a resolved turn resets the unresolved-turn counter", () => {
  const r = decideEscalation({
    modelEscalateCall: null,
    unresolvedTurn: false,
    priorUnresolvedTurns: 2,
    lastUserMessage: "thanks!",
  });
  assertEquals(r.decision.escalate, false);
  assertEquals(r.decision.trigger, null);
  assertEquals(r.nextUnresolvedTurns, 0);
});

// ── performEscalation: side-effect orchestration via a fake sink ─────────────

function makeFakeSink() {
  const calls = {
    setEscalated: [] as SetEscalatedInput[],
    notify: [] as NotifyOwnerInput[],
    metered: [] as string[],
  };
  const sink: EscalationSink = {
    setConversationEscalated: (i) => {
      calls.setEscalated.push(i);
      return Promise.resolve();
    },
    notifyOwner: (i) => {
      calls.notify.push(i);
      return Promise.resolve();
    },
    meterEscalation: (uid) => {
      calls.metered.push(uid);
      return Promise.resolve();
    },
  };
  return { sink, calls };
}

Deno.test("perform: flips status, notifies the owner, and meters — scoped to the caller", async () => {
  const { sink, calls } = makeFakeSink();
  const now = new Date("2026-06-13T12:00:00Z");
  await performEscalation(
    sink,
    {
      escalate: true,
      trigger: "model",
      reason: "needs a human",
      summary: "summary text",
    },
    { conversationId: "conv-1", userId: "user-1" },
    now,
  );

  assertEquals(calls.setEscalated.length, 1);
  const s = calls.setEscalated[0];
  assertEquals(s.conversationId, "conv-1");
  assertEquals(s.userId, "user-1"); // tenant scope on the write
  assertEquals(s.trigger, "model");
  assertEquals(s.escalatedAtIso, now.toISOString());

  assertEquals(calls.notify.length, 1);
  assertEquals(calls.notify[0].trigger, "model");
  assertEquals(calls.metered, ["user-1"]);
});

Deno.test("perform: a non-escalation decision is a no-op (no writes, no notify, no meter)", async () => {
  const { sink, calls } = makeFakeSink();
  await performEscalation(
    sink,
    { escalate: false, trigger: null, reason: "", summary: "" },
    { conversationId: "conv-1", userId: "user-1" },
  );
  assertEquals(calls.setEscalated.length, 0);
  assertEquals(calls.notify.length, 0);
  assertEquals(calls.metered.length, 0);
});

Deno.test("adminThreadPath builds the US-839 inbox deep link", () => {
  assertEquals(adminThreadPath("abc-123"), "/admin/support/abc-123");
});
