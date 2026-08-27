// US-2961: the wirings that decide whether snippets are safe, checked at source.
//
// Three of this story's acceptance criteria are about what the code must NOT
// do, and each of them fails silently when it breaks:
//
//   * the settings page must go to Supabase under RLS, not through an edge CRUD
//     API that would need its own tenant scoping;
//   * apply-to-drafts must touch drafts and nothing else, and that filter lives
//     on the server where a browser cannot widen it;
//   * a protected page must NOT be registered as an indexable public route.
//
// The last one is the sharpest: adding it to PUBLIC_ROUTES would put a
// ProtectedRoute behind a prerender and a sitemap entry, so a crawler would
// index a redirect and the SEO guards would not object.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXTUAL_ROUTES } from "@/lib/surfaces";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { addSnippetBlock, describeBlock, removeBlockAt } from "@/lib/description-blocks";
import type { BlockRowContext } from "@/lib/description-blocks";
import type { DescriptionBlock } from "@/types/database";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const SNIPPETS_PATH = "/dashboard/flipdesk/settings/blocks";

describe("the settings page is registered and reachable (AC1)", () => {
  const routes = read("src/routes/index.tsx");

  it("has a route", () => {
    expect(routes).toContain(`path: "${SNIPPETS_PATH}"`);
    expect(routes).toContain("FlipdeskDescriptionSnippetsPage");
  });

  it("is linked from the composer's description card", () => {
    // A route nobody links to is a route nobody finds. The card is where a
    // seller is standing when they want a standing line.
    const card = read("src/components/flipdesk/composer/description-card.tsx");
    expect(card).toContain(`const SNIPPETS_HREF = "${SNIPPETS_PATH}"`);
    expect(card).toContain("Manage snippets");
    expect(card).toContain("addSnippetBlock(blocks, s.id)");
  });

  it("is exempted from the nav registry with a reason, not left orphaned", () => {
    const exemption = CONTEXTUAL_ROUTES.find((r) => r.path === SNIPPETS_PATH);
    expect(exemption, "the route needs a CONTEXTUAL_ROUTES entry").toBeTruthy();
    expect(exemption!.why.length).toBeGreaterThan(25);
  });
});

