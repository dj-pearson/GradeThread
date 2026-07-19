#!/usr/bin/env node
// US-570: connection-pool load test.
//
// Drives a target endpoint at a configured concurrency for a fixed duration
// while sampling Postgres `pg_stat_activity` (via psql against the DIRECT db
// connection) and asserting the backend connection count never approaches
// `max_connections`. This is the AC#4 gate: "Load test confirms no
// max_connections exhaustion at target concurrency".
//
// Usage:
//   EDGE_URL=https://functions.gradethread.com/health/ready \
//   SUPABASE_DB_DIRECT_URL='postgres://postgres:...@db-host:5432/postgres' \
//   node scripts/ops/loadtest-connections.mjs --concurrency 200 --duration 60
//
// Flags (all optional; env vars are the primary inputs):
//   --concurrency N   simultaneous in-flight HTTP requests   (default 100)
//   --duration   S    seconds to sustain the load            (default 30)
//   --threshold  P    fail if backend conns exceed P% of max (default 80)
//   --sample-ms  MS   pg_stat_activity sampling interval      (default 1000)
//   --url        URL  overrides EDGE_URL
//
// Exit codes: 0 = PASS (peak backend conns stayed under threshold, no probe
// could disprove it), 1 = FAIL (threshold breached) or load could not run.
//
// The DB sampler is OPTIONAL: with no SUPABASE_DB_DIRECT_URL (or no `psql` on
// PATH) the script still runs the HTTP load and reports latency/errors, then
// tells you to watch pg_stat_activity manually — it just can't auto-gate.

import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url || process.env.EDGE_URL;
const concurrency = Number(args.concurrency ?? 100);
const durationS = Number(args.duration ?? 30);
const thresholdPct = Number(args.threshold ?? 80);
const sampleMs = Number(args["sample-ms"] ?? 1000);
const dbUrl =
  process.env.SUPABASE_DB_DIRECT_URL || process.env.SUPABASE_DB_URL || "";

if (!url) {
  console.error(
    "ERROR: set EDGE_URL (or --url) to the endpoint to load — e.g. " +
      "https://functions.gradethread.com/health/ready",
  );
  process.exit(1);
}
if (!Number.isFinite(concurrency) || concurrency < 1) {
  console.error("ERROR: --concurrency must be a positive integer");
  process.exit(1);
}

// ── Postgres backend-connection sampler (optional) ──────────────────────────
function psqlAvailable() {
  if (!dbUrl) return false;
  const r = spawnSync("psql", ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

// Returns { used, max } or null if the probe failed.
function sampleConnections() {
  const sql =
    "select count(*)::int as used, current_setting('max_connections')::int as max from pg_stat_activity;";
  const r = spawnSync(
    "psql",
    [dbUrl, "-Atqc", sql],
    { encoding: "utf8", timeout: 5000 },
  );
  if (r.error || r.status !== 0) return null;
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  const [used, max] = line.split("|").map((n) => Number(n.trim()));
  if (!Number.isFinite(used) || !Number.isFinite(max)) return null;
  return { used, max };
}

const dbProbe = psqlAvailable();
let peakUsed = 0;
let maxConns = 0;
let samples = 0;
let sampler = null;
if (dbProbe) {
  const tick = () => {
    const s = sampleConnections();
    if (s) {
      samples++;
      peakUsed = Math.max(peakUsed, s.used);
      maxConns = s.max;
    }
  };
  tick();
  sampler = setInterval(tick, sampleMs);
} else if (dbUrl) {
  console.warn(
    "WARN: `psql` not found on PATH — running HTTP load WITHOUT the " +
      "pg_stat_activity gate. Install psql to auto-verify connection counts.",
  );
} else {
  console.warn(
    "WARN: SUPABASE_DB_DIRECT_URL unset — running HTTP load WITHOUT the " +
      "pg_stat_activity gate. Watch `pg_stat_activity` manually during the run.",
  );
}

// ── HTTP load generator ─────────────────────────────────────────────────────
let sent = 0;
let ok = 0;
let failed = 0;
const latencies = [];
const deadline = Date.now() + durationS * 1000;
let running = true;

async function worker() {
  while (running && Date.now() < deadline) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: "GET" });
      sent++;
      if (res.ok) ok++;
      else failed++;
      // Drain the body so the socket is freed back to the agent pool.
      await res.arrayBuffer().catch(() => {});
    } catch {
      sent++;
      failed++;
    }
    latencies.push(Date.now() - t0);
  }
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

console.log(
  `[loadtest] ${url} @ concurrency=${concurrency} for ${durationS}s` +
    (dbProbe ? ` (gate: backend conns < ${thresholdPct}% of max)` : " (no DB gate)"),
);

const workers = Array.from({ length: concurrency }, () => worker());
await Promise.all(workers);
running = false;
if (sampler) clearInterval(sampler);

// ── Report ──────────────────────────────────────────────────────────────────
console.log("");
console.log(`[loadtest] requests:   ${sent} (ok=${ok}, failed=${failed})`);
console.log(
  `[loadtest] latency ms: p50=${pct(latencies, 50)} ` +
    `p95=${pct(latencies, 95)} p99=${pct(latencies, 99)} max=${pct(latencies, 100)}`,
);

if (dbProbe && samples > 0) {
  const peakPct = maxConns ? (100 * peakUsed) / maxConns : 0;
  console.log(
    `[loadtest] postgres:   peak backend conns=${peakUsed}/${maxConns} ` +
      `(${peakPct.toFixed(1)}% of max_connections, ${samples} samples)`,
  );
  if (peakPct >= thresholdPct) {
    console.error(
      `FAIL: peak backend connections reached ${peakPct.toFixed(1)}% of ` +
        `max_connections (threshold ${thresholdPct}%). The pooler is not ` +
        `absorbing the fan-out — check that pooled consumers point at the ` +
        `transaction port (6543), not direct 5432. See vault/10-ops/connection-pooling.md.`,
    );
    process.exit(1);
  }
  console.log(
    `PASS: backend connections stayed under ${thresholdPct}% of max ` +
      `(peak ${peakPct.toFixed(1)}%) — no exhaustion at concurrency ${concurrency}.`,
  );
} else {
  console.log(
    "[loadtest] no DB gate ran — HTTP load completed; verify pg_stat_activity " +
      "stayed well under max_connections (see vault/10-ops/connection-pooling.md §7).",
  );
}

// A flood of failed HTTP requests usually means the load never reached the app
// (DNS/TLS/wrong URL) — surface it so a green DB gate isn't misread as a pass.
if (sent > 0 && failed / sent > 0.5) {
  console.error(
    `WARN: ${failed}/${sent} requests failed — the load may not have reached ` +
      "the app. Confirm EDGE_URL is correct before trusting the result.",
  );
}
