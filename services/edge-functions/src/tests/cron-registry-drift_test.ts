// US-1561: cron-registry drift guards.
//
// Three invariants, each of which has silently broken before:
//   1. CODE ↔ REGISTRY — every /api/jobs/* route registered in main.ts has a
//      CRON_REGISTRY entry and vice versa (a new cron without a registry entry
//      fails; a registry entry whose route was removed fails).
//   2. REGISTRY sanity — unique names/endpoints, every schedule parses through
//      nextCronRun (a typo'd cron string would silently never fire).
//   3. DOCS ↔ REGISTRY — COOLIFY.md and vault/10-ops/launch-checklist.md embed the exact
//      renderCronDocs() output between the cron-registry markers, so the
//      operator docs can never drift from the code again.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { CRON_REGISTRY, nextCronRun, renderCronDocs, renderCronSetupGuide } = await import(
  "../lib/cron-runs.ts"
);

const MAIN_TS = new URL("../main.ts", import.meta.url);
const EBAY_ROUTES = new URL("../routes/flipdesk-ebay.ts", import.meta.url);
const COOLIFY = new URL("../../COOLIFY.md", import.meta.url);
const CHECKLIST = new URL("../../../../vault/10-ops/launch-checklist.md", import.meta.url);
const CRON_SETUP = new URL("../../CRON_SETUP.md", import.meta.url);

// US-2447: /api/jobs/* endpoints that are NOT Coolify tasks.
//
// CRON_REGISTRY drives the operator docs — COOLIFY.md and launch-checklist.md
// embed renderCronDocs() verbatim — so every entry reads as "create this task in
// the Coolify UI". `/api/jobs/watchdog-heartbeat` is called by a HOST cron
// (scripts/ops/edge-watchdog.sh, every minute); registering it would instruct
// the operator to build a second, duplicate scheduler for it.
//
// THIS IS NOT A FREE EXEMPTION, and the assertion below is what stops it
// becoming one: an exempted endpoint must appear in scripts/ops/host-schedules.json.
// So the only thing it buys you is moving a route from one registry to the
// other, which is the honest trade — it cannot make a route unregistered.
const HOST_SCHEDULED_JOB_ROUTES = new Set([
  "/api/jobs/watchdog-heartbeat",
]);
const HOST_SCHEDULES = new URL("../../../../scripts/ops/host-schedules.json", import.meta.url);

Deno.test("US-2447: a host-scheduled job route is declared in the host manifest, not merely exempted", async () => {
  const manifest = await Deno.readTextFile(HOST_SCHEDULES);
  for (const path of HOST_SCHEDULED_JOB_ROUTES) {
    assert(
      manifest.includes(path),
      `${path} is exempted from CRON_REGISTRY as host-scheduled but does not ` +
        "appear in scripts/ops/host-schedules.json — so nothing records what " +
        "schedules it, which is the blind spot both registries exist to close",
    );
  }
});

Deno.test("US-1561: every /api/jobs/* route in main.ts is registered (and none is stale)", async () => {
  const main = await Deno.readTextFile(MAIN_TS);
  // `\s*` after the paren is load-bearing, not defensive tidying. A mount whose
  // arguments no longer fit on one line is formatted as
  // `app.post(\n  "/api/jobs/x",\n  ...)`, and the anchored form of this
  // pattern matched neither it nor anything else about it — the route was
  // simply absent from `routed`, which reads exactly like a repo with one
  // fewer cron. /api/jobs/measurement-text-backfill shipped that way. Formatting
  // is not a place a guard may lose a route, so every scan of main.ts in this
  // file tolerates the break.
  const routed = new Set(
    [...main.matchAll(/app\.post\(\s*"(\/api\/jobs\/[^"]+)"/g)].map((m) => m[1]),
  );
  const registered = new Set(
    CRON_REGISTRY.map((d) => d.endpoint).filter((e) => e.startsWith("/api/jobs/")),
  );
  for (const path of routed) {
    if (HOST_SCHEDULED_JOB_ROUTES.has(path)) continue;
    assert(
      registered.has(path),
      `${path} is mounted in main.ts but missing from CRON_REGISTRY — ` +
        "register it (schedule, secret, category) in lib/cron-runs.ts",
    );
  }
  for (const path of registered) {
    assert(
      routed.has(path),
      `${path} is in CRON_REGISTRY but no longer mounted in main.ts — remove the stale entry`,
    );
  }
});

Deno.test("US-1561: the eBay sub-router cron endpoints are registered", async () => {
  const src = await Deno.readTextFile(EBAY_ROUTES);
  const jobPaths = new Set(
    [...src.matchAll(/"(\/jobs\/[^"]+)"/g)].map(
      (m) => `/api/flipdesk/ebay${m[1]}`,
    ),
  );
  const registered = new Set(CRON_REGISTRY.map((d) => d.endpoint));
  for (const path of jobPaths) {
    assert(
      registered.has(path),
      `${path} (flipdesk-ebay.ts) is missing from CRON_REGISTRY`,
    );
  }
});

