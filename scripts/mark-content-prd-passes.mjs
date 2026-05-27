// Mark the content-module user stories that are actually delivered as
// passes: true. Leaves the deliberately-skipped Phase F items
// (US-251, US-252, US-254, US-255, US-260) as passes: false so they
// remain visible as backlog. Adds US-261 for the scheduled-post
// processor + cache-on-edit work that wasn't in the original plan.
// Idempotent.

import fs from "node:fs";

const PRD_PATH = "C:/Users/dpearson/Documents/GradeThread/prd.json";

const DONE_IDS = new Set([
  // Phase A
  "US-226", "US-227", "US-228", "US-229", "US-230", "US-231",
  // Phase B
  "US-232", "US-234", "US-237", "US-238", "US-241", "US-242", "US-243",
  "US-245",
  // Phase C
  "US-244", "US-246", "US-247", "US-248", "US-249",
  // Phase D
  "US-233", "US-239", "US-240", "US-250",
  // Phase E (235/236 are the dispatcher + scheduler; Make.com config is the user's)
  "US-235", "US-236",
  // Phase F (delivered)
  "US-253", "US-256", "US-257", "US-258", "US-259",
]);

const prd = JSON.parse(fs.readFileSync(PRD_PATH, "utf8"));
let updated = 0;
for (const s of prd.userStories) {
  if (DONE_IDS.has(s.id) && s.passes !== true) {
    s.passes = true;
    updated++;
  }
}

const NEW_STORY = {
  id: "US-261",
  title: "Scheduled-post processor + cache purge on edits",
  description:
    "As an admin, I need scheduled posts (status='scheduled' with scheduled_for set) to actually publish themselves when due, and I need the Cloudflare cache to purge when I edit a published post so readers see changes immediately.",
  acceptanceCriteria: [
    "Scheduler tick publishes blog and social posts where status='scheduled' AND scheduled_for <= now at the top of every tick, before any cadence-driven generation",
    "Concurrency-safe: WHERE status='scheduled' on the UPDATE means a second concurrent tick won't double-publish",
    "Each promoted post fires the publish-time webhook + history-index append + (blog only) Cloudflare cache purge",
    "Tick response includes published_scheduled count so the dashboard can show it",
    "PATCH /api/content/blog/:id purges /blog/<slug> + /sitemap.xml + /rss.xml when the post is currently status='published'",
    "Slug renames purge BOTH the old and new slug so search engines don't see a 200 on the old URL",
  ],
  priority: 261,
  passes: true,
  notes: "",
};
if (!prd.userStories.find((s) => s.id === NEW_STORY.id)) {
  prd.userStories.push(NEW_STORY);
  updated++;
}

// Also append a US-262 for the analytics dashboard above and beyond
// the original US-258 spec (we delivered something tighter than the
// original "needs GA4 reporting API" framing).
const NEW_ANALYTICS = {
  id: "US-262",
  title: "Self-contained content analytics dashboard",
  description:
    "As an admin, I need a single page that summarizes content health (topic bank levels, posts published this week/month, webhook success rate, AI token usage, recent activity) using only data already in our DB — no external analytics dependency.",
  acceptanceCriteria: [
    "GET /api/content/settings/stats returns one composite response covering bank levels, published-7d and -30d per surface/product, webhook success rate over last 100, failed-7d count, AI input/output token totals over 30d, and the 10 most recent published items per surface",
    "src/pages/content/analytics.tsx renders 4 headline KPI cards + topic bank table (low-bank slices badged red) + per-product published breakdown + interleaved recent-activity feed with live links",
    "Lazy-loaded route at /dashboard/content/analytics under <AdminRoute>",
    "Sidebar entry added to the Content group (Activity icon)",
  ],
  priority: 262,
  passes: true,
  notes: "",
};
if (!prd.userStories.find((s) => s.id === NEW_ANALYTICS.id)) {
  prd.userStories.push(NEW_ANALYTICS);
  updated++;
}

fs.writeFileSync(PRD_PATH, JSON.stringify(prd, null, 2) + "\n");
console.log(
  `Updated ${updated} entries. Total stories: ${prd.userStories.length}.`,
);
console.log(
  `Remaining content backlog (passes:false): ${prd.userStories
    .filter((s) => /^US-25[12456]$|^US-260$/.test(s.id))
    .map((s) => s.id)
    .join(", ")}`,
);
