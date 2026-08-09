#!/usr/bin/env node
// Local CI mirror — run the same gates GitHub Actions runs, BEFORE you push, so
// broken code never leaves the machine. Cross-platform (spawn with shell:true).
//
// Usage:
//   node scripts/verify.mjs              # default: web + edge + db
//   node scripts/verify.mjs --web        # frontend lane only (ci.yml build job)
//   node scripts/verify.mjs --edge       # edge/Deno lane only (security.yml deno-check)
//   node scripts/verify.mjs --db         # migrations lane only (db-migrations.yml) — needs Docker
//   node scripts/verify.mjs --security   # npm audit + Trivy image scan — needs Docker
//   node scripts/verify.mjs --e2e        # add the Playwright e2e suite (ci.yml e2e job)
//   node scripts/verify.mjs --all        # everything above
//
// Lane flags combine. With no lane flag, the default set is web + edge + db.
// Secrets are NOT scanned here — the pre-commit hook runs gitleaks on staged
// changes (the right moment for secret detection). See .githooks/pre-commit.
//
// The DB + security lanes need Docker running. If the daemon is down they are
// SKIPPED with a loud warning rather than failing the whole run — so a quick
// `npm run verify` still works without Docker. Turn Docker on (and re-run, or
// use `npm run verify:db`) whenever you touch supabase/migrations or the edge
// Dockerfile.
//
// NOTE (self-hosted Supabase): `supabase db start` / `db reset` boot a LOCAL,
// throwaway Supabase stack in Docker on localhost. It is migration-validation
// ONLY and is completely separate from the self-hosted production instance at
// api.gradethread.com — it never connects to or mutates prod. Don't `supabase
// link` / `db push` from here expecting to hit prod; prod is deployed by its
// own self-hosted process.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const edgeDir = resolve(root, "services/edge-functions");

const flags = new Set(process.argv.slice(2));
const anyLaneFlag = ["--web", "--edge", "--db", "--security", "--e2e", "--vault", "--all"]
  .some((f) => flags.has(f));
const on = (name) => flags.has(`--${name}`) || flags.has("--all") || !anyLaneFlag && ["web", "edge", "db", "vault"].includes(name);

function dockerUp() {
  return spawnSync("docker", ["info"], { stdio: "ignore", shell: true }).status === 0;
}

const results = [];
let skipped = [];
const warnings = [];

function run(name, cmd, opts = {}) {
  process.stdout.write(`\n\x1b[1m▶ ${name}\x1b[0m\n  $ ${cmd}${opts.cwd ? `   (in ${opts.cwd})` : ""}\n`);
  const started = Date.now();
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: opts.cwd ?? root });
  const ok = r.status === 0;
  results.push({ name, ok, sec: ((Date.now() - started) / 1000).toFixed(1) });
}

// Runs a check for its REPORT rather than its verdict: a failure is surfaced
// loudly in the summary but does not fail the lane. For known-broken external
// state (a vulnerable base image) where a hard gate would be red on arrival.
function advisory(name, cmd, opts = {}) {
  process.stdout.write(`\n\x1b[1m▶ ${name}\x1b[0m \x1b[2m(advisory)\x1b[0m\n  $ ${cmd}\n`);
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: opts.cwd ?? root });
  if (r.status !== 0) warnings.push(name);
}

// ── Web (Node) — mirrors ci.yml "build" job ──────────────────────────────────
if (on("web")) {
  // US-1612: cheap prd.json hygiene gate FIRST — catches a bad nextId / dep
  // cycle / dup id before the expensive lanes run.
  run("web: prd-lint", "node scripts/prd-lint.mjs");
  // CLAUDE.md is read at the start of every session, so a path that has moved
  // costs every one of them. Cheap enough to sit beside prd-lint.
  run("web: doc path refs", "node scripts/doc-refs.mjs");
  // US-2437: BEFORE eslint, deliberately. The bug that filed that story was
  // eslint linting supabase/.temp/start-secrets/ — 189 errors in generated,
  // minified code nobody wrote — which only appears once you run `supabase
  // start`, i.e. only for the people following CLAUDE.md's full-stack lanes. A
  // wall of errors in a file you did not touch reads as "my change broke
  // something"; naming the cause first is the whole point of the ordering.
  run("web: no tracked-and-gitignored files", "node scripts/check-tracked-ignored.mjs");
  run("web: script tests (prd-lint/digest)", "npm run test:scripts");
  run("web: eslint", "npm run lint");
  // US-1879: the browser extensions' zero-dep node tests (pure adapter helpers +
  // the bundled⇄hosted config sync guard) — cheap, so run before the heavy lanes.
  run("web: extension tests (condition-check)", "node scripts/test-extensions.mjs");
  run("web: tsc -b", "npx tsc -b");
  // Build BEFORE vitest: the prerender suite validates dist/, and CI runs it
  // after `npm run build`. Testing first would check a STALE dist — any newly
  // registered public route reads as "missing" until the next local build.
  run("web: production build (incl. prerender)", "npm run build");
  run("web: vitest + coverage", "npm run test:coverage");
  run("web: bundle-size budget + code-splitting", "node scripts/check-bundle-budget.mjs");
  // US-2336: the UI anti-pattern gate. Blocks on the tells the project's own
  // guidance rules out (side tabs, gradient text, nested cards); reports the
  // rest against a recorded noise baseline. Runs here rather than as a bare
  // impeccable call so one noisy rule cannot block a deploy.
  run("web: UI anti-patterns (impeccable)", "node scripts/check-ui-antipatterns.mjs");
  run("web: npm audit (high)", "npm audit --audit-level=high");
}

