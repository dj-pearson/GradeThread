// US-448: focus management for custom (non-Radix) overlays.
//
// A modal overlay must (1) move focus into itself, (2) keep Tab/Shift+Tab inside
// while open, (3) close on Escape, (4) restore focus to whatever opened it, and
// (5) make the rest of the page inert + aria-hidden so neither the keyboard nor a
// screen reader's virtual cursor can wander out of the dialog. Radix Dialog does
// all of this for us; this helper gives the same guarantees to our hand-rolled
// `<div role="dialog">` overlays (e.g. the certificate photo lightbox).
//
// `trapFocus()` is a framework-agnostic DOM function so it can be unit-tested
// against jsdom without React; `useFocusTrap` (src/hooks/use-focus-trap.ts) wraps
// it for components.

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Tabbable descendants of `container`, in DOM order. Elements inside an `inert`
 * subtree or explicitly `hidden` are skipped (no layout in jsdom, so we can't
 * filter on visibility — the selector + inert/hidden checks are enough).
 */
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => !el.closest("[inert]") && !el.hidden);
}

export interface TrapFocusOptions {
  /** Called when Escape is pressed inside the trap. */
  onEscape?: () => void;
  /** Element to focus first; falls back to the first focusable, then the container. */
  initialFocus?: HTMLElement | null;
}

/**
 * Activate a focus trap on `container`. Returns a `release()` cleanup that undoes
 * everything (restores background interactivity, scroll, and focus to the opener).
 */
export function trapFocus(
  container: HTMLElement,
  opts: TrapFocusOptions = {},
): () => void {
  const doc = container.ownerDocument;
  const opener = doc.activeElement as HTMLElement | null;

  // Walk from the container up to <body>, marking every sibling along the way as
  // inert + aria-hidden. The result: only the container's own ancestor chain
  // stays interactive, so background content is unreachable by Tab, pointer, or
  // assistive tech — without needing to portal the overlay. We remember which
  // nodes we touched (and whether they already had aria-hidden) so cleanup is
  // exact and idempotent across nested traps.
  const hidden: { el: HTMLElement; hadAriaHidden: boolean }[] = [];
  let node: HTMLElement = container;
  while (node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const sib of Array.from(parent.children)) {
      if (sib === node || !(sib instanceof HTMLElement)) continue;
      if (sib.hasAttribute("inert")) continue; // already inert (outer trap) — leave it
      const hadAriaHidden = sib.hasAttribute("aria-hidden");
      sib.setAttribute("inert", "");
      if (!hadAriaHidden) sib.setAttribute("aria-hidden", "true");
      hidden.push({ el: sib, hadAriaHidden });
    }
    if (parent === doc.body) break;
    node = parent;
  }

  // Lock background scroll while the overlay is open.
  const prevOverflow = doc.body.style.overflow;
  doc.body.style.overflow = "hidden";

  // Move focus into the dialog.
  const initialFocusables = getFocusable(container);
  (opts.initialFocus ?? initialFocusables[0] ?? container).focus();

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      opts.onEscape?.();
      return;
    }
    if (e.key !== "Tab") return;

    const focusables = getFocusable(container);
    if (focusables.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = doc.activeElement;

    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (active && !container.contains(active)) {
      // Focus escaped the dialog (e.g. programmatic move) — pull it back.
      e.preventDefault();
      first.focus();
    }
  }

  doc.addEventListener("keydown", onKeyDown, true);

  return function release() {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.body.style.overflow = prevOverflow;
    for (const { el, hadAriaHidden } of hidden) {
      el.removeAttribute("inert");
      if (!hadAriaHidden) el.removeAttribute("aria-hidden");
    }
    opener?.focus?.();
  };
}
