#!/usr/bin/env node
// US-2668 — is GOOGLE_ADS_API_VERSION still a live Google Ads API version?
//
// WHY THIS EXISTS: THE SAME FAILURE, TWICE, EIGHTEEN DAYS APART. Google sunsets
// Ads API versions roughly quarterly, and a sunset version does NOT answer with
// a JSON error - googleads.googleapis.com serves an HTML "Error 404 (Not
// Found)!!1" page. That reaches our logs as
//
//     Google Ads query failed (404): <!DOCTYPE html>...
//
// which reads like a malformed request, or a bad credential, and not like a
// dead endpoint. On 2026-08-18 v18 had sunset and ads-sync failed every morning
// at 08:00. On 2026-09-06 the constant was on v21, v21 had ALSO sunset, and
// ads-sync had recorded 18 consecutive failures across three days while
// keyword_research_runs held the same 404 HTML from 2026-08-31.
//
// Both times the diagnosis in the story was "an expired refresh token or a
// developer token limited to test accounts". Both times it was the URL.
//
// THE PROBE NEEDS NO CREDENTIALS, which is the point - an UNAUTHENTICATED POST
// to a live version is rejected with 401 JSON (the endpoint exists, you are not
// allowed), and to a sunset version with 404 HTML (the endpoint is gone). So
// this distinguishes "our secrets are wrong" from "the version is dead" without
// holding any secret, and can run anywhere.
//
// Run:  node scripts/ops/google-ads-version-check.mjs
//       node scripts/ops/google-ads-version-check.mjs --self-test
//
// Exits non-zero when the pinned version is not live. Network-dependent by
// nature, so it belongs in ops and in a scheduled job, NOT in the pre-push
// verify: a flight-mode laptop must not fail someone's push.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `new URL(...).pathname` - the latter is absolute on
// Windows and RELATIVE on Linux, which is green here and red in CI.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLIENT = join(
  ROOT,
  "services",
  "edge-functions",
  "src",
  "lib",
  "google-ads-client.ts",
);

const BASE = "https://googleads.googleapis.com";
const PROBE_CUSTOMER = "1234567890";

/** The version this repo actually ships, read from the source of truth. */
export function pinnedVersion(source = readFileSync(CLIENT, "utf8")) {
  const m = source.match(/GOOGLE_ADS_API_VERSION\s*=\s*"(v\d+)"/);
  if (!m) throw new Error(`GOOGLE_ADS_API_VERSION not found in ${CLIENT}`);
  return m[1];
}

/**
 * Classify one version from its unauthenticated response.
 *
 * 401 = live (endpoint exists, we sent no credentials).
 * 404 = sunset (Google serves an HTML page, not a JSON error).
 * Anything else is UNKNOWN and must not be read as either - a proxy, a captive
 * portal or an outage would otherwise be reported as a sunset version and send
 * someone bumping a constant that was fine.
 */
export function classify(status) {
  if (status === 401) return "live";
  if (status === 404) return "sunset";
  return "unknown";
}

async function probe(version) {
  const url = `${BASE}/${version}/customers/${PROBE_CUSTOMER}/googleAds:search`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "select customer.id from customer" }),
      signal: AbortSignal.timeout(20_000),
    });
    return classify(res.status);
  } catch {
    return "unknown";
  }
}

function selfTest() {
  const cases = [
    [401, "live"],
    [404, "sunset"],
    [200, "unknown"],
    [500, "unknown"],
    [403, "unknown"],
  ];
  const bad = cases.filter(([status, want]) => classify(status) !== want);
  if (bad.length) {
    console.error("classify() is wrong for:", bad);
    return 1;
  }
  const v = pinnedVersion('export const GOOGLE_ADS_API_VERSION = "v22";');
  if (v !== "v22") {
    console.error(`pinnedVersion() read ${v}, expected v22`);
    return 1;
  }
  // And it must FAIL rather than default when the constant is gone, because a
  // silent default is how a check starts passing against nothing.
  let threw = false;
  try {
    pinnedVersion("const SOMETHING_ELSE = 1;");
  } catch {
    threw = true;
  }
  if (!threw) {
    console.error("pinnedVersion() did not throw on a missing constant");
    return 1;
  }
  console.log(`google-ads-version-check self-test: ${cases.length + 2} cases OK.`);
  return 0;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const pinned = pinnedVersion();
  const state = await probe(pinned);
  console.log(`GOOGLE_ADS_API_VERSION = ${pinned} -> ${state}`);

  if (state === "live") return 0;

  if (state === "unknown") {
    // Not a pass and not a failure. Saying "sunset" here on a flaky network is
    // how someone bumps a constant that was never the problem.
    console.error(
      `Could not classify ${pinned}: the probe answered neither 401 nor 404. ` +
        `Network, proxy or an outage. Re-run before concluding anything.`,
    );
    return 2;
  }

  // Sunset: find what to move to, and name the lowest live one.
  const candidates = [];
  for (let n = Number(pinned.slice(1)); n <= Number(pinned.slice(1)) + 6; n++) {
    candidates.push(`v${n}`);
  }
  const results = await Promise.all(candidates.map(probe));
  const live = candidates.filter((_, i) => results[i] === "live");

  console.error(`\n${pinned} IS SUNSET. googleads.googleapis.com serves an HTML`);
  console.error(`404 for it, which reaches the logs as an opaque`);
  console.error(`"failed (404): <!DOCTYPE html>" and reads like a bad request.`);
  console.error(
    `\nprobed: ${candidates.map((v, i) => `${v}=${results[i]}`).join(" ")}`,
  );
  if (live.length) {
    console.error(
      `\nBump GOOGLE_ADS_API_VERSION to ${live[0]} (the LOWEST live one - every` +
        `\nversion carries breaking changes, so take the smaller hop).`,
    );
  }
  return 1;
}

main().then((code) => process.exit(code));
