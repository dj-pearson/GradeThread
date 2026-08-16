// US-2286: a sandbox purchase must not be counted as revenue.
//
// 00559 stamped `users.billing_environment` so an App Review tester's free
// entitlement could be told from a paying subscriber. Nothing read it for
// months — the marker existed and both revenue surfaces still counted a sandbox
// grant in MRR, which is the defect the marker was added to make fixable.
//
// 00608 adds the exclusion at six sites. These cases pin the three things that
// would each break it silently:
//
//   1. a site losing the condition (the count goes back to including sandbox);
//   2. `<> 'sandbox'` instead of `is distinct from` — which looks equivalent,
//      evaluates to NULL for every pre-marker row, and would drop the whole of
//      historical MRR on the floor; and
//   3. the constant and the SQL disagreeing about what counts, since
//      `countsAsRevenue()` in TypeScript and the predicate in SQL are two
//      statements of one rule.

import { assert, assertEquals } from "@std/assert";
import { countsAsRevenue } from "../lib/billing-environment.ts";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
const SQL = Deno.readTextFileSync(
  new URL("00608_exclude_sandbox_from_revenue.sql", MIGRATIONS),
);

Deno.test("US-2286: every revenue site excludes sandbox", () => {
  const inserted = SQL.match(/billing_environment is distinct from 'sandbox'/g) ?? [];
  assertEquals(
    inserted.length,
    6,
    "expected the exclusion at all six revenue sites — the MRR sum, activePaid, " +
      "arpuCents and byPlan in revenue_dashboard, plus activePaid and " +
      "byPlanInterval in admin_revenue_metrics",
  );
});

Deno.test("US-2286: it is `is distinct from`, never a plain inequality", () => {
  // The subtle one. Pre-marker rows are NULL, and `NULL <> 'sandbox'` is NULL,
  // not true — so a plain inequality silently drops every historical row from
  // MRR while looking like a tightening.
  assert(
    !/billing_environment\s*(<>|!=)\s*'sandbox'/.test(SQL),
    "a plain inequality on a nullable column excludes the NULL rows too",
  );
});

Deno.test("US-2286: the SQL predicate and countsAsRevenue agree", () => {
  // Two statements of one rule, in two languages. If they disagree, the number
  // an admin reads and the number the code believes diverge with nothing saying
  // so.
  assertEquals(countsAsRevenue(null), true, "a pre-marker row still counts");
  assertEquals(countsAsRevenue("production"), true);
  assertEquals(countsAsRevenue("sandbox"), false);
  // `is distinct from 'sandbox'` is TRUE for NULL and for 'production', FALSE
  // for 'sandbox' — the same three answers.
  assert(/is distinct from 'sandbox'/.test(SQL));
});

Deno.test("US-2286: non-revenue counts are deliberately untouched", () => {
  // `trialing` and the past_due-only count are not revenue. Excluding sandbox
  // from them would change numbers this story never claimed, and a silent
  // scope creep in a money migration is worth failing over.
  for (const nonRevenue of [
    /'trialing', \(\s*\r?\n\s*select count\(\*\)::int from public\.users where subscription_status = 'trialing'\s*\r?\n\s*\)/,
    /'pastDue', \(\s*\r?\n\s*select count\(\*\)::int from public\.users where subscription_status = 'past_due'\s*\r?\n\s*\)/,
  ]) {
    assert(
      nonRevenue.test(SQL),
      "a non-revenue count was rewritten; this migration only touches revenue",
    );
  }
});

Deno.test("US-2286: the bodies are otherwise unchanged from what is running", () => {
  // The whole safety argument for a 350-line migration authored without a
  // database to run it against: undo the six inserts and what is left must be
  // byte-identical to 00215 and 00514. Anything else means a transcription
  // error, which is the risk that mattered here — not the predicate.
  const undo = (s: string) =>
    s.replace(/\r?\n\s*and (?:u\.)?billing_environment is distinct from 'sandbox'/g, "");
  const slice = (src: string, start: string, delim: string) => {
    const at = src.indexOf(start);
    const open = src.indexOf(delim, at);
    const close = src.indexOf(delim, open + delim.length);
    return src.slice(at, close + delim.length);
  };

  const s215 = Deno.readTextFileSync(new URL("00215_revenue_dashboard.sql", MIGRATIONS));
  const s514 = Deno.readTextFileSync(
    new URL("00514_admin_metrics_service_role_guard.sql", MIGRATIONS),
  );
  const live = `${slice(s215, "create or replace function public.revenue_dashboard(", "$$")};\n\n${
    slice(s514, "CREATE OR REPLACE FUNCTION public.admin_revenue_metrics()", "$function$")
  };`;

  const from = SQL.indexOf("create or replace function public.revenue_dashboard(");
  const to = SQL.indexOf("insert into public.applied_migrations");
  assert(from > -1 && to > from, "the migration's shape changed — this guard is stale");
  assertEquals(undo(SQL.slice(from, to)).trimEnd(), live);
});
