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

// ── THE OPENING MOVE, BEFORE THE 157-STORY LIST (US-3042 pass, 2026-09-20) ──
//
// Grouping by venue turned an impossible list into "open this, do these", and
// it still opens with 62 steps under "somewhere else". What it does not answer
// is the only question worth asking first: what is the SHORTEST thing you can
// do that unblocks the most stories.
//
// It has a mechanical answer. Held migrations are named in PENDING_MIGRATIONS.md
// with a fixed heading shape, each naming the story it carries. Applying them
// is one sitting. The edge deploy that must follow is a second, and a large
// share of the remaining criteria are "after the edge deploy, measure X" --
// they are not separate work at all, they are the same deploy plus a read.
//
// So this section is computed, never hand-maintained: a hand-kept "start here"
// is out of date the first time a migration lands.

/** Held migrations, oldest first, from PENDING_MIGRATIONS.md's own headings. */
function heldMigrations() {
  let doc;
  try {
    doc = readFileSync(ROOT + "PENDING_MIGRATIONS.md", "utf8");
  } catch {
    return [];
  }
  const held = [];
  // `## <hourglass> HELD: 00808_name.sql (US-3197 - what it carries)`
  const re = /^##\s*\S*\s*HELD:\s*(\d{5})_(\S+?)\.sql\s*\(([^)]*)\)/gim;
  let m;
  while ((m = re.exec(doc))) {
    const inside = m[3];
    const story = /US-\d+/.exec(inside);
    held.push({
      version: m[1],
      name: m[2],
      story: story ? story[0] : null,
      // Everything after the story id and its separator, which is the human
      // sentence the heading already wrote.
      what: inside.replace(/^US-\d+\s*[-\u2014:]*\s*/, "").trim(),
    });
  }
  held.sort((a, b) => a.version.localeCompare(b.version));
  return held;
}

/** Steps that are a READ taken after the edge deploy, not separate work. */
const AFTER_DEPLOY =
  /after (the )?(edge )?deploy|once (the )?edge|following the deploy|after it deploys/i;

function startHere(rows) {
  const held = heldMigrations();
  const afterDeploy = [];
  for (const { s, ops } of rows) {
    for (const op of ops) if (AFTER_DEPLOY.test(op)) { afterDeploy.push(s); break; }
  }
  const lines = [];
  lines.push("## Start here");
  lines.push("");
  if (held.length === 0 && afterDeploy.length === 0) {
    lines.push(
      "No migration is held and nothing is waiting on an edge deploy, so there " +
        "is no shortest path to compute. Work the venues below in the order " +
        "they are listed.",
    );
    lines.push("");
    lines.push("---");
    lines.push("");
    return lines;
  }
  lines.push(
    "Computed from PENDING_MIGRATIONS.md and the criteria below, so it is " +
      "right on the day you read it. Everything under this heading is two " +
      "sittings, and it is the two that move the most stories.",
  );
  lines.push("");
  if (held.length > 0) {
    lines.push(
      `**1. Apply the ${held.length} held migration${held.length === 1 ? "" : "s"}, oldest first.** ` +
        "`npm run migrate:prod` reads what prod already has; " +
        "`npm run migrate:prod -- --apply --yes` takes a backup and applies. " +
        "Each entry in PENDING_MIGRATIONS.md carries its own risk note and its " +
        "own readback -- run the readback, do not assume the apply.",
    );
    lines.push("");
    for (const h of held) {
      const who = h.story ? `${h.story} — ` : "";
      lines.push(`- \`${h.version}_${h.name}.sql\` — ${who}${h.what}`);
    }
    lines.push("");
  }
  lines.push(
    `**${held.length > 0 ? "2" : "1"}. Redeploy the edge on Coolify.** Its boot guard ` +
      "expects the schema version the migrations above just set, so this " +
      "follows them rather than leading. " +
      (afterDeploy.length > 0
        ? `That one deploy is the precondition for **${afterDeploy.length} ` +
          `stor${afterDeploy.length === 1 ? "y" : "ies"}** whose remaining step is a ` +
          "measurement taken afterwards, not separate work: " +
          afterDeploy.map((s) => s.id).join(", ") + "."
        : "Nothing below is waiting on it today."),
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines;
}

out.push(...startHere(rows));

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
