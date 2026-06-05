// Flip `passes: true` for the given story IDs in prd.json, preserving the
// file's exact formatting (2-space indent, CRLF line endings, no trailing
// newline) so the git diff shows ONLY the changed `passes` lines.
//
//   node scripts/mark-stories.mjs US-491 US-497 US-508 US-509
//
// Idempotent: re-marking an already-true story is a no-op. Errors loudly if an
// id isn't found so a typo can't silently mark nothing.
import fs from "node:fs";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: node scripts/mark-stories.mjs <US-XXX> [US-YYY ...]");
  process.exit(1);
}

const path = "prd.json";
const orig = fs.readFileSync(path, "utf8");
const prd = JSON.parse(orig);
const byId = new Map((prd.userStories ?? []).map((s) => [s.id, s]));

const missing = ids.filter((id) => !byId.has(id));
if (missing.length) {
  console.error("Unknown story ids:", missing.join(", "));
  process.exit(1);
}

const changed = [];
for (const id of ids) {
  const s = byId.get(id);
  if (s.passes !== true) {
    s.passes = true;
    changed.push(id);
  }
}

const out = JSON.stringify(prd, null, 2).replace(/\n/g, "\r\n");
fs.writeFileSync(path, out);

const done = prd.userStories.filter((s) => s.passes === true).length;
const total = prd.userStories.length;
console.log(`Marked ${changed.length} story(ies): ${changed.join(", ") || "(none — already true)"}`);
console.log(`prd.json now ${done}/${total} passing.`);
