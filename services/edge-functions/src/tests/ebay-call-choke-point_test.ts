// US-3042 AC5: "every eBay HTTP call is counted through one choke point".
//
// WHAT WAS MISSING. ebay-call-log_test.ts tests the three pure functions that
// decide what a row MEANS. Nothing tested the two properties the criterion is
// actually about, and both are properties eBay can check against its own logs
// while we cannot:
//
//   1. the choke point counts a call it never got an answer to;
//   2. nothing reaches an eBay host WITHOUT going through the choke point.
//
// The second one was already false when this file was written. lib/ebay-
// notification-verify.ts fetched eBay's public key for a `kid` with a bare
// fetchWithTimeout, so every inbound-notification signature check that missed
// the key cache was an uncounted call against eBay's quota, on the one code
// path eBay itself triggers. It read as fine in review: the call is bounded,
// cached, and its comment says so. Nothing about it looked like a gap, which is
// the argument for a scan rather than another reading.

import "./_env.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { countedEbayFetch } from "../lib/ebay-client.ts";
import {
  pendingEbayCallBuckets,
  resetEbayCallLog,
} from "../lib/ebay-call-log.ts";

// --- 1. the choke point counts, including what it could not ask ---

const realFetch = globalThis.fetch;

function stubFetch(impl: () => Promise<Response>): void {
  (globalThis as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
}

function restoreFetch(): void {
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
}

Deno.test("countedEbayFetch counts a successful call", async () => {
  resetEbayCallLog();
  stubFetch(() => Promise.resolve(new Response("{}", { status: 200 })));
  try {
    assertEquals(pendingEbayCallBuckets(), 0, "buffer did not start empty");
    const res = await countedEbayFetch(
      "https://api.ebay.com/sell/inventory/v1/offer?sku=ABC",
    );
    // Drain rather than cancel: fetchWithTimeout re-streams the body to hold
    // its deadline over the read, so the stream is already locked.
    await res.text();
    assertEquals(pendingEbayCallBuckets(), 1);
  } finally {
    restoreFetch();
    resetEbayCallLog();
  }
});

Deno.test("countedEbayFetch counts a 429 in its own bucket", async () => {
  // 429 is the whole reason the table exists: it is the status that says we are
  // at the ceiling. Folded into the 2xx bucket it would be invisible.
  resetEbayCallLog();
  let status = 200;
  stubFetch(() => Promise.resolve(new Response("{}", { status })));
  try {
    const url = "https://api.ebay.com/sell/inventory/v1/offer?sku=ABC";
    await (await countedEbayFetch(url)).text();
    assertEquals(pendingEbayCallBuckets(), 1);
    status = 429;
    await (await countedEbayFetch(url)).text();
    assertEquals(
      pendingEbayCallBuckets(),
      2,
      "the 429 landed in the same bucket as the 200",
    );
  } finally {
    restoreFetch();
    resetEbayCallLog();
  }
});

Deno.test("countedEbayFetch counts a call that never got a response", async () => {
  // THE PROPERTY THE `finally` EXISTS FOR. A timeout or a connection reset is a
  // request that left this process. Counting only what came back would report a
  // number lower than eBay's for exactly the reason - trouble - that makes the
  // comparison worth having. The error must still propagate: a counter that
  // swallows a failure is worse than no counter.
  resetEbayCallLog();
  stubFetch(() => Promise.reject(new Error("connection reset")));
  try {
    await assertRejects(
      () => countedEbayFetch("https://api.ebay.com/sell/inventory/v1/offer"),
      Error,
      "connection reset",
    );
    assertEquals(
      pendingEbayCallBuckets(),
      1,
      "a request that got no answer was not counted",
    );
  } finally {
    restoreFetch();
    resetEbayCallLog();
  }
});

// --- 2. nothing reaches eBay around the choke point ---

const SRC = new URL("../", import.meta.url);

/**
 * The raw network primitives. Anything here is a call that leaves the process
 * without passing recordEbayCall; the counted wrappers (countedEbayFetch,
 * ebayFetch, ebayResilientFetch) are what a caller is supposed to reach for.
 */
const RAW_CALLS = ["fetchWithTimeout(", "globalThis.fetch(", "await fetch("];

/**
 * Tokens that mean "this URL is an eBay host". apiHost/apizHost/authHost are
 * ebay-client's own helpers; tradingHost is ebay-trading's; the literals catch
 * a URL written out by hand.
 */
const EBAY_HOSTS = [
  "apiHost()",
  "apizHost()",
  "authHost()",
  "tradingHost()",
  "api.ebay.com",
  "apiz.ebay.com",
  "auth.ebay.com",
];

/**
 * lib/ebay-client.ts holds countedEbayFetch, which IS the choke point and is
 * therefore the one legitimate raw fetch in the service. Nothing else may be
 * added here without a reason a reviewer would accept.
 */
const CHOKE_POINT = "lib/ebay-client.ts";

/** Comments argue about calls; only code makes them. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/**
 * The argument text of every raw network call in `code`, read by matching
 * parentheses from the opening one. Substring matching would run past the call
 * into whatever followed it and flag a neighbour's eBay URL.
 */
function rawCallArgs(code: string): string[] {
  const out: string[] = [];
  for (const marker of RAW_CALLS) {
    let from = 0;
    for (;;) {
      const at = code.indexOf(marker, from);
      if (at === -1) break;
      from = at + marker.length;
      let depth = 0;
      let end = at + marker.length - 1;
      for (let i = end; i < code.length; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      out.push(code.slice(at, end + 1));
    }
  }
  return out;
}

function reachesEbay(args: string): boolean {
  return EBAY_HOSTS.some((h) => args.includes(h));
}

async function edgeSources(): Promise<Array<{ rel: string; code: string }>> {
  const out: Array<{ rel: string; code: string }> = [];
  for (const dir of ["lib", "routes"]) {
    for await (const entry of Deno.readDir(new URL(`${dir}/`, SRC))) {
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      const rel = `${dir}/${entry.name}`;
      const raw = await Deno.readTextFile(new URL(rel, SRC));
      out.push({ rel, code: codeOnly(raw) });
    }
  }
  return out;
}

Deno.test("the scan can tell a bypass from a counted call", () => {
  // Proven on fixtures before it is believed on the tree. Every assertion below
  // rests on this pair, and a detector that matches nothing reports a clean
  // codebase in exactly the same words as a clean codebase.
  const bypass = rawCallArgs(
    'res = await fetchWithTimeout(`${apiHost()}/commerce/notification/v1/public_key/${kid}`, {}, 5000);',
  );
  assertEquals(bypass.length, 1, "the detector missed a raw call");
  assert(reachesEbay(bypass[0]!), "the detector missed an eBay host in a raw call");

  const counted = rawCallArgs(
    'res = await countedEbayFetch(`${apiHost()}/sell/inventory/v1/offer`, {}, 5000);',
  );
  assertEquals(counted.length, 0, "a counted call was reported as a raw one");

  // A raw call to something that is not eBay is fine and must not be flagged.
  const ours = rawCallArgs('await fetchWithTimeout(url, { method: "HEAD" }, 5000);');
  assertEquals(ours.length, 1);
  assertEquals(reachesEbay(ours[0]!), false);

  // A comment describing a bypass is not a bypass.
  assertEquals(
    rawCallArgs(codeOnly("// was: await fetchWithTimeout(`${apiHost()}/x`)")).length,
    0,
  );
});

Deno.test("every eBay call in the service goes through the choke point", async () => {
  const files = await edgeSources();
  assert(files.length > 50, `only ${files.length} edge sources scanned`);

  // Floor, and a known positive: the choke point itself must still contain the
  // one raw fetch. If it stops doing so the primitive was renamed and this scan
  // is looking for a string that no longer exists anywhere.
  const chokePoint = files.find((f) => f.rel === CHOKE_POINT);
  assert(chokePoint, `${CHOKE_POINT} was not scanned`);
  assert(
    rawCallArgs(chokePoint.code).length > 0,
    `${CHOKE_POINT} makes no raw fetch - the primitive was renamed and this ` +
      `scan now matches nothing, anywhere`,
  );

  const offenders: string[] = [];
  for (const { rel, code } of files) {
    if (rel === CHOKE_POINT) continue;
    for (const args of rawCallArgs(code)) {
      if (reachesEbay(args)) {
        offenders.push(`${rel}: ${args.replace(/\s+/g, " ").slice(0, 140)}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    `these reach an eBay host without going through countedEbayFetch, so they ` +
      `never appear in ebay_api_call_daily and the growth-check number is an ` +
      `undercount:\n${offenders.join("\n")}`,
  );
});
