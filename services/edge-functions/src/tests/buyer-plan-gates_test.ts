// US-2359: every buyer route is either tier-gated or explicitly not.
//
// THE LEAK THIS CLOSES. `requireBuyerFeature` — the 402 upgrade-required guard —
// was written, exported, and called by nothing. `BuyerGateFlags` declares
// thirteen paid features; across seven buyer route files exactly ONE read a gate
// flag. The demand board, a Connoisseur feature, had no gate on any of its four
// routes. The purchase-guarantee claim, a Guard feature, had none either. So the
// paid tiers were sold and not enforced.
//
// Dead security code is the worst kind of dead code: the helper's EXISTENCE is
// what makes a reviewer believe the gating is handled. Nothing about reading
// `buyer-wants.ts` says "this is ungated" — the absence is the bug, and absence
// is what a diff never shows you.
//
// So the guard is an ENUMERATION over the whole route surface: every buyer route
// is listed with either the feature that gates it or a stated reason it is
// ungated, and the scan asserts the listed set IS the route set. A new buyer
// route fails this test until its author answers the question — which is the
// question that never got asked for thirteen features.
//
// WHY NOT DRIVE THE ROUTES. A live 402 assertion needs an authenticated request
// against a seeded free-tier buyer, which needs the database. What can be
// verified without one is stronger than it sounds: that the guard is CALLED, on
// the right route, with the right feature name, and that the feature is one the
// plan matrix actually withholds from someone.

import { assert, assertEquals } from "@std/assert";
import {
  BUYER_PLAN_ENTITLEMENTS,
  type BuyerFeature,
  type BuyerPlanKey,
} from "../lib/buyer-plans.ts";

const ROUTES_DIR = new URL("../routes/", import.meta.url);

interface RouteGate {
  /** The route file, without the directory. */
  readonly file: string;
  /** Method + path exactly as the Hono registration spells it. */
  readonly route: string;
  /** The feature that gates it, or null when it is deliberately open. */
  readonly feature: BuyerFeature | null;
  /** Required when `feature` is null. Why this route is not gated. */
  readonly why?: string;
}

