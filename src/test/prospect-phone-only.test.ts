import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_SURFACES } from "@/lib/surfaces";

// US-2878. Prospect is phone-only, ON PURPOSE, and the web now says so.
//
// WHAT THE STORY GOT WRONG, and it is worth reading before changing anything
// here: "the web says nothing about it" is not quite true. The web mentions
// Prospect in the privacy policy, in a Settings card about Thrift Radar
// contribution, in my-stores.tsx, and in the product glossary (US-2864). What
// it did not do was mention it ANYWHERE A SELLER DECIDING WHAT TO BUY WOULD
// LOOK. Every existing mention assumed you already knew what Prospect was.
//
// AND ONE MORE THING THE STORY DOES NOT SAY: the server endpoint
// /api/flipdesk/scout/prospect already exists. Prospect is not phone-only
// because the backend cannot do it. It is phone-only because the value is
// standing in a shop holding something you have not bought, and a desk is never
// in that situation. That distinction is the difference between a decision and
// an unfinished feature, and it is why this file guards the DECISION rather
// than guarding "nobody built a page".

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** TS/TSX comments, so a scan never fires on its own prose. */
const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/\/?.*$/gm, "");

const ADR = "vault/60-decisions/adr-prospect-stays-phone-only.md";
const ROW = "src/components/flipdesk/phone-only-row.tsx";
const SOURCING = "src/pages/flipdesk/sourcing.tsx";

describe("the decision is written down (US-2878 AC1)", () => {
  it("the ADR exists", () => {
    expect(existsSync(resolve(ROOT, ADR)), `${ADR} is missing`).toBe(true);
  });

  const adr = existsSync(resolve(ROOT, ADR)) ? read(ADR) : "";

  it("it is a decision note the vault index will pick up", () => {
    expect(adr).toContain("type: decision");
    expect(adr).toContain("status: accepted");
    expect(adr).toMatch(/^summary: .{40,}$/m);
  });

  it("it says which way the decision went, not just that there was one", () => {
    expect(adr).toContain("not built on the web");
  });

  it("it records that the endpoint already exists", () => {
    // The single most reversible-decision-relevant fact, and the one a reader
    // six months from now will get wrong: this is NOT a backend gap.
    expect(adr).toContain("`/api/flipdesk/scout/prospect`");
    expect(adr).toContain("reversing this is cheap");
  });

  it("the endpoint it names is actually there", () => {
    // If the route is ever deleted, the ADR's central claim quietly becomes
    // false and the "reversing is cheap" line becomes a lie.
    const scout = read("services/edge-functions/src/routes/flipdesk-scout.ts");
    expect(scout).toContain('flipdeskScoutRoutes.post("/prospect"');
  });
});

describe("the web Sourcing surface names it (US-2878 AC2)", () => {
  const page = stripComments(read(SOURCING));

  it("the row is rendered on Sourcing", () => {
    expect(page).toMatch(/<PhoneOnlyRow\b/);
  });

  it("the copy comes from the registry, not retyped", () => {
    // Retyped copy is how the web and the Tools hub end up describing one
    // feature two ways -- the exact failure US-2876 exists to stop.
    expect(page).toContain("ALL_SURFACES");
    expect(page).toContain("PROSPECT.label");
    expect(page).toContain("PROSPECT.description");
  });

  it("it says WHY, not just where", () => {
    // "On the app" with no reason reads as an oversight or a tease.
    const row = stripComments(read(ROW));
    expect(row).toContain("why: string");
    expect(page).toMatch(/why="[^"]{30,}"/);
  });

  it("it is not styled as a plan gate", () => {
    // The one rule. A seller should think "I should get the app", not "I should
    // upgrade". A lock, an Upgrade button or a disabled treatment here would
    // turn a fact about phones into a sales pitch.
    const row = stripComments(read(ROW));
    for (const banned of ["Lock", "Upgrade", "disabled", "explainGate", "requiresFlipdeskFlag"]) {
      expect(row, `PhoneOnlyRow reads as a paywall: it mentions ${banned}`).not.toContain(
        banned,
      );
    }
  });

  it("the row is reusable, because it is the pattern now", () => {
    // There was no phone-only treatment before this. Hardcoding Prospect into
    // it would mean the next phone-only surface invents a second one.
    const row = stripComments(read(ROW));
    expect(row, "PhoneOnlyRow hardcodes Prospect").not.toContain("Prospect");
    expect(row).toContain("label: string");
    expect(row).toContain("description: string");
  });
});

