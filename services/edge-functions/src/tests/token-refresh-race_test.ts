// US-2322: a seller must not be disconnected because two of our own callers
// refreshed their token at the same moment.
//
// Etsy, Whatnot and Depop all rotate the refresh token — each refresh returns a
// new one. The token path was read-expiry → refresh → persist with no
// coordination, so a page load next to a cron tick sent two POSTs carrying the
// same refresh token. Where the provider invalidates the old one it honoured the
// first and answered the second with invalid_grant, which every connector
// classified as PERMANENT — is_active false, reconnect message, seller locked out
// by our own concurrency.
//
// ⚠ TWO OF THREE DOCUMENT THE INVALIDATION (US-2322 AC4, 2026-08-17). These
// three headers all used to state it of all three providers as fact. Whatnot and
// Depop both say so in their own docs; Etsy says nothing either way and is still
// open. The Depop entry was itself wrong for a day — recorded "undocumented" from
// the page whose title matched the question, while the answer sat in a How-To
// guide nobody had enumerated. Severity, not correctness: the defences below make
// the race survivable regardless and they stay for all three. See
// vault/30-platform/marketplace-connector-contract.md §4a.
//
// eBay is deliberately absent from all of this: it does not rotate its refresh
// token, so it was never exposed.

import { assertEquals } from "@std/assert";
import {
  inFlightCount,
  resetSingleFlight,
  siblingRefreshWon,
  singleFlightRefresh,
} from "../lib/token-refresh-race.ts";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

Deno.test("a sibling's fresh token means we lost a race, not the grant", () => {
  const won = siblingRefreshWon(
    { accessTokenEncrypted: "old", tokenExpiresAt: iso(30_000) },
    { accessTokenEncrypted: "new", tokenExpiresAt: iso(3_600_000) },
    NOW,
  );
  assertEquals(won, true);
});

Deno.test("an unchanged row is not a sibling refresh", () => {
  // The decisive case. Nobody rewrote the row, so our invalid_grant really does
  // mean the grant is gone and the connection SHOULD be deactivated. Treating
  // this as a race would leave a genuinely dead connection active forever,
  // silently failing every sync.
  //
  // THE TIMES HERE ARE THE TEST. An earlier version used a 30-second expiry on
  // both sides and passed even with the unchanged-row guard deleted — the
  // freshness floor rejected it for an unrelated reason, so the case proved
  // nothing about the guard it was written for. The token has HOURS left here,
  // which is the sweep's world: `refreshWithinMs` is the 24-hour horizon there,
  // so a proactive refresh can fail on a row that is nowhere near expiry, and
  // the unchanged ciphertext is then the only thing standing between a dead
  // grant and being called a race.
  assertEquals(
    siblingRefreshWon(
      { accessTokenEncrypted: "same", tokenExpiresAt: iso(3 * 3_600_000) },
      { accessTokenEncrypted: "same", tokenExpiresAt: iso(3 * 3_600_000) },
      NOW,
    ),
    false,
  );
});

Deno.test("a sibling token that is itself about to expire does not count", () => {
  // A rewritten row whose token expires in 10 seconds is not evidence of a
  // successful refresh — it is the same near-expiry state we started from, and
  // using it would hand the caller a token that dies mid-request.
  assertEquals(
    siblingRefreshWon(
      { accessTokenEncrypted: "old", tokenExpiresAt: iso(30_000) },
      { accessTokenEncrypted: "new", tokenExpiresAt: iso(10_000) },
      NOW,
    ),
    false,
  );
});

Deno.test("a missing or unreadable row is never treated as a race", () => {
  const before = { accessTokenEncrypted: "old", tokenExpiresAt: iso(30_000) };
  assertEquals(siblingRefreshWon(before, null, NOW), false);
  assertEquals(
    siblingRefreshWon(before, { accessTokenEncrypted: null, tokenExpiresAt: iso(9e6) }, NOW),
    false,
  );
  assertEquals(
    siblingRefreshWon(before, { accessTokenEncrypted: "new", tokenExpiresAt: null }, NOW),
    false,
  );
  assertEquals(
    siblingRefreshWon(before, { accessTokenEncrypted: "new", tokenExpiresAt: "not a date" }, NOW),
    false,
  );
});

