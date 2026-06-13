#!/usr/bin/env node
// US-573: grading / autolister memory load test.
//
// Drives a target endpoint (the grade or autolister path) at a configured
// concurrency for a fixed duration while sampling the edge container's memory
// via GET /health/metrics, and asserts RSS never approaches the container
// memory limit. This is the AC gate: "No OOM observed at target concurrency".
//
// The in-process base64 image buffering (grading-pipeline.ts) is the memory
// risk this exercises — each concurrent grade holds multi-MB data URIs resident
// until its vision analysis settles. GRADING_MAX_CONCURRENT_PIPELINES bounds it;
// this script proves the bound holds under load.
//
// Usage (sampling only — point real load at the host some other way, e.g. a
// staging traffic replay, and just watch memory):
//   METRICS_URL=https://functions.gradethread.com/health/metrics \
//   node scripts/ops/loadtest-grading.mjs --duration 120
//
// Usage (drive a real endpoint — supply method + auth + JSON body):
//   METRICS_URL=https://functions.gradethread.com/health/metrics \
//   TARGET_URL=https://functions.gradethread.com/api/grade/submit \
//   TARGET_AUTH="Bearer eyJ..." \
//   node scripts/ops/loadtest-grading.mjs \
//     --concurrency 20 --duration 120 --method POST --body-file grade-payload.json
//
// Flags (all optional):
//   --concurrency N   simultaneous in-flight requests to TARGET_URL   (default 10)
//   --duration   S    seconds to sustain the load + sampling          (default 60)
//   --threshold  P    FAIL if peak RSS exceeds P% of the limit        (default 80)
//   --sample-ms  MS   /health/metrics sampling interval               (default 1000)
//   --method     M    HTTP method for TARGET_URL                      (default GET)
//   --body-file  F    JSON file sent as the request body (POST/PUT/PATCH)
//   --metrics-url URL overrides METRICS_URL
//   --target-url  URL overrides TARGET_URL (omit to sample only)
//
// Exit codes: 0 = PASS (peak RSS stayed under threshold), 1 = FAIL (threshold
// breached, or the metrics endpoint never returned a usable sample).
//
// The 80% default threshold is the OOM safety gate; the 70% line in
// /health/metrics `pressure` is the SCALE-OUT trigger (CAPACITY.md), not a
// failure — they are deliberately different.

import { readFileSync } from "node:fs";

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
const metricsUrl = args["metrics-url"] || process.env.METRICS_URL;
const targetUrl = args["target-url"] || process.env.TARGET_URL || "";
const concurrency = Number(args.concurrency ?? 10);
const durationS = Number(args.duration ?? 60);
const thresholdPct = Number(args.threshold ?? 80);
const sampleMs = Number(args["sample-ms"] ?? 1000);
const method = (args.method || "GET").toUpperCase();
const auth = process.env.TARGET_AUTH || "";

if (!metricsUrl) {
  console.error(
    "ERROR: set METRICS_URL (or --metrics-url) to the edge metrics endpoint — " +
      "e.g. https://functions.gradethread.com/health/metrics",
  );
  process.exit(1);
}
if (!Number.isFinite(concurrency) || concurrency < 1) {
  console.error("ERROR: --concurrency must be a positive integer");
  process.exit(1);
}

let body;
if (args["body-file"]) {
  try {
    body = readFileSync(args["body-file"], "utf8");
  } catch (e) {
    console.error(`ERROR: could not read --body-file ${args["body-file"]}: ${e.message}`);
    process.exit(1);
  }
}

// ── /health/metrics sampler ──────────────────────────────────────────────────
let peakRssMb = 0;
let peakPct = 0;
let limitMb = null;
let samples = 0;
let sampleErrors = 0;

async function sampleMetrics() {
  try {
    const res = await fetch(metricsUrl, { method: "GET" });
    if (!res.ok) {
      sampleErrors++;
      return;
    }
    const json = await res.json();
    const m = json?.memory;
    if (!m || typeof m.rss_mb !== "number") {
      sampleErrors++;
      return;
    }
    samples++;
    peakRssMb = Math.max(peakRssMb, m.rss_mb);
    if (typeof m.limit_mb === "number") limitMb = m.limit_mb;
    if (typeof m.rss_pct_of_limit === "number") {
      peakPct = Math.max(peakPct, m.rss_pct_of_limit);
    }
  } catch {
    sampleErrors++;
  }
}

await sampleMetrics(); // prime + fail fast if the endpoint is wrong
const sampler = setInterval(sampleMetrics, sampleMs);

// ── HTTP load generator (optional — only if TARGET_URL is set) ───────────────
let sent = 0;
let ok = 0;
let failed = 0;
const latencies = [];
const deadline = Date.now() + durationS * 1000;
let running = true;

async function worker() {
  const headers = {};
  if (auth) headers["Authorization"] = auth;
  if (body) headers["Content-Type"] = "application/json";
  while (running && Date.now() < deadline) {
    const t0 = Date.now();
    try {
      const res = await fetch(targetUrl, { method, headers, body });
      sent++;
      if (res.ok) ok++;
      else failed++;
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
  `[loadtest] sampling ${metricsUrl} every ${sampleMs}ms for ${durationS}s` +
    (targetUrl
      ? ` while driving ${method} ${targetUrl} @ concurrency=${concurrency}`
      : " (no target load — sample-only mode)"),
);

if (targetUrl) {
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
} else {
  await new Promise((r) => setTimeout(r, durationS * 1000));
}
running = false;
await sampleMetrics(); // final sample
clearInterval(sampler);

// ── Report ───────────────────────────────────────────────────────────────────
console.log("");
if (targetUrl) {
  console.log(`[loadtest] requests:   ${sent} (ok=${ok}, failed=${failed})`);
  console.log(
    `[loadtest] latency ms: p50=${pct(latencies, 50)} ` +
      `p95=${pct(latencies, 95)} p99=${pct(latencies, 99)} max=${pct(latencies, 100)}`,
  );
}

if (samples === 0) {
  console.error(
    `FAIL: no usable samples from ${metricsUrl} (${sampleErrors} errors). ` +
      "Confirm the URL is the edge /health/metrics endpoint.",
  );
  process.exit(1);
}

const limitStr = limitMb ? `${limitMb} MiB` : "unknown (EDGE_MEMORY_LIMIT_MB unset)";
console.log(
  `[loadtest] memory:     peak RSS=${peakRssMb} MiB of ${limitStr} ` +
    `(peak ${peakPct.toFixed(1)}% of limit, ${samples} samples, ${sampleErrors} errors)`,
);

if (!limitMb) {
  console.log(
    "[loadtest] no limit reported — set EDGE_MEMORY_LIMIT_MB on the container " +
      "to auto-gate. Peak RSS recorded above; compare it to the limit manually.",
  );
  process.exit(0);
}

if (peakPct >= thresholdPct) {
  console.error(
    `FAIL: peak RSS reached ${peakPct.toFixed(1)}% of the ${limitMb} MiB limit ` +
      `(threshold ${thresholdPct}%). Lower GRADING_MAX_CONCURRENT_PIPELINES or ` +
      `raise the container memory limit. See CAPACITY.md.`,
  );
  process.exit(1);
}
console.log(
  `PASS: peak RSS stayed under ${thresholdPct}% of the limit (peak ` +
    `${peakPct.toFixed(1)}%) — no OOM at this concurrency. ` +
    (peakPct >= 70
      ? "NOTE: peak crossed the 70% scale-out line — plan a replica (US-501)."
      : ""),
);