describe("the registry still records Prospect as a gap, not a page (US-2878 AC3)", () => {
  const prospect = ALL_SURFACES.find((s) => s.id === "prospect");

  it("it is still there, with no web route", () => {
    expect(prospect, "prospect left the registry").toBeDefined();
    expect(prospect!.ios).toBe("prospect");
    expect(
      prospect!.web,
      "prospect gained a web route. If that was deliberate, the ADR needs " +
        "superseding and this assertion needs to move -- not be deleted.",
    ).toBeNull();
  });

  it("the registry points at the decision rather than implying an oversight", () => {
    const src = read("src/lib/surfaces.ts");
    const at = src.indexOf('id: "prospect"');
    expect(at).toBeGreaterThan(-1);
    // The comment sits ABOVE the id, so read backwards from it.
    const above = src.slice(Math.max(0, at - 700), at);
    expect(above).toContain("adr-prospect-stays-phone-only");
    expect(above).toContain("DELIBERATELY");
  });
});

describe("the three comp tools say how they differ (US-2878 AC4)", () => {
  const byId = (id: string) => {
    const s = ALL_SURFACES.find((x) => x.id === id);
    expect(s, `${id} left the registry`).toBeDefined();
    return s!;
  };
  const snap = byId("snap");
  const scout = byId("scout");
  const prospect = byId("prospect");

  it("Snap to Value says the garment is already yours", () => {
    expect(snap.description.toLowerCase()).toMatch(/already own|you own/);
  });

  it("Prospect says it happens before you buy", () => {
    expect(prospect.description.toLowerCase()).toContain("before you buy");
  });

  it("Scout says it is about finding listings, not valuing yours", () => {
    expect(scout.description.toLowerCase()).toMatch(/search|find/);
    expect(scout.description.toLowerCase()).toContain("ebay");
  });

  it("no two of the three read the same", () => {
    const three = [snap.description, scout.description, prospect.description];
    expect(new Set(three).size, "two of the three tools share a description").toBe(3);
  });

  it("each is one sentence a person could read", () => {
    for (const s of [snap, scout, prospect]) {
      expect(s.description.trim().endsWith("."), `${s.id} is not a sentence`).toBe(true);
      expect(
        s.description.slice(0, -1).includes(". "),
        `${s.id} is two sentences; one tool gets one`,
      ).toBe(false);
      expect(s.description.length, `${s.id} is too long`).toBeLessThanOrEqual(90);
    }
  });

  it("the glossary agrees with the registry about Prospect being phone-only", () => {
    // US-2864's product glossary defines Prospect too. Two definitions of one
    // invented word is exactly the drift this epic keeps finding.
    const terms = read("src/lib/product-terms.ts");
    const at = terms.indexOf('term: "Prospect"');
    expect(at, "Prospect left the glossary").toBeGreaterThan(-1);
    const entry = terms.slice(at, at + 400);
    expect(entry.toLowerCase()).toMatch(/phone app only|phone only/);
  });

  it("iOS carries the same three sentences, via the generated mirror", () => {
    const mirror = read("ios/GradeThread/Tools/ProductSurfaces.swift");
    for (const s of [snap, scout, prospect]) {
      expect(mirror, `${s.id}'s sentence did not reach iOS`).toContain(
        `summary: "${s.description}"`,
      );
    }
  });
});
