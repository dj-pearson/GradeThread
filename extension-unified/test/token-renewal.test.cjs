// GradeThread unified extension — account-token lifecycle (US-3296).
//
// THE FAILURE. mintExtensionToken issues a 30-day token and the only place it
// was ever handed over was /connect-extension, from a button a seller presses
// once. Nothing re-minted it: no refresh on expiry, no re-handoff on sign-in,
// no warning as the end approached. So every connected seller silently dropped
// to the ANONYMOUS entitlements about a month after connecting, and every
// Lister action failed from then on.
//
// What made it invisible: an expired token and no token at all produce the
// SAME server answer, because an expired token authenticates nothing. So the
// extension reported a lapsed connection as "never connected" — and before
// US-3295, as "buy a plan", to sellers already on Business.
//
// Loads registry.js with an injected `self` (same trick as registry.test.cjs)
// so no ESM/require friction. Zero-dependency: throws on mismatch.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadRegistry() {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "registry.js"), "utf8");
  const selfObj = {};

  new Function("self", src)(selfObj);
  assert.ok(selfObj.GT_REGISTRY, "registry.js must assign self.GT_REGISTRY");
  return selfObj.GT_REGISTRY;
}

const R = loadRegistry();
const BG = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");
const POPUP = fs.readFileSync(path.resolve(__dirname, "..", "popup.js"), "utf8");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const USER = "8b1d5b0e-3c2a-4f7e-9a11-2c9d0f4e6a55";

/** A real token shape, minted `daysAgo` ago with the production 30-day TTL. */
function tokenMintedDaysAgo(daysAgo) {
  const expiresSec = Math.floor((NOW - daysAgo * DAY + 30 * DAY) / 1000);
  return USER + "." + expiresSec + ".deadbeef";
}

// ── AC5: 31 days old resolves to reconnect, not to a plan upgrade ──────────
{
  const token = tokenMintedDaysAgo(31);
  const state = R.tokenStateFrom(R.tokenExpiryMs(token), NOW);
  assert.strictEqual(state, "expired", "a 31-day-old 30-day token is expired");

  // The account is on Business and paying. The server cannot say so, because an
  // expired token authenticates nothing — so the entitlements come back
  // anonymous, exactly as they do for a browser that never connected.
  const caps = R.resolveCapabilities(R.ANONYMOUS_ENTITLEMENTS, {}, state);
  assert.strictEqual(caps.lister, false, "the Lister is closed either way");
  assert.strictEqual(caps.authenticated, false, "the server cannot see the account");
  assert.strictEqual(caps.tokenStatus, "expired");

  const reason = R.listerBlockReason(caps);
  assert.strictEqual(
    reason,
    "reconnect",
    "a 31-day-old token must resolve to RECONNECT. 'plan' is the answer that " +
      "sent a Business seller to /pricing (US-3295); 'signin' is the answer " +
      "that tells someone who connected a month ago to connect.",
  );
  assert.notStrictEqual(reason, "plan");
  assert.notStrictEqual(reason, "signin");

  // And it is renewable, so the extension digs itself out without the seller.
  assert.strictEqual(R.shouldRenewToken(state), true);
}

// ── the four states are actually four ──────────────────────────────────────
{
  assert.strictEqual(R.tokenStateFrom(null, NOW), "none", "nothing stored");
  assert.strictEqual(R.tokenStateFrom(0, NOW), "none");
  assert.strictEqual(R.tokenStateFrom("nonsense", NOW), "none");
  assert.strictEqual(R.tokenStateFrom(NOW + 20 * DAY, NOW), "active");
  assert.strictEqual(R.tokenStateFrom(NOW + 6 * DAY, NOW), "expiring");
  assert.strictEqual(R.tokenStateFrom(NOW + 8 * DAY, NOW), "active");
  assert.strictEqual(R.tokenStateFrom(NOW - 1, NOW), "expired");
  assert.strictEqual(R.tokenStateFrom(NOW, NOW), "expired", "the boundary is dead, not alive");

  // The renewal window matches the edge's EXTENSION_TOKEN_RENEW_WITHIN_SECONDS.
  assert.strictEqual(R.TOKEN_RENEW_WITHIN_MS, 7 * DAY);
}

// ── never-connected and expired must not collapse again ────────────────────
{
  const never = R.resolveCapabilities(R.ANONYMOUS_ENTITLEMENTS, {}, "none");
  const lapsed = R.resolveCapabilities(R.ANONYMOUS_ENTITLEMENTS, {}, "expired");

  // Identical entitlements. The ONLY thing telling them apart is the token
  // state the extension keeps for itself, which is the whole point.
  assert.strictEqual(never.authenticated, lapsed.authenticated);
  assert.strictEqual(never.sellerEnabled, lapsed.sellerEnabled);
  assert.strictEqual(R.listerBlockReason(never), "signin");
  assert.strictEqual(R.listerBlockReason(lapsed), "reconnect");
}

