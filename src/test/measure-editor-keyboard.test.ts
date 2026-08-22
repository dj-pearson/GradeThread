import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2686. The web measurement editor could only be operated with a mouse drag.
//
// A pointer drag on a bare SVG is reachable by exactly one input method: there
// is no keyboard equivalent and nothing for a screen reader to hold, so a
// keyboard-only user could not set a measurement at all. Same total gap iOS had
// (US-2534), on the client most likely to be audited for it.
//
// WHY A SOURCE SCAN RATHER THAN A RENDER TEST. Mounting this component needs a
// Supabase client, two react-query fetches, an <img> that reports
// naturalWidth/naturalHeight, and a laid-out SVG — jsdom reports zero for all
// of the geometry, so a render test would assert that a 0x0 endpoint received a
// keydown. That proves the wiring compiles, not that the control works. The
// MATHS is properly unit-tested in src/lib/__tests__/measure-editor-math.test.ts
// against the shared fixture; this file holds the five properties of the
// COMPONENT that make those maths reachable.
//
// Every check below reads CODE LINES ONLY. The component's own comments explain
// the keyboard model and quote most of these tokens while doing it, so a
// whole-file scan would pass on the explanation rather than on the code — the
// fail-open shape the repo's guard notes list first.

const EDITOR = "src/components/flipdesk/measurement-photo-editor.tsx";

/**
 * The file with its comments removed.
 *
 * BLOCK COMMENTS ARE STRIPPED AS BLOCKS, not by line prefix. The first version
 * filtered lines starting with `//`, `/*` or `*`, which leaves the INTERIOR
 * lines of a JSX `{/* ... *\/}` comment behind — and the comment beside the
 * endpoint explains the keyboard model using the very tokens these assertions
 * look for, so `role="button"` was being satisfied by the prose describing it.
 */
function codeOf(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

/**
 * Just the `<circle …/>` element, which is the endpoint.
 *
 * SCOPED TIGHTLY, because the obvious slice is wrong: `<circle` to the next
 * `</g>` runs straight past the endpoints and into the label chip, whose
 * `<text>` also renders `displayVal(inches)`. The sabotage run caught it — an
 * aria-label stripped of its measurement stayed green, because the assertion
 * was reading the chip.
 */
function endpointElement(code: string): string {
  const start = code.indexOf("<circle");
  expect(start, "the endpoints are no longer <circle> elements").toBeGreaterThan(-1);
  const end = code.indexOf("/>", start);
  expect(end, "the <circle> element is not self-closing any more").toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("the measurement editor is operable without a pointer (US-2686)", () => {
  const code = codeOf(EDITOR);

  it("AC1: every endpoint is focusable and announced with its line and value", () => {
    // The endpoints are <circle> elements. tabIndex makes them reachable,
    // role="button" is what makes a screen reader announce them as operable
    // rather than reading a label and stopping, and the label has to carry the
    // measurement — an unnamed focus stop is a worse experience than none.
    const circle = endpointElement(code);
    expect(circle, "endpoints are not focusable").toContain("tabIndex={0}");
    expect(circle, "endpoints are not announced as operable").toContain('role="button"');
    expect(circle, "the endpoint has no accessible name").toContain("aria-label=");
    expect(
      circle,
      "the endpoint's name does not carry its measurement, so a screen-reader " +
        "user hears which point they are on and not what it is set to",
    ).toContain("displayVal(inches)");
  });

  it("AC1: the focus ring is visible, and only to keyboard users", () => {
    // focus-visible rather than focus: a mouse user must not get a ring they
    // did not ask for, and `outline-none` alone with no replacement is the
    // classic way a focus indicator disappears entirely.
    expect(code).toMatch(/focus-visible:/);
  });

  it("AC2: arrow keys move the endpoint, shift gives the coarse step", () => {
    expect(code).toContain("onKeyDown={(e) => onEndpointKeyDown(");
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(code, `${key} is not handled`).toContain(key);
    }
    expect(code, "shift does nothing, so there is no coarse step").toContain("e.shiftKey");
    expect(
      code,
      "the coarse step is no longer a multiple of the fine one",
    ).toContain("NUDGE_COARSE_MULTIPLE");
  });

  it("AC2: the step rule is the SHARED one, not a number invented here", () => {
    // If the web derived its own step, the two clients would disagree about
    // what one press moves and their logged correction deltas would stop being
    // comparable. nudgeStep is the same formula as MeasureNudge.swift.
    expect(code).toContain("nudgeStep(imgDims[0], imgDims[1])");
    expect(code).toContain("nudged(");
  });

  it("AC2: the page does not scroll out from under the endpoint", () => {
    // Arrow keys scroll a page by default, so without this the endpoint moves
    // and the view runs away from it.
    const handler = code.slice(code.indexOf("function onEndpointKeyDown"));
    expect(handler.slice(0, 800)).toContain("e.preventDefault()");
  });

  it("AC3: moving by keyboard marks the line touched, exactly as the drag does", () => {
    // The difference between an accessible alternative and a decorative one.
    // Without this the line moves on screen and saves nothing: Save writes only
    // touched keys, and the correction delta is logged only for touched keys.
    const handler = code.slice(
      code.indexOf("function onEndpointKeyDown"),
      code.indexOf("const missing = fields.filter"),
    );
    expect(
      handler,
      "the keyboard path no longer marks the line touched, so a keyboard user " +
        "can move an endpoint and save nothing",
    ).toContain("setTouched(");
  });

  it("AC4: the change is announced as the measurement, not as coordinates", () => {
    const handler = code.slice(
      code.indexOf("function onEndpointKeyDown"),
      code.indexOf("const missing = fields.filter"),
    );
    expect(handler).toContain("setAnnouncement(");
    expect(
      handler,
      "the announcement no longer carries the measurement — coordinates are " +
        "true and useless to somebody setting a chest measurement",
    ).toContain("inchesBetween(");
    // Polite, not assertive: a held arrow key fires repeatedly and an assertive
    // region would interrupt itself into noise.
    expect(code).toContain('aria-live="polite"');
  });

  it("AC5: the pointer drag is still there", () => {
    // This is an alternative, not a replacement. Removing the drag would fix
    // the audit by making the screen worse for everyone already using it.
    for (const h of ["onPointerDown", "onPointerMove", "onPointerUp"]) {
      expect(code, `${h} was removed`).toContain(`${h}={${h}}`);
    }
  });
});
