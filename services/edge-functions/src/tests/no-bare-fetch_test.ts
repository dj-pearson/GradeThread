// US-2321 [P0]: nothing in the edge service may call an external host without a
// deadline.
//
// A bare `fetch` in Deno has no socket-read timeout. The failure that matters is
// not one slow request — it is that the sheet-sync cron fans out per user every
// 5 minutes, each call parks on a hung socket forever, and the ONE Deno
// container that also serves /api/grade/* and /api/payments/* fills with stalled
// requests and stops answering. A Google regional slowdown becomes a grading and
// payments outage.
//
// Every marketplace client already went through `fetchWithTimeout` (US-499).
// The Google integration was simply never migrated — 22 call sites across
// Sheets, the service-account mint, OAuth, Photos Picker, the sheet export and
// Ads. It is now on `googleFetch`.
//
// This guard is an ENUMERATION, not a regex ban. Every remaining bare fetch is
// declared below with its count. A new one in an undeclared file fails. A new
// one in a declared file fails, because the count moves. And fixing a file fails
// until its entry is deleted — so the list can only ever shrink.
//
// It has to be an enumeration because there ARE 33 legitimate-until-audited
// sites left, in files this story does not touch. Banning outright would mean
// either a red build or a blanket suppression, and a suppressed guard is a
// deleted guard.

import { assert, assertEquals } from "@std/assert";

// Files that still call `fetch` directly, and how many times. Sorted by path.
// Deleting an entry is the only way to record a fix; adding one is a deliberate
// act that a reviewer will see.
//
// NOTE ON circuit-breaker.ts: its single call IS `fetchWithTimeout`'s own
// implementation. That one is permanent — it is the thing everything else is
// supposed to use.
const KNOWN_BARE_FETCH: Array<[string, number]> = [
  ["src/lib/agent-tools.ts", 2],
  ["src/lib/apns.ts", 1],
  ["src/lib/cert-image-render.ts", 1],
  ["src/lib/circuit-breaker.ts", 1], // fetchWithTimeout itself — permanent.
  ["src/lib/cloudflare-purge.ts", 1],
  ["src/lib/coherent-cache.ts", 1],
  ["src/lib/content-webhook.ts", 2],
  // US-2326: 1 -> 0. The public-key lookup was a bare fetch reached from an
  // UNAUTHENTICATED webhook with an attacker-chosen kid, so it had no deadline
  // and no negative cache — 600 outbound eBay calls/min/replica on requests
  // that were going to be rejected anyway. It goes through fetchWithTimeout now.
  // US-2323: 3 → 0. All three Trading calls (tradingCall, GetItem specifics
  // and the GetMyeBaySelling paginator) now go through ebayResilientFetch,
  // which composes breaker → retry → timeout. Trading is eBay's slowest and
  // least reliable surface and had none of the three.
  ["src/lib/fcm.ts", 1],
  ["src/lib/gsc-client.ts", 2],
  ["src/lib/indexnow.ts", 1],
  ["src/lib/keyword-research.ts", 2],
  ["src/lib/newsletter-webhook.ts", 1],
  ["src/lib/observability.ts", 1],
  ["src/lib/openai-images.ts", 1],
  ["src/lib/posthog.ts", 1],
  ["src/lib/sns-verify.ts", 1],
  ["src/lib/webhook-delivery.ts", 1],
  ["src/routes/admin-ops.ts", 1],
  ["src/routes/content-public.ts", 1],
  ["src/routes/content-settings.ts", 1],
  ["src/routes/email-sns.ts", 1],
  ["src/routes/flipdesk-ebay.ts", 1],
  ["src/routes/flipdesk-images.ts", 1],
  ["src/routes/jobs-content-watchdog.ts", 1],
  ["src/routes/webhooks.ts", 1],
];

