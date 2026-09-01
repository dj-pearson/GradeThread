import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  API_CROSS_LISTING_PLATFORMS,
  EXTENSION_CROSS_LISTING_PLATFORMS,
  FLIPDESK_PLANS,
  LISTING_PLATFORMS,
  LIVE_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_MECHANISM,
  MARKETPLACE_TIER,
  MARKETPLACE_TIER_LABEL,
  MARKETPLACE_EXTENSION_FLOW,
  MARKETPLACE_EXTENSION_FLOWS,
  MARKETPLACE_FLOW_LABEL,
  MARKETPLACE_REVISE_LABEL,
  formatListingAllowance,
} from "@/lib/constants";
import { marketplaceDisclosureFor } from "@/lib/marketplace-disclosure";

// US-717: the composer + Marketplaces UI read MARKETPLACE_MECHANISM to show each
// channel's REAL mechanism (API vs browser-extension) — these guards keep the
// map honest and the two cross-list groupings consistent with it.

describe("MARKETPLACE_MECHANISM", () => {
  it("classifies every listing platform", () => {
    for (const p of LISTING_PLATFORMS) {
      expect(MARKETPLACE_MECHANISM[p]).toBeDefined();
    }
  });

  it("routes eBay/Shopify/Depop through the API", () => {
    // Depop stays mechanism=api on purpose: the mechanism says HOW a channel
    // would be reached, and Depop's adapter really is a server-side API
    // connector. Whether it is switched on is MARKETPLACE_TIER's job, and that
    // still reads api_pending. Conflating the two is what US-2327 unpicked.
    expect(MARKETPLACE_MECHANISM.ebay).toBe("api");
    expect(MARKETPLACE_MECHANISM.shopify).toBe("api");
    expect(MARKETPLACE_MECHANISM.depop).toBe("api");
  });

  it("routes Poshmark/Mercari/Grailed through the extension", () => {
    expect(MARKETPLACE_MECHANISM.poshmark).toBe("extension");
    expect(MARKETPLACE_MECHANISM.mercari).toBe("extension");
    expect(MARKETPLACE_MECHANISM.grailed).toBe("extension");
  });

  it("every API cross-list platform is mechanism=api", () => {
    for (const p of API_CROSS_LISTING_PLATFORMS) {
      expect(MARKETPLACE_MECHANISM[p]).toBe("api");
    }
  });

  it("every extension cross-list platform is mechanism=extension", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      expect(MARKETPLACE_MECHANISM[p]).toBe("extension");
    }
  });

  it("the API and extension groups don't overlap", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      expect(API_CROSS_LISTING_PLATFORMS as readonly string[]).not.toContain(p);
    }
  });

  // US-2327: this used to assert the opposite — that Depop IS live. The
  // assertion was true of the constant and false of the product: the connector
  // defaults to DISABLED, so on a stock deployment nothing about Depop works.
  // A test that pins a claim the code cannot honour makes the claim harder to
  // fix, not safer.
  it("Depop is NOT advertised as live — the connector defaults off (US-2327)", () => {
    expect(LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).not.toContain("depop");
  });

  it("Whatnot is not reached by any mechanism (US-2327)", () => {
    // Every adapter method is notImplemented and the API was modelled with no
    // public docs, so "api" was the least supported claim in constants.ts.
    expect(MARKETPLACE_MECHANISM.whatnot).toBe("none");
  });
});

