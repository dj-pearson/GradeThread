// US-3042: the eBay retention policy, and the guard that keeps it published.
//
// A retention rule has two halves that live in different repositories' worth of
// distance from each other: the sweep that enforces it (lib/ebay-retention.ts)
// and the sentence that promises it (src/pages/legal/privacy.tsx). Either half
// can be changed without the other, and both failure directions are bad in a
// way nobody notices:
//
//   rule with no published row      we quietly delete data users were not told
//                                   we delete
//   published row with no rule      we promise a deletion that never happens,
//                                   which is the one an eBay or GDPR review
//                                   actually punishes
//
// So this test reads both files and requires them to agree, matching on the
// `data-retention-rule="<table>:<days>"` attributes on the privacy page.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  cutoffFor,
  EBAY_RETENTION_RULES,
  type RetentionRule,
} from "../lib/ebay-retention.ts";

const PRIVACY_PAGE = new URL(
  "../../../../src/pages/legal/privacy.tsx",
  import.meta.url,
);

async function publishedRules(): Promise<Set<string>> {
  const src = await Deno.readTextFile(PRIVACY_PAGE);
  const out = new Set<string>();
  for (const m of src.matchAll(/data-retention-rule="([^"]+)"/g)) {
    out.add(m[1]!);
  }
  return out;
}

function key(rule: RetentionRule): string {
  return `${rule.table}:${rule.maxAgeDays}`;
}

Deno.test("every enforced rule is published on the privacy page", async () => {
  const published = await publishedRules();
  assert(
    published.size > 0,
    "no data-retention-rule markers found — the privacy page markup changed",
  );
  const missing = EBAY_RETENTION_RULES.filter((r) => !published.has(key(r)))
    .map(key)
    .sort();
  assertEquals(
    missing,
    [],
    `these rules delete data with nothing on the privacy page telling users so: ` +
      `${missing.join(", ")}`,
  );
});

Deno.test("every published rule is actually enforced", async () => {
  // The direction that matters more. A promise with no sweep behind it reads as
  // compliant and is not.
  const published = await publishedRules();
  const enforced = new Set(EBAY_RETENTION_RULES.map(key));
  const unenforced = [...published].filter((p) => !enforced.has(p)).sort();
  assertEquals(
    unenforced,
    [],
    `the privacy page promises these deletions and no rule performs them: ` +
      `${unenforced.join(", ")}`,
  );
});

Deno.test("rules age on last-seen, not on creation", () => {
  // A style code the market re-confirmed last week is current data in an old
  // row. Ageing on created_at would delete precisely the records still true.
  for (const rule of EBAY_RETENTION_RULES) {
    assert(
      rule.ageColumn !== "created_at",
      `${rule.table} ages on created_at, which deletes still-current records`,
    );
  }
});

Deno.test("a clear rule names the columns it nulls", () => {
  for (const rule of EBAY_RETENTION_RULES) {
    if (rule.action !== "clear") continue;
    assert(
      (rule.columns?.length ?? 0) > 0,
      `${rule.table} is a clear rule that nulls nothing`,
    );
  }
});

Deno.test("cutoffFor: a DATE column gets a date, a timestamp gets a timestamp", () => {
  // Postgres truncates an ISO timestamp sent to a DATE column, which moves the
  // boundary by up to a day without any error. The two shapes are not
  // interchangeable and this is the only place that decides between them.
  const now = new Date("2026-09-01T12:00:00Z");

  const daily = EBAY_RETENTION_RULES.find((r) => r.ageColumn === "day");
  assert(daily, "no rule ages on a DATE column any more");
  assertEquals(cutoffFor(daily, now), "2024-09-01");

  const stamped = EBAY_RETENTION_RULES.find((r) => r.ageColumn === "captured_at");
  assert(stamped, "no rule ages on captured_at any more");
  assertEquals(cutoffFor(stamped, now), "2026-03-05T12:00:00.000Z");
});

Deno.test("cutoffFor: the window is measured backwards from now", () => {
  const rule: RetentionRule = {
    table: "t",
    ageColumn: "last_seen_at",
    maxAgeDays: 90,
    action: "delete",
    rationale: "test",
  };
  assertEquals(
    cutoffFor(rule, new Date("2026-09-01T00:00:00Z")),
    "2026-06-03T00:00:00.000Z",
  );
});

Deno.test("every rule carries a plain-words rationale", () => {
  // The rationale is what gets copied into the privacy page and into an eBay
  // application. A rule with no stated reason is a rule nobody can defend.
  for (const rule of EBAY_RETENTION_RULES) {
    assert(
      rule.rationale.trim().length > 20,
      `${rule.table} has no usable rationale`,
    );
  }
});