Deno.test("concurrent callers for one connection share ONE refresh", async () => {
  resetSingleFlight();
  let calls = 0;
  const refresh = () =>
    new Promise<string>((resolve) => {
      calls++;
      setTimeout(() => resolve(`token-${calls}`), 5);
    });

  const [a, b, c] = await Promise.all([
    singleFlightRefresh("etsy:u1", refresh),
    singleFlightRefresh("etsy:u1", refresh),
    singleFlightRefresh("etsy:u1", refresh),
  ]);
  // One provider call, one rotated refresh token, no loser to take an
  // invalid_grant. That is the whole in-replica half of the fix.
  assertEquals(calls, 1);
  assertEquals([a, b, c], ["token-1", "token-1", "token-1"]);
  assertEquals(inFlightCount(), 0, "the entry must not outlive the refresh");
});

Deno.test("different connections are not collapsed into each other", async () => {
  resetSingleFlight();
  let calls = 0;
  const refresh = () => Promise.resolve(`t${++calls}`);
  const [a, b] = await Promise.all([
    singleFlightRefresh("etsy:u1", refresh),
    singleFlightRefresh("etsy:u2", refresh),
  ]);
  assertEquals(calls, 2);
  assertEquals(a === b, false);
});

Deno.test("a failed refresh is not cached for the next caller", async () => {
  resetSingleFlight();
  let calls = 0;
  const flaky = () => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error("503 from the provider"))
      : Promise.resolve("good");
  };

  let first = "";
  try {
    await singleFlightRefresh("etsy:u1", flaky);
  } catch (e) {
    first = e instanceof Error ? e.message : String(e);
  }
  assertEquals(first, "503 from the provider");
  // A cached rejection would turn one transient 503 into a failure for every
  // caller behind it — and on these paths a failure ends in a deactivation.
  assertEquals(await singleFlightRefresh("etsy:u1", flaky), "good");
  assertEquals(calls, 2);
});

Deno.test("all three rotating connectors are wired, and eBay is not", () => {
  // Enumerated rather than pattern-matched: eBay's absence is a DECISION (it
  // does not rotate its refresh token), and a rule broad enough to include it
  // would hide that.
  for (const file of ["etsy-client.ts", "whatnot-client.ts", "depop-client.ts"]) {
    const src = Deno.readTextFileSync(new URL(`../lib/${file}`, import.meta.url));
    assertEquals(src.includes("singleFlightRefresh("), true, `${file}: no single flight`);
    assertEquals(src.includes("siblingRefreshWon("), true, `${file}: no race check`);
  }
});

Deno.test("the race check runs BEFORE the deactivating update", () => {
  // A perfect check that runs after is_active:false has already been written is
  // no check at all. Compared by index, since both halves exist either way.
  for (const file of ["etsy-client.ts", "whatnot-client.ts", "depop-client.ts"]) {
    const src = Deno.readTextFileSync(new URL(`../lib/${file}`, import.meta.url));
    const check = src.indexOf("siblingRefreshWon(");
    const deactivate = src.indexOf("...(permanent ? { is_active: false } : {}),");
    assertEquals(check > -1 && deactivate > -1, true, `${file}: anchors missing`);
    assertEquals(check < deactivate, true, `${file}: the race check runs too late`);
  }
});

Deno.test("the proactive sweep asks for its own horizon", () => {
  // US-2322 AC3. Each sweep selects connections expiring within 24 hours and
  // used to call a getter that only refreshed inside 60 seconds — so it
  // decrypted every active connection every run and renewed nothing. Asserting
  // the horizon is PASSED is the property; asserting the sweep exists is not.
  for (const file of ["etsy-client.ts", "whatnot-client.ts", "depop-client.ts"]) {
    const src = Deno.readTextFileSync(new URL(`../lib/${file}`, import.meta.url));
    assertEquals(
      /AccessToken\(userId, \{ refreshWithinMs: horizonMs \}\)/.test(src),
      true,
      `${file}: the sweep still uses the default 60s window`,
    );
    // And the getter must actually honour it rather than keeping the constant.
    assertEquals(
      /expiresAt - Date\.now\(\) < refreshWithinMs/.test(src),
      true,
      `${file}: the threshold is accepted but not used`,
    );
  }
});
