// US-1893: leaf-category guard. Publish must reject a non-leaf / unknown eBay
// category id with a fixable blocker instead of an opaque eBay error. These
// cover the pure decision surface: the cache-hit fast path (non-empty aspects
// prove leaf-ness), the subtree parse, and the blocker phrasing. The route's
// isLeafCategory composes these with the DB cache + Taxonomy fetch.

import { assert, assertEquals } from "@std/assert";
import {
  cachedAspectsProveLeaf,
  leafCategoryBlocker,
  parseSubtreeIsLeaf,
  type SubtreeResponse,
} from "../lib/category-leaf.ts";

// ── cache-hit path ───────────────────────────────────────────────────
Deno.test("cachedAspectsProveLeaf: non-empty aspects prove a leaf (cache hit)", () => {
  assert(cachedAspectsProveLeaf({ Brand: ["Nike"], Size: ["M"] }));
});

Deno.test("cachedAspectsProveLeaf: empty / non-object aspects prove nothing", () => {
  assertEquals(cachedAspectsProveLeaf({}), false); // getCategoryName writes {} for display
  assertEquals(cachedAspectsProveLeaf(null), false);
  assertEquals(cachedAspectsProveLeaf([]), false);
  assertEquals(cachedAspectsProveLeaf("aspects"), false);
  assertEquals(cachedAspectsProveLeaf(undefined), false);
});

// ── subtree parse ────────────────────────────────────────────────────
Deno.test("parseSubtreeIsLeaf: leaf flag drives the result", () => {
  const leaf: SubtreeResponse = {
    categorySubtreeNode: {
      leafCategoryTreeNode: true,
      category: { categoryId: "57988" },
    },
  };
  const branch: SubtreeResponse = {
    categorySubtreeNode: {
      leafCategoryTreeNode: false,
      childCategoryTreeNodes: [{}, {}],
      category: { categoryId: "11450" },
    },
  };
  assertEquals(parseSubtreeIsLeaf(leaf), true);
  assertEquals(parseSubtreeIsLeaf(branch), false);
});

Deno.test("parseSubtreeIsLeaf: falls back to child presence when the flag is absent", () => {
  assertEquals(
    parseSubtreeIsLeaf({
      categorySubtreeNode: { childCategoryTreeNodes: [], category: { categoryId: "1" } },
    }),
    true,
  );
  assertEquals(
    parseSubtreeIsLeaf({
      categorySubtreeNode: { childCategoryTreeNodes: [{}], category: { categoryId: "1" } },
    }),
    false,
  );
});

Deno.test("parseSubtreeIsLeaf: unrecognizable/empty shape → null (unknown)", () => {
  assertEquals(parseSubtreeIsLeaf({}), null);
  assertEquals(parseSubtreeIsLeaf({ categorySubtreeNode: {} }), null);
  assertEquals(
    parseSubtreeIsLeaf({ categorySubtreeNode: { leafCategoryTreeNode: true } }),
    null, // no category id → can't trust it
  );
});

// ── blocker phrasing (leaf-pass vs non-leaf-block) ───────────────────
const SUGGESTION = {
  categoryId: "57988",
  categoryName: "Athletic Shoes",
  categoryTreePath: "Clothing › Shoes › Athletic Shoes",
};

Deno.test("leafCategoryBlocker: a confirmed leaf does not block (leaf-pass)", () => {
  assertEquals(leafCategoryBlocker(true, "57988", SUGGESTION), null);
  assertEquals(leafCategoryBlocker(true, "57988", null), null);
});

Deno.test("leafCategoryBlocker: a non-leaf blocks and offers the suggested leaf", () => {
  const b = leafCategoryBlocker(false, "11450", SUGGESTION);
  assert(b !== null);
  assert(b!.includes("isn't a specific (leaf) category"));
  assert(b!.includes("57988"));
  assert(b!.includes("Clothing › Shoes › Athletic Shoes"));
});

Deno.test("leafCategoryBlocker: an unknown id blocks with 'could not be verified'", () => {
  const b = leafCategoryBlocker(null, "99999999", SUGGESTION);
  assert(b !== null);
  assert(b!.includes("could not be verified"));
  assert(b!.includes("57988"));
});

Deno.test("leafCategoryBlocker: no suggestion → generic composer fix", () => {
  const b = leafCategoryBlocker(false, "11450", null);
  assert(b !== null);
  assert(b!.includes("Pick a specific (leaf) category"));
});
