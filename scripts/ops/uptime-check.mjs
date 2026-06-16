#!/usr/bin/env node
// External synthetic uptime monitor (US-500). Run by .github/workflows/uptime.yml
// on a schedule from GitHub-hosted runners — infrastructure that is external to
// everything it checks (Cloudflare Pages, Coolify, self-hosted Supabase), so a
// total prod outage still gets detected and alerted.
//
// Behavior:
//   1. Probe every target (10s timeout each).
//   2. Any failure is re-checked once after CONFIRM_DELAY_MS — only a target
//      that fails BOTH rounds alerts (threshold: 2 consecutive failures, so a
//      single blip/cold-start never pages).
//   3. Confirmed failure → POST to UPTIME_ALERT_WEBHOOK (Slack-compatible, same
//      payload shape as the edge service's MONITOR_ALERT_WEBHOOK) AND open (or
//      comment on) a GitHub issue labeled `uptime` — the issue is the always-on
//      channel: it works with zero secrets and notifies repo watchers by
//      email/mobile. Exit 1 so the workflow run itself shows red.
//   4. Full recovery → comment on + close any open `uptime` issue.
//
// Thresholds + escalation: docs/INCIDENT_RESPONSE.md ("Availability monitoring").
// Local test: `node scripts/ops/uptime-check.mjs` (GitHub-issue steps are
// skipped without GITHUB_TOKEN; webhook skipped without UPTIME_ALERT_WEBHOOK).

const SITE_URL = (process.env.UPTIME_SITE_URL || "https://gradethread.com").replace(/\/$/, "");
const EDGE_URL = (process.env.UPTIME_EDGE_URL || "https://functions.gradethread.com").replace(/\/$/, "");
const SUPABASE_URL = (process.env.UPTIME_SUPABASE_URL || "https://api.gradethread.com").replace(/\/$/, "");
const ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || "";

const TIMEOUT_MS = 10_000;
const CONFIRM_DELAY_MS = Number(process.env.UPTIME_CONFIRM_DELAY_MS ?? 30_000);

// The SPA shell carries the app root div; the hard-404 page (public/404.html,
// US-422) carries a noindex marker + "Page Not Found" title. We use these to
// tell "deep link served the app" from "deep link soft/hard-404'd".
const SPA_SHELL_MARKER = /<div id="root">/i;
const NOT_FOUND_MARKER = /Page Not Found|name="robots" content="noindex/i;

const TARGETS = [
  {
    id: "spa",
    name: "Web app (SPA)",
    url: `${SITE_URL}/`,
    ok: (status) => status === 200,
  },
  {
    // US-422 SPA-fallback regression guard. `/` is a prerendered STATIC file, so
    // it stays 200 even when the _redirects SPA rewrites are broken — it can't
    // catch a routing regression. A deep authenticated route has NO static file:
    // it only resolves if `/dashboard/* → /index.html 200` is live. When that
    // rule is missing/overridden the route 404s (or 308s away), which is exactly
    // the incident this check exists to detect. We require 200 AND the real SPA
    // shell body (not the 404 page served with a 200) so a soft-404 can't pass.
    id: "spa_deep_route",
    name: "SPA deep-link routing (/dashboard/*)",
    url: `${SITE_URL}/dashboard/flipdesk/marketplaces`,
    ok: (status) => status === 200,
    bodyOk: (text) => SPA_SHELL_MARKER.test(text) && !NOT_FOUND_MARKER.test(text),
  },
  {
    id: "edge",
    name: "Edge API liveness",
    url: `${EDGE_URL}/health`,
    ok: (status) => status === 200,
  },
  {
    // /health/ready returns 503 when a hard dependency (DB, critical env) is
    // down even though the process is up — this is the check that catches a
    // database outage.
    id: "edge_ready",
    name: "Edge readiness (database)",
    url: `${EDGE_URL}/health/ready`,
    ok: (status) => status === 200,
  },
  {
    // Kong fronts GoTrue and requires an apikey for /auth/v1/health. With the
    // anon key we demand a real 200 from GoTrue; without it (secret unset) a
    // 401 from Kong still proves Supabase's gateway is up, so accept any
    // non-5xx response rather than report a false outage.
    id: "supabase_auth",
    name: "Supabase Auth",
    url: `${SUPABASE_URL}/auth/v1/health`,
    headers: ANON_KEY ? { apikey: ANON_KEY } : undefined,
    ok: ANON_KEY ? (status) => status === 200 : (status) => status < 500,
  },
];