const GATES: readonly RouteGate[] = [
  // ── gated ────────────────────────────────────────────────────────────────
  {
    file: "buyer-wants.ts",
    route: 'post("/wants"',
    feature: "demandBoard",
    why: "creating a want IS the demand board — Connoisseur only",
  },
  {
    file: "buyer-wants.ts",
    route: 'patch("/wants/:id"',
    feature: "demandBoard",
    why: "editing a want is the same feature as creating one",
  },
  {
    file: "buyer-purchases.ts",
    route: 'post("/purchases/:id/claim"',
    feature: "purchaseGuarantee",
    why: "filing a claim IS the guarantee — Guard and up",
  },

  // ── ungated, with the reason ─────────────────────────────────────────────
  {
    file: "buyer-wants.ts",
    route: 'get("/wants"',
    feature: null,
    why:
      "a downgraded buyer still owns the wants they created; a 402 here would " +
      "hide their own data from them. Gate creation, never retrieval.",
  },
  {
    file: "buyer-wants.ts",
    route: 'get("/wants/:id/matches"',
    feature: null,
    why:
      "US-2552: the same rule as GET /wants. These matches were recorded for a " +
      "want the buyer already posted, and a 402 would show them a count they " +
      "can never open. Posting is what the demandBoard entitlement gates.",
  },
  {
    file: "buyer-wants.ts",
    route: 'delete("/wants/:id"',
    feature: null,
    why:
      "same rule, sharper: a 402 on delete turns a billing state into data the " +
      "buyer cannot clean up.",
  },
  {
    file: "buyer-authenticity.ts",
    route: 'post("/authenticity"',
    feature: null,
    why:
      "gated, but by its own inline check returning 403 not_entitled. NOT " +
      "converted to requireBuyerFeature: that would change the status to 402, " +
      "which the buyer web and iOS clients may branch on. A status-code change " +
      "is a client contract change and belongs in its own story, not in a " +
      "sweep. The flag it reads is authenticityAddon.",
  },
  {
    file: "buyer-closet.ts",
    route: 'get("/closet/valuation"',
    feature: null,
    why: "wardrobePortfolio is true on every tier — a gate would never deny",
  },
  {
    file: "buyer-closet.ts",
    route: 'get("/closet/export.csv"',
    feature: null,
    why: "wardrobePortfolio is true on every tier; also a data-export path",
  },
  {
    file: "buyer-closet.ts",
    route: 'post("/closet/:id/list"',
    feature: null,
    why: "promotes a closet item into FlipDesk; the seller side owns its own gate",
  },
  {
    file: "buyer-closet.ts",
    route: 'post("/closet"',
    feature: null,
    why: "wardrobePortfolio is true on every tier; the CAP is an allowance, not a gate",
  },
  {
    file: "buyer-closet.ts",
    route: 'delete("/closet/:id"',
    feature: null,
    why: "never gate removing your own data — a 402 here strands the closet",
  },
  {
    file: "buyer-profile.ts",
    route: 'post("/extension-token"',
    feature: null,
    why: "extensionSecondOpinion is true on every tier; the free quota is an allowance",
  },
  {
    file: "buyer-profile.ts",
    route: 'get("/profile"',
    feature: null,
    why: "reading your own buyer account is not a feature any tier withholds",
  },
  {
    file: "buyer-profile.ts",
    route: 'post("/profile"',
    feature: null,
    why: "editing your own buyer account is not a feature any tier withholds",
  },
  {
    file: "buyer-profile.ts",
    route: 'get("/entitlements"',
    feature: null,
    why:
      "this route IS the gate — it returns which features the caller's tier " +
      "grants, so requiring one to read it is circular, and a 402 here would " +
      "leave a client unable to learn it should not have asked",
  },
  {
    file: "buyer-purchases.ts",
    route: 'post("/purchases"',
    feature: null,
    why: "recording a purchase is the base loop every tier is sold on",
  },
  {
    file: "buyer-purchases.ts",
    route: 'get("/guarantee-coverage"',
    feature: "purchaseGuarantee",
    why:
      "US-2503: the coverage view iOS reads instead of re-implementing the web's five-way join. Reading coverage you do not have is not harmful; answering as though you might be covered is.",
  },
  {
    file: "buyer-purchases.ts",
    route: 'get("/impact"',
    feature: null,
    why: "circularity impact (US-1842) has no flag in BuyerGateFlags",
  },
  {
    file: "buyer-purchases.ts",
    route: 'post("/purchases/:id/arrival"',
    feature: null,
    why: "logging an arrival is part of the base purchase loop every tier gets",
  },
  {
    file: "buyer-purchases.ts",
    route: 'post("/purchases/:id/confirm"',
    feature: null,
    why: "part of the base purchase loop; also feeds the guarantee evidence",
  },
  {
    file: "buyer-rewards.ts",
    route: 'post("/rewards/leaderboard"',
    feature: null,
    why: "rewards is true on every tier, so a gate would never deny anyone",
  },
  {
    file: "buyer-rewards.ts",
    route: 'get("/rewards/leaderboard"',
    feature: null,
    why: "rewards is true on every tier, so a gate would never deny anyone",
  },
  {
    file: "buyer-trust.ts",
    route: 'post("/trust-signals"',
    feature: null,
    why: "trustScore is true on every tier, so a gate would never deny anyone",
  },
  {
    file: "buyer-trust.ts",
    route: 'get("/reputation"',
    feature: null,
    why:
      "US-2503: the caller's own trust level, server-resolved so iOS does not become a third copy of the perk matrix. trustScore is true on every tier",
  },
];

const FILES = [...new Set(GATES.map((g) => g.file))].sort();

async function read(file: string): Promise<string> {
  return await Deno.readTextFile(new URL(file, ROUTES_DIR));
}

/**
 * Every Hono route registration in a buyer route file.
 *
 * Anchored to the `…Routes.` receiver rather than to a bare `.get(`, which also
 * matched `c.get("userId")` in every handler — the first version reported a
 * phantom route on every file. Over-matching here is not harmless: it would put
 * the guard permanently red, and a permanently red guard gets deleted.
 */
