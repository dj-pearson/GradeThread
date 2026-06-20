import { assert, assertEquals } from "@std/assert";

// US-922: the changelog SELECTION + balancing helpers are pure, but they live in a
// module that statically imports lib/supabase.ts (which throws at import without
// env). Set the env FIRST, then dynamic-import (mirrors ops-jobs_test.ts).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const {
  changelogToLines,
  focusFilter,
  pickProductFocus,
  selectChangelogEntries,
} = await import("../lib/newsletter-changelog.ts");

type Entry = Parameters<typeof selectChangelogEntries>[0][number];

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    title: "Update",
    summary: "A change",
    productFocus: "both",
    publishedAt: "2026-06-01T00:00:00Z",
    ...over,
  };
}

Deno.test("focusFilter always includes 'both'", () => {
  assertEquals(focusFilter("gradethread").sort(), ["both", "gradethread"]);
  assertEquals(focusFilter("flipdesk").sort(), ["both", "flipdesk"]);
  assertEquals(focusFilter("both").sort(), ["both", "flipdesk", "gradethread"]);
});

Deno.test("pickProductFocus balances toward the least-recently-featured product", () => {
  assertEquals(pickProductFocus(["gradethread", "gradethread"]), "flipdesk");
  assertEquals(pickProductFocus(["flipdesk", "flipdesk"]), "gradethread");
  // Ties (and all-'both' history) default to gradethread.
  assertEquals(pickProductFocus([]), "gradethread");
  assertEquals(pickProductFocus(["both", "both"]), "gradethread");
});

Deno.test("selectChangelogEntries excludes already-featured ids (unsent only)", () => {
  const pool = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })];
  const out = selectChangelogEntries(pool, new Set(["b"]), "both", 5);
  assertEquals(out.map((e) => e.id).sort(), ["a", "c"]);
});

Deno.test("selectChangelogEntries respects product focus + newest-first + cap", () => {
  const pool = [
    entry({ id: "old", productFocus: "flipdesk", publishedAt: "2026-05-01T00:00:00Z" }),
    entry({ id: "new", productFocus: "flipdesk", publishedAt: "2026-06-10T00:00:00Z" }),
    entry({ id: "gt", productFocus: "gradethread", publishedAt: "2026-06-11T00:00:00Z" }),
    entry({ id: "both", productFocus: "both", publishedAt: "2026-06-09T00:00:00Z" }),
  ];
  const out = selectChangelogEntries(pool, new Set(), "flipdesk", 2);
  // gradethread-only entry excluded; newest first; capped at 2.
  assertEquals(out.map((e) => e.id), ["new", "both"]);
});

Deno.test("selectChangelogEntries returns nothing when max is 0", () => {
  assertEquals(selectChangelogEntries([entry()], new Set(), "both", 0).length, 0);
});

Deno.test("changelogToLines renders compact dated bullets", () => {
  const lines = changelogToLines([entry({ title: "Comp engine", summary: "faster" })]);
  assert(lines[0].includes("2026-06-01"));
  assert(lines[0].includes("Comp engine"));
  assert(lines[0].includes("faster"));
});
