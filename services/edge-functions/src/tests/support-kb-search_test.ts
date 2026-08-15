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
          // Both corpora: support_kb_articles stores body_md, help_articles
          // stores body_markdown (US-2594). Each row has exactly one of them.
          const hay = `${String(r.title ?? "")} ${String(r.body_md ?? "")} ${
            String(r.body_markdown ?? "")
          }`.toLowerCase();
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

// ---------------------------------------------------------------------------
// US-2594: the same tool reading help_articles, behind HELP_CORPUS_UNIFIED.
//
// The convergence has one ordering rule and it fails quietly if broken: the
// rows must land in help_articles BEFORE the flag flips, because an empty
// corpus makes the assistant say it does not know — a total outage wearing the
// face of a polite answer. So the flag is off by default and these cases pin
// both states.
//
// AC4/AC7 are the sharp half. `internal` did not exist in the old two-value
// model and holds operator runbooks; retrieval feeds a model that quotes what
// it is handed, so the rule is that NOBODY reaches it through this tool.

function helpDb() {
  return makeFakeDb({
    help_articles: [
      {
        slug: "public-answer",
        title: "Refund policy",
        body_markdown: "You can request a refund within 30 days.",
        visibility: "public",
        status: "published",
      },
      {
        slug: "members-answer",
        title: "Refund policy for annual plans",
        body_markdown: "Annual plans are refunded pro rata within 30 days.",
        visibility: "members",
        status: "published",
      },
      {
        slug: "internal-runbook",
        title: "Refund runbook",
        body_markdown: "Issue the refund in Stripe, then reconcile the ledger.",
        visibility: "internal",
        status: "published",
      },
      {
        slug: "draft-answer",
        title: "Refund policy draft",
        body_markdown: "Refunds are being reconsidered.",
        visibility: "public",
        status: "draft",
      },
    ],
    // Deliberately non-empty and deliberately DIFFERENT, so a case that passes
    // by silently reading the old table cannot look like a pass.
    support_kb_articles: [
      {
        slug: "old-corpus-answer",
        title: "Refund policy",
        body_md: "This wording lives in the retired corpus.",
        audience: "public",
        is_published: true,
      },
    ],
  });
}

function withFlag<T>(value: string | null, fn: () => T): T {
  const prev = Deno.env.get("HELP_CORPUS_UNIFIED");
  if (value === null) Deno.env.delete("HELP_CORPUS_UNIFIED");
  else Deno.env.set("HELP_CORPUS_UNIFIED", value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("HELP_CORPUS_UNIFIED");
    else Deno.env.set("HELP_CORPUS_UNIFIED", prev);
  }
}

Deno.test("US-2594: OFF by default — the retired corpus still answers", async () => {
  const rows = await withFlag(null, () =>
    ST.searchKnowledgeBase({ query: "refund policy", audience: "subscriber" }, helpDb()));
  assertEquals(rows.map((r) => r.slug), ["old-corpus-answer"]);
});

Deno.test("US-2594: an unset-but-present junk value does not count as on", () => {
  // Fail-closed: only an explicit 1/true flips a corpus. "yes", "on" and the
  // empty string leave the assistant where it is.
  for (const v of ["", "0", "false", "yes", "on", "maybe"]) {
    assertEquals(withFlag(v, () => ST.unifiedHelpCorpusEnabled()), false, `value: ${v}`);
  }
  for (const v of ["1", "true", "TRUE", " true "]) {
    assertEquals(withFlag(v, () => ST.unifiedHelpCorpusEnabled()), true, `value: ${v}`);
  }
});

Deno.test("US-2594: ON — help_articles answers and the retired corpus does not", async () => {
  const rows = await withFlag("1", () =>
    ST.searchKnowledgeBase({ query: "refund policy", audience: "subscriber" }, helpDb()));
  const slugs = rows.map((r) => r.slug);
  assert(slugs.includes("public-answer"), `got: ${slugs.join(", ")}`);
  assert(!slugs.includes("old-corpus-answer"), "must not fall back to the retired corpus");
  // The snippet comes from body_markdown, not from the other corpus's column.
  const hit = rows.find((r) => r.slug === "public-answer");
  assert(hit && hit.snippet.includes("within 30 days"), `snippet: ${hit?.snippet}`);
});

Deno.test("US-2594 AC7: an anonymous asker never reaches a members article", async () => {
  const rows = await withFlag("1", () =>
    ST.searchKnowledgeBase({ query: "refund policy", audience: "public" }, helpDb()));
  const slugs = rows.map((r) => r.slug);
  assertEquals(slugs, ["public-answer"]);
  assert(!slugs.includes("members-answer"), "a public asker must not reach members content");
});

Deno.test("US-2594 AC4: NOBODY reaches an internal article through the assistant", async () => {
  // Not the subscriber, not the anonymous asker. internal holds operator
  // runbooks, and this tool hands its output to a model that quotes it. A
  // caller-dependent exception here is the one somebody gets wrong later.
  for (const audience of ["public", "subscriber"] as const) {
    const rows = await withFlag("1", () =>
      ST.searchKnowledgeBase({ query: "refund runbook", audience }, helpDb()));
    assert(
      !rows.some((r) => r.slug === "internal-runbook"),
      `internal leaked to ${audience}: ${rows.map((r) => r.slug).join(", ")}`,
    );
  }
  assertEquals(ST.visibleHelpVisibilities("subscriber"), ["public", "members"]);
  assertEquals(ST.visibleHelpVisibilities("public"), ["public"]);
});

Deno.test("US-2594: a draft never surfaces, same rule as the old corpus", async () => {
  const rows = await withFlag("1", () =>
    ST.searchKnowledgeBase({ query: "refund policy", audience: "subscriber" }, helpDb()));
  assert(!rows.some((r) => r.slug === "draft-answer"), "an unpublished article must not surface");
});
