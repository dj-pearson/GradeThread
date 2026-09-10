// US-3296: the extension's account token expires after 30 days and nothing
// renewed it.
//
// THE FAILURE THESE GUARD. mintExtensionToken issues 30 days. The only door to
// it was POST /api/buyer/extension-token, reached from a button on
// /connect-extension that a seller presses once, ever. Nothing re-minted: no
// refresh on expiry, no re-handoff on sign-in, no warning as the end
// approached. So every connected seller silently dropped to the ANONYMOUS
// entitlements about a month after connecting, and every Lister action failed
// from then on. US-3295 made that failure say better words; it did not stop it.
//
// The reason it was invisible for so long is one line: verifyExtensionToken
// answers `null` for "no token was sent" and `null` for "we minted this
// ourselves and it lapsed yesterday". Two situations with opposite fixes,
// reported as one value, all the way up to a composer that told a Business
// seller to buy a plan.
//
// These are pure tests. The clock, not the database, is the whole subject, so
// nothing here needs a stack: decideExtensionTokenRenewal owns the judgement
// and the route owns only the account re-check and the mint.

import { assert, assertEquals } from "@std/assert";
import {
  decideExtensionTokenRenewal,
  EXTENSION_TOKEN_RENEW_GRACE_SECONDS,
  EXTENSION_TOKEN_RENEW_WITHIN_SECONDS,
  EXTENSION_TOKEN_TTL_SECONDS,
  extensionConnectionAdvice,
  inspectExtensionToken,
  isExtensionTokenNearingExpiry,
  isRenewableExtensionToken,
  mintExtensionToken,
  verifyExtensionToken,
} from "../lib/extension-token.ts";

Deno.env.set("EXTENSION_TOKEN_SECRET", "test-secret-for-extension-token-renewal");

const USER = "8b1d5b0e-3c2a-4f7e-9a11-2c9d0f4e6a55";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mint a token as if the clock had said `mintedAtMs`.
 *
 * mintExtensionToken reads Date.now() directly, which is right for production
 * and useless for the one case this story is about. Swapping the clock for the
 * duration of the mint produces a REAL token — same secret, same HMAC, same
 * three segments — that simply happens to be old.
 */
async function mintAt(userId: string, mintedAtMs: number): Promise<string> {
  const realNow = Date.now;
  Date.now = () => mintedAtMs;
  try {
    const { token } = await mintExtensionToken(userId);
    return token;
  } finally {
    Date.now = realNow;
  }
}

// ── AC5 ──────────────────────────────────────────────────────────────────
Deno.test("a token minted 31 days ago resolves to reconnect, never to a plan upgrade", async () => {
  const now = Date.now();
  const token = await mintAt(USER, now - 31 * DAY_MS);

  // 1. It IS expired, and it is expired in a way the server can name. Before
  //    this story the only available answer was `null`, which is also the
  //    answer for a browser that has never been connected at all.
  const seen = await inspectExtensionToken(token, now);
  assertEquals(seen.status, "expired");
  assertEquals(seen.userId, USER);
  assert(seen.expiresAt !== null && seen.expiresAt * 1000 < now);

  // 2. The word the seller is shown is "reconnect" — not "connect" (they did
  //    connect, a month ago) and emphatically not "upgrade".
  assertEquals(extensionConnectionAdvice(seen.status), "reconnect");
  assertEquals(extensionConnectionAdvice("absent"), "connect");

  // 3. And the extension can dig itself out: 31 days is one day past a 30-day
  //    TTL, comfortably inside the renewal grace, so the next wake mints a
  //    fresh token instead of demanding a button press.
  const decision = decideExtensionTokenRenewal(seen, now);
  assertEquals(decision.outcome, "renew");
  assertEquals(decision.outcome === "renew" ? decision.userId : null, USER);

  // 4. The gate itself is unchanged: an expired token still authenticates
  //    NOTHING. Renewal is a separate door, not a relaxation of this one.
  assertEquals(await verifyExtensionToken(token), null);
});

Deno.test("never-connected and expired are different answers", async () => {
  const now = Date.now();
  const absent = await inspectExtensionToken(null, now);
  assertEquals(absent.status, "absent");
  assertEquals(absent.userId, null);
  assertEquals(decideExtensionTokenRenewal(absent, now).outcome, "connect");

  const expired = await inspectExtensionToken(await mintAt(USER, now - 31 * DAY_MS), now);
  assertEquals(expired.status, "expired");
  assertEquals(decideExtensionTokenRenewal(expired, now).outcome, "renew");

  // The distinction is the story. If these two ever collapse again, the
  // composer starts telling connected sellers to connect.
  assert(absent.status !== expired.status);
});

Deno.test("a forged or malformed token is a reconnect, and is never renewable", async () => {
  const now = Date.now();
  const good = await mintAt(USER, now - 31 * DAY_MS);
  const parts = good.split(".");
  const flipped = parts[2]![0] === "a" ? "b" : "a";
  const forged = `${parts[0]}.${parts[1]}.${flipped}${parts[2]!.slice(1)}`;

  for (const bad of [forged, "not-a-token", "a.b", `${USER}.abc.def`]) {
    const seen = await inspectExtensionToken(bad, now);
    assertEquals(seen.status, "invalid", `expected invalid for ${bad}`);
    assertEquals(seen.userId, null, "an unverified token must never name an account");
    assertEquals(seen.expiresAt, null);
    assertEquals(isRenewableExtensionToken(seen, now), false);
    assertEquals(decideExtensionTokenRenewal(seen, now).outcome, "reconnect");
    assertEquals(extensionConnectionAdvice(seen.status), "reconnect");
  }
});

