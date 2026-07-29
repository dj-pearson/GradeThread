// GradeThread unified extension — role/subscription feature registry (US-1873)
//
// ONE place that answers "what may THIS install do?" from the account's stored
// entitlements + the buyer's local settings. Every surface reads the same map:
// the background gates the seller Lister on it, the popup renders only the
// sections it grants, and content scripts key off it. Pure + side-effect-free
// (no chrome.*), so it loads in the MV3 service worker via importScripts, as a
// classic popup script, AND is unit-testable from node (test/registry.test.cjs
// loads it with an injected `self`, same trick as lister-guard.js).
//
// FAIL-SAFE (mirrors lib/buyer-entitlements.ts on the edge): any missing or
// malformed entitlement collapses to the anonymous default — buyer research only,
// no seller tools — so a bad/absent response can never unlock the Lister.

(function (root) {
  "use strict";

  // Buyer research only, no seller tools. The floor for anonymous installs and
  // for every error/lookup gap.
  var ANONYMOUS_ENTITLEMENTS = {
    authenticated: false,
    sellerEnabled: false,
    flipdeskPlan: "free",
    buyerPlan: "free",
  };

  // Coerce whatever GET /api/grading/public/entitlements returned into the trusted
  // shape. Booleans must be strictly true; strings default to "free".
  function normalizeEntitlements(raw) {
    if (!raw || typeof raw !== "object") {
      return {
        authenticated: false,
        sellerEnabled: false,
        flipdeskPlan: "free",
        buyerPlan: "free",
      };
    }
    return {
      authenticated: raw.authenticated === true,
      sellerEnabled: raw.sellerEnabled === true,
      flipdeskPlan: typeof raw.flipdeskPlan === "string" && raw.flipdeskPlan ? raw.flipdeskPlan : "free",
      buyerPlan: typeof raw.buyerPlan === "string" && raw.buyerPlan ? raw.buyerPlan : "free",
    };
  }

  // US-2241: how many listing photos a grade may use. MIRRORS
  // lib/extension-gates.ts on the edge — the server is the authority and trims
  // to the caller's real cap, but the client needs the number BEFORE it extracts
  // a gallery, or it would send four thumbnails and never know it could have
  // sent eight. Same rule on both sides: any plan that is not "free" is paid, so
  // a plan added later inherits the deeper read rather than silently falling
  // back to the floor.
  var MAX_IMAGES_ANON = 4;
  var MAX_IMAGES_PAID = 8;

  function maxImagesFor(buyerPlan) {
    return buyerPlan && buyerPlan !== "free" ? MAX_IMAGES_PAID : MAX_IMAGES_ANON;
  }

  // The capability map. `settings` carries the buyer's local prefs (autoRun).
  //   research : ALWAYS on — anonymous allowed, quota-capped server-side.
  //   autoRun  : buyer setting (only meaningful because research is always on).
  //   lister   : cross-post — granted iff the account has an active paid FlipDesk
  //              plan (sellerEnabled from the signed token's entitlements).
  //   delist   : end-a-live-listing — same seller gate as lister.
  function resolveCapabilities(entitlements, settings) {
    var ent = normalizeEntitlements(entitlements);
    var s = settings && typeof settings === "object" ? settings : {};
    return {
      research: true,
      autoRun: s.autoRun === true,
      lister: ent.sellerEnabled === true,
      delist: ent.sellerEnabled === true,
      authenticated: ent.authenticated === true,
      sellerEnabled: ent.sellerEnabled === true,
      buyerPlan: ent.buyerPlan,
      flipdeskPlan: ent.flipdeskPlan,
      maxImages: maxImagesFor(ent.buyerPlan),
    };
  }

  // Freshness of a cached entitlements entry ({ at:number, ent }). The endpoint
  // sends no-store; the extension caches briefly so a content-script boot on every
  // page doesn't re-hit the endpoint. Kept short (see ENT_TTL_MS in background.js)
  // so a plan change — sign-in, upgrade, lapse — reflects within one TTL, and a
  // token set/clear force-invalidates it so it reflects immediately.
  function entitlementsFresh(entry, now, ttlMs) {
    return !!(entry && typeof entry.at === "number" && now - entry.at < ttlMs);
  }

  root.GT_REGISTRY = {
    ANONYMOUS_ENTITLEMENTS: ANONYMOUS_ENTITLEMENTS,
    normalizeEntitlements: normalizeEntitlements,
    resolveCapabilities: resolveCapabilities,
    maxImagesFor: maxImagesFor,
    MAX_IMAGES_ANON: MAX_IMAGES_ANON,
    MAX_IMAGES_PAID: MAX_IMAGES_PAID,
    entitlementsFresh: entitlementsFresh,
  };
})(typeof self !== "undefined" ? self : globalThis);