Deno.test("US-1561: registry entries are unique and every schedule parses", () => {
  const names = CRON_REGISTRY.map((d) => d.name);
  assertEquals(new Set(names).size, names.length, "duplicate cron names");
  const endpoints = CRON_REGISTRY.map((d) => d.endpoint);
  assertEquals(new Set(endpoints).size, endpoints.length, "duplicate endpoints");
  const from = new Date("2026-01-01T00:00:00Z");
  for (const def of CRON_REGISTRY) {
    assert(
      nextCronRun(def.schedule, from) !== null,
      `${def.name}: schedule "${def.schedule}" never fires (typo?)`,
    );
  }
});

Deno.test("US-1561: COOLIFY.md and LAUNCH_CHECKLIST.md embed the generated table verbatim", async () => {
  // renderCronDocs() emits LF; normalize the docs' line endings before matching
  // so the guard is agnostic to the dev's checkout config. On a Windows checkout
  // core.autocrlf=true smudges these LF-in-git files to CRLF in the working tree,
  // which would otherwise make the LF-only marker regex miss ("markers missing").
  const expected = renderCronDocs().replace(/\r\n/g, "\n").trim();
  for (const [doc, url] of [["COOLIFY.md", COOLIFY], ["LAUNCH_CHECKLIST.md", CHECKLIST]] as const) {
    const text = (await Deno.readTextFile(url)).replace(/\r\n/g, "\n");
    const m = text.match(
      /<!-- cron-registry:start[^>]*-->\n([\s\S]*?)\n<!-- cron-registry:end -->/,
    );
    assert(m, `${doc}: cron-registry markers missing`);
    assertEquals(
      m![1].trim(),
      expected,
      `${doc}: the embedded cron table drifted from CRON_REGISTRY — regenerate with ` +
        "`deno run --allow-env --allow-net --allow-read scripts/render-cron-docs.ts` and paste between the markers",
    );
  }
});

Deno.test("CRON_SETUP.md embeds the generated Coolify setup blocks verbatim", async () => {
  const expected = renderCronSetupGuide().replace(/\r\n/g, "\n").trim();
  const text = (await Deno.readTextFile(CRON_SETUP)).replace(/\r\n/g, "\n");
  const m = text.match(/<!-- cron-setup:start[^>]*-->\n([\s\S]*?)\n<!-- cron-setup:end -->/);
  assert(m, "CRON_SETUP.md: cron-setup markers missing");
  assertEquals(
    m![1].trim(),
    expected,
    "CRON_SETUP.md drifted from CRON_REGISTRY — regenerate with " +
      "`deno run --allow-env --allow-net --allow-read scripts/render-cron-setup.ts` and paste between the markers",
  );
});

