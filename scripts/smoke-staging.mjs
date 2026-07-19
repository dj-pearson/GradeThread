#!/usr/bin/env node
// Staging smoke check (US-520). Proves the staging stack is alive, wired
// together, and actually STAGING (not accidentally pointed at production)
// before a change is promoted to main/prod.
//
// Checks:
//   1. Edge liveness  — /health is ok AND reports env:"staging" (the edge
//      exposes EDGE_ENV on the liveness body for exactly this assertion).
//   2. Edge readiness — /health/ready says ready (staging DB reachable,
//      critical env present). Feature-group gaps are reported, not fatal.
//   3. Supabase Auth  — <supabase>/auth/v1/health responds (GoTrue up).
//   4. Frontend shell — staging web URL serves the app (title marker).
//   5. Separation guard — staging URLs must not equal the prod hostnames.
//
// Usage:
//   node scripts/smoke-staging.mjs \
//     [--edge https://functions-staging.gradethread.com] \
//     [--web https://staging.gradethread.com] \
//     [--supabase https://api-staging.gradethread.com]
// or via env: STAGING_EDGE_URL / STAGING_WEB_URL / STAGING_SUPABASE_URL.
//
// Only --edge/STAGING_EDGE_URL is required; web/supabase checks are skipped
// (warn) when their URL isn't provided. Non-zero exit on any failure so it
// can gate promotion (npm run smoke:staging; .github/workflows/staging-smoke.yml).

const PROD_HOSTS = new Set([
  "gradethread.com",
  "www.gradethread.com",
  "api.gradethread.com",
  "functions.gradethread.com",
]);

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    flags[args[i].slice(2)] = args[i + 1];
    i++;
  }
}

const strip = (u) => (u ? u.replace(/\/+$/, "") : u);
const EDGE = strip(flags.edge || process.env.STAGING_EDGE_URL);
const WEB = strip(flags.web || process.env.STAGING_WEB_URL);
const SUPABASE = strip(flags.supabase || process.env.STAGING_SUPABASE_URL);

if (!EDGE) {
  console.error(
    "✗ No staging edge URL. Pass --edge <url> or set STAGING_EDGE_URL.\n" +
      "  (See vault/10-ops/staging.md — if the staging stack isn't stood up yet, that is\n" +
      "  the documented gap, not a smoke failure.)",
  );
  process.exit(2);
}

let failed = 0;
let warned = 0;
const ok = (name, detail = "") => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, detail) => {
  console.log(`  ✗ ${name}: ${detail}`);
  failed++;
};
const warn = (name, detail) => {
  console.log(`  ⚠ ${name}: ${detail}`);
  warned++;
};

async function getJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // leave body null — callers treat unparseable JSON as a failure
  }
  return { res, body };
}

async function run() {
  console.log(`Staging smoke — edge=${EDGE} web=${WEB ?? "(skip)"} supabase=${SUPABASE ?? "(skip)"}\n`);

  // 5 first: refuse to "pass" a prod URL handed in as staging.
  for (const [label, url] of [["edge", EDGE], ["web", WEB], ["supabase", SUPABASE]]) {
    if (!url) continue;
    const host = new URL(url).hostname;
    if (PROD_HOSTS.has(host)) {
      fail(`separation guard (${label})`, `${host} is a PRODUCTION hostname — staging must not point at prod`);
    }
  }
  if (failed === 0) ok("separation guard", "no staging URL is a prod hostname");

  // 1. Edge liveness + env assertion.
  try {
    const { res, body } = await getJson(`${EDGE}/health`);
    if (!res.ok || body?.status !== "ok") {
      fail("edge liveness", `HTTP ${res.status}, status=${body?.status}`);
    } else if (body.env !== "staging") {
      // An older deploy without the env field reports undefined — surface that
      // explicitly so ops redeploys rather than chasing a config ghost.
      fail(
        "edge env",
        body.env === undefined
          ? "no `env` field on /health — deploy a build that includes US-520"
          : `EDGE_ENV is "${body.env}", expected "staging"`,
      );
    } else {
      ok("edge liveness", `release=${body.release ?? "?"} env=staging`);
    }
  } catch (err) {
    fail("edge liveness", err?.message ?? err);
  }

  // 2. Edge readiness.
  try {
    const { res, body } = await getJson(`${EDGE}/health/ready`);
    if (!res.ok || body?.status !== "ready") {
      fail(
        "edge readiness",
        `HTTP ${res.status}, status=${body?.status}` +
          (body?.missing_env ? `, missing_env=${body.missing_env.join(",")}` : ""),
      );
    } else {
      ok("edge readiness");
      // Unconfigured feature groups are expected on staging (warn-only) but
      // worth printing — a smoke run is when someone is actually looking.
      for (const [feat, msg] of Object.entries(body.features ?? {})) {
        if (msg !== "ok") warn(`feature ${feat}`, msg);
      }
    }
  } catch (err) {
    fail("edge readiness", err?.message ?? err);
  }

  // 3. Supabase Auth health (GoTrue exposes an unauthenticated health probe).
  if (SUPABASE) {
    try {
      const res = await fetch(`${SUPABASE}/auth/v1/health`, { redirect: "follow" });
      if (res.ok) ok("supabase auth health");
      else fail("supabase auth health", `HTTP ${res.status}`);
    } catch (err) {
      fail("supabase auth health", err?.message ?? err);
    }
  } else {
    warn("supabase auth health", "skipped — set STAGING_SUPABASE_URL");
  }

  // 4. Frontend shell.
  if (WEB) {
    try {
      const res = await fetch(`${WEB}/`, { redirect: "follow" });
      const html = await res.text();
      if (!res.ok) fail("frontend shell", `HTTP ${res.status}`);
      else if (!/GradeThread/i.test(html)) fail("frontend shell", "response has no GradeThread marker");
      else ok("frontend shell");
    } catch (err) {
      fail("frontend shell", err?.message ?? err);
    }
  } else {
    warn("frontend shell", "skipped — set STAGING_WEB_URL");
  }

  console.log("");
  if (failed > 0) {
    console.error(`✗ ${failed} staging smoke check(s) failed${warned ? `, ${warned} warning(s)` : ""}.`);
    process.exit(1);
  }
  console.log(`✓ Staging smoke passed${warned ? ` (${warned} warning(s))` : ""}.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
