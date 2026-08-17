// US-2667: the crisis path's WIRING inside POST /api/support/assistant/message.
//
// WHY THIS IS A STRUCTURAL GUARD AND NOT AN INVOCATION. The handler streams SSE
// and writes through the module-level service-role client; there is no seam to
// inject a fake DB into, and inventing one for this story would be a larger and
// riskier change than the feature. So the ORDERING and the EXEMPTIONS - which
// are the properties that actually decide whether a person in crisis gets the
// numbers - are asserted against the source, using the shared primitives in
// _source-scan.ts rather than a hand-rolled regex over raw text.
//
// The parts that CAN be executed are executed: the detector and the reply in
// support-crisis_test.ts, the escalation decision through a fake sink below,
// and the inbox ordering as a pure function in admin-support-inbox_test.ts.
//
// ⚠ These assertions are lexical. They prove the call sites are in the right
// order and carry the right arguments; they do not prove the handler runs. That
// limit is named here rather than left for someone to discover.

import { assert, assertEquals } from "@std/assert";
import { code, fnBody } from "./_source-scan.ts";
import {
  type EscalationSink,
  type NotifyOwnerInput,
  performEscalation,
  type SetEscalatedInput,
} from "../lib/support-escalation.ts";
import {
  CRISIS_ESCALATION_REASON,
  CRISIS_ESCALATION_SUMMARY,
} from "../lib/support-crisis.ts";

const ROUTE_SRC = code(
  await Deno.readTextFile(
    new URL("../routes/support-assistant.ts", import.meta.url),
  ),
);

/**
 * The brace-matched block that begins at the first `{` at or after `from`.
 *
 * fnBody() in _source-scan.ts is the usual tool and is WRONG here: it walks the
 * parameter list of a `function` declaration, and this handler is an arrow
 * passed as the second argument to `.post(...)`, so fnBody's paren match runs
 * to the end of the whole registration and then takes an unrelated brace. This
 * is the narrower thing that is correct for an arrow body.
 */
function braceBlock(src: string, from: number): string {
  const open = src.indexOf("{", from);
  if (open === -1) throw new Error("braceBlock: no block found");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("braceBlock: unbalanced braces");
}

// The /message handler body. Anchored on its literal registration so a rename
// fails loudly instead of silently scanning the whole file.
const HANDLER = braceBlock(
  ROUTE_SRC,
  ROUTE_SRC.indexOf('supportAssistantRoutes.post("/message"'),
);

// The crisis branch on its own. Sliced by brace matching rather than by a
// trailing comment marker: code() strips whole-line comments, so a marker like
// "// ABUSE CONTROLS" is not in this string at all and indexOf would return -1,
// silently widening the branch to the rest of the handler and making the
// "must not reach the model" assertions vacuous.
const CRISIS_BRANCH = braceBlock(
  HANDLER,
  HANDLER.indexOf("if (crisis.crisis)"),
);

// ── Ordering: the crisis check runs before anything that can swallow it ──────

Deno.test("route: detectCrisis runs BEFORE the abuse controls", () => {
  const crisisAt = HANDLER.indexOf("detectCrisis(");
  const abuseAt = HANDLER.indexOf("runPreTurnAbuseControls(");
  assert(crisisAt > -1, "the handler must call detectCrisis");
  assert(abuseAt > -1, "the handler must still call runPreTurnAbuseControls");
  assert(
    crisisAt < abuseAt,
    "a rate-limited or locked-out user in crisis must still get the resources, " +
      "so detectCrisis has to precede runPreTurnAbuseControls",
  );
});

Deno.test("route: detectCrisis runs BEFORE the human-handled short-circuit", () => {
  const crisisAt = HANDLER.indexOf("detectCrisis(");
  const handledAt = HANDLER.indexOf("HUMAN_HANDLED_STATUSES.has(");
  assert(handledAt > -1, "the handler must still short-circuit handed-off threads");
  assert(
    crisisAt < handledAt,
    "an already-escalated thread must not answer a crisis message with " +
      "'a human will reply soon' - the numbers come first",
  );
});

