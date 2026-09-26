// PATCH /prompts/:id/shadow for both grading stages (grading.md action 6).
//
// The route used to answer 422 "Only composite-stage prompts can be shadowed"
// for every per_image row, so per-image shadow (US-2443) could only be started
// by hand-written SQL. It now takes both stages, and the per_image branch has
// the guardrails a vision bill needs: the env ceiling must be set, the rate is
// capped, and anything that spends asks for step-up. Stopping never does.
//
//   deno test --allow-env --allow-read src/tests/prompt-shadow-toggle_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  PER_IMAGE_SHADOW_MAX_SAMPLE_RATE,
  planShadowToggle,
  type ShadowToggleRow,
} from "../lib/prompt-shadow-toggle.ts";

const { Hono } = await import("hono");
const { adminGradingRoutes } = await import("../routes/admin-grading.ts");

const PER_IMAGE: ShadowToggleRow = {
  stage: "per_image",
  prompt_text: "Analyze this photo.",
  is_shadow: false,
  shadow_sample_rate: 0,
  shadow_daily_cap: 200,
};
const COMPOSITE: ShadowToggleRow = { ...PER_IMAGE, stage: "composite" };

// ── the rule ────────────────────────────────────────────────────────────────

Deno.test("composite: unchanged, no step-up, no env requirement", () => {
  const plan = planShadowToggle(COMPOSITE, { is_shadow: true, shadow_sample_rate: 0.5 }, 0);
  assertEquals(plan, {
    ok: true,
    update: { is_shadow: true, shadow_sample_rate: 0.5 },
    needsStepUp: false,
  });
});

Deno.test("per_image: starting needs the env ceiling", () => {
  const plan = planShadowToggle(PER_IMAGE, { is_shadow: true, shadow_sample_rate: 0.02 }, 0);
  assert(!plan.ok);
  assertEquals(plan.status, 422);
  assert(plan.error.includes("PER_IMAGE_SHADOW_DAILY_VISION_CAP"));
});

Deno.test("per_image: a valid start asks for step-up", () => {
  const plan = planShadowToggle(PER_IMAGE, { is_shadow: true, shadow_sample_rate: 0.02 }, 500);
  assertEquals(plan, {
    ok: true,
    update: { is_shadow: true, shadow_sample_rate: 0.02 },
    needsStepUp: true,
  });
});

Deno.test("per_image: the sample rate is capped", () => {
  const over = PER_IMAGE_SHADOW_MAX_SAMPLE_RATE + 0.01;
  const plan = planShadowToggle(PER_IMAGE, { is_shadow: true, shadow_sample_rate: over }, 500);
  assert(!plan.ok);
  assertEquals(plan.status, 400);
  // At the cap exactly is allowed.
  const at = planShadowToggle(
    PER_IMAGE,
    { is_shadow: true, shadow_sample_rate: PER_IMAGE_SHADOW_MAX_SAMPLE_RATE },
    500,
  );
  assert(at.ok);
});

Deno.test("per_image: an 'on but idle' start is refused", () => {
  // Rate 0 (the column default) never samples.
  const noRate = planShadowToggle(PER_IMAGE, { is_shadow: true }, 500);
  assert(!noRate.ok && noRate.status === 422);
  // Cap 0 never runs.
  const noCap = planShadowToggle(
    PER_IMAGE,
    { is_shadow: true, shadow_sample_rate: 0.02, shadow_daily_cap: 0 },
    500,
  );
  assert(!noCap.ok && noCap.status === 422);
  // Empty prompt_text is the code default: nothing to compare, and the loader skips it.
  const noText = planShadowToggle(
    { ...PER_IMAGE, prompt_text: "  " },
    { is_shadow: true, shadow_sample_rate: 0.02 },
    500,
  );
  assert(!noText.ok && noText.status === 422);
});

Deno.test("per_image: stopping is always allowed, with no step-up", () => {
  // Started by SQL at a rate wider than the form allows, on a server whose
  // env ceiling has since been removed. It must still stop from the UI.
  const running = { ...PER_IMAGE, is_shadow: true, shadow_sample_rate: 0.2 };
  assertEquals(planShadowToggle(running, { is_shadow: false }, 0), {
    ok: true,
    update: { is_shadow: false },
    needsStepUp: false,
  });
});

Deno.test("per_image: retuning a running shadow is a spend change", () => {
  const running = { ...PER_IMAGE, is_shadow: true, shadow_sample_rate: 0.01 };
  const plan = planShadowToggle(running, { shadow_sample_rate: 0.03 }, 500);
  assert(plan.ok && plan.needsStepUp);
});

