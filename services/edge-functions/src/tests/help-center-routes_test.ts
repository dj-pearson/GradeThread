import "./_env.ts";
// Route-level Help Center behaviour, driven through the real supabase-js client
// against the in-memory PostgREST stand-in.
//
// No tenant-isolation_test.ts case: help_articles and help_feedback have no
// tenant (see the header of help-center_test.ts). The property these routes
// guard is visibility, which is pinned here and in help-center_test.ts.
import { assert, assertEquals } from "@std/assert";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import {
  buildPatch,
  helpAdminRoutes,
  helpPublicRoutes,
  helpReaderRoutes,
} from "../routes/help-center.ts";
import { HOSTILE_HELP_BODY, TIPTAP_HELP_BODY } from "./_help-bodies.ts";

Deno.test("H1: buildPatch stores a sanitized body_html", () => {
  const built = buildPatch({ body_html: HOSTILE_HELP_BODY });
  assert("patch" in built);
  const stored = String(built.patch.body_html).toLowerCase();
  for (const bad of ["<script", "onerror", "<meta", "<form", "<input", "evil"]) {
    assert(!stored.includes(bad), `stored body still carries ${bad}`);
  }
});

Deno.test("H1: buildPatch leaves a normal editor body byte-identical", () => {
  const built = buildPatch({ body_html: TIPTAP_HELP_BODY });
  assert("patch" in built);
  assertEquals(built.patch.body_html, TIPTAP_HELP_BODY);
});

// ── content_version on feedback (H3) ──────────────────────

const db = installFakePostgrest();

function article(over: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    slug: "your-first-grade",
    title: "Your first grade",
    summary: "",
    body_html: "<p>hi</p>",
    body_json: {},
    body_markdown: "hi",
    category_key: "getting-started",
    audience: "all",
    visibility: "public",
    status: "published",
    sort_order: 1,
    hero_image_url: null,
    faq: [],
    related_slugs: [],
    video_url: null,
    pillar_path: null,
    published_at: "2026-08-01T00:00:00.000Z",
    reviewed_at: null,
    review_interval_days: 180,
    content_version: 3,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

async function vote(slug: string, body: Record<string, unknown>) {
  return await helpPublicRoutes.request(`/${slug}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("H3: a vote records the content_version the reader actually read", async () => {
  db.reset({ help_articles: [article({ content_version: 3 })], help_feedback: [] });
  const res = await vote("your-first-grade", { helpful: "yes" });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).recorded, true);
  assertEquals(db.tables.help_feedback.length, 1);
  assertEquals(db.tables.help_feedback[0].content_version, 3);
});

Deno.test("H3: a vote on an article above the viewer's tier is still a 404", async () => {
  db.reset({ help_articles: [article({ visibility: "members" })], help_feedback: [] });
  const res = await vote("your-first-grade", { helpful: "yes" });
  assertEquals(res.status, 404);
  assertEquals(db.tables.help_feedback.length, 0);
});

Deno.test("H3: the freshness tally ignores votes cast against an older version", async () => {
  db.reset({
    help_articles: [article({ content_version: 2 })],
    help_articles_stale: [{ slug: "your-first-grade", title: "Your first grade", days_since_basis: 10 }],
    help_feedback: [
      { article_slug: "your-first-grade", content_version: 1, helpful: false, comment: "old wording", created_at: "2026-08-02T00:00:00Z" },
      { article_slug: "your-first-grade", content_version: 1, helpful: false, comment: null, created_at: "2026-08-03T00:00:00Z" },
      { article_slug: "your-first-grade", content_version: 2, helpful: true, comment: null, created_at: "2026-08-04T00:00:00Z" },
    ],
  });
  const res = await helpAdminRoutes.request("/freshness");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.articles[0].feedback, { helpful: 1, unhelpful: 0, comments: [] });
});

// ── reader payloads (H8) ──────────────────────────────────

const CATS: Row[] = [
  { key: "getting-started", title: "Getting started", slug: "getting-started", summary: "", sort_order: 1, icon: null },
  { key: "billing", title: "Billing", slug: "billing", summary: "", sort_order: 2, icon: null },
];

function indexSelects(): string[] {
  return db.calls
    .filter((c) => c.method === "GET" && c.table === "help_articles")
    .map((c) => c.params.get("select") ?? "");
}

Deno.test("H8: the reader article has no body_markdown and carries its category", async () => {
  db.reset({ help_articles: [article()], help_categories: CATS });
  const res = await helpReaderRoutes.request("/your-first-grade");
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(!("body_markdown" in body.article), "nothing in the app reads the Markdown");
  assertEquals(body.article.body_html, "<p>hi</p>");
  assertEquals(body.category.key, "getting-started");
});

Deno.test("H8: the public article still ships body_markdown for the .md mirror", async () => {
  db.reset({ help_articles: [article()], help_categories: CATS });
  const res = await helpPublicRoutes.request("/your-first-grade");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).article.body_markdown, "hi");
});

Deno.test("H8: the index selects no body columns, and its rows carry no body", async () => {
  db.reset({ help_articles: [article()], help_categories: CATS });
  db.calls.length = 0;
  const res = await helpReaderRoutes.request("/");
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(!("body_html" in body.articles[0]));
  const selects = indexSelects();
  assertEquals(selects.length, 1);
  assert(!selects[0].includes("body_"), `index select pulled a body: ${selects[0]}`);
});

Deno.test("H8: ?full=1 on the public index is the one path that reads body_markdown", async () => {
  db.reset({ help_articles: [article()], help_categories: CATS });
  db.calls.length = 0;
  const res = await helpPublicRoutes.request("/?full=1");
  const body = await res.json();
  assertEquals(body.articles[0].body_markdown, "hi");
  const [select] = indexSelects();
  assert(select.includes("body_markdown"));
  assert(!select.includes("body_html"));
});
