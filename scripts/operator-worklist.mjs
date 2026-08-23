// The OPERATOR criteria across the open backlog, in priority order.
//
// 84% of open stories carry one. That is NOT the same as 84% blocked — most
// have buildable criteria before the operator step, and this session shipped
// several of those. What it does mean is that the backlog's tail is owner work,
// and it has never been collected in one place.
import { readFileSync, writeFileSync } from "node:fs";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..") + "/";
const prd = JSON.parse(readFileSync(ROOT + "prd.json", "utf8"));
const open = prd.userStories.filter((s) => !s.passes);

const rows = [];
for (const s of open) {
  const ops = (s.acceptanceCriteria ?? []).filter((a) => /\bOPERATOR\b/.test(a));
  if (ops.length === 0) continue;
  rows.push({ s, ops });
}
rows.sort((a, b) => (a.s.priority ?? 1e9) - (b.s.priority ?? 1e9));

const out = [];
out.push("# What the backlog is waiting on you for");
out.push("");
out.push(
  "Regenerate with: node scripts/operator-worklist.mjs. Built from prd.json, " +
    `where ${rows.length} of ${open.length} open stories carry at least one ` +
    "OPERATOR criterion — a step only you can take.",
);
out.push("");
out.push(
  "This is not a list of blocked work. Most of these stories have buildable " +
    "criteria before the operator step, and several were finished this session " +
    "right up to it. It is a list of the last mile.",
);
out.push("");

// Group by WHERE the work happens, not by story.
//
// 120 steps read as an impossible list. They are not 120 sittings: most are
// queries against one database, and a dozen more are one console each. Sorting
// by venue turns the list into "open this, do these" — which is how someone
// actually works through it.
//
// Order matters: the first match wins, so the more specific venues are listed
// before the generic "read something in a browser".
const VENUES = [
  // Specific systems first. A step naming two venues is filed under the one you
  // have to open FIRST, which is why the deploy rules sit above the bare-"prod"
  // rule: "set the variable, redeploy, then confirm in prod" starts at Coolify.
  ["A lawyer", /counsel|lawyer|legal review|terms clause|substantiation/i],
  ["App Store Connect", /App Store|StoreKit|appstore|sandbox purchase|TestFlight/i],
  ["Google Play Console", /Play Console|googleplay|Google Play/i],
  ["eBay developer or seller account", /eBay (developer|seller|sandbox)|developer\.ebay|restricted scope|sell\.logistics/i],
  ["A marketplace account, logged in", /Poshmark|Mercari|Grailed|Vinted|Depop|Etsy|Facebook Marketplace|logged-in|signed in|Check selectors|popup selector/i],
  ["Coolify, or a deploy + env change", /Coolify|redeploy|after deploy|env(ironment)? var|Pages variable|set the .* variable|flip .* flag|rclone|the DB host|SSH|container/i],
  ["Cloudflare dashboard", /Cloudflare|Pages (real-time )?log|\bDNS\b/i],
  ["Sentry or PostHog", /Sentry|PostHog/i],
  ["Email or SES", /\bSES\b|SMTP|confirmation mail|deliverab/i],
  ["A phone, in your hands", /real device|on an? (iPhone|Android)|screen reader|NVDA|VoiceOver|hold the camera|take a photo/i],
  ["A grading run that costs real money", /golden-set|canary|real vision calls|eval gate/i],
  // Now the database. Deliberately broad and deliberately LAST among systems,
  // so a step that merely CONFIRMS something in prod after doing the real work
  // elsewhere is filed where the real work is.
  ["Production database (psql or the Supabase SQL editor)", /prod-diagnostics|\bprod\b|production|psql|SELECT |pg_constraint|supautils|apply (supabase\/migrations|00\d{3})|NOTIFY pgrst/i],
  // A judgement call with nothing to log into.
  ["A decision, with nothing to open", /^decide\b|\bdecide whether\b|choose whether|confirm whether .* wanted/i],
];

function venueOf(text) {
  for (const [name, re] of VENUES) if (re.test(text)) return name;
  return "Somewhere else (read the step)";
}

const byVenue = new Map();
for (const { s, ops } of rows) {
  for (const op of ops) {
    const clean = op.replace(/^\s*OPERATOR:?\s*/i, "").trim();
    const v = venueOf(clean);
    if (!byVenue.has(v)) byVenue.set(v, []);
    byVenue.get(v).push({ s, clean });
  }
}

// Venues with the most work first — that is the order that clears the list.
const venues = [...byVenue.entries()].sort((a, b) => b[1].length - a[1].length);

out.push("## Where the work happens");
out.push("");
out.push("Most of these are not separate sittings. Grouped by what you need open:");
out.push("");
for (const [venue, items] of venues) {
  out.push(`- **${venue}** — ${items.length} step${items.length === 1 ? "" : "s"}`);
}
out.push("");
out.push("---");
out.push("");

for (const [venue, items] of venues) {
  out.push(`## ${venue}`);
  out.push("");
  items.sort((a, b) => (a.s.priority ?? 1e9) - (b.s.priority ?? 1e9));
  for (const { s, clean } of items) {
    out.push(`### ${s.id} — ${s.title ?? ""}`);
    out.push("");
    out.push(`priority ${s.priority ?? "unranked"}`);
    out.push("");
    out.push(clean);
    out.push("");
  }
}

const path = ROOT + "docs/operator-worklist.md";
writeFileSync(path, out.join("\n"));
console.log(`wrote ${path}`);
console.log(`${rows.length} stories, ${rows.reduce((n, r) => n + r.ops.length, 0)} operator criteria`);
console.log("");
console.log("Top 12 by priority:");
for (const { s, ops } of rows.slice(0, 12)) {
  console.log(`  p${String(s.priority ?? "-").padEnd(5)} ${s.id}  ${(s.title ?? "").slice(0, 58)}`);
  console.log(`         ${ops[0].replace(/^\s*OPERATOR:?\s*/i, "").slice(0, 90)}`);
}
