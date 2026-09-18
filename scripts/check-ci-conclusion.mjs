#!/usr/bin/env node
// US-3408 AC3: read the CI conclusion for a pushed commit instead of assuming it.
//
// The third hole this story names is the cheapest one to close and the one
// nobody closed: the loop pushes and moves on. CI would have caught 40e95fadc's
// half-resolved merge in minutes, and the answer would have arrived three
// commits later with nobody looking at it.
//
// This asks GitHub what the check runs for a SHA actually concluded, and says
// so. It does not guess, and when it cannot ask it says THAT rather than
// printing a green line (a guard that cannot fail is worse than no guard —
// vault/70-agent/guards-that-cannot-fail.md).
//
// Usage:
//   node scripts/check-ci-conclusion.mjs                 # HEAD, one look
//   node scripts/check-ci-conclusion.mjs <sha>
//   node scripts/check-ci-conclusion.mjs --wait          # poll until every run finishes
//   node scripts/check-ci-conclusion.mjs --wait --timeout 900
//
// Exit 0 green · 1 red · 2 still running (with --wait, that means it timed out)
// · 3 could not ask.
//
// WHAT HAPPENS WHEN IT IS RED is not a matter of taste here, and the answer is
// in vault/70-agent/reading-a-red-ci.md: read which STEP failed before assuming
// a regression, because this job's knowledge guards (vault lint, runbook-sync,
// the held-migration gate) go red for normal states far more often than the
// code does. Red on a step you did not touch is a report to read, not a licence
// to push again.

import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const wait = argv.includes("--wait");
const timeoutIdx = argv.indexOf("--timeout");
const timeoutSec = timeoutIdx === -1 ? 1800 : Number(argv[timeoutIdx + 1] ?? 1800);
const sha =
  argv.find((a) => /^[0-9a-f]{7,40}$/i.test(a)) ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin is not a GitHub remote: ${url}`);
  return m[1];
}

function token() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

// GT_CI_API_BASE exists so this file's own test can point it at a local server:
// the reporting logic is the part that decides whether a push is reported green,
// and a guard whose reporting is untested is the shape this story is about.
const API_BASE = process.env.GT_CI_API_BASE || "https://api.github.com";

async function checkRuns(slug, ref, auth) {
  const res = await fetch(
    `${API_BASE}/repos/${slug}/commits/${ref}/check-runs?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "gradethread-ci-conclusion",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
    },
  );
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
  return (await res.json()).check_runs ?? [];
}

function report(runs) {
  const pending = runs.filter((r) => r.status !== "completed");
  const failed = runs.filter(
    (r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion),
  );
  return { pending, failed };
}

const slug = repoSlug();
const auth = token();
if (!auth) {
  console.error(`[ci] CANNOT ASK: no GH_TOKEN or GITHUB_TOKEN in the environment.`);
  console.error(`[ci] The CI conclusion for ${sha.slice(0, 9)} is UNKNOWN, not green.`);
  console.error(`[ci] Read it at https://github.com/${slug}/commit/${sha}/checks`);
  process.exit(3);
}

const deadline = Date.now() + timeoutSec * 1000;
for (;;) {
  let runs;
  try {
    runs = await checkRuns(slug, sha, auth);
  } catch (e) {
    console.error(`[ci] CANNOT ASK: ${e.message}`);
    console.error(`[ci] The CI conclusion for ${sha.slice(0, 9)} is UNKNOWN, not green.`);
    process.exit(3);
  }

  if (!runs.length) {
    if (wait && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    console.error(`[ci] no check runs for ${sha.slice(0, 9)} yet — UNKNOWN, not green.`);
    process.exit(2);
  }

  const { pending, failed } = report(runs);

  if (pending.length && wait && Date.now() < deadline) {
    process.stderr.write(`[ci] ${pending.length} run(s) still going…\n`);
    await new Promise((r) => setTimeout(r, 15_000));
    continue;
  }

  for (const r of runs) {
    const state = r.status === "completed" ? r.conclusion : r.status;
    console.log(`  ${state.padEnd(12)} ${r.name}`);
  }

  if (failed.length) {
    console.error(`[ci] RED on ${sha.slice(0, 9)}: ${failed.map((r) => r.name).join(", ")}`);
    console.error(`[ci] ${failed[0].html_url}`);
    console.error(
      `[ci] Read WHICH STEP failed before assuming a regression — this job's` +
        ` knowledge guards go red for normal states (vault/70-agent/reading-a-red-ci.md).`,
    );
    process.exit(1);
  }
  if (pending.length) {
    console.error(`[ci] ${pending.length} run(s) unfinished on ${sha.slice(0, 9)} — UNKNOWN, not green.`);
    process.exit(2);
  }
  console.log(`[ci] green on ${sha.slice(0, 9)} across ${runs.length} check run(s).`);
  process.exit(0);
}
