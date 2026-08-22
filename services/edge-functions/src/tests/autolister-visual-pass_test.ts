// US-2778: AutoLister's half of the visual pass.
//
// The capture screen has had eBay corroboration since US-2768 and the batch
// worker has never seen it. `generateListing` is what AutoLister calls, and a
// grep for "visual" in ai-listing.ts returned four prompt comments and zero
// calls.
//
// Like visual-identify-pass_test.ts, most of what follows is a refusal. The
// block may only ever ADD to the prompt, and the flag-off case has to be
// provably byte-identical to the path that works today.

import "./_env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildListingUserLines,
  LISTING_GEN_TOOL,
  type OwnListingReader,
  ownEbayListingIds,
} from "../lib/ai-listing.ts";
import type { VisualCandidate } from "../lib/visual-candidates.ts";

const CANDIDATES: VisualCandidate[] = [
  { field: "brand", value: "Lululemon", support: 4, outOf: 5 },
  { field: "style", value: "Rest Less 1/2 Zip", support: 3, outOf: 5 },
];

const BASE = {
  photos: [{ url: "https://example.test/front.jpg", type: "front" }],
};

// ── The block appears, and only when there is something to adjudicate ────────

Deno.test("no visual candidates leaves the prompt untouched", () => {
  const withNone = buildListingUserLines(BASE).join("\n\n");
  const withEmpty = buildListingUserLines({ ...BASE, visualCandidates: [] })
    .join("\n\n");

  // Byte-identical, not merely "does not contain the header". An empty array
  // and an absent field are the same prompt or the flag-off guarantee is not a
  // guarantee.
  assertEquals(withEmpty, withNone);
  assert(!withNone.includes("UNVERIFIED EXTERNAL GUESS"));
});

Deno.test("visual candidates render the shared adjudication block", () => {
  const text = buildListingUserLines({ ...BASE, visualCandidates: CANDIDATES })
    .join("\n\n");

  assertStringIncludes(text, "UNVERIFIED EXTERNAL GUESS");
  assertStringIncludes(text, "Lululemon");
  assertStringIncludes(text, "declared by 4 of 5 similar listings");
  // The precedence ladder is the point of the block; a paraphrase here would
  // mean ai-listing grew its own copy of a rule that lives in one place.
  assertStringIncludes(text, "a style/model code printed on the tag");
  assertStringIncludes(text, "visual_rulings");
});

Deno.test("candidates with no value or no support are not offered", () => {
  const text = buildListingUserLines({
    ...BASE,
    visualCandidates: [
      { field: "brand", value: "", support: 3, outOf: 5 },
      { field: "type", value: "Hoodie", support: 0, outOf: 5 },
    ],
  }).join("\n\n");
  assert(!text.includes("UNVERIFIED EXTERNAL GUESS"));
});

// ── The block still loses to the tag ─────────────────────────────────────────

Deno.test("tag ground truth is stated before the visual guess", () => {
  const text = buildListingUserLines({
    ...BASE,
    tagGroundTruth: { brand: "Patagonia" },
    visualCandidates: CANDIDATES,
  }).join("\n\n");

  const tagAt = text.indexOf("TAG GROUND TRUTH");
  const visualAt = text.indexOf("UNVERIFIED EXTERNAL GUESS");
  assert(tagAt >= 0 && visualAt >= 0);
  // Order is not the mechanism - the precedence ladder inside the block is -
  // but a guess printed above the ground truth it must never override reads
  // as the more authoritative of the two, and costs nothing to get right.
  assert(tagAt < visualAt, "tag ground truth must precede the visual block");
});

// ── Somewhere for the verdict to go ──────────────────────────────────────────

Deno.test("create_ebay_listing accepts visual_rulings, and does not require it", () => {
  const props = LISTING_GEN_TOOL.input_schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  assert(props, "tool schema has properties");

  const rulings = props.visual_rulings;
  assert(rulings, "visual_rulings is on the tool schema");
  assertEquals(rulings.type, "array");

  const item = rulings.items as Record<string, unknown>;
  const itemProps = item.properties as Record<string, unknown>;
  for (const key of ["field", "value", "verdict", "evidence"]) {
    assert(itemProps[key], `visual_rulings item carries ${key}`);
  }

  // WITHOUT THIS the block asks for a decision and gives it nowhere to go,
  // which is the failure recorded at visual-candidates.ts:113 from the extract
  // path's first cut.
  const required = LISTING_GEN_TOOL.input_schema.required as string[];
  assert(
    !required.includes("visual_rulings"),
    "a prompt version that never shows the block must still satisfy the tool",
  );
});

// ── We cannot corroborate ourselves, and we cannot read anyone else ──────────

function fakeReader(
  result: { data?: unknown; error?: { message: string } },
): { client: OwnListingReader; filters: Array<[string, unknown]>; cols: string[] } {
  const filters: Array<[string, unknown]> = [];
  const cols: string[] = [];
  // deno-lint-ignore no-explicit-any
  const self: any = {
    eq(col: string, val: unknown) {
      filters.push([col, val]);
      return self;
    },
    not(col: string, op: string, val: unknown) {
      filters.push([`not:${col}`, `${op}:${val}`]);
      return self;
    },
    limit() {
      return Promise.resolve({
        data: result.data ?? null,
        error: result.error ?? null,
      });
    },
  };
  const client = {
    from: () => ({
      select(c: string) {
        cols.push(c);
        return self;
      },
    }),
  } as unknown as OwnListingReader;
  return { client, filters, cols };
}

Deno.test("the own-listing read is scoped to the owner (US-268)", async () => {
  const { client, filters, cols } = fakeReader({
    data: [
      { platform_listing_id: "  111  " },
      { platform_listing_id: null },
      { platform_listing_id: "222" },
    ],
  });

  const ids = await ownEbayListingIds("owner-a", client);

  assertEquals(ids, new Set(["111", "222"]));
  // `listings` has no user_id of its own, so the ownership filter has to travel
  // through the join. An inner join is what makes it a filter rather than a
  // decoration - a left join here would return every seller's listings with a
  // null user_id attached.
  assert(
    cols.some((c) => c.includes("inventory_items!inner(user_id)")),
    "ownership must be enforced by an INNER join, not a left one",
  );
  const owner = filters.find(([col]) => col === "inventory_items.user_id");
  assert(owner, "the owner filter is present");
  assertEquals(owner[1], "owner-a");
  assert(filters.some(([col, val]) => col === "platform" && val === "ebay"));
});

Deno.test("a failed own-listing read is an empty set, never a throw", async () => {
  const { client } = fakeReader({ error: { message: "boom" } });
  // Losing the exclusion weakens the evidence. Losing the pass removes it.
  assertEquals(await ownEbayListingIds("owner-a", client), new Set());
});