function registrations(src: string): string[] {
  return [
    ...src.matchAll(/\w*Routes\.(get|post|patch|put|delete)\((["'][^"']+["'])/g),
  ].map((m) => `${m[1]}(${m[2]!.replace(/'/g, '"')}`);
}

Deno.test("US-2359: the declared route set IS the route set", async () => {
  // The assertion that makes this guard durable. A new buyer route lands here
  // as a failure until someone says whether it is gated — the question that
  // was never asked while thirteen paid features shipped ungated.
  for (const file of FILES) {
    const found = registrations(await read(file)).sort();
    const declared = GATES.filter((g) => g.file === file)
      .map((g) => g.route)
      .sort();
    assertEquals(
      found,
      declared,
      `${file}: routes and declarations disagree. Add the new route to GATES ` +
        `with its feature, or with a reason it is open.`,
    );
  }
});

Deno.test("US-2359: every gated route actually calls the guard", async () => {
  for (const g of GATES.filter((x) => x.feature)) {
    const src = await read(g.file);
    const at = src.indexOf(g.route);
    assert(at > -1, `${g.file}: ${g.route} not found`);
    // The handler body, up to the next registration in the same file.
    const rest = src.slice(at);
    const nextAt = rest.slice(1).search(/\n\w+Routes\.(get|post|patch|put|delete)\(/);
    const body = nextAt === -1 ? rest : rest.slice(0, nextAt + 1);
    assert(
      body.includes(`requireBuyerFeature(c, "${g.feature}")`),
      `${g.file} ${g.route} is declared gated on ${g.feature} but does not call ` +
        `requireBuyerFeature with it`,
    );
    assert(
      body.includes("instanceof Response"),
      `${g.file} ${g.route} calls the guard but does not RETURN its refusal — ` +
        `requireBuyerFeature returns a Response to be returned, not to be ignored`,
    );
  }
});

Deno.test("US-2359: a gate is only claimed for a feature some tier lacks", () => {
  // Guards against a gate that reads as protection and denies nobody. If a flag
  // is true on every tier, gating a route on it is decoration plus a database
  // round trip.
  const tiers = Object.keys(BUYER_PLAN_ENTITLEMENTS) as BuyerPlanKey[];
  for (const g of GATES) {
    if (!g.feature) continue;
    const withheld = tiers.filter(
      (t) => !BUYER_PLAN_ENTITLEMENTS[t].gateFlags[g.feature!],
    );
    assert(
      withheld.length > 0,
      `${g.route} is gated on ${g.feature}, which every tier already has — ` +
        `the gate denies nobody and costs a query`,
    );
  }
});

Deno.test("US-2359: every ungated route states why", () => {
  for (const g of GATES) {
    if (g.feature) continue;
    assert(
      (g.why ?? "").length > 30,
      `${g.file} ${g.route} is declared ungated with no real reason. "Ungated" ` +
        `without a reason is how the original thirteen happened.`,
    );
  }
});

Deno.test("US-2359: the two features the audit named are enforced somewhere", async () => {
  // Named rather than inferred, so a future refactor that drops one of them
  // fails on the specific finding this story exists for.
  const wants = await read("buyer-wants.ts");
  const purchases = await read("buyer-purchases.ts");
  assert(
    wants.includes('requireBuyerFeature(c, "demandBoard")'),
    "the demand board is ungated again — it is Connoisseur-only",
  );
  assert(
    purchases.includes('requireBuyerFeature(c, "purchaseGuarantee")'),
    "the guarantee claim is ungated again — it is Guard and up",
  );
});

Deno.test("US-2359: the free tier really does lack what we gate on", () => {
  // Pins the matrix rows the two gates depend on. If demandBoard were flipped
  // true on free, the gates above would silently stop denying anyone and the
  // route tests would still pass.
  assertEquals(BUYER_PLAN_ENTITLEMENTS.free.gateFlags.demandBoard, false);
  assertEquals(BUYER_PLAN_ENTITLEMENTS.guard.gateFlags.demandBoard, false);
  assertEquals(BUYER_PLAN_ENTITLEMENTS.connoisseur.gateFlags.demandBoard, true);
  assertEquals(BUYER_PLAN_ENTITLEMENTS.free.gateFlags.purchaseGuarantee, false);
  assertEquals(BUYER_PLAN_ENTITLEMENTS.guard.gateFlags.purchaseGuarantee, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// US-2359, the FLAG side of the same question.
//
// Everything above enumerates ROUTES. That answers "is this route gated?" and
// it cannot answer "is this paid feature enforced anywhere?" — which is the
// question the story was actually filed on. The two are not the same surface:
// the buyer route files are seven of them, and five of the thirteen flags are
// enforced in code no buyer route ever touches.
//
// That gap is why this story kept reading as "ten of thirteen flags are still
// unenforced" long after it stopped being true. Measured 2026-08-08, all
// thirteen are accounted for: five are true on EVERY tier and so cannot deny
// anyone, and the other eight are each enforced somewhere — just not all in the
// same shape, and not all in the buyer routes.
//
// The shapes are deliberately different and all of them are correct:
//   • 402 upgrade-required (requireBuyerFeature) — for a route that IS the
//     feature, where refusing the call is the whole answer.
//   • 403 not_entitled inline — buyer-authenticity.ts, kept as-is because
//     changing its status is a client contract change (see its GATES entry).
//   • FIELD SUPPRESSION — the extension scan returns the scan and nulls the
//     paid fields. A 402 there would refuse the free feature to withhold the
//     paid one.
//   • SLA / routing — prioritySupport has no runtime path at all, and
//     lib/plan-gate.ts says so in prose.
// A test that demanded one shape would push three of these toward the wrong one.
const FLAG_ENFORCEMENT: Record<BuyerFeature, string | null> = {
  // null = no enforcement required. ASSERTED below to be true on every tier,
  // so "we don't gate it" has to stay earned rather than assumed.
  extensionSecondOpinion: null,
  conditionAlerts: null,
  rewards: null,
  trustScore: null,
  wardrobePortfolio: null,

  // "GATES" = enforced by a buyer route in the registry above.
  demandBoard: "GATES",
  purchaseGuarantee: "GATES",

  // Enforced outside the buyer route files. The path is read and must still
  // mention the flag, so deleting the enforcement reddens here rather than
  // leaving this table as a description of code that used to exist.
  authenticityAddon: "routes/buyer-authenticity.ts",
  discrepancyScoring: "lib/extension-gates.ts",
  priceFairness: "lib/extension-gates.ts",
  fitPrediction: "lib/extension-gates.ts",
  videoGrading: "routes/grade.ts",
  prioritySupport: "lib/plan-gate.ts",
};

Deno.test("US-2359: every declared paid feature is accounted for", async () => {
  const flags = Object.keys(
    BUYER_PLAN_ENTITLEMENTS.free.gateFlags,
  ) as BuyerFeature[];

  // The Record type already forces exhaustiveness at compile time. This catches
  // the other direction — a flag deleted from the matrix but left in the table,
  // which would keep asserting against a feature that no longer exists.
  assertEquals(
    Object.keys(FLAG_ENFORCEMENT).sort(),
    [...flags].sort(),
    "FLAG_ENFORCEMENT and BuyerGateFlags disagree — a paid feature was added " +
      "or removed and its enforcement was not stated",
  );

  const tiers = Object.keys(BUYER_PLAN_ENTITLEMENTS) as BuyerPlanKey[];

  for (const flag of flags) {
    const where = FLAG_ENFORCEMENT[flag];

    if (where === null) {
      const withheld = tiers.filter(
        (t) => !BUYER_PLAN_ENTITLEMENTS[t].gateFlags[flag],
      );
      assertEquals(
        withheld,
        [],
        `${flag} is declared as needing no enforcement, but ${withheld.join(", ")} ` +
          `does not have it. It is now a paid feature that nothing withholds — ` +
          `either enforce it and name where, or put the flag back to true on ` +
          `every tier.`,
      );
      continue;
    }

    if (where === "GATES") {
      assert(
        GATES.some((g) => g.feature === flag),
        `${flag} is declared as gated by a buyer route, but no GATES entry ` +
          `claims it`,
      );
      continue;
    }

    const src = await Deno.readTextFile(new URL(`../${where}`, ROUTES_DIR));
    assert(
      src.includes(flag),
      `${flag} is declared as enforced in ${where}, and that file no longer ` +
        `mentions it. Either the enforcement moved (update this table) or it ` +
        `was deleted (a paid feature is now free).`,
    );
  }
});
