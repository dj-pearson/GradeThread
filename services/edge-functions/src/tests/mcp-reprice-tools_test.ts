// US-9117: the reprice tools.
//
// The repricing engine is INJECTED through lib/reprice-port.ts, so every case
// runs for real against a stub rather than skipping without a stack.
//
// The property this file exists for is AC4: a confirm token proves the seller
// saw these numbers and that the numbers have not moved. It does NOT prove the
// numbers were right. A model that computes a 90% drop, shows it, gets a yes and
// applies it has satisfied the whole protocol, and the seller has still lost the
// money. So apply refuses a large move or a sub-floor price EVEN WITH a valid
// token, and the refusal names the listing and the percentage.

import { assert, assertEquals } from "@std/assert";
import type {
  RepriceApplyResult,
  RepricePreviewResult,
  RepriceRow,
} from "../lib/reprice-port.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const port = await import("../lib/reprice-port.ts");
const {
  MAX_PRICE_MOVE_PCT,
  MAX_REPRICE_PER_CALL,
  repriceApplyTool,
  repricePreviewTool,
  applySuggestionTool,
  dismissSuggestionTool,
} = await import("../lib/mcp-reprice-tools.ts");
const { __resetConfirmTokensForTest } = await import("../lib/mcp-confirm.ts");

const L1 = "aaaaaaaa-1111-4111-8111-111111111111";
const ctx = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "22222222-2222-4222-8222-222222222222",
  scopes: ["read", "submit"] as Array<"read" | "submit" | "webhook_manage">,
};

function row(overrides: Partial<RepriceRow> = {}): RepriceRow {
  return {
    listing_id: L1,
    inventory_item_id: "item-1",
    title: "Carhartt Detroit Jacket",
    current_price_cents: 10_000,
    suggested_price_cents: 11_000,
    delta_cents: 1_000,
    comp_count: 12,
    comp_median_cents: 11_500,
    reason_code: "COMP_MEDIAN",
    margin_floor_cents: 5_000,
    skip: null,
    ...overrides,
  };
}

function stub(opts: {
  preview?: () => RepricePreviewResult;
  apply?: (items: Array<{ listing_id: string; price_cents: number }>) => RepriceApplyResult;
} = {}) {
  const calls = { previews: 0, applies: 0, applied: [] as unknown[] };
  port.registerRepricer({
    preview: () => {
      calls.previews++;
      return Promise.resolve(
        opts.preview ? opts.preview() : { items: [row()], capped: false },
      );
    },
    apply: (_owner, items) => {
      calls.applies++;
      calls.applied.push(items);
      return Promise.resolve(
        opts.apply
          ? opts.apply(items)
          : { applied: items.length, ebay_synced: items.length, skipped: [], errors: [] },
      );
    },
    applySuggestion: () =>
      Promise.resolve({ status: 200, body: { applied: true, new_price: 42, ebay_synced: true } }),
    dismissSuggestion: () => Promise.resolve({ status: 200, body: { dismissed: true } }),
  });
  return calls;
}

