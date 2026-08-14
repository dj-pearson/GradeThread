import { createContext, useContext } from "react";

// Signals that a page is being rendered EMBEDDED inside a tabbed host rather
// than at its own standalone route. Child pages read this through PageHeader,
// which drops their title/subtitle/icon and keeps only their actions: the host
// names the section and the tab names the view, so a third heading under the
// tab strip is the same words twice.
//
// It started as the Account hub's private flag (US-741 / US-1441) and is shared
// now (US-2548), because four FlipDesk hosts — Money, Pricing, Sourcing and
// AutoLister — had the opposite half of the same problem: they rendered NO title
// of their own, so the child's heading was the only one on screen and it named
// the tab, never the destination the sidebar sent you to. One rule covers both:
// exactly one h1 per screen, and the host owns it.
//
// Standalone routes still exist and render with the default `embedded: false`,
// so their headers are unaffected.
export const PageHostContext = createContext<{ embedded: boolean }>({
  embedded: false,
});

export function usePageHost(): { embedded: boolean } {
  return useContext(PageHostContext);
}
