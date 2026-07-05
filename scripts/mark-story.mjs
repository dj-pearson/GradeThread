// Loop helper: flip a prd.json story's `passes` to true by id.
//   node scripts/mark-story.mjs US-1614 [US-1615 ...]
// Idempotent; errors if an id isn't found. Preserves file formatting (2-space).
import { readFileSync, writeFileSync } from "node:fs";
const PRD = new URL("../prd.json", import.meta.url);
const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: node scripts/mark-story.mjs US-#### [US-#### ...]");
  process.exit(1);
}
const prd = JSON.parse(readFileSync(PRD, "utf8"));
const byId = new Map(prd.userStories.map((s) => [s.id, s]));
for (const id of ids) {
  const s = byId.get(id);
  if (!s) throw new Error(`story not found: ${id}`);
  s.passes = true;
}
writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n");
console.log(`marked passes:true → ${ids.join(", ")}`);