function textOf(r: { content: Array<{ text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

async function tokenFor(): Promise<string> {
  const r = await repricePreviewTool.handler({ listing_ids: [L1] }, ctx);
  const token = (r.structuredContent as { confirm_token?: string } | undefined)?.confirm_token;
  assert(token, `no token in the preview: ${textOf(r)}`);
  return token;
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

Deno.test("preview is read-scoped and writes nothing; apply is submit-scoped", () => {
  assertEquals(repricePreviewTool.requiredScope, "read");
  assertEquals(repricePreviewTool.annotations.readOnlyHint, true);
  assertEquals(repriceApplyTool.requiredScope, "submit");
  assertEquals(repriceApplyTool.annotations.destructiveHint, true);
  // Both reach eBay, so both say so.
  assertEquals(repricePreviewTool.annotations.openWorldHint, true);
  assertEquals(repriceApplyTool.annotations.openWorldHint, true);
});

Deno.test("importing the pricing route registers a repricer", async () => {
  await import("../routes/flipdesk-pricing.ts");
  assert(
    port.hasRepricer(),
    "routes/flipdesk-pricing.ts no longer calls registerRepricer, so every reprice " +
      "tool refuses — which reads as an outage rather than as a wiring bug",
  );
});

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

Deno.test("preview states the COUNT that would change before handing over a token", async () => {
  // AC5. "Reprice your listings" and "change the price on 34 listings" are
  // different things to say yes to.
  __resetConfirmTokensForTest();
  stub({
    preview: () => ({
      items: [
        row(),
        row({ listing_id: "b", delta_cents: 0, suggested_price_cents: 10_000 }),
        row({ listing_id: "c", skip: "no_comps" }),
      ],
      capped: false,
    }),
  });
  const result = await repricePreviewTool.handler({ listing_ids: [L1, "b", "c"] }, ctx);
  assert(/1 of 3 listing\(s\) would change/.test(textOf(result)), textOf(result));
  assertEquals((result.structuredContent as { would_change?: number }).would_change, 1);
});

Deno.test("a preview with nothing to change issues no token", async () => {
  // A token for an empty change set invites a confirm that does nothing and
  // reports success.
  __resetConfirmTokensForTest();
  stub({
    preview: () => ({
      items: [row({ delta_cents: 0, suggested_price_cents: 10_000 })],
      capped: false,
    }),
  });
  const result = await repricePreviewTool.handler({ listing_ids: [L1] }, ctx);
  assert(!JSON.stringify(result.structuredContent ?? {}).includes("confirm_token"));
});

Deno.test("a skipped listing says WHY in words a seller can act on", async () => {
  __resetConfirmTokensForTest();
  stub({
    preview: () => ({
      items: [row({ skip: "below_margin_floor", suggested_price_cents: 4_000 })],
      capped: false,
    }),
  });
  const text = textOf(await repricePreviewTool.handler({ listing_ids: [L1] }, ctx));
  assert(/cost floor/i.test(text), text);
  assert(text.includes("$50.00"), "name the floor, not just the fact of one");
});

Deno.test("an oversized selection is refused with the cap named", async () => {
  __resetConfirmTokensForTest();
  stub();
  const ids = Array.from({ length: MAX_REPRICE_PER_CALL + 1 }, (_, i) => `id-${i}`);
  const result = await repricePreviewTool.handler({ listing_ids: ids }, ctx);
  assertEquals(result.isError, true);
  assert(textOf(result).includes(String(MAX_REPRICE_PER_CALL)));
});

// ---------------------------------------------------------------------------
// apply: the token
// ---------------------------------------------------------------------------

Deno.test("apply without a token changes nothing", async () => {
  __resetConfirmTokensForTest();
  const calls = stub();
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 11_000 }], confirm_token: "" },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(calls.applies, 0);
});

Deno.test("a valid token applies once", async () => {
  __resetConfirmTokensForTest();
  const calls = stub();
  const token = await tokenFor();
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 11_000 }], confirm_token: token },
    ctx,
  );
  assert(!result.isError, textOf(result));
  assertEquals(calls.applies, 1);
});

Deno.test("the same token cannot apply twice", async () => {
  __resetConfirmTokensForTest();
  const calls = stub();
  const token = await tokenFor();
  const args = { items: [{ listing_id: L1, price_cents: 11_000 }], confirm_token: token };
  await repriceApplyTool.handler(args, ctx);
  const second = await repriceApplyTool.handler(args, ctx);
  assertEquals(second.isError, true);
  assertEquals(calls.applies, 1, "the token was spent twice");
});

Deno.test("a token does not cover a DIFFERENT price than the one previewed", async () => {
  __resetConfirmTokensForTest();
  const calls = stub();
  const token = await tokenFor(); // bound to 11000
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 10_500 }], confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(calls.applies, 0);
});

// ---------------------------------------------------------------------------
// apply: AC4, the refusals a valid token does not buy past
// ---------------------------------------------------------------------------

Deno.test("a move over the limit is refused WITH a valid token", async () => {
  // The whole point of the story's fourth criterion.
  __resetConfirmTokensForTest();
  const calls = stub({
    preview: () => ({
      items: [row({ suggested_price_cents: 1_000, delta_cents: -9_000 })],
      capped: false,
    }),
  });
  const token = await tokenFor(); // bound to a 90% drop, which previews fine
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 1_000 }], confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(calls.applies, 0, "it applied a 90% move");
  const text = textOf(result);
  assert(text.includes("90%"), `the size of the move must be named: ${text}`);
  assert(text.includes(`${MAX_PRICE_MOVE_PCT}%`), "and the limit it broke");
  assert(/confirmation does not change that/i.test(text));
});