// ── an expiring token is not a broken one ──────────────────────────────────
{
  // Still valid, so nothing is blocked. It just gets replaced early, while the
  // old one still works -- renewing only at the moment of failure would mean
  // every renewal happens during an outage the seller is already looking at.
  const caps = R.resolveCapabilities(
    { authenticated: true, sellerEnabled: true, flipdeskPlan: "business", buyerPlan: "guard" },
    {},
    "expiring",
  );
  assert.strictEqual(caps.lister, true);
  assert.strictEqual(R.listerBlockReason(caps), null, "an expiring token blocks nothing");
  assert.strictEqual(R.shouldRenewToken("expiring"), true);
  assert.strictEqual(R.shouldRenewToken("active"), false);
  assert.strictEqual(R.shouldRenewToken("none"), false, "nothing to renew");
}

// ── the old two-way answer is unchanged where it was right ─────────────────
{
  const free = R.resolveCapabilities(
    { authenticated: true, sellerEnabled: false, flipdeskPlan: "free" },
    {},
    "active",
  );
  assert.strictEqual(R.listerBlockReason(free), "plan", "a connected free account is still a plan problem");

  // No third argument at all: every existing caller keeps working and reads as
  // "no token", which is what an install with no token has always been.
  assert.strictEqual(R.resolveCapabilities(R.ANONYMOUS_ENTITLEMENTS, {}).tokenStatus, "none");
  assert.strictEqual(R.listerBlockReason(R.resolveCapabilities(R.ANONYMOUS_ENTITLEMENTS, {})), "signin");
  assert.strictEqual(R.normalizeTokenState("banana"), "none", "an unknown state is not trusted");
}

// ── tokenExpiryMs reads, and never trusts ──────────────────────────────────
{
  assert.strictEqual(R.tokenExpiryMs(USER + ".1790000000.sig"), 1790000000 * 1000);
  assert.strictEqual(R.tokenExpiryMs(null), null);
  assert.strictEqual(R.tokenExpiryMs("two.parts"), null);
  assert.strictEqual(R.tokenExpiryMs(USER + ".notanumber.sig"), null);
  assert.strictEqual(R.tokenExpiryMs(USER + ".-5.sig"), null);
}

// ── the worker actually wires it ───────────────────────────────────────────
{
  assert.ok(
    /const TOKEN_RENEW_ENDPOINT =/.test(BG),
    "background.js must know where to renew",
  );
  assert.ok(
    /grading\/public\/extension-token\/renew/.test(BG),
    "the renewal must go to the PUBLIC mount -- an authed mount 401s an expired " +
      "token before any handler runs, and that is the request that matters most",
  );
  assert.ok(
    /async function renewTokenIfNeeded\(/.test(BG),
    "the renewal function is gone",
  );

  // AC2: the extension asks for a renewal itself, on every wake it gets.
  assert.ok(
    /onStartup[\s\S]{0,300}renewTokenIfNeeded\(/.test(BG),
    "a browser closed straight through the expiry must recover on its next " +
      "wake -- that is the whole of AC2",
  );
  const sweep = BG.slice(BG.indexOf("if (name === SWEEP_ALARM)"));
  assert.ok(
    /renewTokenIfNeeded\(/.test(sweep.slice(0, 1600)),
    "a browser left open for weeks must renew without being touched",
  );
  assert.ok(
    /async function listerBlock\(\)\s*\{\s*await renewTokenIfNeeded/.test(BG),
    "pressing Send is the best moment to discover the token is renewable",
  );

  // The expiry is stored when the token is, or none of the above can schedule.
  assert.ok(/gtBuyerTokenExpiresAt/.test(BG), "the token's expiry must be stored");
  assert.ok(
    /GT_SET_TOKEN[\s\S]{0,600}storeToken\(msg\.token\)/.test(BG),
    "the web handoff must go through storeToken, which records the expiry",
  );

  // FAIL-SAFE, and the direction matters: a failed renewal must NOT delete the
  // token. A deleted token reads as "never connected", which is the exact
  // confusion this story exists to end.
  const renew = BG.slice(BG.indexOf("async function renewTokenIfNeeded("));
  const renewBody = renew.slice(0, renew.indexOf("\n// ── entitlements"));
  assert.ok(
    !/storage\.local\.remove/.test(renewBody),
    "renewTokenIfNeeded must never erase the token -- an erased token reads as " +
      "'never connected' and the seller is told to connect instead of reconnect",
  );

  // The block response keeps both wire names, so an older gradethread.com build
  // still lands on Connect rather than /pricing.
  assert.ok(/needsReconnect: block === "reconnect"/.test(BG));
  assert.ok(/needsSignIn: block === "signin" \|\| block === "reconnect"/.test(BG));
  assert.ok(
    /needsUpgrade: block === "plan"/.test(BG),
    "an expired token must never set needsUpgrade",
  );

  // The ping carries the state and the date the SaaS renders.
  assert.ok(/tokenStatus: token\.state/.test(BG));
  assert.ok(/tokenExpiresAt: token\.expiresAtMs/.test(BG));
}

// ── the popup says reconnect, not sign in ──────────────────────────────────
{
  assert.ok(
    /caps\.tokenStatus === "expired"/.test(POPUP),
    "the popup must tell an expired connection apart from an absent one",
  );
  assert.ok(/Connection expired/.test(POPUP));
  assert.ok(/Reconnect/.test(POPUP));
}

console.log(
  "token-renewal.test.cjs: 31 days resolves to reconnect (never plan), four " +
    "token states, expiry stored on handoff, renewal on startup/sweep/send, " +
    "a failed renewal keeps the token, popup + block strings wired",
);