Deno.test("the active row cannot start or retune a shadow, on either stage", () => {
  // Neither loader filters on is_active, so the champion would shadow itself.
  for (const base of [PER_IMAGE, COMPOSITE]) {
    const active = { ...base, is_active: true };
    const start = planShadowToggle(active, { is_shadow: true, shadow_sample_rate: 0.02 }, 500);
    assert(!start.ok && start.status === 422, `${base.stage} start: ${JSON.stringify(start)}`);
    assert(start.error.includes("active version"));
    // Already shadowing (e.g. started by SQL): retuning keeps it on, so it is refused too.
    const retune = planShadowToggle(
      { ...active, is_shadow: true, shadow_sample_rate: 0.01 },
      { shadow_sample_rate: 0.02 },
      500,
    );
    assert(!retune.ok && retune.status === 422, `${base.stage} retune`);
    // Stopping stays allowed, with no step-up.
    assertEquals(
      planShadowToggle(
        { ...active, is_shadow: true, shadow_sample_rate: 0.2 },
        { is_shadow: false },
        0,
      ),
      { ok: true, update: { is_shadow: false }, needsStepUp: false },
    );
  }
  // is_active false or absent is the draft path, unchanged.
  const draft = planShadowToggle(
    { ...COMPOSITE, is_active: false },
    { is_shadow: true, shadow_sample_rate: 0.1 },
    0,
  );
  assert(draft.ok);
});

Deno.test("composite: an 'on but idle' start is refused too", () => {
  // The composite loader skips rate 0 and cap 0 exactly as the per-image one does.
  const noRate = planShadowToggle(COMPOSITE, { is_shadow: true }, 0);
  assert(!noRate.ok && noRate.status === 422, JSON.stringify(noRate));
  const noCap = planShadowToggle(
    COMPOSITE,
    { is_shadow: true, shadow_sample_rate: 0.1, shadow_daily_cap: 0 },
    0,
  );
  assert(!noCap.ok && noCap.status === 422);
  // Retuning a running composite shadow down to rate 0 leaves it on and idle.
  const toZero = planShadowToggle(
    { ...COMPOSITE, is_shadow: true, shadow_sample_rate: 0.1 },
    { shadow_sample_rate: 0 },
    0,
  );
  assert(!toZero.ok && toZero.status === 422);
  // Stopping with a rate of 0 is fine: nothing runs.
  assert(planShadowToggle(COMPOSITE, { is_shadow: false, shadow_sample_rate: 0 }, 0).ok);
});

Deno.test("listing_gen cannot be shadowed", () => {
  const plan = planShadowToggle({ ...COMPOSITE, stage: "listing_gen" }, { is_shadow: true }, 500);
  assert(!plan.ok && plan.status === 422);
});

Deno.test("validation errors are unchanged", () => {
  for (const body of [{ shadow_sample_rate: 2 }, { shadow_sample_rate: "x" }]) {
    const p = planShadowToggle(COMPOSITE, body, 0);
    assert(!p.ok && p.status === 400);
  }
  const cap = planShadowToggle(COMPOSITE, { shadow_daily_cap: 1.5 }, 0);
  assert(!cap.ok && cap.status === 400);
  const none = planShadowToggle(COMPOSITE, {}, 0);
  assert(!none.ok && none.error === "Nothing to update");
});

// ── the route ───────────────────────────────────────────────────────────────

// supabaseAdmin resolves `fetch` once, on first use, and keeps it, so the stub
// is installed once for the whole file and reads `currentRow` per request.
let currentRow: (ShadowToggleRow & { id: string }) | null = null;
const writes: Array<Record<string, unknown>> = [];
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const json = (b: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
    );
  if (url.includes("/rest/v1/ai_prompt_versions")) {
    const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body ?? "{}"));
      writes.push(patch);
      const updated = { ...currentRow, ...patch };
      return json(wantsObject ? updated : [updated]);
    }
    return json(wantsObject ? currentRow : currentRow ? [currentRow] : []);
  }
  // US-3526: activation reads the candidate's latest passing eval run.
  if (url.includes("/rest/v1/grading_eval_runs")) {
    const run = { mean_absolute_error: 0.3, agreement_rate: 0.9 };
    const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
    return json(wantsObject ? run : [run]);
  }
  return json([], method === "GET" ? 200 : 201);
}) as typeof fetch;

function appWith(claims?: { aal: string; amr: Array<{ method: string; timestamp: number }> }) {
  // deno-lint-ignore no-explicit-any
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("userId", "00000000-0000-0000-0000-000000000001");
    c.set("adminRole", "super_admin");
    if (claims) c.set("authClaims", claims);
    await next();
  });
  app.route("/", adminGradingRoutes);
  return app;
}
const STEPPED_UP = {
  aal: "aal2",
  amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
};

