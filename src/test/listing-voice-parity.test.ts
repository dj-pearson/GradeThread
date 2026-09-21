// US-3211 AC4: the web's preset list must match the server's.
//
// The server decides what a stored value MEANS (resolveVoicePrompt) and the
// web decides what it LOOKS like. If the two disagree about which preset an
// empty column represents, a seller sees Plain facts selected while the
// generator writes in the old register, and nothing on either screen is wrong
// about itself.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_LISTING_VOICE_PRESET,
  LISTING_VOICE_PRESETS,
  presetFor,
  STANDARD_SENTINEL,
} from "@/lib/listing-voice-presets";

const SERVER = readFileSync(
  resolve(process.cwd(), "services/edge-functions/src/lib/listing-voice-presets.ts"),
  "utf8",
);

describe("the voice presets agree across web and edge (US-3211)", () => {
  it("same preset ids, same order", () => {
    const m = /export const LISTING_VOICE_PRESETS = \[([^\]]+)\]/.exec(SERVER);
    expect(m, "LISTING_VOICE_PRESETS not found on the server").toBeTruthy();
    const ids = [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect([...LISTING_VOICE_PRESETS]).toEqual(ids);
  });

  it("same default, and the same sentinel", () => {
    expect(SERVER).toContain(`DEFAULT_LISTING_VOICE_PRESET: ListingVoicePreset = "${DEFAULT_LISTING_VOICE_PRESET}"`);
    expect(SERVER).toContain(`STANDARD_SENTINEL = "${STANDARD_SENTINEL}"`);
  });

  it("presetFor answers the same three ways on both sides", () => {
    expect(presetFor(null)).toBe("plain_facts");
    expect(presetFor("")).toBe("plain_facts");
    expect(presetFor(STANDARD_SENTINEL)).toBe("standard");
    expect(presetFor("my own words")).toBe("custom");
    // And the server's function is the same three branches, read as text
    // because the edge module imports .ts extensions the web build will not
    // resolve.
    const body = SERVER.slice(SERVER.indexOf("export function presetFor"));
    expect(body).toMatch(/STANDARD_SENTINEL\)\s*return\s*"standard"/);
    expect(body).toMatch(/text === ""\)\s*return\s*"plain_facts"/);
    expect(body).toMatch(/return\s*"custom"/);
  });

  it("an untouched account resolves to the Plain facts prompt, not to nothing", () => {
    // The behaviour change AC4 asks for, asserted where it is easy to undo by
    // accident: `return text === "" ? null : text` is what it used to be.
    const body = SERVER.slice(SERVER.indexOf("export function resolveVoicePrompt"));
    expect(body).toMatch(/if \(text === ""\) return PLAIN_FACTS_PROMPT;/);
  });
});
