---
title: States that look normal
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-01
tags: [frontend, debugging, react, agent]
summary: Three shipped frontend failures that rendered as a legitimate UI state — empty, idle, or done — and in each case the obvious diagnostic surface pointed away from the cause.
---

# States that look normal

[[guards-that-cannot-fail]] is about checks that pass for the wrong reason. This
is its runtime sibling: **failures that render as a legitimate state.** Nothing
looks broken. The list is empty, the page is idle, the popup closed. Each of
these shipped, and in each one the surface you would naturally check —
the network tab, the error stack, the window handle — pointed somewhere else.

## 1. The empty list that is actually an error

`supabase.from()` is implemented as `return this.rest.from(relation)`. It works
only while attached to the client:

```js
const from = supabase.from;  from("x")   // TypeError: reading 'rest'
(supabase.from as unknown as T)("x")     // fine — parenthesised member
                                         //   expression keeps `this`
const from = (supabase.from as T).bind(supabase)  // fine, and obvious
```

The throw happens **before any network call**. React Query swallows it into an
errored query, and every consumer's `= []` fallback then renders it as *a seller
with no inventory*: an empty table, and "Item not found." on every item page.
Some surfaces kept working, because they made their own `supabase.from(...)`
calls — which reads like a routing bug rather than a data-layer one.

**The unit tests were green** against a mock `supabase.from` written as a
`this`-free arrow — a shape the real client does not have.

- Never hoist a supabase method into a bare local. Call it inline, or `.bind()`
  it where the binding is visible.
- A mock must reproduce the real object's `this` dependency, or it certifies a
  shape that does not exist.
- **Diagnose from the React Query cache, not the network tab** — the tab is
  empty because no request was made. Walk the `#root` fiber for
  `memoizedProps.client`, then `getQueryCache().getAll()` and read
  `state.fetchFailureReason`.

## 2. The crash whose stack names an innocent component

```js
const { data: photos = [] } = useQuery(...)      // NEW [] identity each render
useEffect(() => setOrder(photos), [photos])      // re-fires every render
```

While the query is pending, the inline `= []` default is a fresh array every
render, so an identity-keyed effect re-fires, `setOrder` schedules another
render, and it loops until the query resolves. On a **slow** load — cold cache,
production latency, a loaded machine — React hits its nested-update limit first:
"Maximum update depth exceeded" (#185), and the whole route drops to the
ErrorBoundary.

**The stack is a red herring.** It lands in whichever Radix ref or setState
happened to cross the counter during the commit cascade, not in the code driving
the loop.

It never reproduces on a fast warm load, which is exactly why it ships.

- Hoist a **module-level** `EMPTY` constant, or key the effect on something
  stable. The fix is one line and the diagnosis is hours.
- To make a timing loop deterministic in a test: Playwright plus
  `Emulation.setCPUThrottlingRate {rate: 6}` over CDP took this from 0% to 100%
  reproducible (`e2e/composer-update-loop.spec.ts`).
- A boundary crash produces **no** `pageerror` — assert on the fallback text.
- Symbolicating a minified prod #185: `curl` the deployed chunk and slice at the
  stack's line:col; the string literals identify the source.

Note that shapes 1 and 2 are the *same* inline default. One turns an error into
emptiness; the other turns pending into a loop.

## 3. The popup close that is not a cancel

The Google Photos picker tells the user to close its window and finish "in the
other window". So **closing the popup is the normal completion path**, and an
import flow that treated close as cancel raced the poll that would have returned
`ready`. The user hit Done and nothing happened; edge logs showed a few polls
and then silence, with no `POST /import`.

- Poll the **server** for authoritative state until ready or timeout. Never let
  a window handle decide that a server-side flow ended.
- Give an explicit cancel affordance instead (the AutoLister button doubles as
  cancel while a pick is in flight).
- Tear the interval down on unmount — it now outlives the popup.

> [!note] The COOP part of this story has changed (verified 2026-08-01)
> This was originally compounded by `Cross-Origin-Opener-Policy: same-origin`,
> which severs the handle to a cross-origin popup: `popup.closed` returns a
> value you cannot trust and `popup.close()` silently no-ops. `public/_headers`
> now sets **`same-origin-allow-popups`** deliberately, so the app keeps handles
> to popups it opens and can close them when a flow completes. We never set
> COEP, so cross-origin isolation was never in play and the XS-Leak protection
> that actually applied is retained. `functions/_shared/security-headers.ts`
> still sends bare `same-origin` for SSR'd blog/marketing responses, which do not
> mount the SPA or open popups — that difference is intentional, not drift.
> **The rule above does not depend on any of this.** Even with a perfectly good
> handle, a user closing a picker is not a cancellation.

## Related

- [[guards-that-cannot-fail]] — the same problem one layer up, in the checks
- [[deploy]] — a deployed fix that "did not work" has its own look-normal failure
- [[INDEX]]
