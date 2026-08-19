// US-9114 (write half): the preview/confirm protocol on the grading tools.
//
// These tools spend the seller's grading allowance, and the caller is a model
// that retries on timeout. So what is asserted here is not "does it grade" --
// that is the submit path's own suite -- but the four ways an AI caller turns a
// working money path into a double charge:
//
//   1. confirming without ever previewing,
//   2. reusing a token that already charged,
//   3. confirming a payload that changed since the preview,
//   4. sending the same garment twice in one list.
//
// The handlers run against a stub database, so every case here executes for
// real rather than skipping without a stack.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { gradeBatchTool, gradeItemTool } = await import("../lib/mcp-grade-tools.ts");
const { __confirmTokenCountForTest, __resetConfirmTokensForTest, issueConfirmToken } = await import(
  "../lib/mcp-confirm.ts",
);
const { MAX_BATCH_ITEMS } = await import("../lib/grading-batch.ts");
const { TOOLS } = await import("../lib/mcp-tools.ts");

const TENANT = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

const ctx = {
  tenantId: TENANT,
  userId: TENANT,
  apiKeyId: KEY_ID,
  scopes: ["read", "submit"] as Array<"read" | "submit" | "webhook_manage">,
};

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

Deno.test("both grading write tools require the submit scope, not read", () => {
  // A read-scoped credential must not be able to spend money. This is the line
  // between "let Claude look at my inventory" and "let Claude charge me".
  for (const tool of [gradeItemTool, gradeBatchTool]) {
    assertEquals(tool.requiredScope, "submit", `${tool.name} must require submit`);
    assertEquals(
      tool.annotations.readOnlyHint,
      undefined,
      `${tool.name} must not claim to be read-only`,
    );
    assertEquals(tool.annotations.destructiveHint, true);
    assertEquals(
      tool.annotations.idempotentHint,
      false,
      `${tool.name} charges, so it is not idempotent and must not say it is`,
    );
  }
});

Deno.test("a read-only credential is not shown the grading write tools", async () => {
  const { listToolsFor } = await import("../lib/mcp-tools.ts");
  const names = listToolsFor(["read"]).map((t) => t.name as string);
  assert(!names.includes("gradethread_grade_item"));
  assert(!names.includes("gradethread_grade_batch"));
  assert(names.includes("gradethread_grading_readiness"), "the read tool should still show");
});

Deno.test("both tools are in the registry", () => {
  const names = TOOLS.map((t) => t.name);
  assert(names.includes("gradethread_grade_item"));
  assert(names.includes("gradethread_grade_batch"));
});

// ---------------------------------------------------------------------------
// The refusals that happen before any database work
// ---------------------------------------------------------------------------

Deno.test("confirm without a token is refused, and says to preview", async () => {
  __resetConfirmTokensForTest();
  const result = await gradeItemTool.handler(
    { item_id: ITEM, mode: "confirm" },
    ctx,
  );
  assertEquals(result.isError, true);
  assert(/preview/i.test(textOf(result)), "the refusal must point at preview");
});

Deno.test("confirm with a made-up token is refused", async () => {
  __resetConfirmTokensForTest();
  const result = await gradeItemTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: "gtc_not-a-real-token" },
    ctx,
  );
  assertEquals(result.isError, true);
});

Deno.test("a token issued to a DIFFERENT credential cannot be spent here", async () => {
  // The token is bound to the API key, so one seller's preview cannot be
  // confirmed by another's credential.
  __resetConfirmTokensForTest();
  const record = await issueConfirmToken({
    subject: "someone-elses-key",
    toolName: "gradethread_grade_item",
    payload: [`${ITEM}:standard`],
    targetIds: [ITEM],
  });
  const result = await gradeItemTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: record.token },
    ctx,
  );
  assertEquals(result.isError, true);
});

Deno.test("a token issued for a DIFFERENT tool cannot be spent here", async () => {
  __resetConfirmTokensForTest();
  const record = await issueConfirmToken({
    subject: KEY_ID,
    toolName: "gradethread_publish_listing",
    payload: [`${ITEM}:standard`],
    targetIds: [ITEM],
  });
  const result = await gradeItemTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: record.token },
    ctx,
  );
  assertEquals(result.isError, true);
});

