---
title: Injected extension UI is isolated by location, not by CSS discipline
type: contract
status: current
source_of_truth: vault
code_refs:
  - extension-unified/research/overlay-host.js
  - extension-unified/research/overlay.css
  - extension-condition/content/overlay-host.js
  - scripts/lib/extension-overlay-css.cjs
reviewed: 2026-08-07
tags: [extension, ui, css, shadow-dom, contract]
summary: Any UI the extension renders into a marketplace's page mounts in a shadow root; the host element's layout is inline !important; the stylesheet ships as a generated string, never as a manifest css entry.
---

# Injected extension UI is isolated by location, not by CSS discipline

Everything the extension draws — the condition overlay, the search-grid scan
badges, anything added later — is a guest in a document someone else controls.
The rule is that its isolation must be a property of **where the nodes live**,
never of how carefully its stylesheet was written.

## The rule

1. **Mount in a shadow root.** Use `GT_CC_SHADOW.createOverlayHost` /
   `createBadgeHost` (`research/overlay-host.js`, and its identical twin at
   `extension-condition/content/overlay-host.js`). Never append rendered UI
   straight into the page.
2. **The host element's layout is inline and `!important`.** The host is the one
   node the page can still select. Inline `!important` is the top of the author
   cascade — a page cannot outrank it, not even with an `!important` of its own.
   `all` is the first declaration, because it resets everything the page's
   cascade would otherwise inherit in.
3. **Positioning lives on the host, and only there.** `overlay.css` must not
   re-declare `position` / `z-index` / `right` / `bottom` on `.gt-cc-root`. Two
   copies of a layout drift, and the copy inside the shadow root cannot position
   the host anyway.
4. **The stylesheet ships as a string, not a manifest `"css"` entry.** A content
   script's `"css"` injects into the *document*, and a document stylesheet cannot
   cross a shadow boundary. `overlay.css` is the authored source;
   `overlay-css.js` is generated from it by
   `node scripts/gen-extension-overlay-css.mjs` and adopted into each shadow
   root.
5. **One constructable sheet per document.** A search grid carries a couple of
   dozen badge hosts. They adopt the same `CSSStyleSheet` object; a per-host
   `<style>` would copy the whole sheet that many times into the page.

## Why the earlier approach could not be finished

The previous defence was per-element `all: initial` / `all: unset`. It has three
holes that no additional CSS closes: a site rule with higher specificity wins, a
site `!important` wins outright, and — the one that matters most — **every new
child element is unprotected until someone remembers to add the reset.** Nothing
can see that omission: not a test, not a reviewer, not a build.

That is also why US-1884 AC4 sat open across three passes as "needs cross-site
browser verification". It did, *as long as the answer depended on what some
marketplace's stylesheet happens to contain*. A shadow root does not answer that
question, it deletes it: style encapsulation is a platform guarantee, so there is
nothing left for a browser to disprove. What remains is mechanical — did the
nodes land in the shadow tree, did the sheet travel with them, is the host's
layout unbeatable — and all of it is asserted by
`extension-*/test/overlay-shadow.test.cjs` against a DOM stub.

**Transferable form of this:** when an acceptance criterion reads "verified
against real sites", check first whether the design can be changed so the
property holds by construction. Verification you no longer need beats
verification you cannot schedule.

## The one thing a shadow root does NOT block

Inherited properties (font, colour, line-height, direction) still pass through a
shadow boundary from the host's ancestors. That is why `all: initial` remains on
`.gt-cc-root` and `.gt-cc-badge-row` — not as the defence, but as the reset of
what the boundary deliberately lets through.

## Related

- [[extension-telemetry-consent]] — what the extension may send, and under which toggle
- [[extension-adapter-verification]] — proving an adapter reads a real listing
- [[ralph-learnings]] — the agent-loop playbook that points here
