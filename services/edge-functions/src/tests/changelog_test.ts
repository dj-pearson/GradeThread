import { assert, assertEquals } from "@std/assert";

// US-916: the changelog policy helpers are PURE (no supabase/env import), so this
// imports them statically with no env dance.
import {
  audienceForProductFocus,
  audiencesForProduct,
  type ChangelogRow,
  isChangelogAudience,
  isChangelogCategory,
  selectUnsentChangelog,
  toPublicEntry,
  toWhatsNewEntry,
} from "../lib/changelog.ts";

function row(over: Partial<ChangelogRow>): ChangelogRow {
  return {
    id: "1",
    title: "Thing",
    summary: null,
    body: null,
    category: "feature",
    audience: "all",
    image_url: null,
    status: "published",
    published_at: "2026-06-01T00:00:00Z",
    source: "manual",
    source_ref: null,
    featured_at: null,
    featured_issue_id: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

Deno.test("audiencesForProduct gates product-specific news", () => {
  assertEquals(audiencesForProduct("flipdesk"), ["all", "flipdesk"]);
  assertEquals(audiencesForProduct("gradethread"), ["all", "grading", "verified"]);
  assertEquals(audiencesForProduct("both"), ["all", "grading", "flipdesk", "verified"]);
  // A grading-only audience never includes flipdesk-only news (AC5).
  assert(!audiencesForProduct("gradethread").includes("flipdesk"));
});

Deno.test("audienceForProductFocus maps the auto-capture default tag", () => {
  assertEquals(audienceForProductFocus("flipdesk"), "flipdesk");
  assertEquals(audienceForProductFocus("gradethread"), "grading");
  assertEquals(audienceForProductFocus("both"), "all");
});

Deno.test("isChangelog* validators reject bad enum values", () => {
  assert(isChangelogCategory("fix"));
  assert(!isChangelogCategory("bug"));
  assert(isChangelogAudience("verified"));
  assert(!isChangelogAudience("everyone"));
});

Deno.test("selectUnsentChangelog filters drafts, featured, and wrong audience", () => {
  const rows = [
    row({ id: "a", audience: "all", published_at: "2026-06-03T00:00:00Z" }),
    row({ id: "b", audience: "flipdesk", published_at: "2026-06-05T00:00:00Z" }),
    row({ id: "c", audience: "grading", published_at: "2026-06-04T00:00:00Z" }),
    row({ id: "d", audience: "all", status: "draft" }), // draft → excluded
    row({ id: "e", audience: "all", featured_at: "2026-06-02T00:00:00Z" }), // sent → excluded
  ];
  // A grading-focused issue gets all + grading + verified, newest first.
  const picked = selectUnsentChangelog(rows, audiencesForProduct("gradethread"), 4);
  assertEquals(picked.map((r) => r.id), ["c", "a"]);
  // The cap is honored.
  assertEquals(selectUnsentChangelog(rows, ["all", "flipdesk", "grading"], 1).length, 1);
  // max<=0 → nothing.
  assertEquals(selectUnsentChangelog(rows, ["all"], 0).length, 0);
});

Deno.test("toPublicEntry drops operator bookkeeping", () => {
  const pub = toPublicEntry(row({ featured_at: "2026-06-02T00:00:00Z", source_ref: "blog:1" }));
  assert(!("featured_at" in pub));
  assert(!("source_ref" in pub));
  assert(!("source" in pub));
  assertEquals(pub.title, "Thing");
});

Deno.test("toWhatsNewEntry maps into the newsletter ChangelogEntry shape", () => {
  const e = toWhatsNewEntry(row({ id: "x", title: "Shipped", summary: "Nice" }));
  assertEquals(e.id, "x");
  assertEquals(e.title, "Shipped");
  assertEquals(e.summary, "Nice");
  assertEquals(e.productFocus, "both");
  assertEquals(e.publishedAt, "2026-06-01T00:00:00Z");
});