// US-2012: vault/10-ops/deploy.md tells an operator how many Coolify tasks to re-add when
// rebuilding the service. It said "16" while CRON_REGISTRY held 71 — rebuilding
// from that sentence would have silently dropped 55 crons, including the
// consignor/affiliate payout jobs and the GDPR data-retention sweep, with no
// error anywhere. The generated tables in this file never drifted; the failure
// was in hand-written prose beside them, which is exactly the gap a generation
// guard leaves open. So pin the prose too.
Deno.test("vault/10-ops/deploy.md cron count matches CRON_REGISTRY", async () => {
  const deploy = (await Deno.readTextFile(
    new URL("../../../../vault/10-ops/deploy.md", import.meta.url),
  )).replace(/\r\n/g, "\n");

  const claimed = deploy.match(/there are \*\*(\d+)\*\*/);
  if (!claimed) {
    throw new Error(
      "vault/10-ops/deploy.md no longer states a cron count in the expected form " +
        '("there are **N**"). Update this guard alongside the prose — do not ' +
        "delete it, or the count is free to drift again.",
    );
  }

  const actual = CRON_REGISTRY.length;
  if (Number(claimed[1]) !== actual) {
    throw new Error(
      `vault/10-ops/deploy.md claims ${claimed[1]} cron tasks but CRON_REGISTRY has ${actual}. ` +
        "An operator recreating the service follows that sentence, so a stale " +
        "number silently drops jobs — including payouts and GDPR retention.",
    );
  }
});

// US-2012: the launch checklist must not RE-HARDCODE a migration version.
//
// The row for "All migrations applied" once read `latest = 00132` while prod
// was at 00476. That is the worst possible failure direction for a runbook: an
// operator verifying against it mid-incident would have CONFIRMED a
// catastrophically stale DB — 345 versions behind — and moved on satisfied.
//
// It now says to ask /health/ready instead, with a "Do not hardcode a version
// here" warning. But that warning is PROSE, and prose is not enforcement: the
// next person updating this table can helpfully "fix" the row by filling in
// today's number, and nothing would object. This makes it object.
//
// Asking the system beats generating the line, too: a generated value would be
// the REPO's max migration, which is not the same as what PROD has applied —
// a distinction this repo learned the hard way when /health/ready reported an
// applied version with no corresponding file (see PENDING_MIGRATIONS.md).
Deno.test("US-2012: launch-checklist does not hardcode a migration version", async () => {
  const md = await Deno.readTextFile(
    new URL("../../../../vault/10-ops/launch-checklist.md", import.meta.url),
  );

  // Only look at the migrations row — other rows may legitimately cite a
  // version when describing history.
  const row = md.split("\n").find((l) => /All migrations applied/.test(l));
  if (!row) {
    throw new Error(
      "vault/10-ops/launch-checklist.md no longer has an 'All migrations applied' row. " +
        "If it was renamed, update this guard; if it was deleted, say so in US-2012 " +
        "rather than letting the check quietly cover nothing.",
    );
  }

  // An assertion of the form `latest = 00123` / `latest is 00123` is the shape
  // that burned us. Referring to a version while EXPLAINING the past ("this row
  // previously read `latest = 00132`") is fine and is why the pattern requires
  // the assertion form rather than banning digits outright.
  const hardcoded = row.match(/latest\s*(?:=|is)\s*`?0\d{4}`?/gi) ?? [];
  const explanatory = row.match(/previously read/i);

  if (hardcoded.length > 0 && !explanatory) {
    throw new Error(
      `vault/10-ops/launch-checklist.md hardcodes a migration version (${hardcoded.join(", ")}). ` +
        `Ask the system instead: curl /health/ready | jq .schema. A hardcoded ` +
        `version fails in the CONFIRMING direction — it tells a stressed operator ` +
        `that a stale DB is correct.`,
    );
  }
});

// ── US-2310 [P0]: every registered cron must be REACHABLE with only its secret ─
//
// The invariant the three existing guards do not cover, and the one that
// actually cost us: a cron can be registered, documented, scheduled in Coolify
// — and 401 on every single fire, forever, silently.
//
// Three entries were in exactly that state. Their endpoints sit under a
// `app.use(<prefix>, authMiddleware)` mount, and their handlers have no
// requireJobSecret branch, so the documented curl-with-job-secret invocation is
// rejected BEFORE the handler runs. They are also `recorded: false`, so they
// write no cron_runs row — which means cron-fleet-health, whose only input is
// that ledger, structurally cannot see them. A task that never runs and a task
// that runs fine look identical to every monitor we have.
//
// So this asserts the property directly from source: for each registry entry,
// either the path is outside every authMiddleware mount, or the handler that
// serves it calls requireJobSecret. Static, but the failure is static too —
// it is a mounting decision, not a runtime condition.

