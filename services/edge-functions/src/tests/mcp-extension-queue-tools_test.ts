// US-3065 AC1/AC2: the connector's two extension-queue tools.
//
// The caller is a language model, so every refusal here is shaped around a
// mistake a model makes in a recognisable way: inventing a channel, asking for
// "everything", or passing a kind that reads plausibly and is not one of the
// four the extension knows.
//
// THE SENTENCE THAT MATTERS is QUEUED_NOTICE. A model reporting "done, it's
// listed" about a queued job is the failure this whole feature is arranged
// around — the seller's desktop may be shut. So it appears verbatim in the
// preview and in the result, and this file pins that the module never writes
// its own wording for it.
import assert from "node:assert/strict";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");

const {
  MAX_QUEUE_TOOL_ITEMS,
  QUEUE_TOOL_PLATFORMS,
  extensionQueueTool,
  parseQueueRequest,
  plannedRowCount,
  previewText,
  queueExtensionWorkTool,
} = await import("../lib/mcp-extension-queue-tools.ts");
const { QUEUED_NOTICE, MAX_QUEUE_DEPTH } = await import("../lib/extension-queue.ts");
const { budgetKindForTool, DEFAULT_BUDGETS } = await import("../lib/mcp-budget.ts");
const { WRITE_TOOL_NAMES } = await import("../lib/mcp-tools.ts");

const OK = { kind: "list", item_ids: ["a", "b"], platforms: ["poshmark", "mercari"] };

Deno.test("US-3065: a well-formed request parses and counts one row per item per channel", () => {
  const out = parseQueueRequest(OK);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.request.itemIds, ["a", "b"]);
  assert.deepEqual(out.request.platforms, ["poshmark", "mercari"]);
  assert.equal(plannedRowCount(out.request), 4);
});

Deno.test("US-3065: an invented channel is refused and the real ones are named", () => {
  // A model asked for "everywhere" will guess. The refusal has to say which
  // channels exist, or the next attempt is another guess.
  for (const bad of ["ebay", "etsy", "shopify", "everywhere", "depop"]) {
    const out = parseQueueRequest({ ...OK, platforms: [bad] });
    assert.equal(out.ok, false, `${bad} was accepted`);
    if (out.ok) return;
    assert.match(out.error, /poshmark/);
    assert.match(out.error, new RegExp(bad));
  }
  // eBay in particular has a write API, so the refusal points at it rather than
  // just saying no.
  const ebay = parseQueueRequest({ ...OK, platforms: ["ebay"] });
  assert.equal(ebay.ok, false);
  if (ebay.ok) return;
  assert.match(ebay.error, /write\s+APIs?/i);
});

Deno.test("US-3065: only the four kinds the extension knows are accepted", () => {
  for (const bad of ["publish", "sell", "post", "cross-list", "", "LIST "]) {
    assert.equal(parseQueueRequest({ ...OK, kind: bad }).ok, false, `${bad} was accepted`);
  }
  for (const good of ["list", "delist", "revise", "relist"]) {
    assert.equal(parseQueueRequest({ ...OK, kind: good }).ok, true, good);
  }
});

Deno.test("US-3065: an empty or oversized batch is refused", () => {
  assert.equal(parseQueueRequest({ ...OK, item_ids: [] }).ok, false);
  assert.equal(parseQueueRequest({ ...OK, platforms: [] }).ok, false);
  assert.equal(parseQueueRequest({ ...OK, item_ids: "all" }).ok, false);

  const many = Array.from({ length: MAX_QUEUE_TOOL_ITEMS + 1 }, (_, i) => `i${i}`);
  const out = parseQueueRequest({ ...OK, item_ids: many });
  assert.equal(out.ok, false);
  if (out.ok) return;
  // The reason is about a PERSON being able to read what they agreed to, not
  // about a technical limit, and the message says so.
  assert.match(out.error, /see what they agreed to/);

  // Exactly at the cap is fine — the boundary, in both directions.
  assert.equal(
    parseQueueRequest({ ...OK, item_ids: many.slice(0, MAX_QUEUE_TOOL_ITEMS) }).ok,
    true,
  );
});

Deno.test("US-3065: duplicates collapse before the cap is applied", () => {
  // "list these" from a model that repeated itself is one item, not a refusal.
  const out = parseQueueRequest({
    ...OK,
    item_ids: Array(30).fill("same"),
    platforms: ["poshmark", "poshmark", "POSHMARK"],
  });
  assert.equal(out.ok, true, "30 duplicate ids were rejected as over the cap");
  if (!out.ok) return;
  assert.deepEqual(out.request.itemIds, ["same"]);
  assert.deepEqual(out.request.platforms, ["poshmark"]);
});

