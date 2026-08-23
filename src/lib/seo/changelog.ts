// US-2809: the public product changelog at /changelog.
//
// The feed API (changelogPublicRoutes, /api/changelog) has existed since US-916
// and its own header says it "powers a public /changelog page AND an in-app
// 'What's New' panel". The admin authoring page says the same thing twice, in
// its description and in its on-screen subtitle. Only the newsletter half was
// ever built, so an admin publishing an entry was told it appeared somewhere it
// did not. This is the page that makes the promise true.
//
// PURE DATA: imports only the PublicRoute TYPE, like every other module in this
// directory, because public-routes.ts is loaded by the Vite config in a plain
// Node context where the `@/` alias does not resolve.

import type { PublicRoute } from "./public-routes";

export const CHANGELOG_PATH = "/changelog";

export const CHANGELOG_META = {
  path: CHANGELOG_PATH,
  title: "Product Changelog",
  description:
    "Every change to GradeThread: new features, improvements and fixes to condition grading, certificates and the FlipDesk reseller tools, newest first.",
  h1: "What's new in GradeThread",
};

export function changelogRoute(): PublicRoute {
  return {
    path: CHANGELOG_PATH,
    title: CHANGELOG_META.title,
    description: CHANGELOG_META.description,
    // Entries are published as they ship, which is the one changefreq value
    // here that is a claim rather than a guess.
    changefreq: "weekly",
    priority: 0.5,
  };
}
