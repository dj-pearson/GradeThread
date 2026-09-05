import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs operator script, no types
import { TARGETS, ogFallbackNote } from "../../scripts/ops/uptime-check.mjs";

// US-2619 AC3/AC4: an OG endpoint is checked as an IMAGE, not as a status code.
//
// THE FAILURE. /og/social/card returns HTTP 200, Content-Type image/png, and
// ZERO BYTES. workers-og's ImageResponse streams, so the raster happens as the
// body is consumed — after the Response was built and returned — and the
// route's try/catch cannot see a failure that happens then. The catch never
// fires, the branded fallback never runs, and the client gets a well-formed 200
// with nothing in it. Every auto-filled social image on the site is blank.
//
// THREE STATES THAT ALL LOOK IDENTICAL from outside, which is why status-code
// monitoring never noticed:
//   zero bytes   — broken, and must FAIL
//   the fallback — graceful, and must be a NOTE, because the real renderer did
//                  not run and nobody would otherwise know
//   a real render — fine
//
// The second is the one worth having. /og/help and /og/verified returned 133915
// bytes and read as healthy for months; that number was the static branded
// card, and their actual render path had never once executed.

interface Target {
  id: string;
  url: string;
  ok: (status: number) => boolean;
  bytesOk?: (bytes: number) => boolean;
  bytesNote?: (bytes: number) => string | null;
}

const card = (TARGETS as Target[]).find((t) => t.id === "og_social_card");

describe("US-2619: the social card is checked as an image", () => {
  it("is a monitored target at all", () => {
    expect(
      card,
      "og_social_card is missing from TARGETS — the endpoint that serves every " +
        "auto-filled social image is unmonitored",
    ).toBeTruthy();
    expect(card!.url).toContain("/og/social/card");
  });

  it("a zero-byte 200 FAILS rather than passing as an image", () => {
    // The whole defect in one assertion. Before this, a 200 was a pass.
    expect(card!.ok(200)).toBe(true);
    expect(
      card!.bytesOk!(0),
      "a 200 image/png with no body is a blank link preview everywhere it is " +
        "used, and must not read as up",
    ).toBe(false);
  });

  it("a real render passes", () => {
    expect(card!.bytesOk!(134022)).toBe(true);
    expect(card!.bytesOk!(1)).toBe(true);
  });

  it("a non-200 still fails on status alone", () => {
    expect(card!.ok(500)).toBe(false);
    expect(card!.ok(404)).toBe(false);
  });
});

describe("ogFallbackNote: telling a graceful answer from a real one", () => {
  const FALLBACK = 133915;

  it("names the fallback when the byte count matches exactly", () => {
    const note = ogFallbackNote("og/social/card", FALLBACK, FALLBACK);
    expect(note).toBeTruthy();
    expect(note).toContain("BRANDED FALLBACK");
    expect(note).toContain("og/social/card");
    // The note has to say what it means, not just that it happened: "serving
    // the fallback" is not an outage, it is the renderer never having run.
    expect(note).toContain("the real renderer did not run");
  });

  it("says nothing about a real render", () => {
    expect(ogFallbackNote("og/social/card", 134022, FALLBACK)).toBeNull();
    expect(ogFallbackNote("og/social/card", FALLBACK - 1, FALLBACK)).toBeNull();
  });

  it("says nothing about zero bytes, which is already a FAILURE", () => {
    // Reporting it twice — once as down, once as a note — makes the incident
    // line read as two problems.
    expect(ogFallbackNote("og/social/card", 0, FALLBACK)).toBeNull();
  });

  it("says nothing when the fallback size could not be measured", () => {
    // measureFallbackBytes is best-effort. A failure to measure must cost the
    // NOTE and never invent an alert: a monitor that cries wolf is one people
    // switch off, and then the next real outage arrives into a channel nobody
    // reads.
    expect(ogFallbackNote("og/social/card", 134022, null)).toBeNull();
    expect(ogFallbackNote("og/social/card", 134022, 0)).toBeNull();
    expect(ogFallbackNote("og/social/card", 134022, undefined)).toBeNull();
  });
});
