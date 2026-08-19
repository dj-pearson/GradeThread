// US-9116: the publish tool.
//
// The eBay path is INJECTED through lib/ebay-publish-port.ts, so every case
// here runs for real against a stub publisher rather than skipping without a
// stack. That is the point of the port: the interesting behaviour is what the
// tool does with an answer, and stubbing the answer is how you test it.
//
// Four properties, each one a way a publish tool gets a seller a listing they
// did not agree to:
//
//   1. confirming without a token,
//   2. a token that survives a price change between the ask and the act,
//   3. reporting success from a result that never confirmed one,
//   4. saying "nothing was published" after an exception that may have.

import { assert, assertEquals } from "@std/assert";
// Types statically, values through the dynamic import below: a dynamic binding
// cannot be used as a type namespace, and the env has to be set before the
// module graph loads.
import type { PublishItemOutcome, PublishPreviewData } from "../lib/ebay-publish-port.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const port = await import("../lib/ebay-publish-port.ts");
const { publishListingTool } = await import("../lib/mcp-publish-tool.ts");
const { __resetConfirmTokensForTest } = await import("../lib/mcp-confirm.ts");

const ITEM = "33333333-3333-4333-8333-333333333333";
const ctx = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "22222222-2222-4222-8222-222222222222",
  scopes: ["read", "submit"] as Array<"read" | "submit" | "webhook_manage">,
};

function readyPreview(overrides: Partial<PublishPreviewData> = {}): PublishPreviewData {
  return {
    ready: true,
    blockers: [],
    warnings: [],
    title: "Vintage Levi's 501",
    price: 48,
    quantity: 1,
    categoryId: "11483",
    policiesReady: true,
    photoCount: 6,
    condition: "USED_EXCELLENT",
    ...overrides,
  };
}

/** Install a stub publisher and return what it recorded. */
function stub(opts: {
  preview?: () => PublishPreviewData;
  publish?: () => PublishItemOutcome | Promise<PublishItemOutcome>;
} = {}) {
  const calls = { previews: 0, publishes: 0 };
  port.registerEbayPublisher({
    preview: () => {
      calls.previews++;
      return Promise.resolve(opts.preview ? opts.preview() : readyPreview());
    },
    publish: () => {
      calls.publishes++;
      return Promise.resolve(
        opts.publish
          ? opts.publish()
          : {
            ok: true as const,
            listing_id: "v1|123|0",
            listing_url: "https://www.ebay.com/itm/123",
            offer_id: "of-1",
            sku: "SKU-1",
          },
      );
    },
    // US-9118 added relist to the port. Not exercised here — it has its own
    // tool and its own suite — but the shape has to be complete.
    relist: () => Promise.resolve({ status: 200, body: { ok: true } }),
  });
  return calls;
}

