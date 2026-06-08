import { useEffect } from "react";

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
 * single-key shortcuts (n, /, ?) shouldn't hijack the keystroke. Exported so
 * non-hook listeners (e.g. the command palette's `/`) share the same rule.
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
  useEffect(() => {
    if (!enabled) return;

    function onKey(e: KeyboardEvent) {
      for (const shortcut of shortcuts) {
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
  }, [shortcuts, enabled]);
}
