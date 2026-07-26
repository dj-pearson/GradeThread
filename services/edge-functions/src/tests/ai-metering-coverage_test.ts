// US-1581: AI-action metering — the reserve/refund contract + the coverage
// drift test that keeps it honest.
//
// Part 1 unit-tests withAiAction with injected deps (no DB).
// Part 2 statically walks src/routes/ and asserts that EVERY route module
// importing a model-calling lib either meters through the atomic reserve
// contract or sits on the explicit allow-list (billed elsewhere / operator
// cost). A future AI feature that forgets metering fails CI here — same
// drift-test pattern as rls-guard / cron-registry.
//
//   deno test --allow-env --allow-read src/tests/ai-metering-coverage_test.ts

import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { withAiAction, AiQuotaExhaustedError } = await import(
  "../lib/ai-metering.ts"
);

// ── Part 1: the reserve/refund contract ─────────────────────────────

Deno.test("withAiAction: success reserves once and never refunds", async () => {
  const calls: string[] = [];
  const out = await withAiAction("u1", 100, () => Promise.resolve("ok"), {
    reserve: (id, limit) => {
      calls.push(`reserve:${id}:${limit}`);
      return Promise.resolve(true);
    },
    refund: (id) => {
      calls.push(`refund:${id}`);
      return Promise.resolve();
    },
  });
  assertEquals(out, "ok");
  assertEquals(calls, ["reserve:u1:100"]);
});

Deno.test("withAiAction: cap reached throws AiQuotaExhaustedError and never runs fn", async () => {
  let ran = false;
  await assertRejects(
    () =>
      withAiAction("u1", 5, () => {
        ran = true;
        return Promise.resolve("nope");
      }, {
        reserve: () => Promise.resolve(false),
        refund: () => Promise.resolve(),
      }),
    AiQuotaExhaustedError,
  );
  assertEquals(ran, false);
});

Deno.test("withAiAction: fn failure refunds the reserved action and rethrows", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      withAiAction("u1", 5, () => Promise.reject(new Error("model down")), {
        reserve: () => {
          calls.push("reserve");
          return Promise.resolve(true);
        },
        refund: () => {
          calls.push("refund");
          return Promise.resolve();
        },
      }),
    Error,
    "model down",
  );
  assertEquals(calls, ["reserve", "refund"]);
});

// ── Part 2: coverage drift test ─────────────────────────────────────

// Libs whose import means "this module can spend Anthropic tokens".
const MODEL_LIBS = [
  "ai-extract",
  "ai-listing",
  "ai-photo-qa",
  "ai-photo-roles",
  "ai-group-verify",
  "ai-reconcile",
  "ai-size-estimate",
  "ai-size-estimate-core",
  "ai-tag-ocr",
  "ai-grading",
  "ai-authenticity",
  "grading-pipeline",
  "quick-grade",
  "support-assistant-engine",
];
const MODEL_IMPORT = new RegExp(
  `from "\\.\\./lib/(${MODEL_LIBS.join("|")})\\.ts"`,
);

// Deliberately UNMETERED route modules — every entry needs a rationale.
// Adding a new AI route? Either meter it (withAiAction / reserveAiAction)
// or add it here WITH a reason a reviewer can veto.
const ALLOWLIST: Record<string, string> = {
  "grade.ts": "grading is billed per-grade (credits/included grades), not AI actions",
  "public-grading.ts":
    "US-1687 free anonymous grade-checker: no account/user to meter per-user AI " +
    "actions against — deliberately un-metered as a top-of-funnel tool. Abuse is " +
    "capped independently: a per-IP sliding window (gradeCheckRateLimited, 5/hr) + " +
    "an 8 MB body cap in the route, plus the global daily Vision ceiling in the " +
    "shared Anthropic client (ai-limiter.ts) that bounds quickGrade's spend.",
  "api-v1.ts": "public API grading — billed per-grade via API key credits",
  "flipdesk-grading.ts": "FlipDesk grading submissions — billed per-grade",
  "webhooks.ts": "payment webhooks re-enter the grading pipeline (per-grade billing)",
  "support-assistant.ts": "support assistant is an operator cost, not user AI spend",
  "admin-grading.ts": "operator tooling (super-admin gated)",
  "admin-bulk.ts": "operator tooling (super-admin gated)",
  "admin-jobs.ts": "operator tooling (super-admin gated)",
  "admin-monitoring.ts": "operator tooling (super-admin gated)",
  "buyer-authenticity.ts":
    "US-1840 buyer authenticity add-on: metered on the BUYER credit contract " +
    "(withBuyerMeter authenticity_credits — included allowance → reward credits → " +
    "upgrade, US-1800/1813), gated by the authenticityAddon entitlement, and " +
    "additionally bounded by the global daily Vision ceiling (reserveGlobalDailyBudget). " +
    "It does NOT use the seller-side withAiAction meter, so the marker regex misses it.",
};

const METER_MARKER = /withAiAction|reserveAiAction|reserve_ai_action/;

async function routeFiles(): Promise<Array<{ name: string; text: string }>> {
  const dir = new URL("../routes/", import.meta.url);
  const out: Array<{ name: string; text: string }> = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".ts")) {
      out.push({
        name: e.name,
        text: await Deno.readTextFile(new URL(e.name, dir)),
      });
    }
  }
  return out;
}

