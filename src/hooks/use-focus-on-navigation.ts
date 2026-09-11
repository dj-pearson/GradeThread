import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

// US-3244 AC4. Put the keyboard on the new page, not back at the top of the nav.
//
// This is the other half of RouteAnnouncer. The live region names the
// destination, but a keyboard or screen-reader user is still standing where
// they were: focus stays on the sidebar link they activated, so reaching the
// content means tabbing forward through the whole nav again, on every single
// navigation. Moving focus to the <main> that the skip link already targets
// fixes that, and it is also what makes the announcement land somewhere.
//
// It is split out because the naive version is worse than nothing. Three things
// in this codebase fight it, and each one is a rule below rather than a page
// list, because a list of pages is a list that goes stale.
//
// 1. PAGES THAT PUT THE CURSOR SOMEWHERE THEMSELVES.
//    React applies `autoFocus` during the commit phase and a page's own
//    focus-on-mount effect is a CHILD effect, so both have already run by the
//    time this parent effect fires -- meaning a layout that focuses
//    unconditionally steals the cursor every time, and the seller types into
//    nothing. Four surfaces do this today: /dashboard/flipdesk/search focuses
//    its query box on mount, /dashboard/flipdesk/intake?mode=bulk autofocuses
//    the title field, scheduled-drops focuses its roving calendar cell, and
//    /buyer/billing?cancel=1 focuses the Cancel button it was linked to.
//    Rather than name them, this checks whether focus has ALREADY landed inside
//    the target and stands down if it has. A fifth page that does the same
//    thing tomorrow is handled by existing.
//
// 2. DIALOGS AND SHEETS, WHICH OWN FOCUS AND TAKE IT BACK.
//    Radix restores focus on close from inside a setTimeout (see
//    react-focus-scope's unmount effect), and every shadcn overlay here has an
//    exit animation, so a closing dialog is still in the DOM -- with its
//    pending restore still queued -- for a few hundred milliseconds after the
//    navigation. Route changes really do happen with one open: the command
//    palette runs `setOpen(false); navigate(to)` in one tick, so does the
//    mobile Add dialog, and on a phone EVERY nav click goes through a Sheet.
//    Grabbing focus there produces a visible fight, so this stands down while
//    any overlay is present, open or closing. Radix's own restore wins, which
//    is the behaviour that exists today.
//
// 3. THE SEARCH STRING IS NOT A NAVIGATION.
//    Tabs, filters, sorts, the pager and the inventory search box all write
//    query params: useUrlParamState replaces the URL on every change, and
//    useUrlSearchInput does it 250ms after a keystroke. Keying off `search`
//    the way the announcer does would yank the cursor out of the search box
//    mid-sentence. PATHNAME ONLY.
//
// Silent on first paint for the same reason the announcer is: nothing moved.

/**
 * Any overlay that manages its own focus. Radix gives Dialog, AlertDialog,
 * Sheet and Popover content `role="dialog"` or `role="alertdialog"` in both the
 * open and the closing state, so this catches the pending-restore window too.
 * `data-scroll-locked` is react-remove-scroll's refcounted body marker, which
 * covers the modal menus and selects that use a different role.
 */
const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"]';
const BODY_LOCK_ATTR = "data-scroll-locked";

/** True while something other than the page is entitled to the cursor. */
function anOverlayOwnsFocus(): boolean {
  if (document.body.hasAttribute(BODY_LOCK_ATTR)) return true;
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

/**
 * Moves focus to `#${targetId}` after an in-app path change.
 *
 * The target must carry `tabIndex={-1}` so it can take programmatic focus, and
 * `outline-none` so a move nobody asked for does not paint a ring around the
 * whole page. All three layouts already do, because the skip link lands there.
 *
 * Mount once, in a layout, beside RouteAnnouncer.
 */
export function useFocusOnNavigation(targetId: string): void {
  const { pathname } = useLocation();
  const firstPaint = useRef(true);

  useEffect(() => {
    if (firstPaint.current) {
      firstPaint.current = false;
      return;
    }
    const target = document.getElementById(targetId);
    if (!target) return;
    if (anOverlayOwnsFocus()) return;
    // The page put the cursor somewhere deliberate. Leave it there.
    if (target.contains(document.activeElement)) return;
    target.focus({ preventScroll: true });
  }, [pathname, targetId]);
}
