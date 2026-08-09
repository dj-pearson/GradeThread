---
title: Ralph browser-extension working log
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-09
tags: [agent, ralph, extension]
summary: Traps from the unified browser-extension epic (US-1868…US-1912), including the pattern of an epic whose deliverable is a fence rather than a feature.
---

> [!info] Read ON DEMAND, not every iteration.
> Split out of [[ralph-learnings]] by US-2445, which had grown to 892 lines
> against its own 800-line rule. Nothing here was deleted or reworded — it is
> the same text, one hop away instead of on every loop iteration.
>
> Read this for anything under `extension-unified/`, and for any EPIC whose ACs
> are RULES rather than code — the opening bullets are about that shape, not
> about extensions.

# An EPIC story whose fence is the whole deliverable

- Some epics ship no code by AC — but their ACs are still RULES ("do not build
  lending", "always label it an estimate"), and a rule that lives only in a story
  is one the next author never reads. US-1868's deliverable was therefore the
  fence itself: the refused vocabulary and the required disclosure as exported
  constants, plus a guard that finds the surfaces by DISCOVERY (glob the path for
  the feature word across src/, edge, functions/, ios/, android/) so a surface
  that does not exist yet is already covered. Strip COMMENTS before scanning, or
  the header comment declaring the rule trips it; strip IMPORT lines too, or a
  file that imports the copy and renders nothing passes. Mutation-check both
  halves — mine passed twice while broken before that. Rules: [[inventory-equity]].
- A PATH-discovery fence also decides your FILE LAYOUT, and noticing that after
  you have written four files is expensive: US-1871's iOS card keeps read models,
  transport, store and views in ONE `InventoryEquityCard.swift`, because every
  `.swift` the fence finds must RENDER the disclosure. Two rules follow for the
  literal itself. It must be UNBROKEN in source — the guard normalizes whitespace
  but not Swift's `+` concatenation or a `"""` line-continuation `\`, so a wrapped
  literal reads as a paraphrase to the only thing that checks. And since the
  identifier the guard also accepts appears in those files only inside `///`
  comments (which it strips), the pass is the literal's — confirm that with a
  one-character mutation rather than assuming it.

- A CONDITIONAL AC ("delete X once Y reaches parity") is a gate, and a gate
  written as prose rots in every copy at once. US-1872 AC5's gate lived as the
  same sentence in five files — "parity is not reached (US-1880/1881/1882/1883
  are open)" — and stayed there long after three of those shipped; nothing went
  red, and the next reader re-derives the whole question. Fix: COMPUTE the half
  that is a property of the code (`scripts/lib/extension-retirement-gate.cjs`
  reads both manifests and diffs permissions/hosts/reach/files/icons), leave the
  half no code can close as ONE operator flag, and guard BOTH DIRECTIONS — the
  usual "not done early" assert plus "gate satisfied and the work still not
  done" fails the build. Also: "which child stories are open" is a proxy, not
  the gate — a story that makes the replacement BETTER than the thing it
  replaces was never a parity blocker. Beware an assert message that calls
  `regex.exec(src)[0]`: it is built even when the assertion passes, so it throws
  on every file that is clean.

- An AC that says "verified against the live site" is not blocked on its CODE,
  only on its EVIDENCE — and two US-1880 passes stopped at "a human must do it"
  without leaving that human anything to do it WITH. The completable half is the
  MEASUREMENT: generate a DevTools snippet that inlines the shipped helper source
  verbatim (`scripts/lib/adapter-verification.mjs` embeds image-utils.js), so what
  the operator measures is what the extension does and no second implementation
  can rot. Two rules the shape forces. Measure the OUTCOME, not the config — a
  URL-upgrade rule that rewrote nothing looks perfect in JSON, so probe
  `naturalWidth` on the upgraded URL; that is the only check the config cannot
  satisfy by itself. And test generated browser text by EXECUTING it
  (`new Function` + a selector-string→elements stub, no CSS engine needed) — a
  verification tool nothing runs is one that reports PASS forever. Mutation-check
  it with the old dead regex. Procedure: [[extension-adapter-verification]].
