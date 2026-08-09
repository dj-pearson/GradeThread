// US-2225 AC3: a condition grade must never read as an authenticity verdict.
//
// A handbag is the one item where both land on the same certificate. Every
// authentication tell pack GradeThread holds is for a bag brand — louisvuitton,
// coach, gucci — so the authenticity add-on converges on exactly the items
// where a buyer is most likely to read the condition number as a statement
// about whether the bag is real. On a four-figure resale that misreading is a
// liability, not a UX regret, which is why the AC asks for the RENDERED copy to
// be asserted rather than the prompt that requests it. A prompt is a request;
// the page is a claim.
//
// Two surfaces render a certificate and neither can import the other: the SPA
// (src/pages/certificate.tsx, via src/lib/rubrics.ts) and the Cloudflare Pages
// SSR page (functions/cert/[id].ts, via functions/_shared). So the copy exists
// twice and this file is what keeps the two from drifting — the same remedy
// src/test/embed-grade-widget.test.ts uses for the AI disclosure.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AUTHENTICITY_ADJACENT_RUBRIC_KEYS as SSR_KEYS,
  CONDITION_NOT_AUTHENTICITY_DISCLOSURE as SSR_COPY,
  conditionAuthenticityNoticeHtml,
  needsAuthenticitySeparation as ssrNeeds,
} from "../../functions/_shared/condition-authenticity";
import {
  AUTHENTICITY_ADJACENT_RUBRIC_KEYS as SPA_KEYS,
  CONDITION_NOT_AUTHENTICITY_DISCLOSURE as SPA_COPY,
  needsAuthenticitySeparation as spaNeeds,
  rubricForKey,
} from "../lib/rubrics";

const CERT_SSR = readFileSync("functions/cert/[id].ts", "utf8");
const CERT_SPA = readFileSync("src/pages/certificate.tsx", "utf8");
const EDGE_RUBRIC = readFileSync("services/edge-functions/src/lib/rubric.ts", "utf8");

describe("US-2225 AC3: the separation exists and says the right thing", () => {
  it("states plainly that the grade is not an authenticity opinion", () => {
    // Asserted on the WORDS, not just on presence. "Condition only" without
    // naming authenticity would leave the reader to make the connection, which
    // is exactly what they are failing to make.
    expect(SPA_COPY).toContain("condition grade only");
    expect(SPA_COPY).toContain("authentic");
  });

  it("is identical across the SPA and the SSR page, string for string", () => {
    // The two copies exist because a Pages Function cannot import from src/.
    // Nothing else stops them drifting.
    expect(SSR_COPY).toBe(SPA_COPY);
    expect([...SSR_KEYS]).toEqual([...SPA_KEYS]);
  });

  it("covers handbags — the rubric the authenticity packs actually target", () => {
    expect(spaNeeds("handbags")).toBe(true);
    expect(ssrNeeds("handbags")).toBe(true);
  });

  it("does NOT fire for clothing, so existing certificates are unchanged", () => {
    for (const key of ["clothing", "sports_cards", "watches", "shoes"]) {
      expect(spaNeeds(key), key).toBe(false);
      expect(ssrNeeds(key), key).toBe(false);
    }
    // Absent / unknown must not fire either — a legacy certificate carries no
    // rubric_key at all and must render byte-identically to before.
    expect(spaNeeds(null)).toBe(false);
    expect(spaNeeds(undefined)).toBe(false);
    expect(ssrNeeds("")).toBe(false);
  });
});

describe("US-2225 AC3: it is rendered, not merely defined", () => {
  it("the SSR page emits the notice for a handbag certificate", () => {
    const html = conditionAuthenticityNoticeHtml("handbags");
    expect(html).toContain("condition grade only");
    expect(html).toContain("authentic");
  });

  it("the SSR page emits NOTHING for every other rubric", () => {
    for (const key of ["clothing", "watches", null, undefined]) {
      expect(conditionAuthenticityNoticeHtml(key)).toBe("");
    }
  });

  it("the SSR notice is placed with the factor breakdown, not in a footer", () => {
    // Adjacency is the property. A separation rendered at the bottom of the
    // page is a disclaimer nobody reaches, which is indistinguishable from not
    // having one — so this pins that the notice is emitted as part of
    // factorsHtml rather than appended somewhere later in the template.
    expect(CERT_SSR).toMatch(
      /const factorsHtml = `\$\{conditionOnlyHtml\}<div class="cert-factors">/,
    );
  });

  it("the SPA renders it inside the Factor Breakdown card", () => {
    const cardStart = CERT_SPA.indexOf("Factor Breakdown");
    expect(cardStart).toBeGreaterThan(-1);
    const card = CERT_SPA.slice(cardStart, cardStart + 1600);
    expect(card).toContain("needsAuthenticitySeparation(activeRubric.key)");
    expect(card).toContain("CONDITION_NOT_AUTHENTICITY_DISCLOSURE");
  });
});

describe("US-2225 AC1: the handbags rubric is real and coherent", () => {
  it("exists on the client with weights summing to exactly 1", () => {
    const r = rubricForKey("handbags");
    expect(r.key).toBe("handbags");
    const total = r.factors.reduce((s, f) => s + f.weight, 0);
    // Float-safe: 0.3 + 0.2 + 0.15 + 0.15 + 0.1 + 0.1 does not land on 1
    // exactly in IEEE 754, and a strict equality here would be a test that
    // fails for a reason unrelated to the rubric.
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  it("grades a bag on corners and edges above anything else", () => {
    // The story's core claim: corner and edge-paint wear is the most-inspected
    // area and the most expensive to restore, so it must outweigh every other
    // factor. A rubric that spread the weight evenly would be the clothing
    // problem in new clothes.
    const r = rubricForKey("handbags");
    const sorted = [...r.factors].sort((a, b) => b.weight - a.weight);
    expect(sorted[0]!.key).toBe("corners_edges");
    expect(sorted[0]!.weight).toBeGreaterThan(sorted[1]!.weight);
  });

  it("the server prompt guidance forbids an authenticity claim", () => {
    // The rendered copy above is the guard for the buyer. This is the guard for
    // the WRITE-UP: the model is told, in the rubric that will build its
    // prompt, not to comment on authenticity — so the separation holds in the
    // generated text too, which no assertion on the page template can reach.
    const block = EDGE_RUBRIC.slice(EDGE_RUBRIC.indexOf("const HANDBAGS"));
    const guidance = block.slice(0, block.indexOf("defectRouting"));
    expect(guidance).toContain("Say nothing about whether it is authentic");
  });
});
