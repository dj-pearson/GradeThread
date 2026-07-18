#!/usr/bin/env node
// US-1612 / AGENTIC-OS Phase 2 (Module Z): progress digest — a terse markdown
// summary of progress.txt entries + prd.json backlog deltas since a given date.
// Host-side, read-only. Answers "what landed, what's in flight, what's blocked"
// without reading the whole 690 KB progress log by hand.
//
//   node scripts/prd-digest.mjs [--since YYYY-MM-DD]

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;
const HEADER_RE = /^===\s*(.+?)\s*===\s*$/;
const STORY_ID_RE = /US-\d+/g;

// Parse progress.txt into dated entries. Each `=== … ===` header starts one.
export function parseProgressEntries(text) {
  const entries = [];
  for (const line of String(text ?? "").split("\n")) {
    const h = HEADER_RE.exec(line);
    if (!h) continue;
    const header = h[1];
    const date = DATE_RE.exec(header)?.[1] ?? null;
    const ids = [...new Set(header.match(STORY_ID_RE) ?? [])];
    // Title = the header minus a leading date/parenthetical noise, best-effort.
    entries.push({ date, ids, title: header });
  }
  return entries;
}

// Which OPEN stories are blocked by another OPEN story (a dependsOn on a
// passes:false active id — a dep on a done/archived id is satisfied). Pure.
export function computeBlocked(prd) {
  const stories = Array.isArray(prd?.userStories) ? prd.userStories : [];
  const openIds = new Set(stories.filter((s) => s?.passes !== true && typeof s?.id === "string").map((s) => s.id));
  const blocked = [];
  for (const s of stories) {
    if (s?.passes === true) continue;
    const deps = Array.isArray(s?.dependsOn) ? s.dependsOn : [];
    const openDeps = deps.filter((d) => openIds.has(d));
    if (openDeps.length) blocked.push({ id: s.id, blockedBy: openDeps });
  }
  return blocked;
}

// Assemble the digest markdown (pure). `sinceDate` is a YYYY-MM-DD string; only
// progress entries dated >= it are listed as "landed".
export function digest({ progressText, prd, sinceDate }) {
  const stories = Array.isArray(prd?.userStories) ? prd.userStories : [];
  const done = stories.filter((s) => s?.passes === true).length;
  const open = stories.length - done;

  const entries = parseProgressEntries(progressText);
  const landed = entries
    .filter((e) => e.date && (!sinceDate || e.date >= sinceDate))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const blocked = computeBlocked(prd);
  const blockedIds = new Set(blocked.map((b) => b.id));
  const ready = stories.filter((s) => s?.passes !== true && !blockedIds.has(s.id));

  const lines = [];
  lines.push(`# Progress digest${sinceDate ? ` since ${sinceDate}` : ""}`);
  lines.push("");
  lines.push(`**Backlog:** ${stories.length} active stories — ${done} done, ${open} open (${ready.length} ready, ${blocked.length} blocked).`);
  lines.push("");

  lines.push(`## Landed${sinceDate ? ` since ${sinceDate}` : ""} (${landed.length})`);
  if (landed.length === 0) lines.push("- _(no dated progress entries in range)_");
  for (const e of landed) lines.push(`- ${e.date} — ${e.title}`);
  lines.push("");

  lines.push(`## Blocked (${blocked.length})`);
  if (blocked.length === 0) lines.push("- _none_");
  for (const b of blocked) lines.push(`- ${b.id} — waiting on ${b.blockedBy.join(", ")}`);
  lines.push("");

  lines.push(`## Ready backlog (${ready.length})`);
  for (const s of ready.slice(0, 25)) lines.push(`- ${s.id} — ${String(s.title ?? "").slice(0, 90)}`);
  if (ready.length > 25) lines.push(`- …and ${ready.length - 25} more`);

  return lines.join("\n") + "\n";
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const prd = JSON.parse(readFileSync(resolve(root, "prd.json"), "utf8"));
  let progressText = "";
  try {
    progressText = readFileSync(resolve(root, "progress.txt"), "utf8");
  } catch {
    // no progress log — the digest still reports the backlog
  }
  const sinceDate = argValue("--since");
  process.stdout.write(digest({ progressText, prd, sinceDate }));
}

// Entry check. Compare URL to URL: `file://` + a raw argv path is not a valid
// file URL on Windows (backslashes, and a missing third slash before the drive
// letter), so the old comparison was always false there and main() never ran —
// the script exited 0 having done nothing, on every Windows run.
const isEntry = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isEntry) {
  main();
}