async function probe(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "GradeThread-Uptime/1.0", ...(target.headers ?? {}) },
    });
    const latency = Date.now() - started;
    // Read the body only when a target asserts on it (e.g. the SPA-shell check);
    // otherwise just drain so the runner doesn't hold sockets open.
    const needsBody = typeof target.bodyOk === "function";
    const bodyText = needsBody ? await res.text() : (await res.arrayBuffer().catch(() => {}), null);
    const statusOk = target.ok(res.status);
    const bodyOk = needsBody ? target.bodyOk(bodyText ?? "") : true;
    return {
      ...target,
      up: statusOk && bodyOk,
      httpStatus: res.status,
      latency,
      // Distinguish a clean status failure from a 200-with-wrong-body (soft 404).
      error: statusOk && !bodyOk ? "HTTP 200 but body is not the SPA shell (soft-404 / broken routing)" : null,
    };
  } catch (err) {
    return {
      ...target,
      up: false,
      httpStatus: null,
      latency: Date.now() - started,
      error: err?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err?.cause ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function describe(r) {
  const state = r.up ? "UP" : "DOWN";
  const detail = r.error ?? `HTTP ${r.httpStatus}`;
  return `${r.name}: ${state} (${detail}, ${r.latency}ms) — ${r.url}`;
}

// ── GitHub issue channel (uses the workflow's GITHUB_TOKEN) ─────────────────

const GH_TOKEN = process.env.GITHUB_TOKEN?.trim() || "";
const GH_REPO = process.env.GITHUB_REPOSITORY?.trim() || "";
const ISSUE_LABEL = "uptime";

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "GradeThread-Uptime/1.0",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

async function findOpenUptimeIssue() {
  const issues = await gh(
    `/repos/${GH_REPO}/issues?labels=${ISSUE_LABEL}&state=open&per_page=1`,
  );
  return issues[0] ?? null;
}

async function reportFailure(failures, allResults) {
  const names = failures.map((f) => f.name).join(", ");
  const lines = allResults.map((r) => `- ${r.up ? "✅" : "🔴"} ${describe(r)}`).join("\n");
  const body =
    `Confirmed by 2 consecutive failed checks ${CONFIRM_DELAY_MS / 1000}s apart ` +
    `(run: ${runUrl()}).\n\n${lines}\n\n` +
    `Runbook: docs/INCIDENT_RESPONSE.md → "Availability monitoring, thresholds & escalation".`;

  // Channel 1: Slack-compatible webhook (optional secret).
  const webhook = process.env.UPTIME_ALERT_WEBHOOK?.trim();
  if (webhook) {
    try {
      const summary = `[GradeThread uptime] DOWN: ${names}`;
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `${summary}\n${failures.map(describe).join("\n")}`,
          summary,
          severity: "critical",
          alert_codes: failures.map((f) => `uptime_${f.id}`),
        }),
      });
      console.log(`Webhook alert → ${res.status}`);
    } catch (err) {
      console.error("Webhook alert failed:", err);
    }
  } else {
    console.log("UPTIME_ALERT_WEBHOOK not set — skipping webhook channel.");
  }

  // Channel 2: GitHub issue (dedupe — one open incident issue at a time).
  if (!GH_TOKEN || !GH_REPO) {
    console.log("No GITHUB_TOKEN/GITHUB_REPOSITORY — skipping issue channel.");
    return;
  }
  try {
    const existing = await findOpenUptimeIssue();
    if (existing) {
      await gh(`/repos/${GH_REPO}/issues/${existing.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `Still failing: **${names}**\n\n${body}` }),
      });
      console.log(`Commented on open uptime issue #${existing.number}`);
    } else {
      const issue = await gh(`/repos/${GH_REPO}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: `🔴 Uptime: ${names} failing`,
          body,
          labels: [ISSUE_LABEL],
        }),
      });
      console.log(`Opened uptime issue #${issue.number}`);
    }
  } catch (err) {
    console.error("GitHub issue channel failed:", err);
  }
}

async function reportRecovery() {
  if (!GH_TOKEN || !GH_REPO) return;
  try {
    const existing = await findOpenUptimeIssue();
    if (!existing) return;
    await gh(`/repos/${GH_REPO}/issues/${existing.number}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: `✅ All targets healthy again (run: ${runUrl()}). Closing.`,
      }),
    });
    await gh(`/repos/${GH_REPO}/issues/${existing.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    console.log(`Closed uptime issue #${existing.number} (recovered)`);
  } catch (err) {
    console.error("Recovery close failed:", err);
  }
}

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : "(local run)";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main ────────────────────────────────────────────────────────────────────

const round1 = await Promise.all(TARGETS.map(probe));
for (const r of round1) console.log(describe(r));

let results = round1;
const firstFailures = round1.filter((r) => !r.up);
if (firstFailures.length > 0) {
  console.log(`\n${firstFailures.length} failure(s) — confirming in ${CONFIRM_DELAY_MS / 1000}s…`);
  await sleep(CONFIRM_DELAY_MS);
  const recheck = await Promise.all(
    firstFailures.map((f) => probe(TARGETS.find((t) => t.id === f.id))),
  );
  for (const r of recheck) console.log(describe(r));
  results = round1.map((r) => recheck.find((c) => c.id === r.id) ?? r);
}

const confirmed = results.filter((r) => !r.up);
if (confirmed.length > 0) {
  console.error(`\nCONFIRMED DOWN: ${confirmed.map((f) => f.name).join(", ")}`);
  await reportFailure(confirmed, results);
  process.exit(1);
}

console.log("\nAll targets healthy.");
await reportRecovery();
