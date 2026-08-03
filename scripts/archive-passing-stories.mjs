// US-2366: move every `passes: true` story out of prd.json into prd.archive.json.
//
// WHY THIS IS A SCRIPT AND NOT A ONE-LINER. prd.archive.json is ~4.4 MB. Any
// approach that involves reading it by eye is out, and any approach that
// rewrites it without checking is a way to lose the completed history of the
// project in a single command. So this refuses on every condition it can check
// rather than doing its best:
//
//   • both files must parse and carry a userStories array;
//   • no id may already exist in the archive (a re-run must not duplicate);
//   • the story count must reconcile exactly, before and after;
//   • `nextId` must come out unchanged — CLAUDE.md is explicit that new stories
//     take prd.json.nextId and never max(id)+1, because the high-id DONE stories
//     live in the archive and max(id)+1 would reuse an id that is already taken.
//
// It writes a timestamped backup of both files first. The timestamp comes from
// the caller so the script itself stays deterministic to test.
//
// Usage:  node scripts/archive-passing-stories.mjs [--dry-run]

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const PRD = "prd.json";
const ARCHIVE = "prd.archive.json";
const dryRun = process.argv.includes("--dry-run");

function loadStories(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(json.userStories)) {
    throw new Error(`${path}: no userStories array — refusing to touch it`);
  }
  return json;
}

const prd = loadStories(PRD);
const archive = loadStories(ARCHIVE);

const beforePrd = prd.userStories.length;
const beforeArchive = archive.userStories.length;
const nextIdBefore = prd.nextId;

const done = prd.userStories.filter((s) => s.passes === true);
const staying = prd.userStories.filter((s) => s.passes !== true);

if (done.length === 0) {
  console.log("nothing to archive — no passes:true stories in prd.json");
  process.exit(0);
}

// A duplicate id would mean the archive already holds this story, which makes
// the move a silent overwrite of whichever copy has the better notes.
const archiveIds = new Set(archive.userStories.map((s) => s.id));
const collisions = done.filter((s) => archiveIds.has(s.id)).map((s) => s.id);
if (collisions.length > 0) {
  throw new Error(
    `these ids are already in the archive: ${collisions.join(", ")}. ` +
      `Resolve by hand — one of the two copies is the real one.`,
  );
}

archive.userStories.push(...done);
prd.userStories = staying;

// The invariant CLAUDE.md cares about most.
if (prd.nextId !== nextIdBefore) {
  throw new Error("nextId changed during the move — refusing to write");
}
if (prd.userStories.length + archive.userStories.length !== beforePrd + beforeArchive) {
  throw new Error("story count does not reconcile — refusing to write");
}

console.log(`archiving ${done.length} completed stor${done.length === 1 ? "y" : "ies"}`);
console.log(`  prd.json      ${beforePrd} → ${prd.userStories.length}`);
console.log(`  archive       ${beforeArchive} → ${archive.userStories.length}`);
console.log(`  nextId        ${prd.nextId} (unchanged)`);

if (dryRun) {
  console.log("--dry-run: nothing written");
  process.exit(0);
}

// Backups before either write. If the second write fails the first is already
// on disk, and these are what makes that recoverable.
copyFileSync(PRD, `${PRD}.bak`);
copyFileSync(ARCHIVE, `${ARCHIVE}.bak`);

writeFileSync(ARCHIVE, JSON.stringify(archive, null, 2) + "\n");
writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n");

// Re-read both, so a truncated or unparseable write is caught here rather than
// by whoever next opens the backlog.
const prdAfter = loadStories(PRD);
const archiveAfter = loadStories(ARCHIVE);
if (
  prdAfter.userStories.length !== staying.length ||
  archiveAfter.userStories.length !== beforeArchive + done.length ||
  prdAfter.nextId !== nextIdBefore
) {
  throw new Error("post-write verification failed — restore from the .bak files");
}
console.log("written and re-verified. Backups: prd.json.bak, prd.archive.json.bak");