/** Route files that can serve a registered cron endpoint. */
const ROUTE_FILES = [
  "flipdesk-ebay.ts",
  "flipdesk-images.ts",
  "flipdesk-reconciliation.ts",
  "flipdesk-listings.ts",
  "flipdesk-google.ts",
  "flipdesk-whatnot.ts",
  "content.ts",
];

/** `app.use("<prefix>", authMiddleware)` prefixes, wildcards resolved. */
function authPrefixes(main: string): string[] {
  // ebayAuthMiddleware (US-2014 AC3) is authMiddleware plus a skip-list, so a
  // path under its wildcard is behind auth exactly as before. Matching only the
  // bare name would drop every eBay cron out of this check — silently, because
  // "not behind auth" is a `continue` here, not a failure.
  return [
    ...main.matchAll(/app\.use\("([^"]+)",\s*(?:authMiddleware|ebayAuthMiddleware)\)/g),
  ]
    .map((m) => m[1] ?? "")
    .filter(Boolean);
}

function isBehindAuth(endpoint: string, prefixes: string[]): boolean {
  return prefixes.some((p) =>
    p.endsWith("/*") ? endpoint.startsWith(p.slice(0, -1)) : endpoint === p
  );
}

/**
 * Does the handler serving `endpoint` accept a job secret?
 *
 * Matched by the route's own path suffix within its sub-router, then by
 * looking for a requireJobSecret call inside the following block. Coarse, but
 * it distinguishes exactly the two cases that matter: a handler that checks the
 * secret, and one that never had the chance.
 */
async function handlerAcceptsJobSecret(endpoint: string): Promise<boolean | null> {
  const tail = "/" + endpoint.split("/").slice(3).join("/"); // strip /api/<area>
  for (const file of ROUTE_FILES) {
    let src: string;
    try {
      src = await Deno.readTextFile(new URL(`../routes/${file}`, import.meta.url));
    } catch {
      continue;
    }
    // Try progressively shorter suffixes — sub-routers are mounted at varying
    // depths (/api/flipdesk/ebay/... vs /api/flipdesk/...).
    const parts = endpoint.split("/").filter(Boolean);
    for (let i = 2; i < parts.length; i++) {
      const suffix = "/" + parts.slice(i).join("/");
      const idx = src.indexOf(`.post("${suffix}"`);
      if (idx === -1) continue;
      const body = src.slice(idx, idx + 1200);
      return body.includes("requireJobSecret");
    }
    void tail;
  }
  return null; // handler not found in the scanned files
}

/**
 * The crons US-2310 found already broken, verified 2026-08-01. **Now empty.**
 *
 * It existed so the guard could be green TODAY while still catching the next
 * one, and it was shrink-only: fixing an entry without removing it from here
 * failed as loudly as adding a new broken cron. All three came off in US-2617
 * and it is deliberately KEPT at zero rather than deleted, because the empty
 * array is what makes a new entry an obvious regression instead of a normal
 * edit.
 *
 * THE THREE NEEDED THREE DIFFERENT ANSWERS, which is the reason to check before
 * fixing. ebay-orders-sync was DELETED, not fixed: ebay-order-backstop
 * (US-1965) was already the same half-hourly fleet sweep through
 * triggerEbaySyncForUser, so building it the loop it seemed to want would have
 * shipped a second copy of a working job. photo-archive and
 * reconciliation-sweep had no equivalent and got the loop for real
 * (routes/jobs-photo-archive.ts, routes/jobs-reconciliation-sweep.ts).
 *
 * So if a name ever lands here again: look for an existing job FIRST, then
 * write the loop. The search costs a grep and the wrong answer costs a
 * duplicate sweep against a shared rate limit.
 */
const KNOWN_UNREACHABLE_CRONS: readonly string[] = [];