Deno.test("a price below the item's cost floor is refused WITH a valid token", async () => {
  __resetConfirmTokensForTest();
  // A small move that still lands under the floor: 10000 -> 8000 is 20%, inside
  // the percentage limit, and the floor is 9000.
  const calls = stub({
    preview: () => ({
      items: [row({ suggested_price_cents: 8_000, delta_cents: -2_000, margin_floor_cents: 9_000 })],
      capped: false,
    }),
  });
  const token = await tokenFor();
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 8_000 }], confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(calls.applies, 0);
  assert(/cost floor/i.test(textOf(result)));
});

Deno.test("a move just INSIDE the limit is allowed", async () => {
  // The boundary from the other side, so the guard is not simply refusing
  // everything. 10000 -> 12400 is 24%.
  __resetConfirmTokensForTest();
  const calls = stub({
    preview: () => ({
      items: [row({ suggested_price_cents: 12_400, delta_cents: 2_400 })],
      capped: false,
    }),
  });
  const token = await tokenFor();
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 12_400 }], confirm_token: token },
    ctx,
  );
  assert(!result.isError, textOf(result));
  assertEquals(calls.applies, 1);
});

Deno.test("the guard reads the CURRENT price, not one the caller supplied", async () => {
  // A caller declaring its own "current price" could make any move look small.
  // The check runs against a fresh preview, so the only number the caller
  // controls is the target.
  __resetConfirmTokensForTest();
  let current = 10_000;
  const calls = stub({
    preview: () => ({
      items: [row({ current_price_cents: current, suggested_price_cents: 11_000 })],
      capped: false,
    }),
  });
  const token = await tokenFor();
  // The listing has since been marked down hard, so 11000 is now a 267% move.
  current = 3_000;
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 11_000 }], confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(calls.applies, 0);
});

Deno.test("a listing that is not the caller's is refused by name", async () => {
  __resetConfirmTokensForTest();
  const calls = stub({ preview: () => ({ items: [], capped: false }) });
  // Mint a token whose payload matches, so the refusal is the OWNERSHIP one.
  const { issueConfirmToken } = await import("../lib/mcp-confirm.ts");
  const record = await issueConfirmToken({
    subject: ctx.apiKeyId,
    toolName: "gradethread_reprice_apply",
    payload: [`${L1}:11000`],
    targetIds: [L1],
  });
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 11_000 }], confirm_token: record.token },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(calls.applies, 0);
  assert(/not one of your live listings/i.test(textOf(result)));
});

// ---------------------------------------------------------------------------
// apply: reporting
// ---------------------------------------------------------------------------

Deno.test("a failed row is reported and says the price is not out of step", async () => {
  // US-467: apply pushes to eBay first, so a failure means neither side moved.
  // Saying so is what stops a seller going to look for a mismatch.
  __resetConfirmTokensForTest();
  stub({
    apply: () => ({
      applied: 0,
      ebay_synced: 0,
      skipped: [],
      errors: [{ listing_id: L1, message: "eBay 25002: duplicate listing" }],
    }),
  });
  const token = await tokenFor();
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 11_000 }], confirm_token: token },
    ctx,
  );
  const text = textOf(result);
  assert(text.includes("25002"), "the marketplace's own reason must survive");
  assert(
    /out of step/i.test(text),
    "a failed reprice must say both sides kept the old price, or the seller goes " +
      `looking for a mismatch that is not there: ${text}`,
  );
});

// ---------------------------------------------------------------------------
// per-suggestion verbs
// ---------------------------------------------------------------------------

Deno.test("applying a suggestion reports whether eBay was actually pushed", async () => {
  // "Applied" with ebay_synced false on a live listing would be a lie. The flag
  // is reported rather than assumed.
  stub();
  const result = await applySuggestionTool.handler({ suggestion_id: "s-1" }, ctx);
  assert(!result.isError, textOf(result));
  assert(/pushed to eBay/.test(textOf(result)));
});

Deno.test("a suggestion verb needs an id", async () => {
  stub();
  assertEquals((await applySuggestionTool.handler({}, ctx)).isError, true);
  assertEquals((await dismissSuggestionTool.handler({}, ctx)).isError, true);
});

