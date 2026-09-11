// US-3112: prove we stop CALLING the eBay APIs this keyset cannot use.
//
// THE DECAY THIS EXISTS TO STOP, and why a source scan would not have caught it.
//
// Two eBay endpoints were asked forever on a keyset that can never answer them:
// /commerce/identity/v1/user (needs commerce.identity.readonly, deliberately not
// requested) on every token refresh, and payment_dispute_summary (needs
// sell.payment.dispute, which one prod connection's token predates) every
// fifteen minutes. Both failures were caught and turned into a null or a log
// line, so from anywhere outside the process a doomed call and no call at all
// look identical. The difference is only visible in eBay's own logs, which is
// exactly where the Application Growth Check reads it.
//
// US-3112 closed both, and until this file neither had a test. A guard that
// scanned for `if (!isIdentityScopeAvailable()) return null;` would pin the
// SPELLING of the gate and say nothing about its answer. An inverted condition,
// a gate moved below the fetch, and a second caller that skips it entirely all
// read to a scan as correct code. So this asserts the property that matters,
// and the only one eBay can see: HOW MANY REQUESTS LEFT THE PROCESS.
//
//   deno test --allow-env --allow-net src/tests/ebay-unlicensed-scope_test.ts

import "./_env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getUserIdentityFromToken,
  isIdentityScopeAvailable,
} from "../lib/ebay-client.ts";
import { pollMarketplaceEventsForUser } from "../lib/marketplace-event-poll.ts";
import type { MarketplacePollDeps } from "../lib/marketplace-event-poll.ts";

const BASE_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

const IDENTITY_SCOPE =
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly";

const realFetch = globalThis.fetch;

/**
 * Run one identity lookup under a given scope list and report BOTH what came
 * back and every URL that left the process.
 *
 * The URL list is the assertion that matters. A test that only checked the
 * return value would pass against a version that calls eBay, gets a 403 and
 * returns null anyway, which is precisely the behaviour this story removed.
 */
async function identityLookupUnder(
  scopes: string,
  respondWith: () => Response,
): Promise<{ result: Awaited<ReturnType<typeof getUserIdentityFromToken>>; urls: string[] }> {
  const previous = Deno.env.get("EBAY_SCOPES");
  const urls: string[] = [];
  Deno.env.set("EBAY_SCOPES", scopes);
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return Promise.resolve(respondWith());
  }) as typeof fetch;
  try {
    // One attempt, not three: the retry loop is US-472's and is not what this
    // file is about, and a three-attempt default would make "how many requests"
    // ambiguous on the enabled path.
    const result = await getUserIdentityFromToken("token-under-test", 1);
    return { result, urls };
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) Deno.env.delete("EBAY_SCOPES");
    else Deno.env.set("EBAY_SCOPES", previous);
  }
}

Deno.test("the scope gate reads the scope list it is asked about", () => {
  const previous = Deno.env.get("EBAY_SCOPES");
  try {
    Deno.env.set("EBAY_SCOPES", BASE_SCOPES);
    assertEquals(isIdentityScopeAvailable(), false);
    Deno.env.set("EBAY_SCOPES", `${BASE_SCOPES} ${IDENTITY_SCOPE}`);
    assertEquals(isIdentityScopeAvailable(), true);
  } finally {
    if (previous === undefined) Deno.env.delete("EBAY_SCOPES");
    else Deno.env.set("EBAY_SCOPES", previous);
  }
});

Deno.test("without commerce.identity.readonly, eBay is never asked", async () => {
  const { result, urls } = await identityLookupUnder(
    BASE_SCOPES,
    () => new Response(JSON.stringify({ username: "seller", userId: "1" }), { status: 200 }),
  );
  // The stub would have answered 200, so a null here can only mean the gate
  // returned before the fetch, never that the call failed.
  assertEquals(result, null);
  assertEquals(urls, [], `no request may leave the process; saw: ${urls.join(", ")}`);
});

Deno.test("re-adding the scope re-enables the lookup with no other change", async () => {
  const { result, urls } = await identityLookupUnder(
    `${BASE_SCOPES} ${IDENTITY_SCOPE}`,
    () =>
      new Response(JSON.stringify({ username: "seller", userId: "ebay-user-1" }), {
        status: 200,
      }),
  );
  assertEquals(result, { username: "seller", externalAccountId: "ebay-user-1" });
  assertEquals(urls.length, 1, `exactly one request; saw: ${urls.join(", ")}`);
  assertStringIncludes(urls[0], "/commerce/identity/v1/user");
});

// -- the payment-dispute read ------------------------------------------------

interface DisputeProbe {
  asked: number;
  flagWrites: Array<{ userId: string; denied: boolean }>;
  errors: string[];
}

