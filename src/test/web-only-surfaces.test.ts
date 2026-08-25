import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALL_SURFACES,
  onlyOn,
  singleClientSurfaces,
  type Surface,
} from "@/lib/surfaces";

// US-2879. Four web surfaces were said to have no iOS equivalent. Three do.
//
// THE STORY'S LIST WAS WRONG, AND HOW IT WAS WRONG IS THE POINT. `ios` in the
// registry is the TOOLS HUB route. `ios: null` means "not a row in the Tools
// hub" -- and US-2876's comment on that field said it meant "iOS does not have
// this at all". Eleven surfaces live outside the hub, so reading null as
// absence over-reported the gap fourfold. Offers & Messages is the clearest
// case: 666 lines of NegotiationInboxView, reachable from three places, and the
// registry said null.
//
// `iosElsewhere` names the Swift file for each of those eleven, and this file
// checks the files exist -- so the correction cannot rot back into a claim
// about screens somebody deleted.
//
// Decision and reasoning: vault/60-decisions/adr-web-only-surfaces.md

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const exists = (p: string) => existsSync(resolve(ROOT, p));

const ADR = "vault/60-decisions/adr-web-only-surfaces.md";

describe("a gap is never a silence (US-2879 AC1, AC3)", () => {
  const single = singleClientSurfaces();

  it("there are single-client surfaces to check", () => {
    // If this ever reads zero the rest of the file passes vacuously.
    expect(single.length).toBeGreaterThan(2);
  });

  it("every single-client surface says why", () => {
    const silent = single.filter((s) => !s.onlyReason).map((s) => s.id);
    expect(
      silent,
      "these exist on one client with no reason recorded. A gap with no " +
        "reason is indistinguishable from a gap nobody noticed: the next " +
        "person either builds something that was deliberately not built, or " +
        "leaves unbuilt something that was simply forgotten.",
    ).toEqual([]);
  });

  it("each reason is a real explanation, not a label", () => {
    for (const s of single) {
      expect(s.onlyReason!.length, `${s.id}'s reason is too short to explain anything`)
        .toBeGreaterThan(80);
      expect(
        /deliberately|on purpose|by design/i.test(s.onlyReason!),
        `${s.id}'s reason does not say the absence is a choice`,
      ).toBe(true);
    }
  });

  it("both directions use the one field", () => {
    // US-2879 asked for a `webOnly` reason. US-2878 had already established
    // the same need pointing the other way, and two fields would have drifted.
    const src = read("src/lib/surfaces.ts");
    expect(
      /^\s*webOnlyReason[?]?:/m.test(src) || /^\s*iosOnlyReason[?]?:/m.test(src),
      "a second, direction-specific reason field appeared",
    ).toBe(false);
    const dirs = new Set(single.map((s) => onlyOn(s)));
    expect(dirs.has("web"), "no web-only surface found").toBe(true);
    expect(dirs.has("ios"), "no iOS-only surface found").toBe(true);
  });

  it("the three measured web-only surfaces are exactly these", () => {
    // Measured 2026-08-25. Pinned so that building one of them, or losing
    // another, is a deliberate edit with a note rather than a drift.
    const webOnly = ALL_SURFACES.filter((s) => onlyOn(s) === "web").map((s) => s.id);
    expect(webOnly.sort()).toEqual(["developers", "measure-card", "rewards"]);
  });

  it("the helper that miscounted gaps is gone", () => {
    // clientGaps() filtered on `ios === null` and so called fourteen surfaces
    // missing that iOS has. It had no callers, which is the only reason it
    // never told anybody. Bringing it back reintroduces the same wrong answer.
    const src = read("src/lib/surfaces.ts");
    expect(
      /export function clientGaps/.test(src),
      "clientGaps() is back, and it counts a non-hub surface as a gap",
    ).toBe(false);
  });

  it("Prospect is still the one going the other way", () => {
    const iosOnly = ALL_SURFACES.filter((s) => onlyOn(s) === "ios").map((s) => s.id);
    expect(iosOnly.sort()).toEqual(["prospect"]);
  });
});