Deno.test("US-2310: every registered cron endpoint is reachable with only the job secret", async () => {
  const main = await Deno.readTextFile(MAIN_TS);
  const prefixes = authPrefixes(main);
  const unreachable: string[] = [];

  for (const entry of CRON_REGISTRY) {
    // /api/jobs/* is mounted outside authMiddleware by construction and every
    // handler there gates on the secret — covered by the first guard above.
    if (entry.endpoint.startsWith("/api/jobs/")) continue;
    if (!isBehindAuth(entry.endpoint, prefixes)) continue;

    const gated = await handlerAcceptsJobSecret(entry.endpoint);
    // `null` = the handler could not be located. Do NOT pass on that: an
    // unfindable handler is exactly how this hid, so it counts as a failure and
    // the fix is to add its file to ROUTE_FILES.
    if (gated !== true) unreachable.push(`${entry.name} → ${entry.endpoint}`);
  }

  // Exact equality, both directions. A NEW broken cron fails here; so does a
  // FIXED one that was left in the list.
  assertEquals(
    unreachable.sort(),
    [...KNOWN_UNREACHABLE_CRONS].sort(),
    "A cron behind authMiddleware with no requireJobSecret branch 401s on every " +
      "fire and leaves no trace. Either add the secret branch + a tenant loop, " +
      "or — if you just fixed one — remove it from KNOWN_UNREACHABLE_CRONS.",
  );
});

// US-2617: the assumption the guard above rests on, asserted instead of stated.
//
// `handlerAcceptsJobSecret` skips /api/jobs/* with the comment "mounted outside
// authMiddleware by construction and every handler there gates on the secret".
// The first half is checked (the mounts are visible in main.ts); the second half
// was nobody's job. It is the more dangerous half: a cron behind authMiddleware
// with no secret branch merely 401s forever, while an /api/jobs/* route with no
// secret branch is callable by ANYONE on the internet, and several of them
// sweep every tenant.
Deno.test("US-2617: every /api/jobs/* handler gates on the job secret", async () => {
  const main = await Deno.readTextFile(MAIN_TS);
  // Read every jobs route with enough following text to cover an inline handler
  // or a one-line delegation to a named one.
  // Same `\s*`-after-the-paren rule as the registry scan above, and it matters
  // more here: a route this pattern cannot see is not merely unregistered, it
  // is never checked for gating on the job secret at all.
  const decls = [...main.matchAll(/app\.post\(\s*"(\/api\/jobs\/[^"]+)"\s*,/g)].map((m) => {
    // Window ends at the NEXT top-level app.* declaration, not at a fixed
    // length. A fixed 700 characters spilled into the following routes, so a
    // NEIGHBOUR's handler name satisfied this route's check — sabotaging the
    // photo-archive gate left the guard green, which is how the window was
    // found. An over-wide window is the failure mode that makes a guard look
    // like it is working.
    const rest = main.slice(m.index + m[0].length);
    const next = rest.search(/\napp\.(post|get|put|patch|delete|use|all)\(/);
    return {
      endpoint: m[1]!,
      tail: rest.slice(0, next === -1 ? Math.min(rest.length, 700) : next),
    };
  });
  assert(decls.length > 20, `expected the whole jobs family, found ${decls.length}`);

  // Handler bodies live inline in main.ts, in routes/, or in lib/ — and lib/
  // NESTS: the App Store and Play expiry sweeps are in lib/appstore/ and
  // lib/google-play/. Every narrowing of this scan produced false positives on
  // its first run (routes-only reported seven safe handlers, non-recursive
  // reported two more), and a guard that names a safe route is worse than no
  // guard, because the person who checks the first name deletes the rest.
  const handlerSrc: string[] = [];
  async function loadDir(rel: string) {
    for await (const entry of Deno.readDir(new URL(rel, import.meta.url))) {
      if (entry.isDirectory) {
        await loadDir(`${rel}${entry.name}/`);
      } else if (entry.name.endsWith(".ts")) {
        handlerSrc.push(await Deno.readTextFile(new URL(`${rel}${entry.name}`, import.meta.url)));
      }
    }
  }
  await loadDir("../routes/");
  await loadDir("../lib/");

  const ungated: string[] = [];
  for (const { endpoint, tail } of decls) {
    if (tail.includes("requireJobSecret") || tail.includes("verifySignedJobRequest")) continue;
    // Delegated: find the named handler and read ITS body. NOT anchored to a
    // "handle" prefix — watchdogHeartbeatHandler puts the word at the other
    // end, and anchoring on a naming convention nobody enforces is how that one
    // read as ungated. Any identifier called with (c) is a candidate.
    const named = [...tail.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*c\s*[,)]/g)].map((m) =>
      m[1]!
    );
    let gated = false;
    for (const fn of named) {
      for (const src of handlerSrc) {
        const idx = src.search(new RegExp(`(export\\s+)?(async\\s+)?function\\s+${fn}\\b`));
        if (idx === -1) continue;
        // Generous window: these handlers gate in their first statement, and a
        // window too small would report a false positive, which is worse here
        // than a miss — it sends someone to "fix" a route that is already safe.
        if (/requireJobSecret|verifySignedJobRequest/.test(src.slice(idx, idx + 2500))) {
          gated = true;
        }
      }
    }
    if (!gated) ungated.push(endpoint);
  }

  assertEquals(
    ungated,
    [],
    "these /api/jobs/* routes have no visible job-secret check, so they are " +
      "callable by anyone. If one is deliberately public, say so here by name " +
      "rather than deleting the assertion.",
  );
});

