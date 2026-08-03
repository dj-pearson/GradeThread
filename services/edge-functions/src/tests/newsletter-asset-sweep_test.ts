// US-2363: abandoned newsletter issues no longer leak public storage objects.
//
// `cleanupIssueAssets` was written for "the issue-deletion / cleanup path" and
// nothing called it. There is no issue-deletion endpoint either, so an issue
// that was drafted, generated a hero image and was then abandoned — blocked and
// never reopened, or just left in draft — kept its objects in the PUBLIC
// content-images bucket forever, with a live public URL, and nothing ever looked
// at them again.
//
// TWO PROPERTIES CARRY THE WHOLE FIX, and both are the kind that fail silently:
//
//   1. A SENT issue keeps its imagery, permanently. Its recipients hold an email
//      that hot-links the object. Sweeping it would break every newsletter
//      already delivered, and nobody would report it — the reader just sees a
//      broken image in an old email.
//
//   2. The sweep is REGISTRY-DRIVEN, never a bucket listing. Newsletter heroes
//      go through uploadHeroImage with `surface: "blog"`, so they live at
//      `blog/<issueId>/…` next to real blog post heroes at `blog/<postId>/…`.
//      The two are indistinguishable by path. A sweep that listed the prefix and
//      removed "objects with no issue" would delete blog hero images off the
//      public marketing site.

import { assert, assertEquals } from "@std/assert";

// newsletter-imagery.ts pulls in supabase.ts, which throws at import time
// without the env. Prime it and dynamic-import, the same shape agent-policy_test
// and agent-kernel_test use.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key",
);
const { ABANDONED_ISSUE_DAYS, KEEP_ASSETS_STATUSES } = await import(
  "../lib/newsletter-imagery.ts"
);

const LIB = new URL("../lib/newsletter-imagery.ts", import.meta.url);
const RETENTION = new URL("../lib/data-retention.ts", import.meta.url);

Deno.test("US-2363: a sent issue's imagery is never swept", () => {
  // The one that costs something if it breaks: an already-delivered newsletter
  // hot-links the object from the recipient's inbox.
  assert(
    (KEEP_ASSETS_STATUSES as readonly string[]).includes("sent"),
    "sent issues are being swept — every delivered newsletter loses its image",
  );
  // `sending` is excluded too: same reason plus the obvious race with a send in
  // flight.
  assert(
    (KEEP_ASSETS_STATUSES as readonly string[]).includes("sending"),
    "an in-flight send can have its imagery deleted underneath it",
  );
});

Deno.test("US-2363: the sweep excludes those statuses in the QUERY, not after", () => {
  // Filtering in JS after the read would still work, but the read would then
  // pull sent issues into the batch limit and starve the abandoned ones it is
  // meant to reach — the same shape as a paging loop that never makes progress.
  const src = Deno.readTextFileSync(LIB);
  assert(
    /\.not\("status", "in", `\(\$\{KEEP_ASSETS_STATUSES\.join\(","\)\}\)`\)/.test(src),
    "the sweep no longer excludes kept statuses in the query itself",
  );
});

Deno.test("US-2363: the sweep is registry-driven, not a bucket listing", () => {
  // The dangerous alternative. Newsletter heroes share the `blog/` prefix with
  // real blog post heroes, so a prefix listing cannot tell them apart and a
  // "delete the orphans" pass would take marketing images with it.
  const src = Deno.readTextFileSync(LIB);
  const sweep = src.slice(src.indexOf("export async function purgeAbandonedIssueAssets"));
  assert(
    !/storage\s*\n?\s*\.from\([^)]*\)\s*\n?\s*\.list\(/.test(sweep),
    "the sweep lists the bucket — it cannot tell a newsletter hero from a blog hero",
  );
  assert(
    sweep.includes("cleanupIssueAssets("),
    "the sweep no longer goes through cleanupIssueAssets, which is the only " +
      "thing that knows which object belongs to an issue",
  );
});

Deno.test("US-2363: the sweep is bounded and ordered", () => {
  // A first run over a never-swept table is the whole backlog. Bounded so each
  // night's work is predictable, ordered oldest-first so the backlog actually
  // drains instead of re-reading the same rows.
  const src = Deno.readTextFileSync(LIB);
  const sweep = src.slice(src.indexOf("export async function purgeAbandonedIssueAssets"));
  assert(sweep.includes(".limit(batchLimit)"), "the sweep is unbounded");
  assert(
    sweep.includes('.order("updated_at", { ascending: true })'),
    "without an oldest-first order a capped sweep can re-read the same rows " +
      "every night and never reach the older ones",
  );
});

Deno.test("US-2363: the retention window is long enough to be a real abandonment", () => {
  // Short enough and this stops being a cleanup and starts being a surprise:
  // an issue parked for a fortnight is not abandoned.
  assert(
    ABANDONED_ISSUE_DAYS >= 60,
    `${ABANDONED_ISSUE_DAYS} days is short enough to reclaim imagery from an ` +
      `issue someone is still working on`,
  );
});

Deno.test("US-2363: the daily retention cron actually runs it", () => {
  // The whole defect was a function with no caller. A sweep nobody calls is the
  // same bug wearing a new name.
  const src = Deno.readTextFileSync(RETENTION);
  assert(
    src.includes("purgeAbandonedIssueAssets("),
    "the sweep has no caller again",
  );
  // Reported, not silent: a capped run that reports nothing cannot be told from
  // a no-op, and this is the only signal that the backlog is draining.
  assert(
    src.includes("newsletter_objects_deleted"),
    "the cron does not report what the sweep did",
  );
  // Best-effort: an imagery sweep must never fail the PII purge that is this
  // job's reason to exist.
  const at = src.indexOf("purgeAbandonedIssueAssets(");
  const before = src.slice(Math.max(0, at - 400), at);
  assert(before.includes("try {"), "the sweep can fail the whole retention job");
});

Deno.test("US-2363: nothing deletes an issue row without cleaning its assets first", () => {
  // THE CASCADE TRAP, for whoever adds a delete endpoint. newsletter_issue_assets
  // rows cascade with the issue, so deleting the issue drops the registry and
  // leaves the objects UNREACHABLE — no path, no way to ever find them again.
  // Cleanup has to run BEFORE the delete, and there is no second chance.
  const routes = new URL("../routes/", import.meta.url);
  const offenders: string[] = [];
  for (const entry of Deno.readDirSync(routes)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = Deno.readTextFileSync(new URL(entry.name, routes));
    for (const m of src.matchAll(/from\("newsletter_issues"\)([\s\S]{0,200}?);/g)) {
      if (/\.delete\(/.test(m[0])) offenders.push(`${entry.name}: ${m[0].slice(0, 60)}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "an issue row is deleted somewhere. The asset registry cascades with it, so " +
      "call cleanupIssueAssets(issueId) BEFORE the delete or the objects are " +
      "orphaned beyond recovery.",
  );
});
