// US-938: the per-send dispatch gate is the single source of truth for whether a
// due drip step is sent, skipped (retry later), or exits the journey. These
// assert the AC6 invariant directly: a suppressed OR opted-out trialist is NOT
// sent — they exit with a recorded reason. The gate is pure, so this runs with
// no DB/env.

import { assert, assertEquals } from "@std/assert";
import { evaluateSendGate } from "../lib/drip-graph.ts";

const CLEAN = {
  optedOut: false,
  noAddress: false,
  suppressed: false,
  frequencyCapped: false,
  qaOk: true,
};

Deno.test("opted-out trialist is NOT sent — exits, recorded reason (US-911)", () => {
  const d = evaluateSendGate({ ...CLEAN, optedOut: true });
  assert(d.action !== "send", "an opted-out trialist must never be sent");
  assertEquals(d.action, "exit");
  assertEquals(d.reason, "opted_out");
  assertEquals(d.exitReason, "unsubscribed");
});

Deno.test("suppressed (hard-bounce/complaint) trialist is NOT sent — recorded (US-914)", () => {
  const d = evaluateSendGate({ ...CLEAN, suppressed: true });
  assert(d.action !== "send", "a suppressed trialist must never be sent");
  assertEquals(d.action, "exit");
  assertEquals(d.reason, "suppressed");
  assertEquals(d.exitReason, "suppressed");
});

Deno.test("missing address exits as suppressed (stop retrying a dead address)", () => {
  const d = evaluateSendGate({ ...CLEAN, noAddress: true });
  assertEquals(d.action, "exit");
  assertEquals(d.reason, "no_address");
  assertEquals(d.exitReason, "suppressed");
});

Deno.test("frequency cap skips (retry later), not a terminal exit", () => {
  const d = evaluateSendGate({ ...CLEAN, frequencyCapped: true });
  assertEquals(d.action, "skip");
  assertEquals(d.reason, "frequency_capped");
  assertEquals(d.exitReason, undefined);
});

Deno.test("QA-gate failure skips (retry later) with reason", () => {
  const d = evaluateSendGate({ ...CLEAN, qaOk: false });
  assertEquals(d.action, "skip");
  assertEquals(d.reason, "qa_failed");
});

Deno.test("a clean, consenting, in-frequency trialist sends", () => {
  const d = evaluateSendGate(CLEAN);
  assertEquals(d.action, "send");
  assertEquals(d.reason, null);
});

Deno.test("permanent stops beat transient blocks (opt-out wins over a QA failure)", () => {
  const d = evaluateSendGate({ ...CLEAN, optedOut: true, qaOk: false, frequencyCapped: true });
  assertEquals(d.action, "exit");
  assertEquals(d.reason, "opted_out");
});