const SRC = new URL("../", import.meta.url);

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// `fetch(` not preceded by an identifier char or a dot — so `fetchWithTimeout(`,
// `googleFetch(`, `this.fetchFn(` and `deps.fetch(` are all excluded, and only a
// genuine global `fetch(` matches.
const BARE_FETCH = /(?<![\w.$])fetch\s*\(/g;

// URLs all the way down, never url.pathname. A file: URL's pathname on Windows
// is "/C:/Users/..." — the leading slash makes it an invalid path, so reading it
// throws NotFound and this guard fails locally while passing in CI. Deno.readDir
// and Deno.readTextFile both take a URL directly; href arithmetic gives the same
// relative path on either platform.
async function scan(): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for await (const entry of walk(SRC)) {
    const rel = `src/${decodeURIComponent(entry.href.slice(SRC.href.length))}`;
    if (!rel.endsWith(".ts")) continue;
    if (rel.startsWith("src/tests/")) continue;
    const src = stripComments(await Deno.readTextFile(entry));
    const n = src.match(BARE_FETCH)?.length ?? 0;
    if (n > 0) found.set(rel, n);
  }
  return found;
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const child = new URL(`${e.name}${e.isDirectory ? "/" : ""}`, dir);
    if (e.isDirectory) yield* walk(child);
    else yield child;
  }
}

Deno.test("US-2321: no undeclared bare fetch in the edge service", async () => {
  const found = await scan();
  const declared = new Map(KNOWN_BARE_FETCH);

  const undeclared = [...found.keys()].filter((f) => !declared.has(f)).sort();
  assertEquals(
    undeclared,
    [],
    `New bare fetch(). Route it through fetchWithTimeout (or googleFetch for ` +
      `Google) — a call with no deadline can hang the whole container. If it ` +
      `genuinely cannot be, add it to KNOWN_BARE_FETCH with a reason.`,
  );

  for (const [file, n] of found) {
    assertEquals(
      n,
      declared.get(file),
      `${file} has ${n} bare fetch call(s), declared ${declared.get(file)}. ` +
        `Fixed one? Lower the count. Added one? Do not.`,
    );
  }
});

Deno.test("US-2321: a declared file that no longer has a bare fetch must be removed", async () => {
  // The other direction. Without this the list is an allowlist that grows
  // stale, and a file everyone believes is guarded stays on a list saying it
  // is not.
  const found = await scan();
  const stale = KNOWN_BARE_FETCH.map(([f]) => f).filter((f) => !found.has(f));
  assertEquals(stale, [], "these no longer call fetch directly — delete their entries");
});

Deno.test("US-2321: the Google integration is off bare fetch entirely", async () => {
  // The story's own scope, pinned by name so a future edit to any of these
  // cannot quietly reintroduce one — the enumeration above would catch it, but
  // this says WHICH files were the point.
  const googleFiles = [
    "lib/google-sheets-api.ts",
    "lib/google-service-account.ts",
    "lib/google-ads-client.ts",
    "lib/google-fetch.ts",
    "routes/flipdesk-google.ts",
    "routes/flipdesk-google-photos.ts",
    "routes/flipdesk-sheets.ts",
  ];
  for (const f of googleFiles) {
    const src = stripComments(await Deno.readTextFile(new URL(`../${f}`, import.meta.url)));
    // google-fetch.ts is the one file allowed to name the global, and it does
    // so through fetchWithTimeout, not directly.
    assertEquals(
      src.match(BARE_FETCH)?.length ?? 0,
      0,
      `${f} still calls fetch directly`,
    );
  }
});

Deno.test("US-2321: SheetsClient's DEFAULT carries the deadline", async () => {
  // All four construction sites take the default, so a default of bare `fetch`
  // meant every SheetsClient in the codebase ran with no deadline. A deadline
  // that each call site has to remember is not a deadline.
  const src = await Deno.readTextFile(
    new URL("../lib/google-sheets-api.ts", import.meta.url),
  );
  assert(src.includes("fetchFn: typeof fetch = googleFetch"));
});

Deno.test("US-2321: the Sheets 429 path is bounded", async () => {
  // It used to self-recurse with a flat 2s sleep, no attempt counter, no growth
  // and no ceiling — the comment said "one retry", the code said forever. Under
  // project-level quota exhaustion (which does not clear in 2s) that hammers
  // Google every 2 seconds per in-flight request per replica, indefinitely,
  // which is how a project gets banned rather than throttled.
  const src = await Deno.readTextFile(
    new URL("../lib/google-sheets-api.ts", import.meta.url),
  );
  assert(src.includes("withRetry("), "must route through lib/retry.ts");
  assert(
    !/return await this\.request<T>\(path, init\);/.test(src),
    "the self-recursive retry must be gone",
  );
  assert(src.includes("maxAttempts: SHEETS_MAX_ATTEMPTS"), "the ceiling must be explicit");
});
