import { describe, it, expect, afterEach } from "vitest";
import { trapFocus, getFocusable } from "../focus-trap";

// US-448: prove the custom-overlay focus trap delivers the four guarantees the
// story requires — focus moves in, background goes inert/aria-hidden, Tab is
// trapped, Escape closes, and focus is restored to the opener on release.

let release: (() => void) | null = null;

function setup() {
  document.body.innerHTML = `
    <div id="root">
      <button id="opener">open</button>
      <p id="bg">background</p>
      <a id="bg-link" href="#x">bg link</a>
    </div>
    <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
      <button id="first">first</button>
      <button id="middle">middle</button>
      <button id="last">last</button>
    </div>
  `;
  const dialog = document.getElementById("dialog") as HTMLDivElement;
  const opener = document.getElementById("opener") as HTMLButtonElement;
  opener.focus();
  return { dialog, opener };
}

function press(key: string, shiftKey = false) {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }),
  );
}

afterEach(() => {
  release?.();
  release = null;
  document.body.innerHTML = "";
});

describe("trapFocus", () => {
  it("moves focus into the dialog on activation", () => {
    const { dialog } = setup();
    release = trapFocus(dialog);
    expect(document.activeElement?.id).toBe("first");
  });

  it("honours initialFocus", () => {
    const { dialog } = setup();
    const last = document.getElementById("last") as HTMLButtonElement;
    release = trapFocus(dialog, { initialFocus: last });
    expect(document.activeElement?.id).toBe("last");
  });

  it("makes background siblings inert + aria-hidden and restores them on release", () => {
    const { dialog } = setup();
    const root = document.getElementById("root")!;
    expect(root.hasAttribute("inert")).toBe(false);

    release = trapFocus(dialog);
    expect(root.hasAttribute("inert")).toBe(true);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(dialog.hasAttribute("inert")).toBe(false); // the dialog itself stays live

    release();
    release = null;
    expect(root.hasAttribute("inert")).toBe(false);
    expect(root.hasAttribute("aria-hidden")).toBe(false);
  });

  it("wraps Tab from the last focusable back to the first", () => {
    const { dialog } = setup();
    release = trapFocus(dialog);
    (document.getElementById("last") as HTMLButtonElement).focus();
    press("Tab");
    expect(document.activeElement?.id).toBe("first");
  });

  it("wraps Shift+Tab from the first focusable to the last", () => {
    const { dialog } = setup();
    release = trapFocus(dialog);
    (document.getElementById("first") as HTMLButtonElement).focus();
    press("Tab", true);
    expect(document.activeElement?.id).toBe("last");
  });

  it("pulls focus back if it escapes the dialog", () => {
    const { dialog, opener } = setup();
    release = trapFocus(dialog);
    opener.focus(); // simulate a programmatic escape
    press("Tab");
    expect(document.activeElement?.id).toBe("first");
  });

  it("calls onEscape when Escape is pressed", () => {
    const { dialog } = setup();
    let escaped = false;
    release = trapFocus(dialog, { onEscape: () => (escaped = true) });
    press("Escape");
    expect(escaped).toBe(true);
  });

  it("restores focus to the opener on release", () => {
    const { dialog, opener } = setup();
    release = trapFocus(dialog);
    expect(document.activeElement).not.toBe(opener);
    release();
    release = null;
    expect(document.activeElement).toBe(opener);
  });

  it("locks and restores body scroll", () => {
    const { dialog } = setup();
    document.body.style.overflow = "auto";
    release = trapFocus(dialog);
    expect(document.body.style.overflow).toBe("hidden");
    release();
    release = null;
    expect(document.body.style.overflow).toBe("auto");
  });
});

describe("getFocusable", () => {
  it("collects tabbable descendants and skips inert subtrees", () => {
    document.body.innerHTML = `
      <div id="c">
        <button id="b1">b1</button>
        <button id="b2" disabled>disabled</button>
        <div inert><button id="b3">inert</button></div>
        <a id="l1" href="#">link</a>
        <span tabindex="-1" id="s1">no</span>
      </div>`;
    const ids = getFocusable(document.getElementById("c") as HTMLElement).map(
      (el) => el.id,
    );
    expect(ids).toEqual(["b1", "l1"]);
  });
});
