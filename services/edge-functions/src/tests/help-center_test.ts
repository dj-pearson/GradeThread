// US-2573: the Help Center visibility wall.
//
// These are pure unit tests on purpose. The wall is a function of (viewer, row)
// and nothing else, so it can be pinned without a database, a JWT or a running
// service — which means it runs on every `deno test`, not only in the CI-only
// integration lane. The route file is forbidden from re-deriving the rule; it
// calls visibilitiesFor/canView, so testing them tests every endpoint.
//
// Deliberately NOT added to tenant-isolation_test.ts, despite the story's AC.
// That suite asserts "user B cannot read user A's row", and help_articles has
// no tenant: there is no such thing as A's help article. Copying a case there
// would have asserted nothing and would have needed two seeded JWTs to do it.
// The property that actually matters here is visibility escalation, and it is
// below.
import { assert, assertEquals } from "@std/assert";
import {
  canView,
  cleanSlugArray,
  HELP_QUERY_MAX_LENGTH,
  HELP_VISIBILITIES,
  isSearchableHelpQuery,
  normalizeHelpQuery,
  type HelpArticleRow,
  type HelpVisibility,
  isReservedHelpSlug,
  isStale,
  normalizeFaq,
  projectArticle,
  projectListItem,
  readableStatusesFor,
  slugifyHelp,
  visibilitiesFor,
} from "../lib/help-center.ts";

function row(over: Partial<HelpArticleRow> = {}): HelpArticleRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "your-first-grade",
    title: "Your first grade",
    summary: "Upload four photos and read the report.",
    body_html: "<p>hi</p>",
    body_json: {},
    body_markdown: "hi",
    category_key: "getting-started",
    audience: "all",
    visibility: "public",
    status: "published",
    sort_order: 10,
    hero_image_url: null,
    faq: [],
    related_slugs: [],
    video_url: null,
    pillar_path: "/how-it-works",
    published_at: "2026-08-01T00:00:00.000Z",
    reviewed_at: null,
    review_interval_days: 180,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

Deno.test("anon sees public only", () => {
  assertEquals(visibilitiesFor("anon"), ["public"]);
});

Deno.test("a member sees public and members, NEVER internal", () => {
  const v = visibilitiesFor("member");
  assert(v.includes("public"));
  assert(v.includes("members"));
  assert(
    !v.includes("internal"),
    "an authenticated session belongs to a customer; operator runbooks are not " +
      "customer-readable just because someone signed up",
  );
});

Deno.test("an admin sees every visibility", () => {
  assertEquals(new Set(visibilitiesFor("admin")), new Set(HELP_VISIBILITIES));
});

Deno.test("visibility is strictly escalating — no viewer skips a level", () => {
  const anon = visibilitiesFor("anon");
  const member = visibilitiesFor("member");
  const admin = visibilitiesFor("admin");
  for (const v of anon) assert(member.includes(v), `member lost ${v}`);
  for (const v of member) assert(admin.includes(v), `admin lost ${v}`);
});

Deno.test("canView: the full (viewer x visibility) grid", () => {
  const expected: Record<string, Record<HelpVisibility, boolean>> = {
    anon: { public: true, members: false, internal: false },
    member: { public: true, members: true, internal: false },
    admin: { public: true, members: true, internal: true },
  };
  for (const viewer of ["anon", "member", "admin"] as const) {
    for (const visibility of HELP_VISIBILITIES) {
      assertEquals(
        canView(viewer, { visibility, status: "published" }),
        expected[viewer][visibility],
        `${viewer} vs ${visibility}`,
      );
    }
  }
});

Deno.test("no viewer reads a draft or an archived article through a reader", () => {
  for (const viewer of ["anon", "member", "admin"] as const) {
    assertEquals(readableStatusesFor(viewer), ["published"]);
    assertEquals(canView(viewer, { visibility: "public", status: "draft" }), false);
    assertEquals(canView(viewer, { visibility: "public", status: "archived" }), false);
  }
});

Deno.test("reserved slugs cannot be taken by an article", () => {
  for (const s of ["search", "categories", "sitemap", "admin", "new"]) {
    assert(isReservedHelpSlug(s), `${s} should be reserved`);
    assert(isReservedHelpSlug(s.toUpperCase()), `${s} should be reserved case-insensitively`);
  }
  assert(!isReservedHelpSlug("your-first-grade"));
});

Deno.test("slugify strips punctuation, casing and edge dashes", () => {
  assertEquals(slugifyHelp("  What's a 10.0?  "), "whats-a-10-0");
  assertEquals(slugifyHelp("eBay Item Specifics"), "ebay-item-specifics");
  assertEquals(slugifyHelp("---"), "");
  assertEquals(slugifyHelp("a".repeat(200)).length, 80);
});

Deno.test("normalizeFaq drops anything that is not a full question/answer pair", () => {
  const out = normalizeFaq([
    { question: "Why?", answer: "Because." },
    { question: "  padded  ", answer: "  trimmed  " },
    { question: "no answer" },
    { answer: "no question" },
    { question: "", answer: "empty q" },
    "a string",
    null,
    42,
  ]);
  assertEquals(out, [
    { question: "Why?", answer: "Because." },
    { question: "padded", answer: "trimmed" },
  ]);
  assertEquals(normalizeFaq(null), []);
  assertEquals(normalizeFaq({ question: "not an array" }), []);
});

Deno.test("cleanSlugArray normalizes, dedupes and preserves order", () => {
  assertEquals(
    cleanSlugArray(["Your First Grade", "your-first-grade", "", null, "Photo Tips"]),
    ["your-first-grade", "photo-tips"],
  );
});

