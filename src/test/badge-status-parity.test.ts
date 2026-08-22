// US-1913: external status — the level + integrity tier on the surfaces buyers
// actually see.
//
// Everything here guards a claim that can go wrong SILENTLY. Both public
// surfaces have two renderers (the SPA route and a Cloudflare Pages Function
// SSR) reading one edge payload, so a field added to one reads `undefined` on
// the other and its section simply vanishes — no test goes red, and two buyers
// are told two different things about the same seller. Same trap as
// src/test/cert-seller-integrity-parity.test.ts and
// src/test/verified-achievements-parity.test.ts.
//
// The tooltip copy is a second instance of the same shape: Pages Functions
// cannot import from src/, so the two sentences exist twice on purpose and are
// held together here rather than by a shared module.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { INTEGRITY_TIER_BASIS, LEVEL_FLAIR_BASIS } from "@/lib/verified";
// US-2789: the SSR copies, IMPORTED rather than grepped. status-basis.ts is a
// plain two-constant module with no Workers types, so it imports cleanly here -
// unlike a route, which would drag PagesFunction into the src tsconfig project.
import {
  INTEGRITY_TIER_BASIS as SSR_INTEGRITY_TIER_BASIS,
  LEVEL_FLAIR_BASIS as SSR_LEVEL_FLAIR_BASIS,
} from "../../functions/_shared/status-basis";

const read = (p: string) => readFileSync(p, "utf8");

const edgeRoute = read("services/edge-functions/src/routes/content-public.ts");
const certSsr = read("functions/cert/[id].ts");
const certSpa = read("src/pages/certificate.tsx");
const profileSsr = read("functions/verified/[handle].ts");
const profileSpa = read("src/pages/verified-seller.tsx");
const verifiedLib = read("src/lib/verified.ts");
const studio = read("src/components/verified/badge-studio.tsx");

describe("status tooltips (US-1913 AC2)", () => {
  it("the SSR and SPA copies of the two sentences agree word for word", () => {
    // A tooltip that says something different on the crawled page than in the
    // app is a second definition of what the mark MEANS, which is the one thing
    // duplicated copy must never drift on.
    //
    // US-2789: compared as VALUES, not by grepping the SSR file for the SPA
    // string. `toContain` on the file text passes when the SSR copy has extra
    // words APPENDED to the same constant - verified: the two surfaces then say
    // different things and the guard stays green, which is precisely the drift
    // it exists to catch.
    expect(SSR_INTEGRITY_TIER_BASIS).toEqual(INTEGRITY_TIER_BASIS);
    expect(SSR_LEVEL_FLAIR_BASIS).toEqual(LEVEL_FLAIR_BASIS);
    // The SPA constants still have to LIVE in verified.ts rather than be
    // re-exported from the SSR module - Pages Functions cannot import from
    // src/, so the duplicate is deliberate and this is what pins its home.
    expect(verifiedLib).toContain(INTEGRITY_TIER_BASIS);
    expect(verifiedLib).toContain(LEVEL_FLAIR_BASIS);
  });

  it("they say different things — a level is not an accuracy claim", () => {
    // The two marks sit side by side and read alike. If the explanations ever
    // collapse into each other the tooltips stop doing the only job they have.
    expect(INTEGRITY_TIER_BASIS).not.toEqual(LEVEL_FLAIR_BASIS);
    expect(LEVEL_FLAIR_BASIS.toLowerCase()).toContain("not how accurate");
    expect(INTEGRITY_TIER_BASIS.toLowerCase()).toContain("confirm");
  });

  it("all four renderers attach a tooltip to the mark it explains", () => {
    for (const [name, src] of [
      ["cert SSR", certSsr],
      ["cert SPA", certSpa],
      ["profile SSR", profileSsr],
      ["profile SPA", profileSpa],
    ] as const) {
      expect(src, `${name} renders a status mark with no explanation`).toContain(
        "INTEGRITY_TIER_BASIS",
      );
      expect(src, `${name} renders a level with no explanation`).toContain(
        "LEVEL_FLAIR_BASIS",
      );
    }
  });
});

describe("grader level flair on the certificate (US-1913 AC2)", () => {
  it("the edge sends the flair alongside the integrity tier", () => {
    expect(edgeRoute).toContain("publicLevelFlair(levelNumber)");
  });

  it("the flair is gated on the integrity standing, never shown alone", () => {
    // A level on its own is activity dressed as accuracy. It rides along only
    // after loadPublicSellerIntegrity has already returned a displayable tier.
    const fn = edgeRoute.slice(
      edgeRoute.indexOf("async function loadCertSellerIntegrity"),
    );
    const body = fn.slice(0, fn.indexOf("\n// ── GET /certificates"));
    expect(body.indexOf("if (!standing) return null;")).toBeGreaterThan(-1);
    expect(body.indexOf("if (!standing) return null;")).toBeLessThan(
      body.indexOf("rewardLevelFor(sellerUserId)"),
    );
  });

  it("both cert renderers render it", () => {
    expect(certSsr).toContain("graderLevelHtml");
    expect(certSpa).toContain("sellerIntegrity.level");
  });
});

describe("status badge embeds (US-1913 AC1)", () => {
  it("Badge Studio offers the plain/status choice per embed", () => {
    // "Opt-in per embed" is the AC: the storefront badge and the per-listing
    // cert badge each carry their own switch, because a seller may want their
    // standing on one and not the other.
    expect(studio).toContain("StatusToggle");
    expect(studio).toContain("sellerStatus");
    expect(studio).toContain("certStatus");
  });

  it("the status choice reaches the image URL, not just the preview", () => {
    expect(verifiedLib).toContain("status=1");
    // Both badge kinds take the variant, so a copied snippet renders the same
    // badge the seller previewed.
    expect(verifiedLib).toMatch(/certBadgeUrl\(\s*certId: string,\s*variant/);
    expect(verifiedLib).toMatch(/verifiedSellerBadgeUrl\([\s\S]{0,160}variant: BadgeVariant/);
  });

  it("the text badge has no status variant", () => {
    // It is pasted once and never redrawn, so a tier baked into it would freeze
    // at copy time — the exact failure AC3 exists to prevent.
    const fn = verifiedLib.slice(verifiedLib.indexOf("export function certBadgeEmbedText"));
    expect(fn.slice(0, fn.indexOf("\n}"))).not.toContain("variant");
  });
});

describe("status badge click attribution (US-1913 AC5)", () => {
  it("?s=embed is preserved — the variant rides its own param", () => {
    // Folding the format into ?s= would retroactively redefine every historical
    // `embed` row as "plain badge", which the data does not support.
    expect(verifiedLib).toContain('`${shareUrl}&v=status`');
    expect(verifiedLib).toContain('certificateShareUrl(certId, "embed")');
    expect(verifiedLib).toContain('profileShareUrl(handle, "embed")');
    expect(verifiedLib).not.toContain('"embed_status"');
  });

  it("both landing pages report which badge format sent the visitor", () => {
    expect(certSpa).toContain('parseBadgeVariant(searchParams.get("v"))');
    expect(profileSpa).toContain('parseBadgeVariant(params.get("v"))');
  });

  it("an unknown variant reads as plain", () => {
    // Untrusted input: the worst a spoofer can do is mislabel their own clicks.
    expect(verifiedLib).toContain('raw === "status" ? "status" : "plain"');
  });
});