// US-2327 AC3: the frontend's "live" claim has to match what the SERVER can
// actually do. Nothing in the UI reads these constants today, which is the only
// reason the wrong values were harmless — the next consumer would have
// inherited them. So the claim is tied to the adapters themselves rather than
// to another constant that could drift alongside it.
describe("the live list matches the adapters (US-2327)", () => {
  const ADAPTERS = resolve(
    process.cwd(),
    "services/edge-functions/src/lib/marketplace-adapters",
  );

  it("every LIVE platform can actually PUBLISH", () => {
    // Scoped to publish deliberately. Written as "no notImplemented anywhere",
    // this first failed on Shopify — and the reason is a lesson in reading a
    // stub before drawing a conclusion from it. Shopify's syncListings and
    // syncOrders ARE 501, but the comment directly above them says why: order
    // and listing changes arrive out-of-band through the webhook receiver
    // (flipdesk-webhooks.ts /shopify) into shopify-orders.ts, plus a manual
    // reconciliation pull, so there is deliberately no adapter-level batch
    // pull (US-1472). A 501 there means "handled elsewhere", not "unbuilt" —
    // unlike the poshmark/mercari/whatnot stubs, which that same comment
    // explicitly distinguishes itself from.
    //
    // So the file-wide form of this assertion was not too strict, it was
    // WRONG: it treated a documented design choice as a missing feature.
    // Publish is the thing "live cross-listing" actually claims.
    for (const p of LIVE_CROSS_LISTING_PLATFORMS) {
      const src = readFileSync(resolve(ADAPTERS, `${p}.ts`), "utf8");
      expect(
        src,
        `${p} is advertised as live but its publish path is a stub`,
      ).not.toMatch(/publish:[^,]*notImplemented\(/);
    }
  });

  it("a platform with a stubbed adapter can never be live", () => {
    // The inverse, so the guard catches the failure from both directions: a
    // half-built adapter being promoted, and a live platform regressing to a
    // stub. Whatnot is the worked example.
    for (const p of ["whatnot"] as const) {
      const src = readFileSync(resolve(ADAPTERS, `${p}.ts`), "utf8");
      expect(src).toMatch(/publish:[^,]*notImplemented\(/);
      expect(LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).not.toContain(p);
    }
  });

  it("live implies tier 'api' — the two layers cannot disagree again", () => {
    // The specific defect: LIVE_CROSS_LISTING_PLATFORMS said Depop was live
    // while MARKETPLACE_TIER said api_pending, and nothing tied them together.
    for (const p of LIVE_CROSS_LISTING_PLATFORMS) {
      expect(MARKETPLACE_TIER[p], `${p} is listed live but its tier is not api`)
        .toBe("api");
    }
  });
});

// US-718: the presentation tier is the single source of truth the Marketplaces
// UI (web + iOS) reads. These guards keep it honest — no channel is advertised
// above the integration that actually ships at launch.
describe("MARKETPLACE_TIER (US-718)", () => {
  it("classifies every listing platform with a labelled tier", () => {
    for (const p of LISTING_PLATFORMS) {
      const tier = MARKETPLACE_TIER[p];
      expect(tier).toBeDefined();
      expect(MARKETPLACE_TIER_LABEL[tier]).toBeTruthy();
    }
  });

  it("only the live API connectors are tier 'api' (eBay + Shopify)", () => {
    const apiTier = LISTING_PLATFORMS.filter(
      (p) => MARKETPLACE_TIER[p] === "api",
    );
    expect(apiTier.sort()).toEqual(["ebay", "shopify"]);
  });

  it("Depop is api_pending — built but not advertised as live (US-713/714)", () => {
    expect(MARKETPLACE_TIER.depop).toBe("api_pending");
  });

  it("Poshmark/Mercari/Grailed are the extension tier (US-716)", () => {
    expect(MARKETPLACE_TIER.poshmark).toBe("extension");
    expect(MARKETPLACE_TIER.mercari).toBe("extension");
    expect(MARKETPLACE_TIER.grailed).toBe("extension");
  });

  it("a channel's mechanism is consistent with its tier", () => {
    for (const p of LISTING_PLATFORMS) {
      const tier = MARKETPLACE_TIER[p];
      const mech = MARKETPLACE_MECHANISM[p];
      if (tier === "api" || tier === "api_pending") expect(mech).toBe("api");
      if (tier === "extension") expect(mech).toBe("extension");
      if (tier === "coming_soon") expect(mech).toBe("none");
    }
  });
});

// US-2477..US-2480: the flow-status constant must match the extension's own
// `enabled` flags.
//
// THE DEFECT THIS CATCHES. MARKETPLACE_TIER said "Connect via browser
// extension" for Mercari, Grailed and Vinted while all three sat at
// `enabled: false` in the extension's selectors — so the UI advertised a
// capability that reported "list manually for now" on every attempt, and
// nothing in the repo tied the two facts together. The frontend cannot import
// an extension content script, so the file is parsed instead. Same technique as
// the adapter-stub check above, and for the same reason: the claim is verified
// against the thing that implements it, not against another constant that can
// drift alongside it.
describe("extension flow status matches the shipped selectors (US-2477..US-2480)", () => {
  const SELECTORS_PATH = resolve(
    process.cwd(),
    "extension-unified/lister/selectors.js",
  );

  /** Evaluate the bundled selectors file and hand back its config object. */
  function loadSelectors(): Record<
    string,
    {
      enabled: boolean;
      lastVerified: string | null;
      delist?: { enabled: boolean; lastVerified: string | null };
      revise?: { enabled: boolean; lastVerified: string | null };
    }
  > {
    const src = readFileSync(SELECTORS_PATH, "utf8");
    const ctx: Record<string, unknown> = {};
    // The file assigns to `self`; give it one and read the global back.
    new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)(ctx);
    return ctx.GT_LISTER_SELECTORS as ReturnType<typeof loadSelectors>;
  }

  const selectors = loadSelectors();

  /** The entry for a channel, or a diagnosis of why it isn't there. */
  function entry(p: string) {
    const e = selectors[p];
    if (!e) throw new Error(`extension-unified/lister/selectors.js has no "${p}" entry`);
    return e;
  }

  it("every extension channel has a selectors entry", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      expect(
        selectors[p],
        `${p} is advertised as an extension channel but has no entry in ` +
          `extension-unified/lister/selectors.js — the seller would get ` +
          `"unsupported marketplace" from a channel the UI offered them`,
      ).toBeDefined();
    }
  });

  it("'live' means enabled in the extension, and 'verifying' means not", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      const expected = entry(p).enabled ? "live" : "verifying";
      expect(
        MARKETPLACE_EXTENSION_FLOW[p],
        `MARKETPLACE_EXTENSION_FLOW.${p} says "${MARKETPLACE_EXTENSION_FLOW[p]}" but ` +
          `selectors.js has enabled: ${entry(p).enabled}. Flipping a channel on ` +
          `is both edits or neither.`,
      ).toBe(expected);
    }
  });

  it("an enabled flow has a verification date", () => {
    // `enabled: true` with `lastVerified: null` is the specific lie this blocks:
    // it claims a human checked the live sell form when nobody did, and the
    // failure shows up as a half-filled form on a seller's real listing.
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      if (!entry(p).enabled) continue;
      expect(
        entry(p).lastVerified,
        `${p} is enabled but lastVerified is null — enable a flow only after ` +
          `re-checking every required selector against the live sell form`,
      ).toBeTruthy();
    }
  });

  it("every flow status has a label", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      expect(MARKETPLACE_FLOW_LABEL[MARKETPLACE_EXTENSION_FLOW[p]]).toBeTruthy();
    }
  });
});

