import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installNumberInputWheelGuard } from "@/lib/number-input-wheel-guard";

// US-3227. A focused `<input type="number">` treats a wheel event as
// increment/decrement, so a seller who clicks into a price and then scrolls the
// page to read the rest of the form changes the price -- no click, no keystroke,
// nothing on screen saying so, and the form saves whatever the wheel left.
//
// jsdom does not implement that increment, so these tests assert the MECHANISM
// (the input loses focus, and only the right one does) rather than the value.
// The behaviour under test is the browser's; what we control is the blur.

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.innerHTML = "";
});

function wheelOver(el: Element) {
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
}

describe("the mouse wheel can't silently edit a number field (US-3227)", () => {
  it("blurs a focused number input when the wheel turns over it", () => {
    const input = document.createElement("input");
    input.type = "number";
    input.value = "42";
    document.body.appendChild(input);
    teardown = installNumberInputWheelGuard();

    input.focus();
    expect(document.activeElement).toBe(input);

    wheelOver(input);
    expect(document.activeElement).not.toBe(input);
  });

  it("leaves a text input alone", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    teardown = installNumberInputWheelGuard();

    input.focus();
    wheelOver(input);
    expect(document.activeElement).toBe(input);
  });

  it("leaves an UNfocused number input alone", () => {
    // Scrolling past a number field you never clicked into must not steal
    // focus state from wherever the user actually is.
    const target = document.createElement("input");
    target.type = "number";
    const elsewhere = document.createElement("input");
    elsewhere.type = "text";
    document.body.append(target, elsewhere);
    teardown = installNumberInputWheelGuard();

    elsewhere.focus();
    wheelOver(target);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("stops guarding once torn down", () => {
    const input = document.createElement("input");
    input.type = "number";
    document.body.appendChild(input);
    installNumberInputWheelGuard()();

    input.focus();
    wheelOver(input);
    expect(document.activeElement).toBe(input);
  });

  it("is installed at boot, not merely exported", () => {
    // A guard nothing calls protects nothing.
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    expect(main).toContain("installNumberInputWheelGuard()");
  });
});