Deno.test("drift: every route importing a model lib is metered or allow-listed", async () => {
  const offenders: string[] = [];
  for (const f of await routeFiles()) {
    if (!MODEL_IMPORT.test(f.text)) continue;
    if (f.name in ALLOWLIST) continue;
    if (!METER_MARKER.test(f.text)) {
      offenders.push(f.name);
    }
  }
  assertEquals(
    offenders,
    [],
    `Route(s) import a model-calling lib without AI-action metering: ${
      offenders.join(", ")
    }. Meter with withAiAction (lib/ai-metering.ts) or allow-list WITH a rationale.`,
  );
});

Deno.test("drift: allow-list carries no stale entries", async () => {
  const files = await routeFiles();
  const stale: string[] = [];
  for (const name of Object.keys(ALLOWLIST)) {
    const f = files.find((x) => x.name === name);
    if (!f || !MODEL_IMPORT.test(f.text)) stale.push(name);
  }
  assertEquals(
    stale,
    [],
    `Allow-listed route(s) no longer import a model lib — remove: ${stale.join(", ")}`,
  );
});

Deno.test("drift: the deprecated increment_ai_actions has no route callers", async () => {
  const offenders: string[] = [];
  for (const f of await routeFiles()) {
    if (f.text.includes('rpc("increment_ai_actions"')) offenders.push(f.name);
  }
  assertEquals(
    offenders,
    [],
    `increment_ai_actions is deprecated on user paths (non-atomic, no cap) — use the reserve contract: ${
      offenders.join(", ")
    }`,
  );
});

Deno.test("bundling contract: generation bills ONE action per item (no reserve inside ai-listing)", async () => {
  const text = await Deno.readTextFile(
    new URL("../lib/ai-listing.ts", import.meta.url),
  );
  // The batch worker / route reserves ONE action per generated item; the
  // generation's internal sub-passes (tag OCR, research ID, verification,
  // synthesis, aspect extract) must not double-bill from inside the lib.
  assert(
    !text.includes('rpc("reserve_ai_action"') && !text.includes("withAiAction("),
    "lib/ai-listing.ts must not reserve AI actions — the caller bills one per item",
  );
});

// ── Part 3: the monthly rollover predicate (US-2179) ────────────────
//
// reserve_ai_action (00087) rolls the counter over LAZILY — nothing zeroes
// users.ai_actions_used_this_month at midnight on the 1st. Every reader has to
// apply the same rule or it reports a seller pinned at their cap into the new
// month. This is the one TS mirror of that SQL predicate; three readers share it
// (plan-gate readUsage, flipdesk-ai checkQuota, the billing-summary meter).

const { aiActionsRolledOver, effectiveAiActionsUsed } = await import(
  "../lib/ai-metering.ts"
);

Deno.test("aiActionsRolledOver: a boundary in a prior month has rolled over", () => {
  const now = new Date(Date.UTC(2026, 6, 3)); // 2026-07-03
  assert(aiActionsRolledOver(new Date(Date.UTC(2026, 5, 28)).toISOString(), now));
  // Prior YEAR too — the month index alone would say June(5) < July(6) is the
  // only case and miss a December-to-January crossing.
  assert(aiActionsRolledOver(new Date(Date.UTC(2025, 11, 31)).toISOString(), now));
});

Deno.test("aiActionsRolledOver: same calendar month has NOT rolled over", () => {
  const now = new Date(Date.UTC(2026, 6, 30));
  assertEquals(
    aiActionsRolledOver(new Date(Date.UTC(2026, 6, 1)).toISOString(), now),
    false,
  );
});

Deno.test("aiActionsRolledOver: a LATER month has not rolled over", () => {
  // A future boundary must not read as rolled over — that would hand a fresh
  // allowance out on every request.
  const now = new Date(Date.UTC(2026, 6, 3));
  assertEquals(
    aiActionsRolledOver(new Date(Date.UTC(2026, 7, 1)).toISOString(), now),
    false,
  );
});

Deno.test("aiActionsRolledOver: null / unparseable boundary fails CLOSED", () => {
  const now = new Date(Date.UTC(2026, 6, 3));
  // Never-stamped or garbage must NOT read as rolled over, or a broken column
  // becomes unlimited free AI actions.
  assertEquals(aiActionsRolledOver(null, now), false);
  assertEquals(aiActionsRolledOver(undefined, now), false);
  assertEquals(aiActionsRolledOver("not-a-date", now), false);
});

Deno.test("effectiveAiActionsUsed: zeroes a stale counter, keeps a current one", () => {
  const now = new Date(Date.UTC(2026, 6, 3));
  const lastMonth = new Date(Date.UTC(2026, 5, 20)).toISOString();
  const thisMonth = new Date(Date.UTC(2026, 6, 1)).toISOString();
  assertEquals(effectiveAiActionsUsed(750, lastMonth, now), 0);
  assertEquals(effectiveAiActionsUsed(750, thisMonth, now), 750);
  assertEquals(effectiveAiActionsUsed(null, thisMonth, now), 0);
});
