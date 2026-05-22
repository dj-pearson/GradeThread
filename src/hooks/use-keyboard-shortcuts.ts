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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
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