- Careless detail that costs a debug cycle: a `String.raw` block holding generated
  JS still ends at the first backtick and still interpolates `${}` — a prose
  backtick in a comment inside it is a parse error at the CONSUMER, not the
  definition.

- "Chromium-compatible" and "same manifest" do NOT mean the same INSTALL: Chrome
  grants `host_permissions` at install, Firefox withholds them until the person
  opts in, so the identical zip ships a Firefox add-on where no content script
  runs, nothing rejects, nothing logs, and the only reading available is that our
  software is broken. Every guard in this repo executes the Chrome path, where
  the probe answers granted forever — an ungranted state no test can reach is one
  no test can catch, so drive it with a STUB api object rather than a browser
  (US-1881). Three platform rules the fix cannot skip: `permissions.request()`
  THROWS on Chrome for anything not in `optional_permissions` (so probe first,
  and make the request reachable only from the state the probe ruled out); it is
  refused outside a user gesture and an `await` before it ENDS that gesture (so
  it is the first statement of the click handler, never after a check); and a
  grant reaches only the next navigation, so reload the tab or the page they are
  staring at stays as dead as before they said yes. Probes fail OPEN, requests
  fail CLOSED — a false negative shows a working Chrome user a scary prompt for
  access they already have. Same shape as the US-1967 capability probe.
- Corollary: the *second* surface a permission feeds is the one that breaks
  silently. Firefox has no `externally_connectable`, so sign-in rides
  `gt-bridge.js` — an ordinary content script on gradethread.com — and an
  ungranted site permission does not fail the sign-in, it HANGS it: the connect
  page opens, mints the token, posts it, and nothing is listening.
- When a story adds a SECOND transport/backend behind one call site, "the old one
  still wins where it exists" is a preference nobody can see — it is a branch
  order, and reordering it passes review, typecheck and every existing test.
  US-1882 had only code-reading as evidence. Pin it as an outcome instead: assert
  the OTHER transport was not ALSO used (`sendToLister` with a stubbed
  `chrome.runtime` AND the bridge marker must post zero `__gtExtReq` envelopes) —
  a page that used both would double-list and still resolve looking healthy, so
  "the right one answered" is not the assertion you want. For the live half, a
  DevTools tool that WRAPS the transports and then watches beats a checklist that
  describes them: it observes the shipped code, so there is no second copy of the
  preference to rot, and it can derive the expectation from what the browser
  exposed (runtime present ⇒ must be used) rather than from the user agent — one
  snippet, correct in both browsers. `scripts/transport-verify.mjs`, procedure in
  `extension-unified/TESTING.md` §5c.

- An AC deferred as "needs real-browser verification" is sometimes deferred
  because the DESIGN made verification necessary. US-1884 AC4 (overlay hardened
  against site CSS) sat open three passes on exactly that, and the answer was not
  to schedule a browser: it was to mount the overlay in a SHADOW ROOT, which
  makes the property a platform guarantee instead of a claim about what some
  marketplace's stylesheet happens to contain. Per-element `all: unset` can never
  be finished — a site `!important` still wins, and every future child is
  unprotected until someone remembers. Before deferring for evidence, ask whether
  the design can be changed so the property holds by construction. Two mechanics
  the switch forces: a content script's manifest `"css"` injects into the
  DOCUMENT and cannot cross a shadow boundary (so the sheet ships as a generated
  string beside the .css, with a drift guard), and the HOST element — the one
  node the page can still select — needs its layout as inline `!important`, `all`
  first. Rules: [[extension-injected-ui-isolation]].


## Related

- [[extension-injected-ui-isolation]] — why injected UI lives in a shadow root
- [[extension-adapter-verification]] — proving a marketplace adapter reads a real listing
- [[ralph-learnings]] — the always-read playbook
- [[INDEX]]