Deno.test("US-2617: ebay-orders-sync stays deleted, because backstop is the real one", () => {
  // A guard against RE-ADDING, which is the failure mode a shrink-only list
  // cannot cover. The entry looked like a missing feature — a half-hourly
  // orders sync that never ran — and the obvious repair is to give it a /jobs/
  // route with a tenant loop. That repair ships a SECOND fleet sweep firing the
  // same detached pulls at the same eBay rate-limit bucket on the same cadence.
  const names = CRON_REGISTRY.map((d) => d.name);
  assertEquals(
    names.includes("ebay-orders-sync"),
    false,
    "ebay-order-backstop already sweeps every active eBay connection through " +
      "triggerEbaySyncForUser every 30 minutes. If you need to change the " +
      "scheduled orders sync, change THAT job.",
  );
  // Named positively too: if the backstop is ever removed, this case must fail
  // rather than quietly become a guard protecting nothing.
  assertEquals(
    names.includes("ebay-order-backstop"),
    true,
    "the job the assertion above defers to no longer exists — deleting it " +
      "leaves the fleet with no scheduled eBay orders sync at all",
  );
});

Deno.test("US-2310: the known-broken list is not silently growing", () => {
  // Stated as its own case so the NUMBER is visible in the test output. It read
  // 3 from 2026-08-01 to 2026-08-15 — three scheduled tasks that had most
  // likely never run in production — and US-2617 took it to 0.
  //
  // Kept rather than deleted, and asserting 0 rather than "<= 3": a guard whose
  // budget has slack is a guard that permits one more. There is no longer a
  // number to spend.
  assertEquals(
    KNOWN_UNREACHABLE_CRONS.length,
    0,
    "US-2310 is closed at zero. A name here means a cron that 401s on every " +
      "fire and leaves no trace — fix it rather than listing it, and check for " +
      "an existing job before writing its tenant loop.",
  );
});