function textOf(r: { content: Array<{ text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

async function previewToken(): Promise<string> {
  const r = await publishListingTool.handler({ item_id: ITEM, mode: "preview" }, ctx);
  const token = (r.structuredContent as { confirm_token?: string } | undefined)?.confirm_token;
  assert(token, `no token in the preview: ${textOf(r)}`);
  return token;
}

// ---------------------------------------------------------------------------

Deno.test("the tool is destructive, open-world, and needs submit", () => {
  assertEquals(publishListingTool.requiredScope, "submit");
  assertEquals(publishListingTool.annotations.destructiveHint, true);
  assertEquals(
    publishListingTool.annotations.openWorldHint,
    true,
    "it reaches eBay, and eBay's answer is what decides whether the listing exists",
  );
});

Deno.test("preview publishes nothing and returns a token", async () => {
  __resetConfirmTokensForTest();
  const calls = stub();
  const result = await publishListingTool.handler({ item_id: ITEM, mode: "preview" }, ctx);
  assertEquals(calls.publishes, 0, "preview called the publish path");
  assert(!result.isError);
  assert(textOf(result).includes("Vintage Levi's 501"));
  assert((result.structuredContent as { confirm_token?: string }).confirm_token);
});

Deno.test("preview shows the price AND what eBay takes", async () => {
  __resetConfirmTokensForTest();
  stub();
  const result = await publishListingTool.handler({ item_id: ITEM, mode: "preview" }, ctx);
  const text = textOf(result);
  assert(text.includes("$48.00"), `the price is missing: ${text}`);
  assert(/eBay's cut/.test(text), "a seller approving a price should see what is taken from it");
  assert(/estimate/i.test(text), "the fee must be named as an estimate, not as an invoice");
});

Deno.test("an unready item gets the blockers, not 'publish failed'", async () => {
  __resetConfirmTokensForTest();
  const calls = stub({
    preview: () =>
      readyPreview({
        ready: false,
        blockers: ["Missing required aspect: Department"],
      }),
  });
  const result = await publishListingTool.handler({ item_id: ITEM, mode: "preview" }, ctx);
  assertEquals(result.isError, true);
  assert(textOf(result).includes("Department"), "the remediable cause must survive to the model");
  assertEquals(calls.publishes, 0);
  assert(
    !JSON.stringify(result.structuredContent ?? {}).includes("confirm_token"),
    "a blocked item must not get a token — confirming it would fail after the seller said yes",
  );
});

Deno.test("no business policies names the fix, not the symptom", async () => {
  __resetConfirmTokensForTest();
  stub({ preview: () => readyPreview({ ready: false, blockers: [], policiesReady: false }) });
  const result = await publishListingTool.handler({ item_id: ITEM, mode: "preview" }, ctx);
  assertEquals(result.isError, true);
  assert(/business polic/i.test(textOf(result)));
  assert(/Marketplaces/.test(textOf(result)), "say WHERE to fix it");
});

Deno.test("confirm without a token publishes nothing", async () => {
  __resetConfirmTokensForTest();
  const calls = stub();
  const result = await publishListingTool.handler({ item_id: ITEM, mode: "confirm" }, ctx);
  assertEquals(result.isError, true);
  assertEquals(calls.publishes, 0);
  assert(/preview/i.test(textOf(result)));
});

Deno.test("a valid token publishes once and reports the URL", async () => {
  __resetConfirmTokensForTest();
  const calls = stub();
  const token = await previewToken();
  const result = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    ctx,
  );
  assert(!result.isError, textOf(result));
  assertEquals(calls.publishes, 1);
  assert(textOf(result).includes("https://www.ebay.com/itm/123"));
});

Deno.test("the same token cannot publish twice", async () => {
  // The replay protection Idempotency-Key gives /api/v1. A model that times out
  // and retries must get a refusal, not a second listing.
  __resetConfirmTokensForTest();
  const calls = stub();
  const token = await previewToken();
  await publishListingTool.handler({ item_id: ITEM, mode: "confirm", confirm_token: token }, ctx);
  const second = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    ctx,
  );
  assertEquals(second.isError, true);
  assertEquals(calls.publishes, 1, "the token was spent twice");
});

Deno.test("a PRICE CHANGE between preview and confirm voids the token", async () => {
  // The case the payload hash exists for, and the reason a mode flag alone
  // would not do: the seller agreed to $48.
  __resetConfirmTokensForTest();
  let price = 48;
  const calls = stub({ preview: () => readyPreview({ price }) });
  const token = await previewToken();
  price = 95;
  const result = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(calls.publishes, 0, "it published at a price the seller never saw");
  assert(/preview/i.test(textOf(result)), "the refusal must say to preview again");
});

Deno.test("a TITLE change between preview and confirm voids the token", async () => {
  __resetConfirmTokensForTest();
  let title = "Vintage Levi's 501";
  const calls = stub({ preview: () => readyPreview({ title }) });
  const token = await previewToken();
  title = "Something else entirely";
  const result = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(calls.publishes, 0);
});

Deno.test("a WARNING changing does NOT void the token", async () => {
  // The other side of the same rule. Re-asking a seller because a non-blocking
  // note appeared teaches them to click through, which is worse than not asking.
  __resetConfirmTokensForTest();
  let warnings: string[] = [];
  const calls = stub({ preview: () => readyPreview({ warnings }) });
  const token = await previewToken();
  warnings = ["Your hero photo is a tag shot"];
  const result = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    ctx,
  );
  assert(!result.isError, textOf(result));
  assertEquals(calls.publishes, 1);
});

Deno.test("a token from ANOTHER credential cannot publish here", async () => {
  __resetConfirmTokensForTest();
  stub();
  const token = await previewToken();
  const result = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    { ...ctx, apiKeyId: "99999999-9999-4999-8999-999999999999" },
  );
  assertEquals(result.isError, true);
});