describe("iosElsewhere is a claim about a real file (US-2879 AC3)", () => {
  const withElsewhere = ALL_SURFACES.filter((s) => s.iosElsewhere);

  it("eleven-ish surfaces live outside the Tools hub", () => {
    expect(withElsewhere.length).toBeGreaterThan(10);
  });

  it("every named Swift file exists", () => {
    const gone = withElsewhere
      .filter((s) => !exists(s.iosElsewhere!))
      .map((s) => `${s.id} -> ${s.iosElsewhere}`);
    expect(gone, "iosElsewhere names files that are not there").toEqual([]);
  });

  it("every named file declares a view or is the shell", () => {
    // A path that exists but holds no screen is the same lie with extra steps.
    for (const s of withElsewhere) {
      const src = read(s.iosElsewhere!);
      expect(
        /^struct \w+(View|Sheet)\b/m.test(src),
        `${s.iosElsewhere} declares no View or Sheet, so it is not where ${s.id} lives`,
      ).toBe(true);
    }
  });

  it("a surface never claims both a hub route and an elsewhere", () => {
    const both = ALL_SURFACES.filter((s) => s.ios !== null && s.iosElsewhere).map((s) => s.id);
    expect(both, "ios and iosElsewhere are alternatives, not a pair").toEqual([]);
  });

  it("the two the story got wrong are recorded as present, not missing", () => {
    // Offers & Messages and the help reader. If either loses its
    // iosElsewhere, the registry goes back to claiming a gap that is not there.
    const offers = ALL_SURFACES.find((s) => s.id === "offers")!;
    expect(offers.iosElsewhere).toContain("NegotiationInboxView.swift");
    const help = ALL_SURFACES.find((s) => s.id === "help")!;
    expect(help.iosElsewhere).toContain("HelpSheet.swift");
  });

  it("the field comment warns the next reader off the old reading", () => {
    // The whole defect was a comment that said `ios: null` meant absence.
    const src = read("src/lib/surfaces.ts");
    const at = src.indexOf("ios: string | null;");
    expect(at).toBeGreaterThan(-1);
    const above = src.slice(Math.max(0, at - 900), at);
    expect(above).toContain("TOOLS HUB route");
    expect(above).toContain("NOT");
  });
});

describe("the decision is written down (US-2879 AC1)", () => {
  it("the ADR exists and is a decision note", () => {
    expect(exists(ADR), `${ADR} is missing`).toBe(true);
    const adr = read(ADR);
    expect(adr).toContain("type: decision");
    expect(adr).toContain("status: accepted");
  });

  it("it names all three, and says which way each went", () => {
    const adr = read(ADR);
    for (const name of ["Rewards", "MeasureCard", "Developers"]) {
      expect(adr, `${name} is not in the ADR`).toContain(name);
    }
    expect(adr).toContain("not built on iOS");
  });

  it("it records that the story's list was wrong", () => {
    // Two of the four already existed. Leaving that out would let somebody
    // re-file the same story next quarter.
    const adr = read(ADR);
    expect(adr).toContain("NegotiationInboxView");
    expect(adr).toContain("HelpSheet.swift");
  });

  it("it says why AC2 is not done, rather than pretending it is", () => {
    const adr = read(ADR);
    expect(adr).toContain("no authenticated web handoff");
    expect(adr).toContain("filed as its own story");
  });

  it("the handoff it says does not exist, still does not exist", () => {
    // If somebody builds one, this assertion is how the ADR's §4 gets
    // revisited instead of quietly becoming false.
    const swift = ["ios/GradeThread/Marketplaces/EbayConnectionService.swift"];
    for (const f of swift) expect(exists(f)).toBe(true);
    // A session-minting endpoint would live in the edge routes.
    const routes = read("services/edge-functions/src/main.ts");
    expect(
      /web-handoff|session-handoff|sessionHandoff/.test(routes),
      "a web session handoff appears to exist now -- revisit ADR §4",
    ).toBe(false);
  });
});

describe("the reasons read like a person wrote them", () => {
  for (const s of singleClientSurfaces()) {
    it(`${s.id}'s reason is plain`, () => {
      const why: string = (s as Surface).onlyReason!;
      expect(why.trim().endsWith("."), `${s.id}'s reason is not a sentence`).toBe(true);
      // No jargon smuggled in from the story text.
      for (const banned of ["leverage", "robust", "seamless", "holistic"]) {
        expect(why.toLowerCase(), `${s.id}'s reason says "${banned}"`).not.toContain(banned);
      }
    });
  }
});
