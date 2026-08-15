import { assertEquals } from "@std/assert";
import {
  deflectionRate,
  rankArticles,
  reportWindowDays,
  splitTicketsByCategory,
} from "../lib/help-analytics.ts";

// US-2592: the arithmetic behind the Help Center report, tested without a
// database. Every case here is a way the report could show a plausible number
// that is not true.

const META = [
  {
    slug: "the-photos-we-need",
    title: "The photos we need",
    category_key: "grading",
    visibility: "public",
    published_at: "2026-07-01T00:00:00Z",
  },
  {
    slug: "cancelling",
    title: "Cancelling",
    category_key: "billing",
    visibility: "public",
    published_at: "2026-07-10T00:00:00Z",
  },
];

Deno.test("rankArticles keeps the two surfaces apart", () => {
  const rows = rankArticles(
    META,
    [
      { article_slug: "the-photos-we-need", surface: "public", views: 40 },
      { article_slug: "the-photos-we-need", surface: "app", views: 3 },
      { article_slug: "cancelling", surface: "app", views: 90 },
    ],
    [],
    [],
  );
  // Ranked by PUBLIC views. An article everybody opens from inside the product
  // and nobody ever finds through search is not the top organic article, and
  // summing the two columns is how you conclude that it is.
  assertEquals(rows[0]?.slug, "the-photos-we-need");
  assertEquals(rows[0]?.public_views, 40);
  assertEquals(rows[0]?.app_views, 3);
  assertEquals(rows[1]?.public_views, 0);
  assertEquals(rows[1]?.app_views, 90);
});

Deno.test("rankArticles tallies votes and deflections per article", () => {
  const rows = rankArticles(
    META,
    [{ article_slug: "cancelling", surface: "public", views: 5 }],
    [
      { article_slug: "cancelling", helpful: true },
      { article_slug: "cancelling", helpful: true },
      { article_slug: "cancelling", helpful: false },
    ],
    [
      { article_opened: "cancelling" },
      { article_opened: null },
    ],
  );
  const row = rows.find((r) => r.slug === "cancelling");
  assertEquals(row?.helpful, 2);
  assertEquals(row?.unhelpful, 1);
  // A deflection with no article opened is not a deflection. Counting it would
  // inflate the one number the table exists to keep honest.
  assertEquals(row?.deflections, 1);
});

Deno.test("rankArticles keeps views of a deleted article, labelled", () => {
  // Dropping them is how a traffic cliff becomes invisible.
  const rows = rankArticles(
    [],
    [{ article_slug: "gone-away", surface: "public", views: 12 }],
    [],
    [],
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.public_views, 12);
  assertEquals(rows[0]?.title, "(deleted: gone-away)");
});

Deno.test("rankArticles omits articles with no signal at all", () => {
  // The freshness panel already lists the whole corpus. Repeating it here would
  // bury the rows that carry the answer under the rows that do not.
  const rows = rankArticles(META, [], [], []);
  assertEquals(rows.length, 0);
});

Deno.test("deflectionRate divides by deflections PLUS tickets", () => {
  // Over tickets alone it would pass 100% the moment the help centre works, and
  // would rise whenever ticket volume fell for unrelated reasons.
  assertEquals(deflectionRate(3, 1), 0.75);
  assertEquals(deflectionRate(0, 4), 0);
  assertEquals(deflectionRate(4, 0), 1);
});

Deno.test("deflectionRate returns null when nothing happened", () => {
  // No data is not zero. A dashboard showing 0% for an empty week is reporting
  // a failure that did not occur.
  assertEquals(deflectionRate(0, 0), null);
});

Deno.test("splitTicketsByCategory buckets equal windows either side", () => {
  const split = new Date("2026-07-15T00:00:00Z");
  const now = new Date("2026-08-20T00:00:00Z");
  const result = splitTicketsByCategory(
    [
      { created_at: "2026-07-01T00:00:00Z", triage_category: "grading" },
      { created_at: "2026-07-10T00:00:00Z", triage_category: "grading" },
      { created_at: "2026-07-20T00:00:00Z", triage_category: "grading" },
      { created_at: "2026-06-01T00:00:00Z", triage_category: "grading" }, // outside
    ],
    split,
    10,
    now,
  );
  assertEquals(result.before, [{ category: "grading", count: 1 }]);
  assertEquals(result.after, [{ category: "grading", count: 1 }]);
  assertEquals(result.after_complete, true);
});

Deno.test("splitTicketsByCategory keeps untriaged tickets in the totals", () => {
  // Dropping them would make this table disagree with the ticket queue.
  const result = splitTicketsByCategory(
    [{ created_at: "2026-07-16T00:00:00Z", triage_category: null }],
    new Date("2026-07-15T00:00:00Z"),
    10,
    new Date("2026-08-20T00:00:00Z"),
  );
  assertEquals(result.after, [{ category: "untriaged", count: 1 }]);
});

Deno.test("splitTicketsByCategory says when the after window has not elapsed", () => {
  // Comparing a full 30 days against 4 elapsed days always shows a fall, and it
  // is not a result.
  const result = splitTicketsByCategory(
    [],
    new Date("2026-08-10T00:00:00Z"),
    30,
    new Date("2026-08-14T00:00:00Z"),
  );
  assertEquals(result.after_complete, false);
});

Deno.test("reportWindowDays clamps to something answerable", () => {
  assertEquals(reportWindowDays(undefined), 30);
  assertEquals(reportWindowDays("not a number"), 30);
  assertEquals(reportWindowDays("7"), 7);
  assertEquals(reportWindowDays("0"), 1);
  assertEquals(reportWindowDays("-5"), 1);
  assertEquals(reportWindowDays("99999"), 365);
});