// ── Vault (knowledge base integrity) — US-2044 ───────────────────────────────
// Fast, no Docker, no network — so it runs in the default set. --strict makes
// drift on a `type: contract` note an ERROR: those are the notes whose staleness
// actively misleads, since a stale contract gets read as authoritative and then
// implemented. Drift on every other note type stays a warning, because a commit
// touching a file often does not invalidate the prose describing it.
if (on("vault")) {
  run("vault: lint (schema, links, orphans, contract drift)", "node scripts/vault-lint.mjs --strict");
  // Regenerate-and-diff. A stale index is a silently INCOMPLETE index: notes
  // exist that nothing points at, which the orphan rule then reports as a
  // separate confusing failure. Catch the cause, not the symptom.
  run("vault: index up to date", "node scripts/vault-index.mjs --check");
  // US-2050: the two VENDOR skills exist under both .claude/skills and
  // .agents/skills. Nothing here reads the latter, but an agent tool outside
  // this repo may, so both are kept and CI asserts they stay identical —
  // updating one and forgetting the other leaves two versions of the same
  // instructions with nothing to say which is current.
  run("vault: vendor skill mirrors in sync", "node scripts/skills-sync.mjs");
  // US-2076: the SHIPPED copies of ops knowledge (in-app runbooks, rotation
  // registry) against the vault notes they were distilled from. This is the
  // copy on-call reads during an incident, and it had no guard at all.
  run("vault: shipped runbook copies vs vault", "node scripts/runbook-sync.mjs");
}

// ── Edge (Deno) — mirrors security.yml "deno-check" job ───────────────────────
if (on("edge")) {
  run("edge: deno lint", "deno lint", { cwd: edgeDir });
  // US-2378: src/tests/ is checked alongside main.ts. `deno test` type-checks
  // first, so a type error in a test file runs ZERO tests — checking the tree
  // here names the broken file instead of letting it look like a test failure.
  run("edge: deno check src/main.ts + tests", "deno check src/main.ts src/tests/", {
    cwd: edgeDir,
  });
  run("edge: deno test", "deno test --allow-net --allow-env --allow-read", { cwd: edgeDir });
  run("edge: frozen lockfile", "deno cache --frozen src/main.ts", { cwd: edgeDir });
}

// ── DB (Supabase, local throwaway stack) — mirrors db-migrations.yml ──────────
if (on("db")) {
  if (!dockerUp()) {
    skipped.push("db: Docker daemon is not running — start Docker Desktop, then `npm run verify:db`.");
  } else {
    // config.toml interpolates the Google OAuth creds + Turnstile captcha secret
    // via env(); the CLI rejects an enabled provider/captcha with empty values.
    // Mirror db-migrations.yml's dummies so the local db lane works out of the box
    // (migrations only — neither handshake is exercised). Don't clobber real values.
    process.env.SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID ??= "ci-dummy-client-id.apps.googleusercontent.com";
    process.env.SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET ??= "ci-dummy-secret";
    process.env.SUPABASE_AUTH_CAPTCHA_SECRET ??= "1x0000000000000000000000000000000AA";
    run("db: supabase db start (apply migrations)", "supabase db start");
    run("db: supabase db reset --no-seed (re-apply from zero)", "supabase db reset --no-seed");
    // US-1927 AC3: rls-guard_test.ts pins the policy SOURCE form; this pins the
    // PLAN. A policy can read correctly and still be re-evaluated per row, so
    // the two are different assertions and only this one answers the story.
    // Green today, so it gates.
    run("db: RLS auth.uid() InitPlan (US-1927)", "node scripts/db-rls-initplan-check.mjs");
    // US-2403: a denied function call SEGFAULTs the Supabase Postgres image and
    // restarts the whole database. ADVISORY, not a gate, and deliberately so:
    // the stock image is vulnerable today, so gating here would be red on every
    // migration PR from the moment it lands — and a permanently red check gets
    // switched off, which is how the guard stops guarding. It flips to `run()`
    // the moment the image or the supautils.hint_roles config is fixed; that
    // flip is step one of the mitigation, not a follow-up.
    advisory(
      "db: denied-RPC crash (US-2403)",
      "node scripts/db-denied-rpc-crash-check.mjs",
    );
  }
}

// ── Security (Trivy image scan) — mirrors security.yml "trivy-edge-image" ─────
if (on("security")) {
  if (!dockerUp()) {
    skipped.push("security: Docker daemon is not running — start Docker Desktop, then `npm run verify:security`.");
  } else {
    run("security: npm audit (high)", "npm audit --audit-level=high");
    run("security: build edge image", "docker build -t gradethread-edge:scan services/edge-functions");
    run(
      "security: trivy image (HIGH/CRITICAL, fixed-only)",
      "trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 gradethread-edge:scan",
    );
  }
}

// ── E2E (Playwright) — mirrors ci.yml "e2e" job ──────────────────────────────
if (on("e2e")) {
  run("e2e: playwright (builds + runs against preview)", "npm run build && npm run e2e");
}

// ── Summary ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
process.stdout.write("\n\x1b[1m──────── verify summary ────────\x1b[0m\n");
for (const r of results) {
  const mark = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  process.stdout.write(`  ${mark} ${r.name} \x1b[2m(${r.sec}s)\x1b[0m\n`);
}
for (const s of skipped) process.stdout.write(`  \x1b[33m⚠ skipped\x1b[0m ${s}\n`);
for (const w of warnings) process.stdout.write(`  \x1b[33m⚠ advisory FAILED (does not block)\x1b[0m ${w}\n`);

if (failed.length) {
  process.stdout.write(`\n\x1b[31m\x1b[1m${failed.length} check(s) failed:\x1b[0m ${failed.map((f) => f.name).join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(`\n\x1b[32m\x1b[1mAll ${results.length} check(s) passed.\x1b[0m${skipped.length ? ` (${skipped.length} skipped)` : ""}\n`);
