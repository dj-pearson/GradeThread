// GradeThread unified extension — feature registry gating tests (US-1873).
//
// The registry is the single gate deciding what an install may do. This proves
// the fail-safe contract: only an explicit sellerEnabled:true unlocks the Lister,
// and any malformed/missing entitlement collapses to buyer-research-only. Loads
// registry.js with an injected `self` (same trick as the config guards) so no
// ESM/require friction. Zero-dependency: throws on mismatch.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadRegistry() {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "registry.js"), "utf8");
  const selfObj = {};
  // eslint-disable-next-line no-new-func
  new Function("self", src)(selfObj);
  assert.ok(selfObj.GT_REGISTRY, "registry.js must assign self.GT_REGISTRY");
  return selfObj.GT_REGISTRY;
}

const R = loadRegistry();

// ── normalizeEntitlements: fail-safe coercion ──────────────────────────────
assert.deepStrictEqual(
  R.normalizeEntitlements(null),
  { authenticated: false, sellerEnabled: false, flipdeskPlan: "free", buyerPlan: "free" },
  "null → anonymous default",
);
assert.deepStrictEqual(
  R.normalizeEntitlements("nope"),
  { authenticated: false, sellerEnabled: false, flipdeskPlan: "free", buyerPlan: "free" },
  "non-object → anonymous default",
);
assert.deepStrictEqual(
  R.normalizeEntitlements({ authenticated: 1, sellerEnabled: "yes", flipdeskPlan: 5, buyerPlan: "" }),
  { authenticated: false, sellerEnabled: false, flipdeskPlan: "free", buyerPlan: "free" },
  "truthy-but-not-true booleans do NOT unlock; bad strings → free",
);
assert.deepStrictEqual(
  R.normalizeEntitlements({ authenticated: true, sellerEnabled: true, flipdeskPlan: "pro", buyerPlan: "guard" }),
  { authenticated: true, sellerEnabled: true, flipdeskPlan: "pro", buyerPlan: "guard" },
  "well-formed paid seller passes through",
);

// ── resolveCapabilities: the gate ──────────────────────────────────────────
const anon = R.resolveCapabilities(R.ANONYMOUS_ENTITLEMENTS, {});
assert.equal(anon.research, true, "research is always on (anonymous)");
assert.equal(anon.lister, false, "anonymous cannot list");
assert.equal(anon.delist, false, "anonymous cannot delist");
assert.equal(anon.autoRun, false, "autoRun off by default");

const buyerOnly = R.resolveCapabilities(
  { authenticated: true, sellerEnabled: false, flipdeskPlan: "free", buyerPlan: "guard" },
  { autoRun: true },
);
assert.equal(buyerOnly.research, true);
assert.equal(buyerOnly.autoRun, true, "autoRun reflects the setting");
assert.equal(buyerOnly.lister, false, "authenticated buyer WITHOUT seller plan still locked");
assert.equal(buyerOnly.authenticated, true);

const seller = R.resolveCapabilities(
  { authenticated: true, sellerEnabled: true, flipdeskPlan: "starter", buyerPlan: "free" },
  {},
);
assert.equal(seller.lister, true, "paid FlipDesk unlocks the Lister");
assert.equal(seller.delist, true, "paid FlipDesk unlocks delist");
assert.equal(seller.flipdeskPlan, "starter");

// A malformed payload must never unlock the Lister.
const garbage = R.resolveCapabilities({ sellerEnabled: "true", authenticated: "true" }, {});
assert.equal(garbage.lister, false, "string 'true' does NOT unlock — fail-safe");

// ── entitlementsFresh: TTL window ──────────────────────────────────────────
const TTL = 5 * 60 * 1000;
assert.equal(R.entitlementsFresh({ at: 1000 }, 1000 + TTL - 1, TTL), true, "within TTL → fresh");
assert.equal(R.entitlementsFresh({ at: 1000 }, 1000 + TTL, TTL), false, "at TTL boundary → stale");
assert.equal(R.entitlementsFresh(null, 5000, TTL), false, "no entry → stale");
assert.equal(R.entitlementsFresh({ ent: {} }, 5000, TTL), false, "missing at → stale");

console.log("registry.test.cjs: capability gating + fail-safe normalization + TTL all pass");
