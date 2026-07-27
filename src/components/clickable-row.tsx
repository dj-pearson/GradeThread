import * as React from "react";

import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Selector for interactive descendants that should handle their own clicks
 * (e.g. action buttons/links inside a navigable row). When the original event
 * target is inside one of these, the row's activate handler is suppressed so
 * nested controls keep working.
 */
const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, label, [role="button"], [role="checkbox"], [role="menuitem"], [contenteditable="true"]';

function isInteractiveTarget(
  target: EventTarget | null,
  currentTarget: Element
): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(INTERACTIVE_SELECTOR);
  // Only suppress when the interactive element is a *descendant* of the row,
  // not the row itself.
  return !!interactive && interactive !== currentTarget;
}

export interface ClickableRowProps
  extends Omit<React.ComponentProps<typeof TableRow>, "onClick"> {
  /** Invoked on click, Enter, or Space when the row (not a nested control) is activated. */
  onActivate: () => void;
  /** Accessible label describing where activation leads (e.g. "View submission Blue Jacket"). */
  activateLabel?: string;
}

/**
 * A table row that is fully keyboard-operable: it exposes role="button",
 * tabIndex=0, a visible focus ring, and activates on Enter/Space in addition
 * to click. Clicks that originate inside nested interactive controls
 * (buttons, links, inputs) are ignored so those controls keep their own
 * behavior. Prefer a real <Link>/<button> in the primary cell where the row's
 * sole purpose is navigation; use this when the whole row is the click target.
 *
 * WCAG 2.1.1 (Keyboard), 4.1.2 (Name, Role, Value).
 */
export function ClickableRow({
  onActivate,
  activateLabel,
  className,
  children,
  ...props
}: ClickableRowProps) {
  return (
    <TableRow
      role="button"
      tabIndex={0}
      aria-label={activateLabel}
      className={cn(
        "cursor-pointer hover:bg-muted/50",
        "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset",
        className
      )}
      onClick={(e) => {
        if (isInteractiveTarget(e.target, e.currentTarget)) return;
        onActivate();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (isInteractiveTarget(e.target, e.currentTarget)) return;
        e.preventDefault();
        onActivate();
      }}
      {...props}
    >
      {children}
    </TableRow>
  );
}
