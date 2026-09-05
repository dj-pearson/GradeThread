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
// Thresholds + escalation: vault/10-ops/incident-response.md ("Availability monitoring").
// Local test: `node scripts/ops/uptime-check.mjs` (GitHub-issue steps are
// skipped without GITHUB_TOKEN; webhook skipped without UPTIME_ALERT_WEBHOOK).

const SITE_URL = (process.env.UPTIME_SITE_URL || "https://gradethread.com").replace(/\/$/, "");
const EDGE_URL = (process.env.UPTIME_EDGE_URL || "https://functions.gradethread.com").replace(/\/$/, "");
const SUPABASE_URL = (process.env.UPTIME_SUPABASE_URL || "https://api.gradethread.com").replace(/\/$/, "");
const ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || "";

const TIMEOUT_MS = 10_000;
const CONFIRM_DELAY_MS = Number(process.env.UPTIME_CONFIRM_DELAY_MS ?? 30_000);

// The SPA shell carries the app root div; the hard-404 page (public/404.html,
// US-422) carries a "Page Not Found" title and has NO root div. We use these to
// tell "deep link served the app" from "deep link soft/hard-404'd".
//
// NOTE: do NOT key the 404 marker off `robots: noindex`. Since US-2045 every
// app shell served by functions/_shared/spa-shell.ts is deliberately marked
// `noindex, nofollow` to keep authed routes out of the index, so noindex now
// appears on HEALTHY /dashboard/* responses too — using it as a 404 signal
// produced a false "soft-404" on the (correctly served) SPA shell. The unique
// "Page Not Found" title plus the absence of the root div identify a real 404.
const SPA_SHELL_MARKER = /<div id="root">/i;
const NOT_FOUND_MARKER = /Page Not Found/i;

// US-2619: the size of the static branded card, measured at run time rather
// than written down.
//
// An OG endpoint that fails gracefully serves this exact file, so an image
// whose byte count equals it is the FALLBACK and not a real render. Both are
// 200 image/png and both look healthy from the outside, which is precisely how
// /og/help and /og/verified read as fine for months while their render path had
// never once executed.
//
// Measured, because a hardcoded 133915 would turn the first redesign of the
// fallback into a false alarm — and a monitor that cries wolf is one people
// switch off. Null when it cannot be fetched, and every use is guarded, so
// failing to measure it costs the NOTE and never invents an alert.
let FALLBACK_PNG_BYTES = null;

/**
 * What to say about an OG endpoint that answered 200 image/png with `bytes`.
 *
 * Pure, and exported, because the three-way distinction is the whole point and
 * it is not observable from the outside: zero bytes, the fallback, and a real
 * render are all "200 image/png" to anything that only checks a status code.
 *
 * Returns null when there is nothing to say — which includes zero bytes, since
 * that is a FAILURE (bytesOk) and a note as well would report it twice.
 */
export function ogFallbackNote(endpoint, bytes, fallbackBytes) {
  if (!bytes) return null;
  if (!fallbackBytes || bytes !== fallbackBytes) return null;
  return `${endpoint} is serving the BRANDED FALLBACK (${bytes} bytes, ` +
    `byte-identical to /og-image.png), so the real renderer did not run ` +
    `(US-2619)`;
}

async function measureFallbackBytes() {
  try {
    const res = await fetch(`${SITE_URL}/og-image.png`, {
      headers: { "User-Agent": "GradeThread-Uptime/1.0" },
    });
    if (!res.ok) return null;
    return (await res.arrayBuffer()).byteLength || null;
  } catch {
    return null;
  }
}