// US-2475: every channel must carry an on-screen automation risk disclosure.
//
// This is the guard the story exists for. The failure mode it blocks is not
// "the copy is bad" — it is a platform being added to MARKETPLACE_MECHANISM,
// shipped to the Marketplaces screen, and telling the seller nothing about
// where the automation runs or whose account is on the line. That is a thing a
// seller finds out about afterwards, which is too late to be a decision.
describe("per-channel automation risk disclosure (US-2475)", () => {
  it("every mechanism key has disclosure copy", () => {
    for (const p of LISTING_PLATFORMS) {
      const d = marketplaceDisclosureFor(p);
      expect(d.title, `${p} has no disclosure title`).toBeTruthy();
      expect(d.facts.length, `${p} has no disclosure facts`).toBeGreaterThan(0);
      for (const fact of d.facts) {
        expect(fact.length, `${p} has an empty disclosure fact`).toBeGreaterThan(20);
        // A leaked placeholder means the substitution missed a channel, which
        // would ship "{label}'s terms restrict…" to a real seller.
        expect(fact, `${p} disclosure still contains a raw placeholder`).not.toContain(
          "{label}",
        );
      }
    }
  });

  it("extension channels state all four required facts", () => {
    // The four are: the terms restrict third-party automation; it runs in the
    // seller's own browser/session; our servers never get the password or
    // cookie; the seller owns the account. Asserted by meaning-bearing phrase
    // rather than by index, so reordering the bullets is allowed and dropping
    // one is not.
    const REQUIRED = [
      /terms restrict third-party automation/i,
      /your own browser/i,
      /never receive your .* password or session cookie/i,
      /your account, your responsibility/i,
    ];
    const extensionChannels = LISTING_PLATFORMS.filter(
      (p) => MARKETPLACE_MECHANISM[p] === "extension",
    );
    expect(extensionChannels.length).toBeGreaterThan(0);
    for (const p of extensionChannels) {
      const blob = marketplaceDisclosureFor(p).facts.join(" ");
      for (const rule of REQUIRED) {
        expect(blob, `${p} disclosure is missing: ${rule}`).toMatch(rule);
      }
    }
  });

  it("API channels name the developer terms and link to /trademarks", () => {
    const apiChannels = LISTING_PLATFORMS.filter(
      (p) => MARKETPLACE_MECHANISM[p] === "api",
    );
    expect(apiChannels.length).toBeGreaterThan(0);
    for (const p of apiChannels) {
      const d = marketplaceDisclosureFor(p);
      expect(d.facts.join(" "), `${p} does not name the developer terms`).toMatch(
        /authorized developer API/i,
      );
      expect(d.href, `${p} does not link to the trademark page`).toBe("/trademarks");
    }
  });

  it("no channel claims server-side automation for an extension mechanism", () => {
    // The US-2476 bright line, asserted against the copy a seller actually
    // reads: an extension channel may never be described as running anywhere
    // but the seller's own browser.
    for (const p of LISTING_PLATFORMS) {
      if (MARKETPLACE_MECHANISM[p] !== "extension") continue;
      const blob = marketplaceDisclosureFor(p).facts.join(" ");
      expect(blob).toMatch(/nothing about .* runs on GradeThread's servers/i);
    }
  });
});

// US-718 AC2: plan copy must not advertise non-live API integrations and the
// cap must reflect what actually works (paid tiers can connect >1 API channel).
describe("FlipDesk plan honesty (US-718)", () => {
  it("no plan advertises Poshmark/Mercari/Depop/Etsy as live API integrations", () => {
    for (const plan of Object.values(FLIPDESK_PLANS)) {
      for (const feature of plan.features) {
        // The only legitimate mention of these channels is the extension bullet.
        const isExtensionBullet = /Lister extension/i.test(feature);
        if (isExtensionBullet) continue;
        expect(feature).not.toMatch(/\b(poshmark|mercari|depop|etsy)\b/i);
      }
    }
  });

  it("paid tiers allow more than one marketplace connection (cross-list works)", () => {
    expect(FLIPDESK_PLANS.starter.marketplacesCap).toBe(-1);
    expect(FLIPDESK_PLANS.pro.marketplacesCap).toBe(-1);
    expect(FLIPDESK_PLANS.business.marketplacesCap).toBe(-1);
  });

  it("Free stays eBay-only (single connection) as the upsell", () => {
    expect(FLIPDESK_PLANS.free.marketplacesCap).toBe(1);
  });
});

// US-2483: the listing allowance a shopper reads must be the one the server
// grants.
//
// Every crosslisting tool a reseller compares us against prices by listing
// volume, so this is the number they came for. It exists twice on the plan
// card — once as the explicit allowance line (from activeListingCap, which
// plan-limits-parity.test.ts already ties to the edge's enforcement) and once
// inside the hand-written features bullet. Two copies of a number is how one of
// them goes stale, and the stale one is what a shopper would be quoting back at
// support.
describe("listing allowance (US-2483)", () => {
  it("formats -1 as unlimited rather than inventing a cap", () => {
    expect(formatListingAllowance(-1)).toBe("Unlimited");
    expect(formatListingAllowance(1000)).toBe("1,000");
    expect(formatListingAllowance(25)).toBe("25");
  });

  it("every tier states an allowance", () => {
    for (const [key, plan] of Object.entries(FLIPDESK_PLANS)) {
      expect(
        plan.activeListingCap === -1 || plan.activeListingCap > 0,
        `${key} has no usable listing allowance (${plan.activeListingCap})`,
      ).toBe(true);
    }
  });

  it("the features bullet agrees with the enforced cap", () => {
    for (const [key, plan] of Object.entries(FLIPDESK_PLANS)) {
      const bullet = plan.features.find((f) => /active listings?/i.test(f));
      expect(bullet, `${key} has no "active listings" feature bullet`).toBeTruthy();
      const expected = plan.activeListingCap === -1
        ? "unlimited"
        : formatListingAllowance(plan.activeListingCap);
      expect(
        bullet!.toLowerCase(),
        `${key}'s feature bullet says "${bullet}" but the enforced cap is ` +
          `${plan.activeListingCap}. The bullet and the allowance line are two ` +
          `renderings of one number — they cannot disagree.`,
      ).toContain(expected.toLowerCase());
    }
  });

  it("allowances increase with price", () => {
    // A cheaper tier covering more listings than a dearer one is a pricing bug
    // that reads as a typo and costs a real upgrade.
    const order = ["free", "starter", "pro", "business"] as const;
    let previous = 0;
    for (const key of order) {
      const cap = FLIPDESK_PLANS[key].activeListingCap;
      if (cap === -1) {
        previous = Number.MAX_SAFE_INTEGER;
        continue;
      }
      expect(cap, `${key} does not increase on the tier below it`).toBeGreaterThan(
        previous,
      );
      previous = cap;
    }
  });
});

// US-9202: the per-flow map has the same contract as the list-flow constant,
// for all three flows. A "live" revise while selectors.js says
// `revise.enabled: false` would tell a seller their edits reach Poshmark when
// the extension would answer "edit manually".
describe("MARKETPLACE_EXTENSION_FLOWS matches the shipped selectors (US-9202)", () => {
  const SELECTORS_PATH = resolve(process.cwd(), "extension-unified/lister/selectors.js");
  const src = readFileSync(SELECTORS_PATH, "utf8");
  const ctx: Record<string, unknown> = {};
  new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)(ctx);
  const selectors = ctx.GT_LISTER_SELECTORS as Record<
    string,
    {
      enabled: boolean;
      delist?: { enabled: boolean; lastVerified: string | null };
      revise?: { enabled: boolean; lastVerified: string | null };
    }
  >;

  it("the list column agrees with MARKETPLACE_EXTENSION_FLOW", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      expect(MARKETPLACE_EXTENSION_FLOWS[p].list).toBe(MARKETPLACE_EXTENSION_FLOW[p]);
    }
  });

  it("delist and revise agree with selectors.js, flow by flow", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      const e = selectors[p];
      if (!e) throw new Error(`${p} has no selectors entry`);
      for (const flow of ["delist", "revise"] as const) {
        const cfg = e[flow];
        const expected = cfg?.enabled ? "live" : "verifying";
        expect(
          MARKETPLACE_EXTENSION_FLOWS[p][flow],
          `MARKETPLACE_EXTENSION_FLOWS.${p}.${flow} says "${MARKETPLACE_EXTENSION_FLOWS[p][flow]}" ` +
            `but selectors.js has ${flow}.enabled: ${cfg?.enabled ?? "absent"}.`,
        ).toBe(expected);
        if (cfg?.enabled) {
          expect(cfg.lastVerified, `${p}.${flow} is enabled with no lastVerified`).toBeTruthy();
        }
      }
    }
  });

  it("every enabled list channel declares a revise flow", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      const e = selectors[p];
      if (!e || !e.enabled) continue;
      expect(e.revise, `${p} lists but declares no revise flow`).toBeDefined();
    }
  });

  it("both revise labels exist", () => {
    expect(MARKETPLACE_REVISE_LABEL.live).toBeTruthy();
    expect(MARKETPLACE_REVISE_LABEL.verifying).toMatch(/by hand/);
  });
});