Deno.test("projectListItem does not carry a body", () => {
  const item = projectListItem(row({ body_html: "<p>secret-ish</p>" }));
  assert(!("body_html" in item), "a list payload must not ship every article body");
  assert(!("body_markdown" in item));
  assertEquals(item.slug, "your-first-grade");
});

Deno.test("projectArticle normalizes faq and related_slugs on the way out", () => {
  const view = projectArticle(
    row({
      faq: [{ question: "Q", answer: "A" }, { question: "broken" }],
      related_slugs: ["Photo Tips", "photo-tips"],
    }),
  );
  assertEquals(view.faq, [{ question: "Q", answer: "A" }]);
  assertEquals(view.related_slugs, ["photo-tips"]);
});

Deno.test("projectArticle never leaks the internal row id", () => {
  const view = projectArticle(row()) as unknown as Record<string, unknown>;
  assert(!("id" in view), "the public payload addresses articles by slug, not by uuid");
  assert(!("status" in view), "status is an authoring concern; a reader only ever gets published");
  assert(!("body_json" in view), "the Tiptap document is the editor's, not the renderer's");
});

Deno.test("US-2591: staleness is measured from reviewed_at, falling back to published_at", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-08-14T00:00:00.000Z");

  // Reviewed 200 days ago on a 180-day interval → stale.
  assert(
    isStale(
      {
        reviewed_at: new Date(now - 200 * day).toISOString(),
        published_at: null,
        review_interval_days: 180,
      },
      now,
    ),
  );
  // Reviewed 10 days ago → fresh, even if published years back.
  assert(
    !isStale(
      {
        reviewed_at: new Date(now - 10 * day).toISOString(),
        published_at: "2020-01-01T00:00:00.000Z",
        review_interval_days: 180,
      },
      now,
    ),
  );
  // Never reviewed → publish date is the clock.
  assert(
    isStale(
      { reviewed_at: null, published_at: new Date(now - 400 * day).toISOString(), review_interval_days: 180 },
      now,
    ),
  );
  // Never reviewed and never published (a draft) → not stale, it is unborn.
  assert(!isStale({ reviewed_at: null, published_at: null, review_interval_days: 180 }, now));
  // Unparseable timestamp must not read as "infinitely stale".
  assert(!isStale({ reviewed_at: "not a date", published_at: null, review_interval_days: 180 }, now));
});

// ── search (US-2577) ──────────────────────────────────────

Deno.test("query normalization folds case and collapses whitespace", () => {
  // So "eBay  Fees" and "ebay fees" rank together in the zero-result backlog
  // instead of showing up as two separate misses.
  assertEquals(normalizeHelpQuery("  eBay   Fees  "), "ebay fees");
  assertEquals(normalizeHelpQuery("\tHOW\nTO GRADE "), "how to grade");
});

Deno.test("a query is capped so a paste is not sent to Postgres whole", () => {
  assertEquals(normalizeHelpQuery("a".repeat(5000)).length, HELP_QUERY_MAX_LENGTH);
});

Deno.test("one character is not a search", () => {
  // It matches most of the corpus and costs a full index scan to say so.
  assertEquals(isSearchableHelpQuery("a"), false);
  assertEquals(isSearchableHelpQuery("  x "), false);
  assertEquals(isSearchableHelpQuery(""), false);
  assertEquals(isSearchableHelpQuery("ai"), true);
  assertEquals(isSearchableHelpQuery("how do i grade"), true);
});

Deno.test("search passes visibilitiesFor(viewer), never a literal list", () => {
  // Search is the most tempting way around a permission wall, because it reads
  // like a query against "the index" rather than against the articles.
  const src = Deno.readTextFileSync(
    new URL("../routes/help-center.ts", import.meta.url),
  );
  const block = src.slice(src.indexOf("async function runSearch"));
  assert(
    block.includes("p_visibilities: visibilitiesFor(viewer)"),
    "the RPC must be handed visibilitiesFor(viewer)",
  );
  assert(
    !/p_visibilities:\s*\[/.test(block),
    "a literal visibility array in the search call bypasses the one tested rule",
  );
});

Deno.test("the search RPC has no default visibility argument", () => {
  // A default would make the safe call and the unsafe call identical at the
  // call site, and the unsafe one would be shorter to type.
  const sql = Deno.readTextFileSync(
    new URL("../../../../supabase/migrations/00603_help_center_search.sql", import.meta.url),
  );
  const signature = sql.slice(sql.indexOf("create or replace function public.help_search"));
  const params = signature.slice(0, signature.indexOf(")"));
  assert(
    /p_visibilities\s+text\[\]\s*(,|$)/m.test(params),
    `p_visibilities must be required, got: ${params}`,
  );
});

// ── the guard that keeps the wall in one place ────────────
// The route file must not re-derive visibility with a hand-rolled filter. If
// somebody writes .eq("visibility", "public") in there, the wall stops being a
// single function and the tests above stop covering every endpoint.
Deno.test("help-center.ts routes never hand-roll a visibility filter", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/help-center.ts", import.meta.url),
  );
  const handRolled = /\.(eq|neq|in)\(\s*["']visibility["']/g;
  const hits = [...src.matchAll(handRolled)]
    .map((m) => m[0])
    .filter((m) => !m.includes(".in("));
  assertEquals(
    hits,
    [],
    "use visibilitiesFor(viewer) — a literal visibility filter in a route bypasses " +
      "the single place this rule is tested",
  );
  assert(
    src.includes("visibilitiesFor("),
    "the routes must go through visibilitiesFor()",
  );
});
