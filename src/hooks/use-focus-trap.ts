import { useEffect, useRef, type RefObject } from "react";
import { trapFocus } from "@/lib/a11y/focus-trap";

// US-448: React wrapper around `trapFocus` for hand-rolled overlay components.
// Attach the returned ref to the overlay's root `<div role="dialog" aria-modal>`.
// While mounted (and `active`), focus is trapped inside, Escape calls `onEscape`,
// the background is inert/aria-hidden, and focus returns to the opener on unmount.

interface UseFocusTrapOptions {
  /** Turn the trap on/off without unmounting (default: on). */
  active?: boolean;
  /** Invoked when Escape is pressed inside the overlay. */
  onEscape?: () => void;
  /** Element to focus first when the trap activates. */
  initialFocus?: RefObject<HTMLElement | null>;
}

export function useFocusTrap<T extends HTMLElement>(
  options: UseFocusTrapOptions = {},
): RefObject<T | null> {
  const { active = true, onEscape, initialFocus } = options;
  const containerRef = useRef<T>(null);

  // Keep the latest onEscape without re-arming the trap on every render.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    return trapFocus(container, {
      onEscape: () => onEscapeRef.current?.(),
      initialFocus: initialFocus?.current ?? null,
    });
  }, [active, initialFocus]);

  return containerRef;
}
