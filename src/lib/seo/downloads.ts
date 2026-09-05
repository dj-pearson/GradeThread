// The download page (US-3117): /download.
//
// One URL to hand somebody who asks "where do I get it" — a bio link, an email
// footer, a support reply. US-3116 put the three store links in the site footer
// and on the dashboard; this is the page they can be sent TO, and the only
// surface that explains what each one actually does differently.
//
// Model A prerendered marketing page. PURE DATA: imports only the PublicRoute
// TYPE, so the registry can import it without a cycle.

import type { PublicRoute } from "./public-routes";

export const DOWNLOAD_PATH = "/download";

export const DOWNLOAD_META = {
  path: DOWNLOAD_PATH,
  title: "Download the App & Browser Extensions",
  description:
    "Get GradeThread on iPhone, Chrome and Firefox: grade a garment from your phone while you source, and list from the marketplace tab you are already in.",
  h1: "Get GradeThread wherever you source",
  intro:
    "GradeThread runs in three places, and they are for three different moments. The iPhone app is for the thrift-store aisle, where the garment is in your hands and the decision is buy or walk. The browser extensions are for the desk, where the listing gets written. All three sign in to the same account and share the same inventory.",
};

export function downloadRoute(): PublicRoute {
  return {
    path: DOWNLOAD_PATH,
    title: DOWNLOAD_META.title,
    description: DOWNLOAD_META.description,
    changefreq: "monthly",
    // Below the pillars and above the long tail: it converts, but nobody
    // searches for it — it is a page you are SENT to.
    priority: 0.7,
    // US-2044: jsonLdType must describe what is actually prerendered. The page
    // emits three SoftwareApplication entries (one per platform) and an
    // FAQPage; SoftwareApplication is the primary, and jsonld-parity.test.tsx
    // holds the runtime and prerendered copies identical.
    jsonLdType: "SoftwareApplication",
  };
}