async function patchShadow(
  row: ShadowToggleRow,
  body: Record<string, unknown>,
  opts: { visionCap?: string; stepUp?: boolean } = {},
) {
  currentRow = { id: "pv-1", ...row };
  writes.length = 0;
  const prevCap = Deno.env.get("PER_IMAGE_SHADOW_DAILY_VISION_CAP");
  const prevMfa = Deno.env.get("ADMIN_MFA_ENFORCED");
  if (opts.visionCap === undefined) Deno.env.delete("PER_IMAGE_SHADOW_DAILY_VISION_CAP");
  else Deno.env.set("PER_IMAGE_SHADOW_DAILY_VISION_CAP", opts.visionCap);
  Deno.env.set("ADMIN_MFA_ENFORCED", "true");
  try {
    const res = await appWith(opts.stepUp ? STEPPED_UP : undefined).request(
      "/prompts/pv-1/shadow",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, body: await res.json(), writes: [...writes] };
  } finally {
    if (prevCap === undefined) Deno.env.delete("PER_IMAGE_SHADOW_DAILY_VISION_CAP");
    else Deno.env.set("PER_IMAGE_SHADOW_DAILY_VISION_CAP", prevCap);
    if (prevMfa === undefined) Deno.env.delete("ADMIN_MFA_ENFORCED");
    else Deno.env.set("ADMIN_MFA_ENFORCED", prevMfa);
  }
}

Deno.test("route: a composite shadow starts without step-up", async () => {
  const r = await patchShadow(COMPOSITE, { is_shadow: true, shadow_sample_rate: 0.1 });
  assertEquals(r.status, 200);
  assertEquals(r.writes, [{ is_shadow: true, shadow_sample_rate: 0.1 }]);
});

Deno.test("route: a per_image shadow is no longer refused for its stage", async () => {
  const r = await patchShadow(
    PER_IMAGE,
    { is_shadow: true, shadow_sample_rate: 0.02 },
    { visionCap: "500", stepUp: true },
  );
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.writes, [{ is_shadow: true, shadow_sample_rate: 0.02 }]);
});

Deno.test("route: a per_image start without step-up is refused before the write", async () => {
  const r = await patchShadow(
    PER_IMAGE,
    { is_shadow: true, shadow_sample_rate: 0.02 },
    { visionCap: "500" },
  );
  assertEquals(r.status, 403);
  assertEquals(r.body.code, "STEP_UP_REQUIRED");
  assertEquals(r.writes, []);
});

Deno.test("route: a per_image start with no env ceiling is refused", async () => {
  const r = await patchShadow(
    PER_IMAGE,
    { is_shadow: true, shadow_sample_rate: 0.02 },
    { stepUp: true },
  );
  assertEquals(r.status, 422);
  assertEquals(r.writes, []);
});

Deno.test("route: a per_image stop needs neither env nor step-up", async () => {
  const r = await patchShadow(
    { ...PER_IMAGE, is_shadow: true, shadow_sample_rate: 0.2 },
    { is_shadow: false },
  );
  assertEquals(r.status, 200);
  assertEquals(r.writes, [{ is_shadow: false }]);
});

Deno.test("route: the active row cannot start a shadow, even stepped up", async () => {
  const r = await patchShadow(
    { ...PER_IMAGE, is_active: true },
    { is_shadow: true, shadow_sample_rate: 0.02 },
    { visionCap: "500", stepUp: true },
  );
  assertEquals(r.status, 422, JSON.stringify(r.body));
  assertEquals(r.writes, []);
});

// ── promotion ends the shadow run ───────────────────────────────────────────

// Neither shadow loader filters on is_active, so a shadowed draft that is later
// promoted kept shadowing itself: about 7 vision calls per sampled per_image
// grade comparing the champion to itself. activatePromptVersion now clears
// is_shadow the same way US-896 clears the canary flags.
Deno.test("activatePromptVersion clears is_shadow on the promoted row", async () => {
  const { activatePromptVersion } = await import("../lib/grading-eval.ts");
  const { servingModelForStage } = await import("../lib/ai-config.ts");
  currentRow = {
    id: "pv-1",
    ...PER_IMAGE,
    is_shadow: true,
    shadow_sample_rate: 0.02,
    garment_scope: null,
    eval_passed: true,
    qualified_model: servingModelForStage("per_image"),
  } as ShadowToggleRow & { id: string };
  writes.length = 0;
  // US-3526: live shadow/canary evidence is a separate rule with its own
  // tests (golden-set-growth_test.ts); waive it here to test the flag.
  Deno.env.set("GRADING_ACTIVATION_MIN_LIVE_SAMPLES", "0");
  let result;
  try {
    result = await activatePromptVersion("pv-1");
  } finally {
    Deno.env.delete("GRADING_ACTIVATION_MIN_LIVE_SAMPLES");
  }
  assertEquals(result, { ok: true });
  const promote = writes.find((w) => w.is_active === true);
  assert(promote, `no activating write in ${JSON.stringify(writes)}`);
  assertEquals(promote.is_shadow, false);
});
