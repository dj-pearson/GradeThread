// US-2375: a no-op stand-in for Google's `web-vitals`, aliased in for unit
// tests only (vitest.config.ts resolve.alias).
//
// The real library is loaded through src/lib/web-vitals.ts's dynamic import
// whenever a test grants analytics consent (src/lib/analytics.test.ts and
// friends). Its onCLS/onINP subscriptions arm internal setTimeouts that outlive
// the test file, and when one fires after jsdom teardown it touches `self` and
// crashes the RUN — "ReferenceError: self is not defined", blamed on whichever
// unrelated file happened to be executing. That is a flake by construction: it
// depends on worker packing, so adding any test file anywhere can surface it.
//
// src/lib/web-vitals.ts already carries a guard for the same hazard class (it
// re-checks `document` after the await, for a `document is not defined` version
// of this). That guard can't help here, because the timers are armed INSIDE the
// library after a successful subscribe.
//
// Nothing is lost by stubbing: the four subscriptions need a real browser to
// emit anything, so no test asserts on them. The pure, testable half —
// buildVitalEvent in src/lib/web-vitals.ts — is covered directly by
// src/lib/__tests__/web-vitals.test.ts and does not come from this module.
export function onLCP(): void {}
export function onINP(): void {}
export function onCLS(): void {}
export function onTTFB(): void {}