Deno.test("US-3065: the preview names every item and channel, and ends with THE notice", () => {
  const out = parseQueueRequest(OK);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const text = previewText(out.request, new Map([["a", "Blue Jacket"], ["b", "Red Skirt"]]));

  // Named, not summarised: "queue 12 items" is the shape of approval somebody
  // clicks through.
  assert.match(text, /Blue Jacket/);
  assert.match(text, /Red Skirt/);
  assert.match(text, /poshmark, mercari/);

  // And the notice, verbatim and last, so the person approving is never told
  // the listing is live.
  assert.ok(text.endsWith(QUEUED_NOTICE), `the preview does not end with QUEUED_NOTICE:\n${text}`);
});

Deno.test("US-3065: an unknown item falls back to its id rather than rendering undefined", () => {
  const out = parseQueueRequest({ ...OK, item_ids: ["ghost"] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const text = previewText(out.request, new Map());
  assert.match(text, /ghost/);
  assert.ok(!/undefined/.test(text), text);
});

Deno.test("US-3065: the write tool asks a PERSON, and only on the acting call", () => {
  const ask = queueExtensionWorkTool.humanConfirmation!;
  assert.equal(ask({ mode: "preview" }), null, "a preview must not prompt anyone");
  assert.equal(ask({}), null, "the default mode must not prompt anyone");
  const prompt = ask({ mode: "confirm" });
  assert.ok(prompt, "confirm must ask a person");
  // The question says QUEUED, not listed. A prompt implying the listing goes
  // live is the whole failure of this feature in one sentence.
  assert.match(prompt!, /queue/i);
  assert.ok(!/\blive\b|\blisted\b/i.test(prompt!), prompt!);
});

Deno.test("US-3065: the write tool is destructive and budgeted, the read tool is neither", () => {
  assert.equal(queueExtensionWorkTool.annotations.destructiveHint, true);
  assert.equal(extensionQueueTool.annotations.readOnlyHint, true);

  // WRITE_TOOL_NAMES is DERIVED from destructiveHint, so the write tool lands in
  // it without anyone remembering — which is what AC1 asks for, by construction.
  assert.ok(WRITE_TOOL_NAMES.includes(queueExtensionWorkTool.name));
  assert.ok(!WRITE_TOOL_NAMES.includes(extensionQueueTool.name));

  assert.equal(budgetKindForTool(queueExtensionWorkTool.name), "extension_queue");
  assert.equal(budgetKindForTool(extensionQueueTool.name), null);
  assert.equal(DEFAULT_BUDGETS.extension_queue.max, 20);
});

Deno.test("US-3065: nothing here reaches a marketplace, and the hint says so", () => {
  // The ADR: no server-side marketplace automation. This tool writes rows in
  // our own database; the seller's browser is what talks to anyone else. An
  // openWorldHint of true would tell a client the opposite.
  assert.equal(queueExtensionWorkTool.annotations.openWorldHint, false);
  assert.equal(extensionQueueTool.annotations.openWorldHint, false);
});

Deno.test("US-3065: the per-call cap cannot exceed what the queue holds", () => {
  // MAX_QUEUE_TOOL_ITEMS items across every channel must stay under the depth
  // cap, or a single legal call would be refused row by row halfway through.
  assert.ok(
    MAX_QUEUE_TOOL_ITEMS * QUEUE_TOOL_PLATFORMS.length <= MAX_QUEUE_DEPTH,
    `${MAX_QUEUE_TOOL_ITEMS} items on ${QUEUE_TOOL_PLATFORMS.length} channels is ` +
      `${MAX_QUEUE_TOOL_ITEMS * QUEUE_TOOL_PLATFORMS.length} rows, over the ` +
      `${MAX_QUEUE_DEPTH} depth cap`,
  );
});

Deno.test("US-3065: the notice is imported, never re-written", () => {
  const src = Deno.readTextFileSync(
    new URL("../lib/mcp-extension-queue-tools.ts", import.meta.url),
  );
  // Four clients mirror QUEUED_NOTICE byte-for-byte. A tool inventing its own
  // wording is the drift that rule exists to stop.
  assert.match(src, /QUEUED_NOTICE/);
  assert.ok(
    !/notice: "/.test(src),
    "the tools module writes its own notice string instead of QUEUED_NOTICE",
  );
});