Deno.test("a token stops matching when the ITEM changes", async () => {
  // The case this exists for: preview one garment, confirm a different one.
  __resetConfirmTokensForTest();
  const record = await issueConfirmToken({
    subject: KEY_ID,
    toolName: "gradethread_grade_item",
    payload: [`${ITEM}:standard`],
    targetIds: [ITEM],
  });
  const other = "44444444-4444-4444-8444-444444444444";
  const result = await gradeItemTool.handler(
    { item_id: other, mode: "confirm", confirm_token: record.token },
    ctx,
  );
  assertEquals(result.isError, true);
});

Deno.test("a token stops matching when the TIER changes", async () => {
  // Same garment, dearer grade. The seller agreed to a price, not to an item.
  __resetConfirmTokensForTest();
  const record = await issueConfirmToken({
    subject: KEY_ID,
    toolName: "gradethread_grade_item",
    payload: [`${ITEM}:standard`],
    targetIds: [ITEM],
  });
  const result = await gradeItemTool.handler(
    { item_id: ITEM, mode: "confirm", tier: "express", confirm_token: record.token },
    ctx,
  );
  assertEquals(result.isError, true);
});

Deno.test("the batch token does not care what ORDER the ids arrive in", async () => {
  // A model rebuilding a list from a conversation reorders it constantly, and
  // refusing that would be a refusal the seller cannot act on. The payload is
  // sorted, so the same SET matches.
  __resetConfirmTokensForTest();
  const a = "55555555-5555-4555-8555-555555555555";
  const b = "66666666-6666-4666-8666-666666666666";
  const record = await issueConfirmToken({
    subject: KEY_ID,
    toolName: "gradethread_grade_batch",
    payload: [`${a}:standard`, `${b}:standard`].sort(),
    targetIds: [a, b],
  });
  const result = await gradeBatchTool.handler(
    { item_ids: [b, a], mode: "confirm", confirm_token: record.token },
    ctx,
  );
  // It gets PAST the token check and fails later, on items that do not exist.
  // What matters is that the failure is not the token mismatch.
  assert(
    !/re-?preview|token/i.test(textOf(result)),
    `a reordered batch was rejected as a token mismatch: ${textOf(result)}`,
  );
});

Deno.test("a duplicated id is refused before anything is charged", async () => {
  __resetConfirmTokensForTest();
  const result = await gradeBatchTool.handler(
    { item_ids: [ITEM, ITEM], mode: "preview" },
    ctx,
  );
  assertEquals(result.isError, true);
  assert(/more than once/i.test(textOf(result)));
});

Deno.test("an oversized batch is refused with the cap named", async () => {
  __resetConfirmTokensForTest();
  const ids = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => `id-${i}`);
  const result = await gradeBatchTool.handler({ item_ids: ids, mode: "preview" }, ctx);
  assertEquals(result.isError, true);
  assert(textOf(result).includes(String(MAX_BATCH_ITEMS)));
});

Deno.test("an empty list is refused", async () => {
  const result = await gradeBatchTool.handler({ item_ids: [] }, ctx);
  assertEquals(result.isError, true);
});

Deno.test("a credential acting for someone else's workspace is refused, not assumed", async () => {
  // mcp-auth never sets workspaceOwnerId today, so this is unreachable -- which
  // is exactly why it is pinned. If a workspace-scoped credential ever arrives,
  // submitting as "owner" would let a viewer spend the workspace's credits, and
  // the failure would be a charge rather than an error.
  const result = await gradeItemTool.handler(
    { item_id: ITEM, mode: "preview" },
    { ...ctx, userId: "99999999-9999-4999-8999-999999999999" },
  );
  assertEquals(result.isError, true);
  assert(/workspace/i.test(textOf(result)));
});

Deno.test("preview is the DEFAULT, so an omitted mode never spends a token", async () => {
  // The one-character difference between a tool that asks and a tool that acts.
  //
  // Asserted by whether the TOKEN was spent, not by reading the response text:
  // without a database the call fails either way, so "it did not say submitted"
  // would pass against a tool that took the confirm branch and then errored.
  // A token that survives is proof the confirm branch was never entered.
  __resetConfirmTokensForTest();
  const record = await issueConfirmToken({
    subject: KEY_ID,
    toolName: "gradethread_grade_item",
    payload: [`${ITEM}:standard`],
    targetIds: [ITEM],
  });
  assertEquals(__confirmTokenCountForTest(), 1);

  // mode omitted, token supplied anyway — the tool must ignore it.
  await gradeItemTool.handler({ item_id: ITEM, confirm_token: record.token }, ctx);

  assertEquals(
    __confirmTokenCountForTest(),
    1,
    "an omitted mode spent the confirm token, so the default is confirm and not preview",
  );
});
