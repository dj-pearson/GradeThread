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
const anyLaneFlag = ["--web", "--edge", "--db", "--security", "--e2e", "--all"]
  .some((f) => flags.has(f));
const on = (name) => flags.has(`--${name}`) || flags.has("--all") || !anyLaneFlag && ["web", "edge", "db"].includes(name);

function dockerUp() {
  return spawnSync("docker", ["info"], { stdio: "ignore", shell: true }).status === 0;
}

const results = [];
let skipped = [];

function run(name, cmd, opts = {}) {
  process.stdout.write(`\n\x1b[1m▶ ${name}\x1b[0m\n  $ ${cmd}${opts.cwd ? `   (in ${opts.cwd})` : ""}\n`);
  const started = Date.now();
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: opts.cwd ?? root });
  const ok = r.status === 0;
  results.push({ name, ok, sec: ((Date.now() - started) / 1000).toFixed(1) });
}

// ── Web (Node) — mirrors ci.yml "build" job ──────────────────────────────────
if (on("web")) {
  run("web: eslint", "npm run lint");
  run("web: tsc -b", "npx tsc -b");
  run("web: vitest + coverage", "npm run test:coverage");
  run("web: production build (incl. prerender)", "npm run build");
  run("web: npm audit (high)", "npm audit --audit-level=high");
}

// ── Edge (Deno) — mirrors security.yml "deno-check" job ───────────────────────
if (on("edge")) {
  run("edge: deno lint", "deno lint", { cwd: edgeDir });
  run("edge: deno check src/main.ts", "deno check src/main.ts", { cwd: edgeDir });
  run("edge: deno test", "deno test --allow-net --allow-env --allow-read", { cwd: edgeDir });
  run("edge: frozen lockfile", "deno cache --frozen src/main.ts", { cwd: edgeDir });
}

// ── DB (Supabase, local throwaway stack) — mirrors db-migrations.yml ──────────
if (on("db")) {
  if (!dockerUp()) {
    skipped.push("db: Docker daemon is not running — start Docker Desktop, then `npm run verify:db`.");
  } else {
    run("db: supabase db start (apply migrations)", "supabase db start");
    run("db: supabase db reset --no-seed (re-apply from zero)", "supabase db reset --no-seed");
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

if (failed.length) {
  process.stdout.write(`\n\x1b[31m\x1b[1m${failed.length} check(s) failed:\x1b[0m ${failed.map((f) => f.name).join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(`\n\x1b[32m\x1b[1mAll ${results.length} check(s) passed.\x1b[0m${skipped.length ? ` (${skipped.length} skipped)` : ""}\n`);
