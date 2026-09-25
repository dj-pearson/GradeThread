// US-963: the unified Reconcile area hosts four flows as tabs, reflected in
// `?tab=`. Kept out of reconcile.tsx so the surface registry test can check a
// `?view=reconcile` deep link names a real tab without importing the page.
export const RECONCILE_TABS = ["photos", "ebay", "payouts", "cross-source"] as const;
export type ReconcileTab = (typeof RECONCILE_TABS)[number];
