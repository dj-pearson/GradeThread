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

for (const { s, ops } of rows) {
  out.push(`## ${s.id} — ${s.title ?? ""}`);
  out.push("");
  out.push(`priority ${s.priority ?? "unranked"}`);
  out.push("");
  for (const op of ops) {
    const clean = op.replace(/^\s*OPERATOR:?\s*/i, "").trim();
    out.push(`- ${clean}`);
  }
  out.push("");
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