Deno.test("a success with NO listing id is reported as unknown, never as published", async () => {
  // US-2641's shape: the verb reported success because nothing threw. A seller
  // told "published" when it may not be will publish again and end up with two.
  __resetConfirmTokensForTest();
  stub({
    publish: () => ({
      ok: true as const,
      listing_id: "",
      listing_url: "",
      offer_id: "",
      sku: "SKU-1",
    }),
  });
  const token = await previewToken();
  const result = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  assert(/cannot confirm/i.test(textOf(result)));
  assert(/duplicate/i.test(textOf(result)), "say why not to just try again");
});

Deno.test("a refusal from eBay carries its own remediation", async () => {
  __resetConfirmTokensForTest();
  stub({
    publish: () => ({
      ok: false as const,
      status: 422,
      body: {
        error: "eBay rejected the offer.",
        blockers: ["Add a Department aspect"],
      },
    }),
  });
  const token = await previewToken();
  const result = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  const text = textOf(result);
  assert(text.includes("Department"));
  assert(/not published/i.test(text), "a refused publish should say the item is not live");
});

Deno.test("a THROWN error does not claim nothing was published", async () => {
  // The asymmetry that matters: a refusal is a known negative, an exception is
  // not. It can be thrown after eBay accepted the offer, and "nothing was
  // published" is exactly how a seller ends up with two listings.
  __resetConfirmTokensForTest();
  stub({
    publish: () => {
      throw new Error("socket hang up");
    },
  });
  const token = await previewToken();
  const result = await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token },
    ctx,
  );
  assertEquals(result.isError, true);
  const text = textOf(result);
  assert(/may or may not/i.test(text), `it claimed to know the outcome: ${text}`);
  assert(!/nothing was published/i.test(text));
});

Deno.test("with no publisher registered the tool refuses rather than reporting success", async () => {
  __resetConfirmTokensForTest();
  // Deliberately clears the seam. A null publisher means the route module was
  // never loaded; publishing through it would quietly do nothing.
  port.registerEbayPublisher(
    undefined as unknown as Parameters<typeof port.registerEbayPublisher>[0],
  );
  const result = await publishListingTool.handler({ item_id: ITEM, mode: "preview" }, ctx);
  assertEquals(result.isError, true);
  // Put a working stub back so ordering cannot affect other files.
  stub();
});

Deno.test("the caller's tenant is the owner, never an argument", async () => {
  // US-268, and the reason it is here rather than only in the isolation lane:
  // that lane's publish case cannot discriminate on the current fixture, because
  // assemblePublishContext refuses on the missing eBay connection before it ever
  // reaches the ownership check. So this pins the half the tool owns — that the
  // owner id it passes down is the AUTHENTICATED tenant and not something a
  // model could put in the arguments.
  __resetConfirmTokensForTest();
  const seen: Array<{ owner: string; item: string }> = [];
  port.registerEbayPublisher({
    preview: (owner, item) => {
      seen.push({ owner, item });
      return Promise.resolve(readyPreview());
    },
    publish: (owner, item) => {
      seen.push({ owner, item });
      return Promise.resolve({
        ok: true as const,
        listing_id: "v1|1|0",
        listing_url: "u",
        offer_id: "o",
        sku: "s",
      });
    },
    relist: (owner, listing) => {
      seen.push({ owner, item: listing });
      return Promise.resolve({ status: 200, body: { ok: true } });
    },
  });

  // An owner-shaped argument the schema does not declare, in case a future edit
  // ever starts reading one.
  const token = await previewToken();
  await publishListingTool.handler(
    { item_id: ITEM, mode: "confirm", confirm_token: token, user_id: "somebody-else" },
    ctx,
  );

  assert(seen.length >= 2, "the publisher was not called");
  for (const call of seen) {
    assertEquals(
      call.owner,
      ctx.tenantId,
      "the publish path was handed an owner that is not the authenticated tenant",
    );
    assertEquals(call.item, ITEM);
  }
  stub();
});

Deno.test("importing the eBay route registers a publisher", async () => {
  await import("../routes/flipdesk-ebay.ts");
  assert(
    port.hasEbayPublisher(),
    "routes/flipdesk-ebay.ts no longer calls registerEbayPublisher, so the publish " +
      "tool now refuses every call — which reads as an outage, not as a wiring bug",
  );
});
