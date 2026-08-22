#!/usr/bin/env node
// Answer as many "OPERATOR: check this in prod" questions as possible WITHOUT
// prod credentials, using only what production already serves to the public.
//
// WHY THIS EXISTS. 82 of 124 open stories wait on a person, and several of them
// did not need to. US-2347's own note carries the lesson after it happened
// twice: "/health/ready is a much richer prod read than this story assumed, and
// PostgREST's OpenAPI document answers RPC signature questions without calling
// anything. Before marking a prod question operator-only, check whether one of
// those two already answers it." Acting on that on 2026-08-17 settled that
// 00610-00617 were applied and that eight anon-callable leaks were closed —
// after PENDING_MIGRATIONS.md had spent a day telling the operator to go and
// apply them.
//
// So this is that check, made repeatable. Run it before deciding a question
// needs a session.
//
// ⚠ STRICTLY READ-ONLY, AND ONE LINE OF THAT IS LOAD-BEARING. The guard probes
// POST to RPCs, which looks like a write and is not: every function probed here
// takes NO arguments, so PostgREST either refuses on the guard (401) or cannot
// resolve a signature (404). A function that TAKES arguments is deliberately not
// probed — proving those from outside means a genuinely write-shaped call, and
// the whole premise is that they might be unguarded, so the call itself could
// mint credits on a real account. Those need a service-role session; that is not
// a gap in this tool, it is the honest boundary of it.
//
// The anon key is public by construction: it ships in the browser bundle, which
// is where this reads it from. Nothing here uses a secret.
//
//   npm run build          # once, so dist/ exists for the key
//   node scripts/probe-prod-readonly.mjs

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EDGE = process.env.PROBE_EDGE_URL ?? "https://functions.gradethread.com";
const API = process.env.PROBE_API_URL ?? "https://api.gradethread.com";
const SITE = process.env.PROBE_SITE_URL ?? "https://gradethread.com";
const TIMEOUT_MS = 25_000;

/** The anon key out of the built bundle. Public: it is served to every visitor. */
export function anonKeyFromDist(dir = "dist/assets") {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    return null;
  }
  const JWT = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;
  for (const f of files) {
    const m = JWT.exec(readFileSync(join(dir, f), "utf8"));
    if (!m) continue;
    try {
      const claims = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString());
      if (claims.role === "anon") return m[0];
    } catch { /* not a JWT after all */ }
  }
  return null;
}