Deno.test("US-2310: an unrecorded cron is a deliberate, justified choice", async () => {
  // `recorded: false` means no cron_runs row, which means cron-fleet-health
  // cannot see the task at all. That is sometimes right (the run is recorded
  // under a different name via cronNameForPath) and sometimes how a dead task
  // stays invisible for months. Either way it should be argued, not defaulted:
  // every unrecorded entry must carry a comment saying why.
  const src = await Deno.readTextFile(new URL("../lib/cron-runs.ts", import.meta.url));
  const undocumented: string[] = [];
  for (const entry of CRON_REGISTRY) {
    if (entry.recorded !== false) continue;
    const at = src.indexOf(`name: "${entry.name}"`);
    if (at === -1) continue;
    // The comment block immediately above the entry, or an inline `healthy`
    // note on it, counts as the justification.
    const before = src.slice(Math.max(0, at - 400), at);
    const lastComment = before.lastIndexOf("//");
    const hasNote = lastComment !== -1 && !before.slice(lastComment).includes("},");
    if (!hasNote && !entry.healthy) undocumented.push(entry.name);
  }
  assertEquals(
    undocumented,
    [],
    `recorded:false with no stated reason — these are invisible to ` +
      `cron-fleet-health and nothing explains why: ${undocumented.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// US-2617: `recorded: true` is a CLAIM, and nothing checked it.
//
// The /api/jobs/* family is recorded by construction — one middleware covers the
// whole prefix. Everything else is recorded only because main.ts mounts
// recordEbayCron on that exact path, and the two facts live in different files.
//
// Flip a registry entry to `recorded: true` without the mount and the result is
// worse than leaving it alone: cron-fleet-health starts EXPECTING ledger rows
// that can never arrive, so the job reads as permanently stalled and the alert
// it raises is about the wiring rather than about the job. A stalled-forever
// entry is exactly how an on-call learns to ignore this channel.
//
// Found while closing the blind spot: three entries were flipped in one pass,
// and nothing here would have caught a missed mount.

Deno.test("US-2617: every recorded cron outside /api/jobs/* has a recorder mounted", async () => {
  const main = await Deno.readTextFile(MAIN_TS);
  const routesDir = new URL("../routes/", import.meta.url);
  const routeSources: string[] = [];
  for await (const e of Deno.readDir(routesDir)) {
    if (e.isFile && e.name.endsWith(".ts")) {
      routeSources.push(await Deno.readTextFile(new URL(e.name, routesDir)));
    }
  }
  const missing: string[] = [];

  for (const entry of CRON_REGISTRY) {
    if (!entry.recorded) continue;
    // Covered by the /api/jobs/* chokepoint middleware, by construction.
    if (entry.endpoint.startsWith("/api/jobs/")) continue;

    // Either an exact mount, or a wildcard prefix that contains it — the eBay
    // job family is mounted as /api/flipdesk/ebay/jobs/*.
    const exact = main.includes(`app.use("${entry.endpoint}", recordEbayCron)`);
    const wildcard = [...main.matchAll(/app\.use\("([^"]+)\/\*", recordEbayCron\)/g)]
      .some((m) => entry.endpoint.startsWith(`${m[1]}/`));

    // THIRD MECHANISM, and the reason this test was wrong on its first run: a
    // handler may call recordCronRun itself. drip-tick and newsletter-kickoff
    // both do, with per-branch statuses the middleware could not produce — the
    // drip tick records a 404 "no such campaign" as its own error row. A guard
    // that only knew about the mount reported both as broken, which would have
    // sent the next reader to fix two things that were already right.
    const selfRecorded = routeSources.some((src) =>
      new RegExp(`jobName:\\s*"${entry.name}"`).test(src)
    );

    if (!exact && !wildcard && !selfRecorded) {
      missing.push(`${entry.name} → ${entry.endpoint}`);
    }
  }

  assertEquals(
    missing,
    [],
    "recorded:true with no recordEbayCron mount — cron-fleet-health will expect " +
      "ledger rows that never arrive and report these as permanently stalled:\n  " +
      missing.join("\n  "),
  );
});

Deno.test("US-2617: the recorder treats the signed job request as a cron too", async () => {
  // The content, newsletter and drip schedulers accept EITHER a static
  // X-Internal-Job-Secret or a signed X-Internal-Job-Signature (HMAC, freshness,
  // single-use). Keying the recorder only on the static header would record a
  // caller using the weaker path and silently skip the same job on the stronger
  // one — a ledger gap that appears precisely when someone improves the caller.
  const main = await Deno.readTextFile(MAIN_TS);
  const guard = /const isCron = Boolean\(\s*c\.req\.header\("X-Internal-Job-Secret"\)\s*\?\?\s*c\.req\.header\("X-Internal-Job-Signature"\),?\s*\)/;
  assert(
    guard.test(main),
    "recordEbayCron must treat both internal-call shapes as a cron",
  );
});
