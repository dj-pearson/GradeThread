// US-1912 AC3: the grader's Grade Integrity tier on the public certificate.
//
// The certificate has the same TWO READ PATHS the verified profile does — humans
// in production get the Pages Function SSR (functions/cert/[id].ts), the SPA
// route (src/pages/certificate.tsx) serves in-app and dev — and both consume the
// SAME edge payload from /api/content/public/certificates/:id. Adding the field
// to one renderer and stopping fails silently: it just reads `undefined` on the
// other and the badge vanishes with nothing going red.
//
// That is worse for this field than for a photo or a title. A Grade Integrity
// tier is a trust claim a buyer acts on, so a cert that shows it on one path and
// not the other tells two buyers two different things about the same seller.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const edgeRoute = readFileSync(
  "services/edge-functions/src/routes/content-public.ts",
  "utf8",
);
const ssr = readFileSync("functions/cert/[id].ts", "utf8");
const spa = readFileSync("src/pages/certificate.tsx", "utf8");

describe("certificate seller integrity (US-1912 AC3)", () => {
  it("the edge cert payload carries the projected standing", () => {
    expect(edgeRoute).toContain("seller_integrity: sellerIntegrity");
    expect(edgeRoute).toContain("loadCertSellerIntegrity(");
  });

  it("the standing is gated on a PUBLIC profile, not just on the tier", () => {
    // A tier is a public reputation claim. A seller who never published a
    // verified profile does not acquire one by having graded something, so the
    // opt-in gate has to live beside the floor — not instead of it.
    const fn = edgeRoute.slice(
      edgeRoute.indexOf("async function loadCertSellerIntegrity"),
    );
    const body = fn.slice(0, fn.indexOf("\n// ── GET /certificates"));
    expect(body).toContain("verified_enabled");
    expect(body).toContain("loadPublicSellerIntegrity(sellerUserId)");
  });

  it("both renderers render the standing", () => {
    expect(ssr).toContain("cert.seller_integrity");
    expect(ssr).toContain("${graderHtml}");
    expect(spa).toContain("seller_integrity");
    expect(spa).toContain("sellerIntegrity.label");
  });

  it("both renderers link the claim to the profile it is checkable against", () => {
    // A standing nobody can go and inspect is decoration. Both paths link to
    // /verified/:handle, which is the page the tier was computed for.
    expect(ssr).toContain("/verified/");
    expect(spa).toContain("/verified/");
  });

  it("neither renderer re-decides who qualifies", () => {
    // The anti-gaming floor and the opt-in gate live in ONE place, at the edge
    // read. A renderer re-implementing either would be a second copy of a rule
    // that decides what buyers are told — and a copied rule goes stale on one
    // side without anything failing.
    for (const [name, src] of [["ssr", ssr], ["spa", spa]] as const) {
      expect(src, `${name} re-implements the confirmed-outcome floor`)
        .not.toContain("MIN_CONFIRMED_FOR_TIER");
      // Lookbehind excludes `structural_integrity_score`, which is a GRADING
      // factor on the report and has nothing to do with the seller's standing.
      expect(
        /(?<!structural_)integrity_score/.test(src),
        `${name} exposes the raw seller integrity score`,
      ).toBe(false);
      expect(src, `${name} re-checks the profile opt-in`)
        .not.toContain("verified_enabled");
    }
  });

  it("the SPA clears the standing between certificates", () => {
    // US-1632's A→B navigation race: a stale standing left over from the
    // previous certificate would attribute one seller's record to another.
    expect(spa).toContain("setSellerIntegrity(null)");
  });
});