Deno.test("a 4xx from the pricing path surfaces its own message and eBay's", async () => {
  port.registerRepricer({
    preview: () => Promise.resolve({ items: [], capped: false }),
    apply: () => Promise.resolve({ applied: 0, ebay_synced: 0, skipped: [], errors: [] }),
    applySuggestion: () =>
      Promise.resolve({
        status: 502,
        body: {
          applied: false,
          error: "Couldn't update the price on eBay — left unapplied so you can retry.",
          ebay_error: "Invalid offer id",
        },
      }),
    dismissSuggestion: () => Promise.resolve({ status: 404, body: { error: "Suggestion not found" } }),
  });
  const applied = await applySuggestionTool.handler({ suggestion_id: "s-1" }, ctx);
  assertEquals(applied.isError, true);
  assert(/left unapplied/.test(textOf(applied)), "say it is retryable");
  assert(/Invalid offer id/.test(textOf(applied)), "and what eBay said");

  const dismissed = await dismissSuggestionTool.handler({ suggestion_id: "s-1" }, ctx);
  assertEquals(dismissed.isError, true);
  stub();
});

Deno.test("with no repricer registered every tool refuses", async () => {
  port.registerRepricer(
    undefined as unknown as Parameters<typeof port.registerRepricer>[0],
  );
  for (const tool of [repricePreviewTool, repriceApplyTool]) {
    const args = tool === repricePreviewTool
      ? { listing_ids: [L1] }
      : { items: [{ listing_id: L1, price_cents: 100 }], confirm_token: "x" };
    const result = await tool.handler(args, ctx);
    assertEquals(result.isError, true, `${tool.name} did not refuse`);
  }
  stub();
});

// ---------------------------------------------------------------------------
// AC6: the audit row
//
// The arguments say "listing X, 4200 cents". The old price is the half a
// pricing dispute actually turns on, and by the time anyone reads the row the
// listing already carries the new one. So the handler hands it to the audit
// explicitly rather than hoping it can be reconstructed.
// ---------------------------------------------------------------------------

Deno.test("a reprice records each listing and BOTH prices", async () => {
  __resetConfirmTokensForTest();
  stub();
  const token = await tokenFor();
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 11_000 }], confirm_token: token },
    ctx,
  );
  assert(!result.isError, textOf(result));
  assertEquals(result.auditDetail, {
    changes: [{
      listing_id: L1,
      from_price_cents: 10_000,
      to_price_cents: 11_000,
      changed: true,
    }],
  });
});

Deno.test("a listing the engine skipped is recorded as NOT changed", async () => {
  __resetConfirmTokensForTest();
  stub({
    apply: (items) => ({
      applied: 0,
      ebay_synced: 0,
      skipped: [{ listing_id: items[0]!.listing_id, reason: "no live offer" }],
      errors: [],
    }),
  });
  const token = await tokenFor();
  const result = await repriceApplyTool.handler(
    { items: [{ listing_id: L1, price_cents: 11_000 }], confirm_token: token },
    ctx,
  );
  const changes = (result.auditDetail as { changes: Array<{ changed: boolean }> }).changes;
  assertEquals(changes[0]!.changed, false, "a skipped listing was logged as repriced");
});

Deno.test("taking one suggestion records both prices too", async () => {
  stub();
  port.registerRepricer({
    preview: () => Promise.resolve({ items: [row()], capped: false }),
    apply: (_o, items) =>
      Promise.resolve({ applied: items.length, ebay_synced: 0, skipped: [], errors: [] }),
    applySuggestion: () =>
      Promise.resolve({
        status: 200,
        body: { applied: true, old_price: 50, new_price: 42, ebay_synced: true },
      }),
    dismissSuggestion: () => Promise.resolve({ status: 200, body: { dismissed: true } }),
  });

  const result = await applySuggestionTool.handler({ suggestion_id: "sug-1" }, ctx);
  assert(!result.isError, textOf(result));
  assertEquals(result.auditDetail, {
    changes: [{
      suggestion_id: "sug-1",
      from_price_cents: 5_000,
      to_price_cents: 4_200,
      changed: true,
    }],
  });
  // The seller is told both numbers as well, not just the new one.
  assert(textOf(result).includes("Was $50.00, now $42.00"), textOf(result));
});

Deno.test("dismissing a suggestion writes no price detail, because no price moved", async () => {
  stub();
  const result = await dismissSuggestionTool.handler({ suggestion_id: "sug-1" }, ctx);
  assert(!result.isError, textOf(result));
  assertEquals(result.auditDetail, undefined);
});