Deno.test("the grace window has a far edge", async () => {
  const now = Date.now();
  const graceDays = EXTENSION_TOKEN_RENEW_GRACE_SECONDS / 86400;
  const ttlDays = EXTENSION_TOKEN_TTL_SECONDS / 86400;

  // A laptop shut for a month past expiry still recovers on its next wake.
  const insideGrace = await inspectExtensionToken(
    await mintAt(USER, now - (ttlDays + graceDays - 1) * DAY_MS),
    now,
  );
  assertEquals(insideGrace.status, "expired");
  assertEquals(decideExtensionTokenRenewal(insideGrace, now).outcome, "renew");

  // One shut for longer than that does not. The grace is a sliding renewal, not
  // an eternal one -- a token that leaked and was never used must eventually
  // stop being worth anything.
  const pastGrace = await inspectExtensionToken(
    await mintAt(USER, now - (ttlDays + graceDays + 1) * DAY_MS),
    now,
  );
  assertEquals(pastGrace.status, "expired");
  assertEquals(isRenewableExtensionToken(pastGrace, now), false);
  assertEquals(decideExtensionTokenRenewal(pastGrace, now).outcome, "reconnect");
});

Deno.test("a healthy token renews EARLY, before anything has broken", async () => {
  const now = Date.now();

  // Freshly minted: nothing to do.
  const fresh = await inspectExtensionToken(await mintAt(USER, now), now);
  assertEquals(fresh.status, "valid");
  assertEquals(isExtensionTokenNearingExpiry(fresh.expiresAt, now), false);

  // Inside the renewal window: replace it now, while the old one still works.
  // Renewing only at the moment of failure would mean every renewal happens
  // during an outage the seller is already looking at.
  const windowDays = EXTENSION_TOKEN_RENEW_WITHIN_SECONDS / 86400;
  const ttlDays = EXTENSION_TOKEN_TTL_SECONDS / 86400;
  const soon = await inspectExtensionToken(
    await mintAt(USER, now - (ttlDays - windowDays + 1) * DAY_MS),
    now,
  );
  assertEquals(soon.status, "valid");
  assertEquals(isExtensionTokenNearingExpiry(soon.expiresAt, now), true);
  assertEquals(decideExtensionTokenRenewal(soon, now).outcome, "renew");

  // An unknown expiry counts as "nearing" -- an install that cannot say when its
  // token dies should ask for a new one, not assume it has months left.
  assertEquals(isExtensionTokenNearingExpiry(null, now), true);
  assertEquals(isExtensionTokenNearingExpiry(Number.NaN, now), true);
});

// ── the renewal route is actually wired, and takes nothing from the body ──
Deno.test("the renewal route exists on the extension's own mount", () => {
  const src = Deno.readTextFileSync(new URL("../routes/public-grading.ts", import.meta.url));
  assert(
    src.includes('publicGradingRoutes.post("/extension-token/renew"'),
    "POST /api/grading/public/extension-token/renew is the only door an EXPIRED " +
      "token can knock on -- extensionOrUserAuthMiddleware 401s it before a " +
      "handler runs, which is precisely the request that must succeed.",
  );
  assert(
    src.includes("decideExtensionTokenRenewal(seen)"),
    "the route must use the shared decision, or the 31-day case above proves nothing about it",
  );
});

Deno.test("the renewal route names the account from the signature alone (US-268)", () => {
  const src = Deno.readTextFileSync(new URL("../routes/public-grading.ts", import.meta.url));
  const start = src.indexOf('publicGradingRoutes.post("/extension-token/renew"');
  assert(start > 0);
  const body = src.slice(start, start + 3000);
  const end = body.indexOf("\n});");
  const handler = end > 0 ? body.slice(0, end) : body;

  // No request body is read at all, so there is no id to forge. The only
  // account this can ever mint for is the one the HMAC verified.
  assert(!handler.includes("c.req.json"), "the renewal must not read a request body");
  assert(!handler.includes("c.req.param"), "the renewal must not read a path param");
  assert(!handler.includes("c.req.query"), "the renewal must not read a query param");
  assert(
    handler.includes("getUserById(decision.userId)"),
    "the account re-check must use the signed id, never anything from the request",
  );
  assert(
    handler.includes("mintExtensionToken(decision.userId)"),
    "the fresh token must be minted for the signed id",
  );
  assert(
    handler.includes("email_confirmed_at"),
    "a renewal must make the same account checks the auth middleware makes -- " +
      "a token must not outlive the account it names",
  );
});

Deno.test("the entitlements answer reports the token's state", () => {
  const src = Deno.readTextFileSync(new URL("../routes/public-grading.ts", import.meta.url));
  const start = src.indexOf('publicGradingRoutes.get("/entitlements"');
  assert(start > 0);
  const handler = src.slice(start, src.indexOf("\n});", start));

  assert(
    handler.includes("inspectExtensionToken("),
    "/entitlements must inspect rather than verify, or an expired token is " +
      "indistinguishable from never having connected",
  );
  // The flags ride alongside the entitlements and change no gate: the anonymous
  // payload is still the anonymous payload.
  assert(handler.includes("ANONYMOUS_EXTENSION_ENTITLEMENTS"));
  assert(handler.includes("tokenFacts"));
});
