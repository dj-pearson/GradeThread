// US-9116: the confirm token that makes every mutating tool two calls.
//
// The token is bound to four things and each closes a different hole. A test
// per binding, because a token that checks three of them reads exactly like one
// that checks four until the day it matters.

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  __confirmTokenCountForTest,
  __resetConfirmTokensForTest,
  CONFIRM_TOKEN_TTL_MS,
  hashPayload,
  issueConfirmToken,
  redeemConfirmToken,
} from "../lib/mcp-confirm.ts";

const SUBJECT = "apikey-1";
const OTHER_SUBJECT = "apikey-2";
const TOOL = "gradethread_publish_listing";
const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function payload(overrides: Record<string, unknown> = {}) {
  return {
    item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    price_cents: 12999,
    marketplace: "ebay",
    quantity: 1,
    ...overrides,
  };
}

async function issue(overrides: Record<string, unknown> = {}) {
  return await issueConfirmToken({
    subject: SUBJECT,
    toolName: TOOL,
    payload: payload(),
    targetIds: [payload().item_id],
    nowMs: NOW,
    ...overrides,
  });
}

Deno.test({
  name: "the happy path: preview then confirm",
  fn: async () => {
    __resetConfirmTokensForTest();
    const record = await issue();
    assert(record.token.startsWith("gtc_"));

    const result = await redeemConfirmToken({
      token: record.token,
      subject: SUBJECT,
      toolName: TOOL,
      payload: payload(),
      nowMs: NOW + 1000,
    });
    assert(result.ok, "a matching confirm should succeed");
  },
});

// ---------------------------------------------------------------------------
// Binding 1: single use
// ---------------------------------------------------------------------------

Deno.test("a token is spent once, which is the replay protection MCP has no header for", async () => {
  __resetConfirmTokensForTest();
  const record = await issue();
  const args = {
    token: record.token,
    subject: SUBJECT,
    toolName: TOOL,
    payload: payload(),
    nowMs: NOW + 1000,
  };

  assert((await redeemConfirmToken(args)).ok);

  const second = await redeemConfirmToken(args);
  assert(!second.ok);
  assertEquals(second.failure.reason, "unknown");
  // The message must send the model to re-preview, not to retry — retrying is
  // what it does by default and none of these failures are fixed by it.
  assert(second.failure.message.includes("Preview the action again"));
});

// ---------------------------------------------------------------------------
// Binding 2: the payload
// ---------------------------------------------------------------------------

Deno.test("a price that moved between preview and confirm invalidates the token", async () => {
  // Binding only the item id would let the price change between the two calls,
  // which is precisely the thing the seller was shown a number for.
  __resetConfirmTokensForTest();
  const record = await issue();

  const result = await redeemConfirmToken({
    token: record.token,
    subject: SUBJECT,
    toolName: TOOL,
    payload: payload({ price_cents: 2999 }),
    nowMs: NOW + 1000,
  });
  assert(!result.ok);
  assertEquals(result.failure.reason, "payload_changed");
  assert(result.failure.message.includes("check the new numbers"));
});

Deno.test("re-serialising the same payload in a different key order still confirms", async () => {
  // A client that rebuilds its own arguments must not lose its token for it.
  __resetConfirmTokensForTest();
  const record = await issue();

  const reordered = {
    quantity: 1,
    marketplace: "ebay",
    price_cents: 12999,
    item_id: payload().item_id,
  };
  const result = await redeemConfirmToken({
    token: record.token,
    subject: SUBJECT,
    toolName: TOOL,
    payload: reordered,
    nowMs: NOW + 1000,
  });
  assert(result.ok, "key order should not matter");
});

Deno.test("hashPayload is stable across key order and sensitive to values", async () => {
  const a = await hashPayload({ x: 1, y: [1, 2], z: { b: 2, a: 1 } });
  const b = await hashPayload({ z: { a: 1, b: 2 }, y: [1, 2], x: 1 });
  assertEquals(a, b);

  const changed = await hashPayload({ x: 1, y: [2, 1], z: { a: 1, b: 2 } });
  assert(changed !== a, "array order is meaningful and must change the hash");
});

// ---------------------------------------------------------------------------
// Binding 3: the subject
// ---------------------------------------------------------------------------

