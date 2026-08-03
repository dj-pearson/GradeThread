// US-2353: step-up coverage that matches the risk ordering, in two tiers.
//
// THE INVERSION. `PUT /api/admin/flags` toggles ANY feature flag — a kill switch
// — under the router-wide `ops:write` and nothing else, while the far less
// impactful per-flag RULE endpoint in the same file required super_admin AND a
// step-up. The bar was highest on the smaller action. Four more routes had no
// step-up at all: drawing the guarantee pool, approving a claim (which refunds a
// fee and grants a free re-grade), superseding up to 200 issued grade reports,
// and approving an agent-authored proposal, which EXECUTES it.
//
// TWO CROSS-SCOPE HOLES, and they are the part a scope map cannot survive:
//
//   • the claim decision sits under `grading:review`, so revoking an admin's
//     `billing:write` did not stop them paying claims;
//   • the job retry sits under `ops:write`, so an admin who has never held
//     `grading:review` could void an issued grade through it.
//
// A scope that can be routed around by choosing a different router is not a
// scope, it is a label. Both now check the scope the ACTION belongs to, on top
// of the router's.
//
// AC5: the window, and why the default was not simply lowered. 24 hours is right
// for ordinary sensitive actions — re-prompting for an authenticator on every
// one trains people to keep the app open, which defeats it. It is wrong for the
// irreversible tier, where "you verified this morning" is not evidence that you
// are at the keyboard now. So there are two windows and a second helper, rather
// than one changed default that would have made the common case worse.

import { assert } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key",
);
const { STEP_UP_FRESH_SEC, STEP_UP_MAX_AGE_SEC } = await import("../lib/env.ts");

const R = new URL("../routes/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, R));

Deno.test("US-2353 AC5: the fresh window is short, and shorter than the day one", () => {
  assert(
    STEP_UP_FRESH_SEC < STEP_UP_MAX_AGE_SEC,
    "the two tiers collapsed into one — the fresh window buys nothing",
  );
  assert(
    STEP_UP_FRESH_SEC <= 15 * 60,
    `${STEP_UP_FRESH_SEC}s is long enough that a walked-away session still ` +
      `passes, which is the thing this tier exists to stop`,
  );
  // And not so short that a multi-step action re-prompts mid-flow, which is how
  // a control gets routed around rather than followed.
  assert(STEP_UP_FRESH_SEC >= 60, "the fresh window is under a minute");
});

Deno.test("US-2353 AC5: the day window is still the DEFAULT for everything else", () => {
  // Lowering the global default would have made the common case worse and is the
  // change this deliberately did not make.
  const src = Deno.readTextFileSync(new URL("../lib/step-up.ts", import.meta.url));
  assert(
    /maxAgeSec: number = STEP_UP_MAX_AGE_SEC/.test(src),
    "requireStepUp no longer defaults to the day window",
  );
  assert(
    /requireStepUp\(c, STEP_UP_FRESH_SEC\)/.test(src),
    "requireFreshStepUp no longer composes the short window onto requireStepUp",
  );
});

const IRREVERSIBLE: Array<[string, string, string]> = [
  ["admin-flags.ts", 'adminFlagsRoutes.put("/"', "toggles any feature flag — a kill switch"],
  [
    "admin-guarantee-pool.ts",
    'adminGuaranteePoolRoutes.post("/claims/:id/resolve"',
    "draws the guarantee pool and grants reward credit",
  ],
  [
    "admin-bulk.ts",
    'adminBulkRoutes.post("/regrade"',
    "supersedes up to 200 ISSUED grade reports",
  ],
  [
    "admin-agents.ts",
    'adminAgentsRoutes.post("/proposals/:id/approve"',
    "EXECUTES an agent-authored operational write",
  ],
  [
    "admin-grading.ts",
    'adminGradingRoutes.post("/prompts/:id/deactivate"',
    "reverts every grade to the code default — the activate mirror",
  ],
  [
    "admin-grading.ts",
    'adminGradingRoutes.post("/exemplars/:id/deactivate"',
    "changes what the grader compares against",
  ],
  [
    "admin-grading.ts",
    'adminGradingRoutes.put("/baselines/:id"',
    "overwrites the baseline a regression would be measured against",
  ],
];

function handler(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  assert(at > -1, `route not found: ${anchor}`);
  const rest = src.slice(at + anchor.length);
  const next = rest.search(/\n\w+Routes\.(get|post|put|patch|delete)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

Deno.test("US-2353 AC2/AC3: every irreversible route takes the FRESH step-up", () => {
  const missing: string[] = [];
  for (const [file, anchor, why] of IRREVERSIBLE) {
    const body = handler(read(file), anchor);
    if (!/requireFreshStepUp\(c\)/.test(body)) missing.push(`${file} ${anchor} — ${why}`);
  }
  assert(missing.length === 0, `these lost their step-up:\n  ${missing.join("\n  ")}`);
});

Deno.test("US-2353: the step-up result is RETURNED at each site", () => {
  // Calling it and dropping the Response reads as a guard and is not one.
  for (const [file, anchor] of IRREVERSIBLE) {
    const body = handler(read(file), anchor);
    assert(
      /if \(stepUp\) return stepUp;/.test(body),
      `${file} ${anchor}: the step-up result is discarded`,
    );
  }
});

Deno.test("US-2353 AC3: activate and deactivate are symmetric", () => {
  // The asymmetry was the tell. One gated, its mirror not — a gap with a shape,
  // which is easier to spot than an absence.
  const src = read("admin-grading.ts");
  for (const pair of ["prompts", "exemplars"]) {
    const on = handler(src, `adminGradingRoutes.post("/${pair}/:id/activate"`);
    const off = handler(src, `adminGradingRoutes.post("/${pair}/:id/deactivate"`);
    assert(/requireStepUp|requireFreshStepUp/.test(on), `${pair} activate lost its gate`);
    assert(/requireStepUp|requireFreshStepUp/.test(off), `${pair} deactivate lost its gate`);
  }
});

Deno.test("US-2353 AC4: paying a claim requires billing:write, whatever router it lives in", () => {
  const src = read("admin-claims.ts");
  assert(
    /callerHasScope\([\s\S]{0,200}"billing:write"/.test(src),
    "the claim decision no longer checks billing:write, so revoking that scope " +
      "does not stop an admin paying claims",
  );
  // The router's own scope must still be there — this is in ADDITION, not
  // instead of.
  assert(
    src.includes('adminClaimsRoutes.use("*", requireScope("grading:review"))'),
    "the router-wide grading scope is gone",
  );
});

Deno.test("US-2353 AC4: voiding a grade requires grading:review, whatever router it lives in", () => {
  const src = read("admin-jobs.ts");
  assert(
    /kind === "grading"[\s\S]{0,600}"grading:review"/.test(src),
    "the grading retry no longer checks grading:review, so an ops:write admin " +
      "can void an issued grade",
  );
  // Only the grading kind — requiring a grading scope for ordinary ops retries
  // would be the same category error in reverse.
  assert(
    /if \(kind === "grading"\) \{/.test(src),
    "the grading check is no longer scoped to the grading kind",
  );
});

Deno.test("US-2353: the scan can still find a route, so a pass means something", () => {
  // Guards the guard. If the registration style changes and `handler` stops
  // matching, every case above would throw rather than silently pass — but the
  // route LIST going stale would not, so assert it is non-trivial.
  assert(IRREVERSIBLE.length >= 7, "the irreversible route list shrank");
  const body = handler(read("admin-flags.ts"), 'adminFlagsRoutes.put("/"');
  assert(body.length > 50, "the handler slice is empty — the extractor is broken");
});
