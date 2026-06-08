import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useKeyboardShortcuts,
  isTypingTarget,
  type KeyboardShortcut,
} from "@/hooks/use-keyboard-shortcuts";

// React 19 requires this flag for act() to flush effects in a test env.
// No @testing-library in this repo — render via createRoot like the app does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(shortcuts: KeyboardShortcut[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  function Probe() {
    useKeyboardShortcuts(shortcuts);
    return null;
  }
  act(() => {
    root = createRoot(container!);
    root.render(h(Probe));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

// Dispatch a bubbling keydown from `el` so the window listener sees it with the
// right event.target (mirrors a real keypress while that element is focused).
function press(
  el: Element,
  key: string,
  opts: { ctrl?: boolean; meta?: boolean } = {},
) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      ctrlKey: opts.ctrl,
      metaKey: opts.meta,
    }),
  );
}

describe("useKeyboardShortcuts", () => {
  it("fires a plain-key shortcut when not typing in a field", () => {
    const handler = vi.fn();
    mount([{ key: "n", handler }]);

    press(document.body, "n");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores the shortcut while the user is typing in an input", () => {
    const handler = vi.fn();
    mount([{ key: "n", handler }]);

    const input = document.createElement("input");
    document.body.appendChild(input);
    press(input, "n");
    expect(handler).not.toHaveBeenCalled();
    input.remove();
  });

  it("fires inside an input when allowInInput is set", () => {
    const handler = vi.fn();
    mount([{ key: "n", handler, allowInInput: true }]);

    const input = document.createElement("input");
    document.body.appendChild(input);
    press(input, "n");
    expect(handler).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("respects the ctrlOrMeta requirement", () => {
    const handler = vi.fn();
    mount([{ key: "k", handler, ctrlOrMeta: true }]);

    press(document.body, "k"); // no modifier — should not fire
    expect(handler).not.toHaveBeenCalled();

    press(document.body, "k", { meta: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("isTypingTarget", () => {
  it("detects inputs, textareas, selects and contenteditable", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const div = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");

    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
  });
});