Deno.test("a token leaked into a transcript is useless to another credential", async () => {
  __resetConfirmTokensForTest();
  const record = await issue();

  const result = await redeemConfirmToken({
    token: record.token,
    subject: OTHER_SUBJECT,
    toolName: TOOL,
    payload: payload(),
    nowMs: NOW + 1000,
  });
  assert(!result.ok);
  assertEquals(result.failure.reason, "wrong_subject");
});

Deno.test("a failed redemption still SPENDS the token, so it cannot be probed", async () => {
  // Leaving a token usable after a wrong-subject attempt turns it into an
  // oracle a caller can retry against until something lines up.
  __resetConfirmTokensForTest();
  const record = await issue();

  await redeemConfirmToken({
    token: record.token,
    subject: OTHER_SUBJECT,
    toolName: TOOL,
    payload: payload(),
    nowMs: NOW + 1000,
  });

  const retry = await redeemConfirmToken({
    token: record.token,
    subject: SUBJECT,
    toolName: TOOL,
    payload: payload(),
    nowMs: NOW + 2000,
  });
  assert(!retry.ok);
  assertEquals(retry.failure.reason, "unknown");
});

// ---------------------------------------------------------------------------
// Binding 4: the tool, and the clock
// ---------------------------------------------------------------------------

Deno.test("a publish token cannot end a listing", async () => {
  __resetConfirmTokensForTest();
  const record = await issue();

  const result = await redeemConfirmToken({
    token: record.token,
    subject: SUBJECT,
    toolName: "gradethread_end_listing",
    payload: payload(),
    nowMs: NOW + 1000,
  });
  assert(!result.ok);
  assertEquals(result.failure.reason, "wrong_tool");
  assert(result.failure.message.includes("gradethread_publish_listing"));
});

Deno.test("a token found later is not a standing authorization", async () => {
  __resetConfirmTokensForTest();
  const record = await issue();

  const result = await redeemConfirmToken({
    token: record.token,
    subject: SUBJECT,
    toolName: TOOL,
    payload: payload(),
    nowMs: NOW + CONFIRM_TOKEN_TTL_MS + 1,
  });
  assert(!result.ok);
  assertEquals(result.failure.reason, "expired");
});

Deno.test("a token issued moments before the deadline still works", async () => {
  __resetConfirmTokensForTest();
  const record = await issue();
  const result = await redeemConfirmToken({
    token: record.token,
    subject: SUBJECT,
    toolName: TOOL,
    payload: payload(),
    nowMs: NOW + CONFIRM_TOKEN_TTL_MS - 1,
  });
  assert(result.ok);
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

Deno.test("expired tokens are swept, so the store does not grow forever", async () => {
  __resetConfirmTokensForTest();
  for (let i = 0; i < 5; i++) {
    await issueConfirmToken({
      subject: SUBJECT,
      toolName: TOOL,
      payload: payload({ item_id: `item-${i}` }),
      targetIds: [`item-${i}`],
      nowMs: NOW,
    });
  }
  assertEquals(__confirmTokenCountForTest(), 5);

  // Issuing after the window sweeps the stale ones on the way in.
  await issueConfirmToken({
    subject: SUBJECT,
    toolName: TOOL,
    payload: payload({ item_id: "later" }),
    targetIds: ["later"],
    nowMs: NOW + CONFIRM_TOKEN_TTL_MS + 1,
  });
  assertEquals(__confirmTokenCountForTest(), 1);
});

Deno.test("one subject cannot hold unlimited outstanding tokens", async () => {
  __resetConfirmTokensForTest();
  for (let i = 0; i < 80; i++) {
    await issueConfirmToken({
      subject: SUBJECT,
      toolName: TOOL,
      payload: payload({ item_id: `item-${i}` }),
      targetIds: [`item-${i}`],
      nowMs: NOW + i,
    });
  }
  assert(__confirmTokenCountForTest() <= 50, "the per-subject cap did not apply");
});

Deno.test("the token records what it will act on, for the audit trail", async () => {
  __resetConfirmTokensForTest();
  const record = await issue();
  assertExists(record.targetIds);
  assertEquals(record.targetIds, [payload().item_id]);
});
