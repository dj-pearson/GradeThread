#!/usr/bin/env node
// US-2003 AC4: what is our ACTUAL detection latency, against the 15-minute
// SEV1 ack target?
//
// The Uptime workflow is scheduled `*/10 * * * *` and its own comment called
// GitHub cron "best-effort (runs may start a few minutes late under load)".
// That framing is what made the 15-minute target look reachable, and it is
// wrong by a wide margin: measured over 99 consecutive scheduled runs, exactly
// ONE landed within 10 minutes of the one before it. The median gap was 17.2
// minutes and the worst was 43.
//
// So this is not "a few minutes late". Detection latency exceeds the ack target
// at the MEDIAN, which means the alert typically arrives after the deadline it
// is supposed to feed.
//
// WHY A SCRIPT RATHER THAN A NUMBER IN A NOTE. A number in a note is true on
// the day it is written. GitHub's scheduler load changes, and the honest form
// of this finding is something anyone can re-run before deciding whether the
// vendor-check upgrade (vault/10-ops/uptime-monitoring.md) is still needed.
//
// Read-only: one `gh run list`. Nothing here writes.
//
//   node scripts/ops/uptime-cadence.mjs [--limit 100] [--json]

import { execFileSync } from "node:child_process";

/** The ack target this is measured against (vault/10-ops/incident-response.md). */
const ACK_TARGET_MIN = 15;

/** uptime-check.mjs re-checks a failure once before alerting (CONFIRM_DELAY_MS). */
const CONFIRM_MIN = 0.5;

/** Rough runtime of one check, from the workflow's own history (~10-15s). */
const RUN_MIN = 0.25;

const SCHEDULED_MIN = 10;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * `gh` is not on PATH on the Windows dev box; fall back to the install
 * location before giving up, so this runs without setup on either.
 */
function ghBinary() {
  for (const bin of ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch { /* try the next one */ }
  }
  throw new Error(
    "gh CLI not found. Install it, or run this where `gh auth status` works.",
  );
}

function scheduledRunStarts(limit) {
  const raw = execFileSync(ghBinary(), [
    "run",
    "list",
    "--workflow=Uptime",
    "--limit",
    String(limit),
    "--json",
    "startedAt,event",
  ], { encoding: "utf8", maxBuffer: 1 << 24 });

  return JSON.parse(raw)
    // workflow_dispatch runs are manual and say nothing about the schedule.
    .filter((r) => r.event === "schedule" && r.startedAt)
    .map((r) => new Date(r.startedAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
}

/** Interval statistics, in minutes. Pure, so it is testable without gh. */
export function cadenceStats(startsMs) {
  const gaps = [];
  for (let i = 1; i < startsMs.length; i++) {
    gaps.push((startsMs[i] - startsMs[i - 1]) / 60_000);
  }
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    intervals: sorted.length,
    min: sorted[0],
    median: at(50),
    p90: at(90),
    max: sorted[sorted.length - 1],
    mean: gaps.reduce((a, b) => a + b, 0) / gaps.length,
    onSchedule: sorted.filter((g) => g <= SCHEDULED_MIN).length,
  };
}

/**
 * Worst-case detection latency for an outage that begins just after a passing
 * check: a full interval of blindness, then the confirm delay, then the run.
 */
export function detectionLatency(intervalMin) {
  return intervalMin + CONFIRM_MIN + RUN_MIN;
}

function main() {
  const limit = Number(arg("--limit", "100"));
  const starts = scheduledRunStarts(limit);
  const stats = cadenceStats(starts);
  if (!stats) {
    console.error("Not enough scheduled Uptime runs to measure an interval.");
    return 1;
  }

  const rows = [
    ["median", stats.median],
    ["p90", stats.p90],
    ["worst observed", stats.max],
  ].map(([label, gap]) => ({
    label,
    intervalMin: Number(gap.toFixed(1)),
    latencyMin: Number(detectionLatency(gap).toFixed(1)),
    withinAckTarget: detectionLatency(gap) <= ACK_TARGET_MIN,
  }));

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ackTargetMin: ACK_TARGET_MIN, stats, rows }, null, 2));
    return rows.every((r) => r.withinAckTarget) ? 0 : 1;
  }

  const f = (n) => `${n.toFixed(1)} min`;
  console.log(`Uptime workflow cadence — scheduled */10, measured from ${stats.intervals} intervals`);
  console.log(`  window        : ${new Date(starts[0]).toISOString()} -> ${new Date(starts.at(-1)).toISOString()}`);
  console.log(`  min / median  : ${f(stats.min)} / ${f(stats.median)}`);
  console.log(`  p90 / max     : ${f(stats.p90)} / ${f(stats.max)}`);
  console.log(`  mean          : ${f(stats.mean)}`);
  console.log(
    `  ran on schedule (<= ${SCHEDULED_MIN} min): ${stats.onSchedule}/${stats.intervals}`,
  );
  console.log();
  console.log(`Detection latency vs the ${ACK_TARGET_MIN}-minute SEV1 ack target:`);
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(15)} ${String(r.latencyMin).padStart(5)} min  ` +
        `${r.withinAckTarget ? "within" : "EXCEEDS"}`,
    );
  }
  console.log();
  console.log(
    rows.every((r) => r.withinAckTarget)
      ? "The scheduled detector can meet the ack target."
      : "The scheduled detector CANNOT meet the ack target. The alert arrives after\n" +
        "the deadline it feeds. Either raise the target, or add the vendor check in\n" +
        "vault/10-ops/uptime-monitoring.md (1-minute cadence, off GitHub's scheduler).",
  );
  return rows.every((r) => r.withinAckTarget) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1].split("\\").join("/")}` ||
    import.meta.url.endsWith(process.argv[1].split("\\").pop() ?? "")) {
  process.exit(main());
}
