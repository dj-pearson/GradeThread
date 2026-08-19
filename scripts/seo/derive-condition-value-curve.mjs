// Re-derives the condition-to-value curve in src/lib/condition-value-curve.ts
// from the LIVE public Condition Index (US-9006).
//
// The curve in that file is a default, used when the seller has not picked a
// specific Condition Index item. It has to come from data rather than from
// somebody's sense of what a 7.0 is worth, and it has to be re-runnable so the
// next person can check it rather than trust it.
//
// This reads only the public, unauthenticated, aggregate endpoints — the same
// ones the /condition-index SEO pages use. No credentials, no per-user rows.
//
// Usage:
//   node scripts/seo/derive-condition-value-curve.mjs
//   node scripts/seo/derive-condition-value-curve.mjs --json out.json
//
// It PRINTS the table; it does not write the module. Updating a published
// number is a decision, not a side effect.

const BASE =
  process.env.CONDITION_INDEX_BASE ??
  "https://functions.gradethread.com/api/grading/public/condition-index";

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const hubRes = await fetch(BASE, { headers: { Accept: "application/json" } });
if (!hubRes.ok) throw new Error(`hub: HTTP ${hubRes.status}`);
const items = (await hubRes.json()).items ?? [];
console.log(`[curve] ${items.length} published curves`);

const curves = [];
for (const it of items) {
  const res = await fetch(`${BASE}/${it.slug}`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.log(`[curve] ${it.slug}: HTTP ${res.status}, skipped`);
    continue;
  }
  const body = await res.json();
  const curve = body.curve ?? body;
  if (curve?.points?.length) curves.push(curve);
}

const totalComps = curves.reduce((sum, c) => sum + (c.totalSampleSize ?? 0), 0);
console.log(`[curve] ${curves.length} usable, ${totalComps} sold comps behind them`);

// Each grade's median as a share of the SAME curve's top-grade median, then the
// median of those shares across every curve.
const shares = new Map();
for (const c of curves) {
  const pts = c.points
    .filter((p) => p.medianCents != null && p.medianCents > 0)
    .sort((a, b) => b.grade - a.grade);
  if (!pts.length) continue;
  const top = pts[0].medianCents;
  for (const p of pts) {
    if (!shares.has(p.grade)) shares.set(p.grade, []);
    shares.get(p.grade).push(p.medianCents / top);
  }
}

const rows = [...shares.keys()]
  .sort((a, b) => b - a)
  .map((grade) => {
    const s = shares.get(grade);
    const r3 = (n) => Math.round(n * 1000) / 1000;
    return {
      grade,
      curves: s.length,
      ratio: r3(median(s)),
      low: r3(Math.min(...s)),
      high: r3(Math.max(...s)),
    };
  });

console.table(rows);
console.log("\nPaste-ready for CONDITION_VALUE_CURVE:\n");
for (const r of rows) {
  console.log(`  { grade: ${r.grade}, ratio: ${r.ratio}, low: ${r.low}, high: ${r.high} },`);
}
console.log(`\nCONDITION_CURVE_SOURCE_CURVES = ${curves.length}`);
console.log(`CONDITION_CURVE_SOURCE_COMPS  = ${totalComps}`);

const jsonAt = process.argv.indexOf("--json");
if (jsonAt > -1 && process.argv[jsonAt + 1]) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ rows, curves }, null, 1));
  console.log(`\n[curve] wrote ${process.argv[jsonAt + 1]}`);
}