describe("the page talks to Supabase under RLS, not to an edge CRUD API (AC1)", () => {
  const lib = read("src/lib/flipdesk-snippets.ts");

  it("reads and writes listing_snippets through the browser client", () => {
    for (const call of [
      '.from("listing_snippets")\n    .select("*")',
      '.from("listing_snippets")\n    // `as never`',
      '.from("listing_snippets")\n    .update(',
      '.from("listing_snippets").delete()',
    ]) {
      expect(lib, call).toContain(call);
    }
    expect(lib).toContain('import { supabase } from "@/lib/supabase"');
  });

  it("uses the edge for exactly one thing: the re-render", () => {
    const edgeCalls = lib.match(/edgeFetch\(/g) ?? [];
    expect(edgeCalls.length, "only apply-to-drafts should leave the browser").toBe(1);
    expect(lib).toContain("/api/flipdesk/description/snippets/${id}/apply");
  });
});

describe("apply-to-drafts cannot reach a published listing (AC3)", () => {
  const render = read("services/edge-functions/src/lib/description-render.ts");
  const body = render.slice(render.indexOf("export async function applySnippetToDrafts"));

  it("filters on listing_status in the query", () => {
    expect(body).toContain('.eq("listing_status", "draft")');
  });

  it("takes no status from the caller", () => {
    // The route passes a snippet id and an owner id. If a status ever became a
    // parameter, the safety property would move into the browser.
    expect(body).not.toMatch(/status\s*[:=]\s*(body|params|c\.req)/);
    const route = read("services/edge-functions/src/routes/flipdesk-description.ts");
    const handler = route.slice(route.indexOf('.post("/snippets/:snippetId/apply"'));
    expect(handler).not.toContain("c.req.json()");
  });

  it("tells the seller so before they tick the box", () => {
    // Asserted on the source rather than on markup because the dialog is closed
    // on first paint. A published description is what a buyer is reading; the
    // checkbox has to say it is not in scope.
    const page = read("src/pages/flipdesk/description-snippets.tsx");
    expect(page).toContain("Drafts only.");
    expect(page).toContain("Update my open drafts now");
  });

  it("proves the snippet is the caller's before reading any listing", () => {
    expect(body.indexOf('.eq("user_id", ownerId)')).toBeLessThan(
      body.indexOf('.from("listings")'),
    );
  });
});

describe("a snippet block stores only a ref (AC2)", () => {
  it("adds a block carrying the id and no body", () => {
    const blocks: DescriptionBlock[] = [
      { key: "intro", on: true, src: "ai", text: "hi" },
      { key: "credentials", on: true, src: "seller" },
      { key: "facts", on: true, src: "system" },
    ];
    const out = addSnippetBlock(blocks, "snip-1");
    expect(out.map((b) => b.key)).toEqual([
      "intro",
      "snippet",
      "credentials",
      "facts",
    ]);
    const added = out[1]!;
    expect(added).toEqual({ key: "snippet", on: true, src: "account", ref: "snip-1" });
    expect(added.text).toBeUndefined();
  });

  it("appends when there is nothing pinned to sit above", () => {
    const out = addSnippetBlock([{ key: "intro", on: true, src: "ai" }], "s");
    expect(out.map((b) => b.key)).toEqual(["intro", "snippet"]);
  });

  it("removeBlockAt drops exactly one row", () => {
    const blocks: DescriptionBlock[] = [
      { key: "intro", on: true, src: "ai" },
      { key: "snippet", on: true, src: "account", ref: "s" },
      { key: "facts", on: true, src: "system" },
    ];
    expect(removeBlockAt(blocks, 1).map((b) => b.key)).toEqual(["intro", "facts"]);
    expect(removeBlockAt(blocks, 9)).toBe(blocks);
  });
});

describe("a deleted snippet is visible, not silent (AC5)", () => {
  const ctx = (over: Partial<BlockRowContext>): BlockRowContext => ({
    attributes: {},
    measurementCount: 0,
    unit: "in",
    gradeValue: null,
    snippetNames: {},
    ...over,
  });
  const block: DescriptionBlock = {
    key: "snippet",
    on: true,
    src: "account",
    ref: "gone",
  };

  it("says the section shows nothing once the list has loaded", () => {
    // The renderer already degrades safely: a ref with no row renders an empty
    // string and does not throw. That is the right behaviour and an invisible
    // one, so the row is where the seller gets told.
    expect(describeBlock(block, ctx({ snippetsLoaded: true }))).toBe(
      "Deleted snippet, so this section shows nothing",
    );
  });

  it("does NOT say that while the list is still loading", () => {
    expect(describeBlock(block, ctx({ snippetsLoaded: false }))).toBe("Saved snippet");
    expect(describeBlock(block, ctx({}))).toBe("Saved snippet");
  });

  it("keeps a per-listing override whatever happened to the snippet (AC4)", () => {
    const overridden = { ...block, text: "This one ships Monday." };
    expect(describeBlock(overridden, ctx({ snippetsLoaded: true }))).toBe(
      "This one ships Monday.",
    );
  });
});

describe("the protected settings page is not an indexable route (AC6)", () => {
  it("is absent from PUBLIC_ROUTES", () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path);
    expect(paths).not.toContain(SNIPPETS_PATH);
    // And nothing under /dashboard belongs there at all — the whole tree sits
    // behind ProtectedRoute, so a registered one would prerender a redirect.
    expect(paths.filter((p) => p.startsWith("/dashboard"))).toEqual([]);
  });

  it("is absent from the prerender entry", () => {
    expect(read("src/prerender/entry-server.tsx")).not.toContain(SNIPPETS_PATH);
  });
});

describe("the composer knows the seller's snippets (AC5)", () => {
  const composer = read("src/pages/flipdesk/composer.tsx");

  it("feeds the row context both the names and whether they loaded", () => {
    expect(composer).toContain("snippetNames: snippetNames(listingSnippets.snippets)");
    expect(composer).toContain("snippetsLoaded: listingSnippets.loaded");
  });

  it("offers the saved snippets as sections to add", () => {
    expect(composer).toContain("snippetOptions={listingSnippets.snippets.map");
  });
});