async function get(url, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    return { ok: res.ok, status: res.status, headers: res.headers, body: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Byte length of a binary response.
 *
 * US-2665/US-2619: the image probes below compare SIZES, and `get()` returns
 * `res.text()` — a PNG decoded as UTF-8, which is lossy. The equality test still
 * works (both sides are mangled identically), but the NUMBER it prints is not
 * the byte count, and an operator checking it with `curl -w %{size_download}`
 * gets a different figure and reasonably concludes one of the two is broken.
 * Reading the arrayBuffer costs nothing here and makes the printed number the
 * one a second tool will agree with.
 */
async function byteLength(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return (await res.arrayBuffer()).byteLength;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Functions that take NO arguments — the only ones safe to probe. See the header. */
const NO_ARG_GUARDED = [
  "ai_spend",
  "ai_profitability",
  "retention_cohorts",
  "ai_budget_status",
  "reconciliation_candidates",
  "drip_analytics",
  "newsletter_analytics",
  "data_integrity_scan",
];

const findings = [];
const record = (story, question, answer, verdict) =>
  findings.push({ story, question, answer, verdict });

async function main() {
  const anon = anonKeyFromDist();
  console.log("\nRead-only production probe — nothing here writes, nothing here needs a secret.\n");
  if (!anon) {
    console.log("  ⚠ No anon key found in dist/assets. Run `npm run build` first.");
    console.log("    The health and header probes still run; the RPC ones are skipped.\n");
  }

  // ── /health/ready: schema version, feature posture, release attribution ──
  const health = await get(`${EDGE}/health/ready`);
  if (!health.ok && health.status === 0) {
    console.log(`  ✗ ${EDGE} unreachable: ${health.error}\n`);
  } else {
    let h = null;
    try { h = JSON.parse(health.body); } catch { /* not json */ }
    if (h?.schema) {
      const { expected, applied, status } = h.schema;
      record(
        "US-2282 / US-2606 / any held migration",
        "which migrations are applied in production",
        `expected ${expected}, applied ${applied}, ${status}`,
        status === "match"
          ? "ANSWERED — everything through this version landed, and the running edge expects it"
          : "ANSWERED — and they disagree, which is the thing to act on",
      );
    }
    const rel = h?.features?.release ?? "";
    if (rel) {
      record(
        "US-2001",
        "does the edge build carry a real commit",
        String(rel).slice(0, 60),
        /unattributable/.test(rel)
          ? "ANSWERED — still no GIT_SHA; every prod error is untraceable to a build"
          : "ANSWERED — release is attributable",
      );
    }
    const watch = h?.features?.hostWatchdog ?? "";
    if (watch) {
      record("US-2447", "is the edge hang watchdog installed", String(watch).slice(0, 60),
        /unconfigured/.test(watch) ? "ANSWERED — never checked in" : "ANSWERED — checking in");
    }
    for (const [key, story] of [["alerting", "US-2003"], ["smtp", "US-2597"], ["auth_email_hook", "US-2597"]]) {
      const v = h?.features?.[key];
      if (!v) continue;
      record(story, `${key} configuration`, String(v).split(" — ")[0],
        "PARTIAL — configured is not delivered; the line says so itself");
    }
  }

  // ── GoTrue version (unauthenticated) ──
  if (anon) {
    const gt = await get(`${API}/auth/v1/health`, { apikey: anon });
    try {
      const v = JSON.parse(gt.body)?.version;
      if (v) {
        record("US-2662", "which GoTrue version production runs", v,
          "ANSWERED — decides whether the admin logout route could ever have existed");
      }
    } catch { /* ignore */ }
  }

  // ── OpenAPI: which RPCs exist, with which parameters. Calls nothing. ──
  if (anon) {
    const oa = await get(`${API}/rest/v1/`, { apikey: anon, Accept: "application/openapi+json" });
    let doc = null;
    try { doc = JSON.parse(oa.body); } catch { /* ignore */ }
    if (doc?.paths) {
      const rpcs = Object.keys(doc.paths).filter((p) => p.startsWith("/rpc/"));
      record("US-2606 / US-2662 / any new RPC",
        "is a migration's function actually visible to the API",
        `${rpcs.length} RPCs in the schema cache`,
        "ANSWERED — presence here proves the migration applied AND the cache reloaded");
      for (const [fn, story] of [
        ["admin_revoke_user_sessions", "US-2662"],
        ["flipdesk_overview_metrics", "US-2606"],
      ]) {
        record(story, `is ${fn} live`, doc.paths[`/rpc/${fn}`] ? "present" : "ABSENT",
          doc.paths[`/rpc/${fn}`] ? "ANSWERED — live" : "ANSWERED — missing, so its migration did not land");
      }
    }

    // ── The same document answers COLUMNS, not just RPCs (2026-08-22) ──
    //
    // `definitions[table].properties` is every exposed column and
    // `definitions[table].required` is its NOT NULL set. That settles a whole
    // class of question filed as "one read-only SQL session against
    // production": did this migration's column land, and is prod's nullability
    // the nullability the migrations declare.
    //
    // Proven on US-2777 (lister_locales present => 00648 applied AND the
    // PostgREST cache reloaded, in one read), US-2729 (four agent columns
    // confirmed to have LEFT their required arrays) and US-2444 (the storefront
    // column 00122 created, found by searching every table's columns after
    // searching for its TABLE found nothing).
    //
    // ⚠ ONLY PRESENCE IS CONCLUSIVE. A missing column may be unexposed rather
    // than absent, and this document shows no policies, indexes or defaults.
    if (doc?.definitions) {
      const col = (table, column) =>
        Boolean(doc.definitions[table]?.properties?.[column]);
      for (const [story, table, column, why] of [
        ["US-2777", "flipdesk_settings", "lister_locales",
          "00648 applied and the schema cache reloaded"],
        ["US-2444", "users", "verified_show_listings",
          "the column 00122 creates is live"],
      ]) {
        record(story, `is ${table}.${column} live`, col(table, column) ? "present" : "not exposed",
          col(table, column)
            ? `ANSWERED — ${why}`
            : "INCONCLUSIVE — absence here is not absence in the database");
      }
    }

    // ── pricing_plans is ANON-READABLE, so the money numbers are checkable ──
    //
    // US-2123 was filed as an operator SQL session and was one fetch. The live
    // rows are the authority for what a plan grants, and a client that
    // disagrees is telling a paying seller a number the server will not honour
    // — which is exactly what iOS Settings did (pro 1000 vs the server's 750).
    //
    // Printed rather than judged: this script does not import the frontend's
    // constants, and a mismatch is a decision about which side is wrong.
    // src/test/ios-plan-quota-parity.test.ts holds the iOS side in CI.
    const plans = await get(
      `${API}/rest/v1/pricing_plans?select=key,ai_actions_per_month,included_standard_grades_per_month,active_listing_cap&order=sort_order`,
      { apikey: anon, Authorization: `Bearer ${anon}` },
    );
    if (plans.ok) {
      let rows = null;
      try { rows = JSON.parse(plans.body); } catch { /* not json */ }
      if (Array.isArray(rows) && rows.length) {
        record("US-2123 / US-2117 / any pricing question",
          "what does each plan actually grant in production",
          rows.map((r) => `${r.key}:${r.ai_actions_per_month}ai/${r.included_standard_grades_per_month}gr`).join("  "),
          "ANSWERED — these are the live rows; compare them to FLIPDESK_PLANS before filing a pricing bug");
      }
    }
  }

  // ── The guards, from the outside. No-argument functions only. ──
  if (anon) {
    const refused = [];
    const answered = [];
    for (const fn of NO_ARG_GUARDED) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let status = 0;
      try {
        const res = await fetch(`${API}/rest/v1/rpc/${fn}`, {
          method: "POST",
          headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
          body: "{}",
          signal: ctl.signal,
        });
        status = res.status;
        await res.text();
      } catch { /* leave 0 */ } finally { clearTimeout(t); }
      (status === 401 || status === 403 ? refused : answered).push(`${fn}:${status}`);
    }
    record("US-2282",
      "do the anon-callable SECURITY DEFINER functions still answer the public key",
      `${refused.length}/${NO_ARG_GUARDED.length} refuse`,
      answered.length === 0
        ? "ANSWERED — every no-arg guarded function refuses anon"
        : `LOOK: still answering — ${answered.join(", ")}`);
  }

  // ── The signed-in shell's CSP, and whether the Pages origin secret is armed ──
  const login = await get(`${SITE}/login`);
  if (login.headers) {
    const enforced = login.headers.get("content-security-policy");
    const reportOnly = login.headers.get("content-security-policy-report-only");
    record("US-2330", "is the CSP enforced on the authenticated shell",
      enforced ? "Content-Security-Policy" : reportOnly ? "Report-Only" : "absent",
      enforced ? "ANSWERED — enforced" : "ANSWERED — not enforced yet");
  }
  // A REAL og render can only happen when CF_PAGES_ORIGIN_SECRET matches on BOTH
  // sides; without the Pages half the function returns the fixed-size branded
  // fallback without even calling the edge. So a size that VARIES BY RATIO is
  // proof the secret is armed — which /health/ready cannot see, because it
  // reports the edge's own view.
  const [land, pin] = await Promise.all([
    byteLength(`${SITE}/og/social/card?ratio=landscape`),
    byteLength(`${SITE}/og/social/card?ratio=pin`),
  ]);
  if (land !== null && pin !== null) {
    const a = land, b = pin;
    record("US-2612", "is CF_PAGES_ORIGIN_SECRET set on the Cloudflare Pages side too",
      `landscape ${a}B, pin ${b}B`,
      a !== b
        ? "ANSWERED — sizes differ by ratio, so these are real renders and the Pages half IS armed"
        : "LOOK — identical sizes suggest the branded fallback, i.e. the Pages half is missing");
  }

  // ── /health/metrics: the settings a compose file DECLARES vs what booted ──
  //
  // US-2665. Added 2026-08-17 after these two were measured by hand and turned
  // out to say something no config file could: the edge is running with settings
  // that DISAGREE with every compose file in the repo. A hand probe answers that
  // once; this makes it a line in a report that runs before anyone decides the
  // question needs a session.
  const metrics = await get(`${EDGE}/health/metrics`);
  if (metrics.ok) {
    let m = null;
    try { m = JSON.parse(metrics.body); } catch { /* not json */ }
    // limit_mb is read straight from EDGE_MEMORY_LIMIT_MB. null means the var is
    // absent, which also means headroom_pct and pressure are null — so the
    // load-test gate is comparing against nothing.
    if (m?.memory) {
      const lim = m.memory.limit_mb;
      record(
        "US-2665",
        "is EDGE_MEMORY_LIMIT_MB actually set on the running container",
        lim === null || lim === undefined
          ? `unset — rss ${m.memory.rss_mb}MB, headroom unknowable`
          : `${lim}MB — rss ${m.memory.rss_mb}MB, headroom ${m.memory.headroom_pct}%`,
        lim === null || lim === undefined
          ? "ANSWERED — unset, so docker-compose.coolify.yml (which declares 2048) is NOT the deployed config"
          : "ANSWERED — set, and /health/metrics can compute real headroom",
      );
    }
    // The compose file says 6 and the code default is 6, so any other value came
    // from somewhere outside this repo. capacity.md sized 6 against a 2 GiB
    // limit; a higher number with the limit above unset is the compounding case.
    if (typeof m?.grading?.buffer_pipeline_cap === "number") {
      const cap = m.grading.buffer_pipeline_cap;
      record(
        "US-2665",
        "does the live grading pipeline cap match the repo's sizing",
        `buffer_pipeline_cap ${cap} (repo default and compose both say 6)`,
        cap === 6
          ? "ANSWERED — matches"
          : "LOOK — set outside the repo; vault/10-ops/capacity.md sized 6 for ~600MB peak base64 residency",
      );
    }
  }

  // ── US-2619 AC5: the two OG routes whose render path is still unexercised ──
  //
  // Both answered exactly the branded fallback's byte count when last checked,
  // which was CORRECT (no such handle, and help_articles is empty per US-2618)
  // and means neither renderer has ever actually run in production. AC5 is "re-
  // check once real content exists", and this is what re-checking looks like:
  // compare against the fallback rather than against a remembered number.
  const [fallback, ogHelp, ogVerified] = await Promise.all([
    byteLength(`${SITE}/og-image.png`),
    byteLength(`${SITE}/og/help/getting-started`),
    byteLength(`${SITE}/og/verified/gradethread`),
  ]);
  if (fallback !== null) {
    const fb = fallback;
    for (const [label, n] of [["help", ogHelp], ["verified", ogVerified]]) {
      if (n === null) continue;
      record(
        "US-2619",
        `has the /og/${label} render path ever produced a real image`,
        `${n}B vs branded fallback ${fb}B`,
        n === fb
          ? "ANSWERED — byte-identical to the fallback, so this renderer is still unexercised (seed content first)"
          : "ANSWERED — a real render, so this path now works end to end",
      );
    }
  }

  // ── Report ──
  const answeredCount = findings.filter((f) => f.verdict.startsWith("ANSWERED")).length;
  console.log(`  ${findings.length} question(s) probed, ${answeredCount} answered without a session.\n`);
  for (const f of findings) {
    console.log(`  ${f.story}`);
    console.log(`     Q: ${f.question}`);
    console.log(`     A: ${f.answer}`);
    console.log(`     → ${f.verdict}\n`);
  }
  console.log(
    "  This tool cannot answer anything needing the CATALOG (pg_proc.proacl, a CHECK\n" +
      "  constraint definition, row counts behind RLS) or anything needing a WRITE-shaped\n" +
      "  call. Those are genuinely operator work — see `node scripts/prd-operator.mjs --sessions`.\n",
  );
}

if (process.argv[1]?.endsWith("probe-prod-readonly.mjs")) await main();
