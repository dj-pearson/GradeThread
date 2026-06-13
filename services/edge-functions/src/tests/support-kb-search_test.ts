// US-833: knowledge-base retrieval tool — the ONLY corpus the AI Support
// Assistant may speak product facts from. These tests exercise the real
// filtering logic in lib/support-tools.ts `searchKnowledgeBase` against a
// faithful in-memory fake DB that honours the same chain the supabase-js
// service-role client exposes (select/eq/in/textSearch/limit). No live DB or
// env fixture required — runs in CI.
//
// Coverage (acceptance criteria):
//   * a query HIT against a published article returns it with a concise snippet,
//   * an UNPUBLISHED article never surfaces (is_published filter),
//   * audience is respected — a 'public' caller never reaches subscriber-only
//     content, while a 'subscriber' sees both public + subscriber,
//   * the no-result path returns an EXPLICIT empty set (no fabrication),
//   * results are capped at <= 5.

import { assert, assertEquals } from "@std/assert";

// support-tools.ts imports supabase.ts at module load, which throws if these
// aren't set — mirror tenant-isolation_test.ts.
Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const ST = await import("../lib/support-tools.ts");
type FakeRow = Record<string, unknown>;

// Faithful fake of the narrow supabase-js surface searchKnowledgeBase uses.
// `textSearch("search_tsv", q)` simulates the generated tsvector (title=A,
// body_md=B) by matching when EVERY query token appears in title+body_md —
// a reasonable stand-in for `websearch_to_tsquery` AND semantics.
function makeFakeDb(
  tables: Record<string, FakeRow[]>,
): import("../lib/support-tools.ts").SupportDb {
  function build(
    table: string,
  ): import("../lib/support-tools.ts").SupportQuery {
    const filters: Array<{ kind: "eq" | "in"; col: string; val: unknown }> = [];
    let search: { col: string; query: string } | null = null;
    let limitN: number | null = null;

    const apply = (): FakeRow[] => {
      let rows = (tables[table] ?? []).slice();
      for (const f of filters) {
        if (f.kind === "eq") rows = rows.filter((r) => r[f.col] === f.val);
        else if (f.kind === "in") {
          rows = rows.filter((r) => (f.val as unknown[]).includes(r[f.col]));
        }
      }
      if (search) {
        const terms = search.query.toLowerCase().split(/\s+/).filter(Boolean);
        rows = rows.filter((r) => {
          const hay = `${String(r.title ?? "")} ${String(r.body_md ?? "")}`
            .toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    };

    // deno-lint-ignore no-explicit-any
    const q: any = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters.push({ kind: "eq", col, val });
        return q;
      },
      in: (col: string, vals: readonly unknown[]) => {
        filters.push({ kind: "in", col, val: vals });
        return q;
      },
      gte: () => q,
      textSearch: (col: string, query: string) => {
        search = { col, query };
        return q;
      },
      order: () => q,
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      maybeSingle: () =>
        Promise.resolve({ data: apply()[0] ?? null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (onF: any, onR: any) =>
        Promise.resolve({ data: apply(), error: null }).then(onF, onR),
    };
    return q;
  }
  return { from: build };
}

function kbDb() {
  return makeFakeDb({
    support_kb_articles: [
      {
        slug: "how-grading-works",
        title: "How grading works",
        body_md:
          "Our AI inspects your garment photos and produces a condition grade " +
          "from 1.0 to 10.0 across five factors: fabric, structure, cosmetics, " +
          "function and odor. " + "Lorem ipsum ".repeat(40),
        audience: "public",
        is_published: true,
      },
      {
        slug: "pro-bulk-grading",
        title: "Bulk grading for Pro subscribers",
        body_md:
          "Pro subscribers can submit a CSV to grade many garments at once.",
        audience: "subscriber",
        is_published: true,
      },
      {
        slug: "draft-secret-feature",
        title: "Unreleased grading roadmap",
        body_md:
          "Internal-only draft about an upcoming grading feature, not for users.",
        audience: "public",
        is_published: false, // DRAFT — must never surface
      },
    ],
  });
}

Deno.test("US-833: published public article is returned with a concise snippet", async () => {
  const db = kbDb();
  const results = await ST.searchKnowledgeBase(
    { query: "grading garment condition", audience: "public" },
    db,
  );
  assert(results.length >= 1, "expected at least one hit");
  const hit = results.find((r) => r.slug === "how-grading-works");
  assert(hit, "the published public 'how grading works' article should match");
  assert(hit!.title.length > 0);
  // Snippet, not the whole article: the seeded body is padded well past the cap.
  assert(
    hit!.snippet.length <= 241,
    `snippet should be capped (<=240 + ellipsis), got ${hit!.snippet.length}`,
  );
  assert(hit!.snippet.endsWith("…"), "a truncated snippet should be elided");
});

Deno.test("US-833: an unpublished (draft) article never surfaces", async () => {
  const db = kbDb();
  const results = await ST.searchKnowledgeBase(
    { query: "grading roadmap feature", audience: "subscriber" },
    db,
  );
  assert(
    results.every((r) => r.slug !== "draft-secret-feature"),
    "draft article leaked despite is_published = false",
  );
});

Deno.test("US-833: a public caller cannot reach subscriber-only content", async () => {
  const db = kbDb();
  const results = await ST.searchKnowledgeBase(
    { query: "bulk grading subscribers", audience: "public" },
    db,
  );
  assert(
    results.every((r) => r.slug !== "pro-bulk-grading"),
    "subscriber-only article leaked to a public-audience caller",
  );
});

Deno.test("US-833: a subscriber sees both public and subscriber articles", async () => {
  const db = kbDb();
  const subOnly = await ST.searchKnowledgeBase(
    { query: "bulk grading", audience: "subscriber" },
    db,
  );
  assert(
    subOnly.some((r) => r.slug === "pro-bulk-grading"),
    "subscriber should reach the subscriber-only bulk-grading article",
  );
  const publicToo = await ST.searchKnowledgeBase(
    { query: "grading garment", audience: "subscriber" },
    db,
  );
  assert(
    publicToo.some((r) => r.slug === "how-grading-works"),
    "subscriber should also reach published public articles",
  );
});

Deno.test("US-833: no match returns an explicit empty set (no fabrication)", async () => {
  const db = kbDb();
  const results = await ST.searchKnowledgeBase(
    { query: "quantum cryptography mortgage rates", audience: "subscriber" },
    db,
  );
  assertEquals(results, [], "a miss must be an explicit empty array");
});

Deno.test("US-833: an empty query short-circuits to an empty set", async () => {
  const db = kbDb();
  const results = await ST.searchKnowledgeBase(
    { query: "   ", audience: "subscriber" },
    db,
  );
  assertEquals(results, []);
});

Deno.test("US-833: results are capped at 5", async () => {
  // Seed 8 distinct published public articles that all match the query.
  const rows: FakeRow[] = [];
  for (let i = 0; i < 8; i++) {
    rows.push({
      slug: `pricing-tip-${i}`,
      title: `Pricing tip number ${i}`,
      body_md: `Advice about pricing your listings competitively (#${i}).`,
      audience: "public",
      is_published: true,
    });
  }
  const db = makeFakeDb({ support_kb_articles: rows });
  const results = await ST.searchKnowledgeBase(
    { query: "pricing", audience: "public" },
    db,
  );
  assert(
    results.length <= 5,
    `top-K must cap at 5, got ${results.length}`,
  );
});