/**
 * Poll one owner with every source but disputes stubbed empty, and report how
 * many times the dispute read was attempted plus every write to the
 * disputes_access_denied flag.
 */
async function pollWithDisputes(
  opts: {
    /** Omitted entirely = no seam at all, which must mean "ask eBay". */
    denied?: boolean;
    fetchDisputes: () => Promise<unknown[]>;
  },
): Promise<DisputeProbe> {
  const probe: DisputeProbe = { asked: 0, flagWrites: [], errors: [] };
  const deps: MarketplacePollDeps = {
    fetchOffers: () => Promise.resolve([]),
    fetchReturns: () => Promise.resolve([]),
    fetchDisputes: () => {
      probe.asked += 1;
      return opts.fetchDisputes() as ReturnType<MarketplacePollDeps["fetchDisputes"]>;
    },
    disputesDenied: opts.denied === undefined
      ? undefined
      : () => Promise.resolve(opts.denied === true),
    setDisputesDenied: (userId, denied) => {
      probe.flagWrites.push({ userId, denied });
      return Promise.resolve();
    },
    claim: () => Promise.resolve(false),
    notifyOffer: () => Promise.resolve(),
    notifyReturn: () => Promise.resolve(),
    notifyDispute: () => Promise.resolve(),
  };
  const result = await pollMarketplaceEventsForUser("owner-1", deps);
  probe.errors = result.errors;
  return probe;
}

/** An eBay refusal shaped the three ways isDisputesAccessDenied recognises. */
function refusal(kind: "status" | "errorId" | "message"): Error {
  if (kind === "status") {
    const err = new Error("eBay payment_dispute_summary failed (403)") as Error & {
      status: number;
    };
    err.status = 403;
    return err;
  }
  if (kind === "errorId") {
    const err = new Error("eBay refused") as Error & { ebayErrorIds: number[] };
    err.ebayErrorIds = [1100];
    return err;
  }
  return new Error("Insufficient permissions to fulfill the request.");
}

Deno.test("a connection already flagged denied is not asked again", async () => {
  const probe = await pollWithDisputes({
    denied: true,
    fetchDisputes: () => Promise.resolve([]),
  });
  assertEquals(probe.asked, 0, "the dispute read must not be attempted");
  assertEquals(probe.flagWrites, [], "a known-denied tick writes nothing");
  // And it says nothing in the run ledger: ninety-six copies a day of a fact
  // nobody can act on buries the failures that ARE new.
  assertEquals(
    probe.errors.filter((e) => e.startsWith("disputes")),
    [],
  );
});

for (const kind of ["status", "errorId", "message"] as const) {
  Deno.test(`an insufficient-scope refusal (${kind}) sets the flag once`, async () => {
    const probe = await pollWithDisputes({
      denied: false,
      fetchDisputes: () => Promise.reject(refusal(kind)),
    });
    assertEquals(probe.asked, 1);
    assertEquals(probe.flagWrites, [{ userId: "owner-1", denied: true }]);
    const said = probe.errors.filter((e) => e.startsWith("disputes:"));
    assertEquals(said.length, 1, "the FIRST refusal is reported");
    assertStringIncludes(said[0], "sell.payment.dispute");
    assertStringIncludes(said[0], "reconnect");
  });
}

Deno.test("an ordinary failure never flags the connection denied", async () => {
  // The 404 eBay sends for "this account has no disputes" is already an empty
  // list by the time it reaches here, so the shape to guard is the OTHER one: a
  // blip must not switch dispute polling off for a seller who has the scope.
  const probe = await pollWithDisputes({
    denied: false,
    fetchDisputes: () => Promise.reject(new Error("eBay is having a moment (503)")),
  });
  assertEquals(probe.asked, 1);
  assertEquals(
    probe.flagWrites.filter((w) => w.denied),
    [],
    "a transient failure must not deny",
  );
  assert(probe.errors.some((e) => e.startsWith("disputes:")));
});

Deno.test("access working again clears the flag", async () => {
  const probe = await pollWithDisputes({
    denied: false,
    fetchDisputes: () => Promise.resolve([]),
  });
  assertEquals(probe.asked, 1);
  assertEquals(probe.flagWrites, [{ userId: "owner-1", denied: false }]);
});

Deno.test("no flag seam at all still asks eBay", async () => {
  // The fail-open direction, at the seam. Silence about a seller's disputes is
  // the worse failure, they have days to respond and eBay decides for them if
  // they do not, so every way of not getting an answer out of the flag has to
  // land on "ask". The real reader (readDisputesDenied) returns false on a
  // database error for the same reason; this pins the seam's own default, which
  // is the half a test can reach without a database.
  const probe = await pollWithDisputes({ fetchDisputes: () => Promise.resolve([]) });
  assertEquals(probe.asked, 1, "an absent flag must never mean 'stay silent'");
});
