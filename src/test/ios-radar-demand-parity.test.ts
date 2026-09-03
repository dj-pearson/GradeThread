import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-3106 — the iOS Radar link and demand strip talk to routes the web already
// talks to. Both sides are checked here rather than only in XCTest, because
// Swift compiles only in the macOS lane and these are cross-language claims:
// the person who renames a field is usually editing the TypeScript.
//
//   1. The link body keys the phone sends are the ones the route parses.
//   2. The demand facet fields the phone decodes are the ones the edge emits.

const ROOT = resolve(__dirname, "../..");
const SWIFT_TYPES = resolve(ROOT, "ios/GradeThread/Prospect/RadarTypes.swift");
const SWIFT_DEMAND = resolve(ROOT, "ios/GradeThread/Prospect/DemandService.swift");
const EDGE_RADAR = resolve(ROOT, "services/edge-functions/src/routes/flipdesk-radar.ts");
const EDGE_DEMAND = resolve(ROOT, "services/edge-functions/src/lib/demand-board.ts");

describe("iOS Radar link + demand parity (US-3106)", () => {
  it("the link route still parses source_id and venue_id", () => {
    const edge = readFileSync(EDGE_RADAR, "utf8");
    const at = edge.indexOf('flipdeskRadarRoutes.post("/my-stores/link"');
    expect(at, "the link route moved or was renamed").toBeGreaterThan(-1);
    const handler = edge.slice(at, at + 2000);
    expect(handler).toContain("body.source_id");
    expect(handler).toContain("body.venue_id");
  });

  it("the Swift request spells those two keys in camelCase so the encoder converts them", () => {
    // The shared EdgeAPI encoder is `.convertToSnakeCase`. Writing `source_id`
    // in Swift would double-convert to `source__id`, and the route would answer
    // "source_id is required" for a request that plainly carries one.
    const swift = readFileSync(SWIFT_TYPES, "utf8");
    const at = swift.indexOf("struct RadarLinkRequest");
    expect(at, "RadarLinkRequest not found").toBeGreaterThan(-1);
    const body = swift.slice(at, swift.indexOf("\n}", at));
    expect(body).toContain("let sourceId: String");
    expect(body).toContain("let venueId: String?");
    expect(body).not.toContain("source_id");
    expect(body).not.toContain("CodingKeys");
  });

  it("the demand facet fields match the ones the edge emits", () => {
    const edge = readFileSync(EDGE_DEMAND, "utf8");
    const at = edge.indexOf("export interface DemandFacet");
    expect(at, "DemandFacet not found on the edge").toBeGreaterThan(-1);
    const block = edge.slice(at, edge.indexOf("}", at));
    const edgeFields = [...block.matchAll(/^\s*(\w+)[?]?:/gm)]
      .flatMap((m) => (m[1] ? [m[1]] : []))
      .sort();

    const swift = readFileSync(SWIFT_DEMAND, "utf8");
    const structAt = swift.indexOf("struct DemandFacet");
    const structBlock = swift.slice(structAt, swift.indexOf("var id: String", structAt));
    const swiftFields = [...structBlock.matchAll(/^\s{4}let (\w+):/gm)]
      .flatMap((m) => (m[1] ? [m[1]] : []))
      .sort();

    expect(edgeFields).toEqual(["term", "topMaxPriceCents", "topMinGrade", "wantCount"].sort());
    expect(swiftFields).toEqual(edgeFields);
  });

  it("the demand route is gated on compPulls, which is why the strip may be absent", () => {
    // The strip hides rather than showing a second upgrade prompt. That is only
    // correct while the route actually gates — if the gate is ever removed, the
    // strip should stop treating an empty answer as "you don't have the plan".
    const edge = readFileSync(
      resolve(ROOT, "services/edge-functions/src/routes/flipdesk-demand.ts"),
      "utf8",
    );
    expect(edge).toContain('feature: "compPulls"');
  });

  it("the iOS map uses MapKit and no tile URL of ours", () => {
    // RadarNearbyView was built without a map on purpose: tile URLs ARE the
    // viewport, so a third-party tile map streams the seller's neighbourhood to
    // whoever serves the tiles. MapKit is the one exception and the reasoning is
    // in RadarMap.swift — a fetched tile template appearing here would be a
    // silent reversal of that.
    const map = readFileSync(resolve(ROOT, "ios/GradeThread/Prospect/RadarMap.swift"), "utf8");
    const view = readFileSync(
      resolve(ROOT, "ios/GradeThread/Prospect/RadarNearbyView.swift"),
      "utf8",
    );
    expect(view).toContain("import MapKit");
    expect(map + view).not.toMatch(/https?:\/\/[^\s"']*\{[xyz]\}/);
    expect(map + view).not.toMatch(/tile\.(openstreetmap|mapbox)/);
  });
});