export const TARGETS = [
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
    // US-2447: read the host hang-watchdog's state and report it, WITHOUT
    // letting it fail the target.
    //
    // The watchdog is the only thing that ends an edge hang, it lives on the
    // host, and until now nothing outside SSH could say whether it was still
    // installed — so the answer only ever arrived during an outage, which is
    // exactly when nobody can go and check. This is a note, not a check,
    // because it will read "unconfigured" on any host that has not installed
    // scripts/ops/edge-watchdog.sh yet: paging on that would mean an alert
    // firing every ten minutes forever, and a muted monitor is worse than none.
    // It surfaces in the run log always, and in the incident issue body — which
    // is the moment "was the watchdog even running?" is the first question.
    // ⚠ `features` IS A SIBLING OF `checks`, NOT A CHILD. This read
    // `?.checks?.features?.hostWatchdog` from the day it shipped, which is
    // always undefined, so the note NEVER FIRED — silently, because an optional
    // chain over a wrong path returns undefined and the `typeof !== "string"`
    // arm treats that identically to "the field is fine". The whole point was to
    // answer "was the watchdog even running?" during an incident, and it would
    // have been blank in exactly that moment. Verified against the live
    // response 2026-08-17: top-level keys are status, checks, features, schema,
    // timestamp, and `checks` holds only database and env.
    bodyNote: (bodyText) => {
      try {
        const state = JSON.parse(bodyText)?.features?.hostWatchdog;
        if (typeof state !== "string" || state.startsWith("ok")) return null;
        return `hostWatchdog: ${state}`;
      } catch {
        return null;
      }
    },
  },
  {
    // US-2618 AC4: a Help Center that serves 200 with nothing on it.
    //
    // `renderCategoryGrid` returns "" when every category is empty, so the hub
    // renders its heading, its description and its search box, and then simply
    // stops. Nothing 404s, nothing errors, and the page looks finished. That is
    // the live state right now: 83 articles are written and none are in the
    // database, and no check anywhere noticed.
    //
    // A NOTE, NOT A FAILURE, and deliberately so — the same reasoning recorded
    // above for hostWatchdog. It is empty TODAY, so failing would open an
    // incident issue immediately and keep the monitor red until someone runs
    // the seed. A monitor that is red for a known reason gets ignored, and the
    // next real outage arrives into a channel nobody reads. The note appears in
    // every run log and in the body of any incident issue, which is where
    // "and by the way the help centre is empty" is worth having.
    //
    // The status check is still real: a 200 with the SPA/SSR shell. What the
    // note adds is the difference between "the page loads" and "the page has
    // anything on it".
    id: "help_hub",
    name: "Help Center hub",
    url: `${SITE_URL}/help`,
    ok: (status) => status === 200,
    bodyNote: (bodyText) => {
      // The shelf is the only part of the hub that depends on there being
      // content. Its absence is the signal; its presence says nothing about
      // how MANY articles, which is fine — zero is the failure worth naming.
      if (/class="related-grid"/i.test(bodyText)) return null;
      return "help hub renders NO category shelf — the Help Center is empty (US-2618: run npm run help:seed)";
    },
  },
  {
    // US-2619 AC3/AC4: the social card, checked as an IMAGE rather than as a
    // status code.
    //
    // THE FAILURE THIS EXISTS FOR. /og/social/card returns HTTP 200,
    // Content-Type image/png, and ZERO BYTES. workers-og's ImageResponse
    // STREAMS, so the raster happens as the body is consumed — after the
    // Response object was built and returned — and the route's try/catch
    // cannot see a failure that happens then. The catch never fires, the
    // branded fallback never runs, and the client gets a well-formed 200 with
    // nothing in it. content-social-publish.ts auto-fills this URL whenever a
    // post has no image, so every auto-filled social image is blank.
    //
    // TWO DIFFERENT SIGNALS, and conflating them is what let this hide:
    //   - ZERO bytes FAILS. A 200 with no body is never acceptable.
    //   - The FALLBACK is a NOTE. Serving the branded card is not an outage;
    //     it is the graceful path. But it means the real renderer was not
    //     exercised, which is exactly why /og/help and /og/verified read as
    //     healthy for months while their render path had never once run.
    //
    // The fallback is recognised by comparing against the static file rather
    // than a hardcoded byte count, so a redesign of the fallback does not turn
    // this into a false alarm.
    id: "og_social_card",
    name: "Social card image",
    url: `${SITE_URL}/og/social/card?ratio=landscape`,
    ok: (status) => status === 200,
    bytesOk: (bytes) => bytes > 0,
    bytesNote: (bytes) =>
      ogFallbackNote("og/social/card", bytes, FALLBACK_PNG_BYTES),
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
    // US-2619: a BINARY target asserts on byte length, not text. res.text()
    // decodes as UTF-8, so a PNG's .length is not its byte count — which is the
    // difference between "this image is empty" and "this image is 133915 bytes
    // of branded fallback", and both of those are 200 image/png.
    const needsBytes = typeof target.bytesOk === "function" ||
      typeof target.bytesNote === "function";
    const needsBody = !needsBytes &&
      (typeof target.bodyOk === "function" || typeof target.bodyNote === "function");
    let bodyText = null;
    let byteLength = null;
    if (needsBytes) {
      byteLength = (await res.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength;
    } else if (needsBody) {
      bodyText = await res.text();
    } else {
      await res.arrayBuffer().catch(() => {});
    }
    const statusOk = target.ok(res.status);
    const bodyOk = typeof target.bodyOk === "function" ? target.bodyOk(bodyText ?? "") : true;
    const bytesOk = typeof target.bytesOk === "function"
      ? target.bytesOk(byteLength ?? 0)
      : true;
    // A note never contributes to `up` — see the bodyNote comment on edge_ready.
    const note = typeof target.bytesNote === "function"
      ? target.bytesNote(byteLength ?? 0)
      : typeof target.bodyNote === "function"
      ? target.bodyNote(bodyText ?? "")
      : null;
    return {
      ...target,
      up: statusOk && bodyOk && bytesOk,
      note,
      httpStatus: res.status,
      latency,
      byteLength,
      // Distinguish a clean status failure from a 200-with-wrong-body (soft 404),
      // and both from a 200 with NO body at all.
      error: statusOk && !bytesOk
        ? `HTTP 200 image/png with ${byteLength} bytes — an empty image is a ` +
          `blank link preview everywhere it is used (US-2619)`
        : statusOk && !bodyOk
        ? "HTTP 200 but body is not the SPA shell (soft-404 / broken routing)"
        : null,
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
  // US-2447: the note rides along on both the healthy and the failing line. On
  // the failing one it answers the question an edge-hang incident opens with.
  const note = r.note ? ` [${r.note}]` : "";
  return `${r.name}: ${state} (${detail}, ${r.latency}ms)${note} — ${r.url}`;
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
    `Runbook: vault/10-ops/incident-response.md → "Availability monitoring, thresholds & escalation".`;

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
//
// ⚠ GUARDED, because the test imports TARGETS from this file. Everything below
// is top-level await against the REAL production hostnames — importing this
// module unguarded would fire a full uptime probe (and, with a token in the
// environment, open a GitHub issue) as a side effect of a unit test. Same trap
// that made gen-console-diagnostics regenerate the file it was asked to check.
if (process.argv[1]?.endsWith("uptime-check.mjs")) {

  // US-2619: measure the branded fallback ONCE per run, before probing, so the
  // image targets can tell a real render from a graceful one. Best effort — a
  // null here silently disables that note and nothing else.
  FALLBACK_PNG_BYTES = await measureFallbackBytes();

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

}
