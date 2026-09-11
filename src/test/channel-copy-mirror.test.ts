// The two copies of the per-channel title rule must not drift (2026-09-11).
//
// src/lib/channel-copy.ts (the Listing Kit's title and its send-to-extension
// button) and services/edge-functions/src/lib/channel-copy.ts (the queued
// extension job, the cross-push fan-out and the phone kits) both decide what
// title a marketplace gets. The edge and the SPA share no module graph, so the
// rule exists twice. A drift is the same item reaching Poshmark with one title
// from the desk and another from a phone.
//
// The headers differ on purpose, so the comparison runs from the first export
// to the end of the file, with comments and whitespace removed.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fitTitle,
  readChannelOverrides,
  resolveChannelTitle,
} from "@/lib/channel-copy";

const WEB = resolve("src/lib/channel-copy.ts");
const EDGE = resolve("services/edge-functions/src/lib/channel-copy.ts");
const START = "export const CHANNEL_COPY_KEYS";

function body(src: string): string {
  const start = src.indexOf(START);
  if (start === -1) return "";
  return src
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("channel copy edge/web mirror", () => {
  const web = readFileSync(WEB, "utf8");
  const edge = readFileSync(EDGE, "utf8");

  it("both files carry the marker the comparison starts from", () => {
    expect(web).toContain(START);
    expect(edge).toContain(START);
  });

  it("the rule is identical, token for token", () => {
    const a = body(web);
    // Two empty strings would compare equal and check nothing.
    expect(a.length, "the web copy's mirrored region has shrunk to nothing")
      .toBeGreaterThan(500);
    expect(body(edge), "the two copies of the channel title rule have drifted").toBe(a);
  });
});

describe("resolveChannelTitle (web copy)", () => {
  const ebay =
    "Cozy Earth Bamboo Jogger Set Sz 3XL Navy Blue Hooded Pullover Lounge Pants";

  it("copies eBay, fitted to the channel", () => {
    expect(resolveChannelTitle("poshmark", { sharedTitle: ebay })).toBe(ebay);
    expect(resolveChannelTitle("grailed", { sharedTitle: ebay })).toBe(
      "Cozy Earth Bamboo Jogger Set Sz 3XL Navy Blue Hooded",
    );
    expect(resolveChannelTitle("depop", { sharedTitle: ebay })).toBe("");
  });

  it("lets the seller's override win", () => {
    expect(
      resolveChannelTitle("mercari", { override: "Mine", sharedTitle: ebay }),
    ).toBe("Mine");
  });

  it("reads overrides defensively", () => {
    expect(readChannelOverrides({ title_override: " " }).title).toBeNull();
    expect(fitTitle("aaaa bbbb cccc", 11)).toBe("aaaa bbbb");
  });
});
