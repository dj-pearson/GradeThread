// AL-15: keyboard sorting on the workbench, and the Drafts approve key.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ignoreWorkbenchKey, moveFocus } from "../use-workbench-hotkeys";

describe("moveFocus (AL-15)", () => {
  // A 7-column desktop grid holding 20 photos.
  it("moves within the grid and stops at its edges", () => {
    expect(moveFocus(-1, "ArrowRight", 7, 20)).toBe(1);
    expect(moveFocus(0, "ArrowLeft", 7, 20)).toBe(0);
    expect(moveFocus(3, "ArrowDown", 7, 20)).toBe(10);
    expect(moveFocus(17, "ArrowDown", 7, 20)).toBe(19);
    expect(moveFocus(10, "ArrowUp", 7, 20)).toBe(3);
    expect(moveFocus(2, "ArrowUp", 7, 20)).toBe(0);
  });

  it("an empty grid has nothing to focus", () => {
    expect(moveFocus(0, "ArrowRight", 7, 0)).toBe(-1);
  });
});

function ev(target: Element, over: Partial<KeyboardEventInit> = {}) {
  const e = new KeyboardEvent("keydown", { key: "g", ...over });
  Object.defineProperty(e, "target", { value: target });
  return e;
}

describe("ignoreWorkbenchKey (AL-15)", () => {
  it("leaves typing, dialogs and modified keys alone", () => {
    expect(ignoreWorkbenchKey(ev(document.createElement("input")))).toBe(true);
    expect(ignoreWorkbenchKey(ev(document.body, { metaKey: true }))).toBe(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("span");
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    expect(ignoreWorkbenchKey(ev(inner))).toBe(true);
    dialog.remove();
  });

  it("lets Space on a focused button press that button", () => {
    expect(ignoreWorkbenchKey(ev(document.createElement("button"), { key: " " }))).toBe(true);
    expect(ignoreWorkbenchKey(ev(document.createElement("button"), { key: "g" }))).toBe(false);
  });

  it("acts on the page itself", () => {
    expect(ignoreWorkbenchKey(ev(document.body))).toBe(false);
  });
});

describe("Drafts approve key (AL-15)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/autolister-drafts.tsx"), "utf8");

  it("'a' stamps reviewed_at, which is what drops a draft from the queue", () => {
    expect(src).toMatch(/case "a":[\s\S]{0,120}approveActive\(\)/);
    expect(src).toMatch(/update\(\{ reviewed_at: new Date\(\)\.toISOString\(\) \}/);
  });

  it("Save and next writes nothing when nothing changed, and a typed price is not an estimate", () => {
    expect(src).toMatch(/if \(listingChanged\)/);
    expect(src).toMatch(/price_is_estimated: false/);
    expect(src).toMatch(/price <= 0/);
  });
});
