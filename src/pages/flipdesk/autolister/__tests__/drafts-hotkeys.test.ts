// AL-05: the Drafts cockpit shortcuts stay out of the way of browser shortcuts,
// focused controls and open dialogs.
import { describe, expect, it } from "vitest";
import { shouldIgnoreDraftsHotkey } from "../drafts-hotkeys";

function ev(target: Element | null, over: Partial<KeyboardEventInit> = {}) {
  const e = new KeyboardEvent("keydown", { key: "p", cancelable: true, ...over });
  Object.defineProperty(e, "target", { value: target });
  return e;
}

describe("shouldIgnoreDraftsHotkey (AL-05)", () => {
  it("lets a plain key on the page through", () => {
    expect(shouldIgnoreDraftsHotkey(ev(document.body))).toBe(false);
  });

  it("ignores Cmd+P, Ctrl+P and Alt+P, so print never publishes", () => {
    expect(shouldIgnoreDraftsHotkey(ev(document.body, { metaKey: true }))).toBe(true);
    expect(shouldIgnoreDraftsHotkey(ev(document.body, { ctrlKey: true }))).toBe(true);
    expect(shouldIgnoreDraftsHotkey(ev(document.body, { altKey: true }))).toBe(true);
  });

  it("ignores auto-repeat and an event already handled", () => {
    expect(shouldIgnoreDraftsHotkey(ev(document.body, { repeat: true }))).toBe(true);
    const handled = ev(document.body);
    handled.preventDefault();
    expect(shouldIgnoreDraftsHotkey(handled)).toBe(true);
  });

  it("leaves Enter on a focused button or link to that control", () => {
    expect(shouldIgnoreDraftsHotkey(ev(document.createElement("button"), { key: "Enter" }))).toBe(true);
    expect(shouldIgnoreDraftsHotkey(ev(document.createElement("a"), { key: "Enter" }))).toBe(true);
    const box = document.createElement("div");
    box.setAttribute("role", "checkbox");
    expect(shouldIgnoreDraftsHotkey(ev(box, { key: " " }))).toBe(true);
  });

  it("ignores anything inside an open dialog", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("span");
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    expect(shouldIgnoreDraftsHotkey(ev(inner))).toBe(true);
    dialog.remove();
  });
});
