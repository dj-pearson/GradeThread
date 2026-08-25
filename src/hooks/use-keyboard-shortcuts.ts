import { useEffect, useRef } from "react";

export interface KeyboardShortcut {
  /** Key to match, case-insensitive (e.g. "n", "Escape", "/"). */
  key: string;
  handler: (e: KeyboardEvent) => void;
  /** Fire even when focus is in an input/textarea/select. Default false. */
  allowInInput?: boolean;
  /** Require Ctrl or Cmd to be held. Default false. */
  ctrlOrMeta?: boolean;
}

/**
 * True when the event target is a field the user is typing into, so global
 * single-key shortcuts (n, /, ?) shouldn't hijack the keystroke.
 *
 * Exported for the few remaining non-hook listeners. US-2881 moved the command
 * palette onto the hook -- it used to hand-roll a window listener that called
 * this for `/` and NOT for Cmd-K, which is why Cmd-K inside a text field
 * worked on /admin and did nothing on /dashboard.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // isContentEditable is the truth in real browsers; fall back to the
  // attribute so the guard also works under jsdom (which doesn't implement it).
  return (
    target.isContentEditable === true ||
    target.getAttribute("contenteditable") === "true"
  );
}

/**
 * Registers global keyboard shortcuts for the lifetime of the calling
 * component. Shortcuts are ignored while the user is typing in a field
 * unless `allowInInput` is set.
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  enabled = true
): void {
  // Every call site passes an inline array literal, so `shortcuts` has a fresh
  // identity each render. Holding it in a ref (instead of an effect dep) lets us
  // register ONE stable listener keyed only on `enabled`, rather than tearing
  // down and re-adding the window keydown listener on every parent re-render.
  const shortcutsRef = useRef(shortcuts);
  useEffect(() => {
    shortcutsRef.current = shortcuts;
  });

  useEffect(() => {
    if (!enabled) return;

    function onKey(e: KeyboardEvent) {
      // Some events (autofill / datalist commits / IME) dispatch a keydown with
      // no `key`; calling .toLowerCase() on it throws and blows up the handler.
      if (!e.key) return;
      for (const shortcut of shortcutsRef.current) {
        if (!shortcut.key) continue;
        if (e.key.toLowerCase() !== shortcut.key.toLowerCase()) continue;

        const hasMod = e.metaKey || e.ctrlKey;
        if (!!shortcut.ctrlOrMeta !== hasMod) continue;
        if (e.altKey) continue;

        if (!shortcut.allowInInput && isTypingTarget(e.target)) continue;

        e.preventDefault();
        shortcut.handler(e);
        return;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