Deno.test("route: the crisis branch returns before the model is reached", () => {
  const crisisAt = HANDLER.indexOf("if (crisis.crisis)");
  const loopAt = HANDLER.indexOf("runAssistantLoop(");
  assert(crisisAt > -1, "the crisis branch must exist");
  assert(loopAt > -1, "the ordinary path must still run the assistant loop");
  assert(crisisAt < loopAt, "the crisis branch must sit ahead of the model call");
  // The branch itself returns, so nothing below it can execute.
  assert(
    /return streamSSE\(/.test(CRISIS_BRANCH),
    "the crisis branch must return its own stream",
  );
});

// ── The reply is the constant, never generated ──────────────────────────────

Deno.test("route: the crisis branch streams CRISIS_RESPONSE and nothing else", () => {
  const branch = CRISIS_BRANCH;
  assert(
    branch.includes("CRISIS_RESPONSE"),
    "the branch must stream the fixed reply",
  );
  for (const forbidden of ["runAssistantLoop", "guardAssistantOutput", "getLightweightModel"]) {
    assert(
      !branch.includes(forbidden),
      `the crisis branch must not touch ${forbidden} - the reply is a constant`,
    );
  }
});

// ── Exemptions: the crisis turn is not metered and is not an abuse event ────

Deno.test("route: the crisis escalation is not metered", () => {
  const branch = CRISIS_BRANCH;
  assert(
    /makeEscalationSink\(\{\s*meter:\s*false\s*\}\)/.test(branch),
    "the crisis path must pass meter:false - billing an escalation against " +
      "this turn is not something this product does",
  );
  assert(
    !branch.includes("incrementUsage("),
    "the crisis turn spends no tokens and must not be metered at all",
  );
});

Deno.test("route: the crisis turn is never recorded as abuse", () => {
  const branch = CRISIS_BRANCH;
  assert(
    !branch.includes("recordAbuseEvent("),
    "a message about self-harm is not an abuse event",
  );
});

Deno.test("route: analytics carry the matched pattern, never the message", () => {
  const branch = CRISIS_BRANCH;
  const eventAt = branch.indexOf("captureAssistantEvent(");
  assert(eventAt > -1, "the crisis path still reports its outcome");
  const event = branch.slice(eventAt, branch.indexOf(");", eventAt));
  assert(
    !/\bmessage\b/.test(event),
    "the user's text must never travel into the analytics payload",
  );
  assert(event.includes("crisis.pattern"), "the pattern source is what is reported");
});

// ── The escalation itself, executed through a fake sink ─────────────────────

function recordingSink(): {
  sink: EscalationSink;
  escalated: SetEscalatedInput[];
  notified: NotifyOwnerInput[];
  metered: string[];
} {
  const escalated: SetEscalatedInput[] = [];
  const notified: NotifyOwnerInput[] = [];
  const metered: string[] = [];
  return {
    escalated,
    notified,
    metered,
    sink: {
      setConversationEscalated: (i) => {
        escalated.push(i);
        return Promise.resolve();
      },
      notifyOwner: (i) => {
        notified.push(i);
        return Promise.resolve();
      },
      meterEscalation: (uid) => {
        metered.push(uid);
        return Promise.resolve();
      },
    },
  };
}

Deno.test("escalation: a crisis handoff flips the thread and tags the trigger", async () => {
  const r = recordingSink();
  await performEscalation(
    r.sink,
    {
      escalate: true,
      trigger: "crisis",
      reason: CRISIS_ESCALATION_REASON,
      summary: CRISIS_ESCALATION_SUMMARY,
    },
    { conversationId: "conv-1", userId: "user-1" },
    new Date("2026-08-17T12:00:00Z"),
  );

  assertEquals(r.escalated.length, 1);
  assertEquals(r.escalated[0].trigger, "crisis");
  assertEquals(r.escalated[0].conversationId, "conv-1");
  assertEquals(r.escalated[0].userId, "user-1");
  assertEquals(r.escalated[0].reason, CRISIS_ESCALATION_REASON);
  // A human is told, every time.
  assertEquals(r.notified.length, 1);
  assertEquals(r.notified[0].trigger, "crisis");
});

// ── The notification an operator actually sees ──────────────────────────────
//
// Source-scanned for the same reason as the handler: sendSupportEscalationEmail
// ends in sendEmail(), which is SMTP. What matters is that the crisis branch
// exists and keys on the trigger, which is exactly what a lexical check can
// establish.

const EMAIL_SRC = code(
  await Deno.readTextFile(new URL("../lib/email.ts", import.meta.url)),
);

Deno.test("email: a crisis escalation gets its own subject", () => {
  const body = fnBody(EMAIL_SRC, "export async function sendSupportEscalationEmail");
  assert(
    /const isCrisis = data\.trigger === "crisis"/.test(body),
    "the escalation email must branch on the crisis trigger",
  );
  const subjectAt = body.indexOf("subject:");
  assert(subjectAt > -1, "the email still has a subject");
  const subject = body.slice(subjectAt, subjectAt + 220);
  assert(
    subject.includes("isCrisis"),
    "the SUBJECT is what survives an inbox being skimmed, so it has to change",
  );
  assert(
    /URGENT/.test(subject),
    "the crisis subject must say so in a word a human scans for",
  );
});

Deno.test("notification: the in-app alert names a crisis in its title", () => {
  const body = fnBody(ROUTE_SRC, "async function notifyOwnerOfEscalation");
  assert(
    /const isCrisis = trigger === "crisis"/.test(body),
    "the in-app notification must branch on the crisis trigger",
  );
  assert(
    /URGENT/.test(body),
    "a bell menu of identical 'escalated' rows gives no way to tell which to " +
      "open first - the title has to",
  );
});
