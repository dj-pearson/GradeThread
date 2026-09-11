// US-3044: does the MAX_AI_ASPECTS demand cut ever remove an aspect that the
// coverage metric still counts?
//
// WHY THIS EXISTS. The AutoLister fill report (services/edge-functions/scripts/
// aspect-fill-report.ts) divides "filled" by "exposed", where exposed means the
// aspect was filled OR eBay listed it in the RECOMMENDED tier for that leaf.
// That denominator comes from recommendedAspectCoverage(), which reads the RAW
// leaf payload and counts every RECOMMENDED aspect. The tool schema the model
// actually answers comes from buildAspectSpecsForCategory() -> prioritizeByDemand(),
// which caps at MAX_AI_ASPECTS (45).
//
// Those two lists are not the same list. Any aspect that is RECOMMENDED but
// falls past the cap sits in the fill report's denominator with a structurally
// impossible numerator: the model is never asked about it, so no prompt change
// can move its rate. US-3044's AFTER run left that open on Theme ("needs the
// leaf's cached payload, not a draft").
//
// This script gets the leaf payloads. eBay's Taxonomy API answers
// get_item_aspects_for_category with an APPLICATION token (client_credentials),
// so the whole census needs EBAY_APP_ID / EBAY_CERT_ID and no seller consent,
// no Supabase service-role key and no Anthropic key. A capture is checked in so
// the report runs with no credentials at all.
//
// Usage:
//   node scripts/aspect-demand-cut.mjs                 report from the capture
//   node scripts/aspect-demand-cut.mjs --self-test     prove the arithmetic
//   node scripts/aspect-demand-cut.mjs --refresh       re-capture from eBay
//   node scripts/aspect-demand-cut.mjs --cap 30        what a tighter cap would cut
//   node scripts/aspect-demand-cut.mjs --json          machine-readable
//
// The ranking below MIRRORS prioritizeByDemand() in
// services/edge-functions/src/lib/aspect-priority.ts. It is a mirror because
// this is a node script and that is Deno TypeScript; a mirror with nothing
// enforcing it drifts, so src/test/aspect-demand-cut-parity.test.ts runs both
// over randomized inputs and fails when their orderings disagree.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A path built from import.meta.url must go through fileURLToPath: .pathname is
// "/C:/..." on Windows and a bare relative path on Linux.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

export const DEFAULT_CAP = 45;
export const DEFAULT_FIXTURE = path.join(
  REPO,
  "scripts",
  "fixtures",
  "aspect-demand-cut-ebay-us-2026-09-11.json",
);

/**
 * The aspects US-3044 names, spelled the way eBay's US apparel tree spells
 * them. "Country of Origin" is eBay's own aspect name; the fill report's
 * shorter labels are cosmetic.
 */
export const REPORT_ASPECTS = [
  "Theme",
  "Fabric Type",
  "Garment Care",
  "Country of Origin",
  "MPN",
  "Style Code",
  "Product Line",
  "Model",
  "Character",
  "Department",
  "Features",
  "Occasion",
];

// ── the mirror ──────────────────────────────────────────────────────────────

/**
 * Mirror of prioritizeByDemand() in aspect-priority.ts.
 *
 * Required first in eBay's own order and never cut, then everything else by
 * relevanceIndicator.searchCount descending, ties RECOMMENDED before OPTIONAL,
 * then by name, then by original position.
 *
 * @param {Array<{name: string, required: boolean}>} specs
 * @param {unknown} rawAspects
 * @param {number} cap
 */
export function prioritizeByDemand(specs, rawAspects, cap = DEFAULT_CAP) {
  const list = Array.isArray(rawAspects) ? rawAspects : [];
  const searchCountByName = new Map();
  const usageByName = new Map();
  for (const a of list) {
    const name = typeof a?.localizedAspectName === "string" ? a.localizedAspectName : "";
    if (!name) continue;
    const count = Number(a?.relevanceIndicator?.searchCount);
    searchCountByName.set(name, Number.isFinite(count) ? count : 0);
    usageByName.set(name, String(a?.aspectConstraint?.aspectUsage ?? "OPTIONAL").toUpperCase());
  }

  const required = specs.filter((s) => s.required);
  const rest = specs
    .filter((s) => !s.required)
    .map((s, i) => ({
      spec: s,
      index: i,
      count: searchCountByName.get(s.name) ?? 0,
      recommended: usageByName.get(s.name) === "RECOMMENDED" ? 0 : 1,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.recommended - b.recommended ||
        a.spec.name.localeCompare(b.spec.name) ||
        a.index - b.index,
    )
    .map((e) => e.spec);

  const room = Math.max(0, cap - required.length);
  return [...required, ...rest.slice(0, room)];
}

/**
 * Mirror of the name/required half of buildAspectSpecsForCategory(): names are
 * trimmed, nameless aspects are dropped, order is eBay's.
 *
 * @param {Array<Record<string, unknown>>} rawAspects
 */
export function specsFromRaw(rawAspects) {
  const out = [];
  for (const a of Array.isArray(rawAspects) ? rawAspects : []) {
    const name = typeof a?.localizedAspectName === "string" ? a.localizedAspectName.trim() : "";
    if (!name) continue;
    out.push({ name, required: !!a?.aspectConstraint?.aspectRequired });
  }
  return out;
}

// ── the capture format ──────────────────────────────────────────────────────
//
// Columnar on purpose: 457 leaves x ~19 aspects is 8,748 rows, and a row of
// full-length JSON keys is four times the size of the data. `columns` names the
// tuple so the file stays self-describing.

export const CAPTURE_COLUMNS = ["nameIndex", "required", "usage", "mode", "searchCount", "valueCount"];

/** Expand a capture back into the raw eBay shape prioritizeByDemand reads. */
export function rawAspectsForLeaf(capture, leaf) {
  const names = capture.aspectNames;
  return leaf.aspects.map((row) => {
    const [nameIndex, required, usage, mode, searchCount, valueCount] = row;
    return {
      localizedAspectName: names[nameIndex],
      aspectConstraint: {
        aspectRequired: required === 1,
        aspectUsage: usage,
        aspectMode: mode,
      },
      ...(searchCount === null ? {} : { relevanceIndicator: { searchCount } }),
      valueCount,
    };
  });
}

// ── the arithmetic ──────────────────────────────────────────────────────────

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[i];
}

/**
 * Per aspect, across the captured leaves: how often eBay puts it in the
 * RECOMMENDED tier (the fill report's denominator) versus how often it survives
 * the cap into the tool schema (what the model can actually answer).
 *
 * @param {object} capture
 * @param {{cap?: number, aspects?: string[]}} [opts]
 */
export function reachabilityReport(capture, opts = {}) {
  const cap = opts.cap ?? DEFAULT_CAP;
  const wanted = opts.aspects ?? REPORT_ASPECTS;
  const stat = new Map();
  for (const name of wanted) {
    stat.set(name, {
      name,
      offered: 0,
      offeredInSchema: 0,
      recommended: 0,
      recommendedInSchema: 0,
      required: 0,
      modes: {},
    });
  }

  const perLeaf = [];
  let aspectRows = 0;
  let searchCountRows = 0;
  let leavesOverCap = 0;
  const cutButCounted = [];

  for (const leaf of capture.leaves) {
    const raw = rawAspectsForLeaf(capture, leaf);
    const specs = specsFromRaw(raw);
    perLeaf.push(specs.length);
    if (specs.length > cap) leavesOverCap++;
    const kept = new Set(prioritizeByDemand(specs, raw, cap).map((s) => s.name));

    for (const a of raw) {
      const name = String(a.localizedAspectName ?? "").trim();
      if (!name) continue;
      aspectRows++;
      const sc = Number(a.relevanceIndicator?.searchCount);
      if (Number.isFinite(sc) && sc > 0) searchCountRows++;

      const usage = String(a.aspectConstraint?.aspectUsage ?? "").toUpperCase();
      const inSchema = kept.has(name);
      // Every RECOMMENDED aspect the coverage metric counts but the schema
      // dropped: the whole question this script exists to answer.
      if (usage === "RECOMMENDED" && !inSchema) {
        cutButCounted.push({ leafId: leaf.id, path: leaf.path, aspect: name });
      }

      const s = stat.get(name);
      if (!s) continue;
      s.offered++;
      if (inSchema) s.offeredInSchema++;
      if (a.aspectConstraint?.aspectRequired) s.required++;
      const mode = String(a.aspectConstraint?.aspectMode ?? "UNKNOWN");
      s.modes[mode] = (s.modes[mode] ?? 0) + 1;
      if (usage === "RECOMMENDED") {
        s.recommended++;
        if (inSchema) s.recommendedInSchema++;
      }
    }
  }

  perLeaf.sort((a, b) => a - b);
  return {
    cap,
    leafCount: capture.leaves.length,
    aspectsPerLeaf: {
      min: perLeaf[0] ?? null,
      median: quantile(perLeaf, 0.5),
      p95: quantile(perLeaf, 0.95),
      max: perLeaf[perLeaf.length - 1] ?? null,
    },
    leavesOverCap,
    aspectRows,
    searchCountRows,
    cutButCounted,
    rows: wanted.map((name) => {
      const s = stat.get(name);
      return {
        ...s,
        reachable: s.recommended === 0 ? null : s.recommendedInSchema / s.recommended,
      };
    }),
  };
}

// ── capture ─────────────────────────────────────────────────────────────────

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function ebayAppToken(appId, certId) {
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${appId}:${certId}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });
  if (!res.ok) {
    throw new Error(`eBay app token failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).access_token;
}

async function taxonomy(token, urlPath, marketplaceId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://api.ebay.com/commerce/taxonomy/v1${urlPath}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        "Accept-Language": "en-US",
      },
    });
    if (res.ok) return await res.json();
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      continue;
    }
    throw new Error(`eBay taxonomy ${urlPath} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`eBay taxonomy ${urlPath} gave up after 3 attempts`);
}

async function refresh({ rootCategoryId, treeId, marketplaceId, out }) {
  const env = { ...readEnvFile(path.join(REPO, ".env")), ...process.env };
  const appId = env.EBAY_APP_ID;
  const certId = env.EBAY_CERT_ID;
  if (!appId || !certId) {
    console.error(
      "--refresh needs EBAY_APP_ID and EBAY_CERT_ID (repo .env or the environment).\n" +
        "They mint an APPLICATION token; no seller consent, no service-role key.",
    );
    process.exit(2);
  }
  const token = await ebayAppToken(appId, certId);

  const subtree = await taxonomy(
    token,
    `/category_tree/${treeId}/get_category_subtree?category_id=${encodeURIComponent(rootCategoryId)}`,
    marketplaceId,
  );
  const leaves = [];
  (function walk(node, trail) {
    const cat = node.category;
    const here = trail.concat(cat.categoryName);
    if (node.leafCategoryTreeNode) leaves.push({ id: cat.categoryId, path: here.join(" > ") });
    for (const child of node.childCategoryTreeNodes ?? []) walk(child, here);
  })(subtree.categorySubtreeNode, []);
  console.error(`[refresh] ${leaves.length} leaf categories under ${rootCategoryId}`);

  const nameIndex = new Map();
  const aspectNames = [];
  const indexOf = (name) => {
    let i = nameIndex.get(name);
    if (i === undefined) {
      i = aspectNames.length;
      aspectNames.push(name);
      nameIndex.set(name, i);
    }
    return i;
  };

  const byId = new Map();
  const queue = [...leaves];
  let done = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (queue.length > 0) {
        const leaf = queue.shift();
        const payload = await taxonomy(
          token,
          `/category_tree/${treeId}/get_item_aspects_for_category?category_id=${encodeURIComponent(leaf.id)}`,
          marketplaceId,
        );
        byId.set(leaf.id, { leaf, payload });
        done++;
        if (done % 50 === 0) console.error(`[refresh] ${done}/${leaves.length}`);
      }
    }),
  );

  // Re-walk in leaf order so the capture is byte-stable across runs.
  const rows = [];
  for (const leaf of leaves) {
    const { payload } = byId.get(leaf.id);
    const aspects = [];
    for (const a of payload?.aspects ?? []) {
      const name = a.localizedAspectName;
      if (typeof name !== "string" || name.trim() === "") continue;
      const sc = a.relevanceIndicator?.searchCount;
      aspects.push([
        indexOf(name),
        a.aspectConstraint?.aspectRequired ? 1 : 0,
        a.aspectConstraint?.aspectUsage ?? null,
        a.aspectConstraint?.aspectMode ?? null,
        typeof sc === "number" ? sc : null,
        (a.aspectValues ?? []).length,
      ]);
    }
    rows.push({ id: leaf.id, path: leaf.path, aspects });
  }

  const capture = {
    source: "eBay Taxonomy get_item_aspects_for_category (application token)",
    capturedAt: new Date().toISOString(),
    marketplaceId,
    categoryTreeId: treeId,
    rootCategoryId,
    columns: CAPTURE_COLUMNS,
    aspectNames,
    leaves: rows,
  };
  fs.writeFileSync(out, JSON.stringify(capture));
  console.error(
    `[refresh] wrote ${out} (${leaves.length} leaves, ${aspectNames.length} distinct aspects, ` +
      `${fs.statSync(out).size} bytes)`,
  );
  return capture;
}

// ── self-test ───────────────────────────────────────────────────────────────

function buildTestCapture() {
  const aspectNames = ["Brand", "Size", "Theme", "Alpha", "Beta", "Color", "Delta", "Zeta"];
  const i = (n) => aspectNames.indexOf(n);
  const REQ = "REQUIRED";
  const REC = "RECOMMENDED";
  const OPT = "OPTIONAL";
  const F = "FREE_TEXT";
  return {
    columns: CAPTURE_COLUMNS,
    aspectNames,
    leaves: [
      // L1: 2 required + 4 others, cap 5 leaves room for 3. All searchCounts
      // absent, so the tie-break is RECOMMENDED-then-alphabetical:
      // Alpha, Beta, Theme in; Zeta out. Theme survives.
      {
        id: "L1",
        path: "test > L1",
        aspects: [
          [i("Brand"), 1, REQ, F, null, 0],
          [i("Size"), 1, REQ, F, null, 0],
          [i("Theme"), 0, REC, F, null, 5],
          [i("Alpha"), 0, REC, F, null, 5],
          [i("Beta"), 0, REC, F, null, 5],
          [i("Zeta"), 0, OPT, F, null, 5],
        ],
      },
      // L2: 1 required + 5 recommended, cap 5 leaves room for 4. Alphabetical:
      // Alpha, Beta, Color, Delta in; Theme out. Theme is CUT while the
      // coverage metric still counts it.
      {
        id: "L2",
        path: "test > L2",
        aspects: [
          [i("Brand"), 1, REQ, F, null, 0],
          [i("Alpha"), 0, REC, F, null, 5],
          [i("Beta"), 0, REC, F, null, 5],
          [i("Color"), 0, REC, F, null, 5],
          [i("Delta"), 0, REC, F, null, 5],
          [i("Theme"), 0, REC, F, null, 5],
        ],
      },
      // L3: same shape, but Theme carries a real searchCount. Demand beats the
      // alphabet, so Theme is in and Delta is out.
      {
        id: "L3",
        path: "test > L3",
        aspects: [
          [i("Brand"), 1, REQ, F, null, 0],
          [i("Alpha"), 0, REC, F, 1, 5],
          [i("Beta"), 0, REC, F, 1, 5],
          [i("Color"), 0, REC, F, 1, 5],
          [i("Delta"), 0, REC, F, 1, 5],
          [i("Theme"), 0, REC, F, 900, 5],
        ],
      },
      // L4: 7 required against a cap of 5. Required aspects are publish
      // blockers, so the cap must never cut one.
      {
        id: "L4",
        path: "test > L4",
        aspects: [
          [i("Brand"), 1, REQ, F, null, 0],
          [i("Size"), 1, REQ, F, null, 0],
          [i("Theme"), 1, REQ, F, null, 0],
          [i("Alpha"), 1, REQ, F, null, 0],
          [i("Beta"), 1, REQ, F, null, 0],
          [i("Color"), 1, REQ, F, null, 0],
          [i("Delta"), 1, REQ, F, null, 0],
        ],
      },
    ],
  };
}

function selfTest() {
  const failures = [];
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${a}${ok ? "" : ` (expected ${e})`}`);
    if (!ok) failures.push(label);
  };

  const capture = buildTestCapture();
  const rep = reachabilityReport(capture, { cap: 5, aspects: ["Theme", "Delta", "Zeta"] });

  check("leafCount", rep.leafCount, 4);
  check("aspects per leaf (min/median/max)", [
    rep.aspectsPerLeaf.min,
    rep.aspectsPerLeaf.median,
    rep.aspectsPerLeaf.max,
  ], [6, 6, 7]);
  check("leaves over cap 5", rep.leavesOverCap, 4);
  check("aspect rows", rep.aspectRows, 25);
  check("rows carrying a positive searchCount", rep.searchCountRows, 5);

  const theme = rep.rows.find((r) => r.name === "Theme");
  check("Theme offered on", theme.offered, 4);
  check("Theme required on", theme.required, 1);
  check("Theme RECOMMENDED on", theme.recommended, 3);
  check("Theme RECOMMENDED and in schema", theme.recommendedInSchema, 2);
  check("Theme reachable", Math.round(theme.reachable * 100) / 100, 0.67);

  const delta = rep.rows.find((r) => r.name === "Delta");
  check("Delta RECOMMENDED on", delta.recommended, 2);
  check("Delta RECOMMENDED and in schema (L2 in, L3 out)", delta.recommendedInSchema, 1);

  const zeta = rep.rows.find((r) => r.name === "Zeta");
  check("Zeta is never RECOMMENDED, so reachable is undefined", zeta.reachable, null);

  check(
    "cut-but-counted pairs",
    rep.cutButCounted.map((c) => `${c.leafId}:${c.aspect}`).sort(),
    ["L2:Theme", "L3:Delta"],
  );

  // The cap must never cut a required aspect: L4 has 7 required against cap 5.
  const l4 = capture.leaves[3];
  const raw4 = rawAspectsForLeaf(capture, l4);
  check("required aspects survive a cap below their count", prioritizeByDemand(specsFromRaw(raw4), raw4, 5).length, 7);

  // An absent relevanceIndicator must rank as 0, not NaN. A NaN comparator
  // returns 0 for every pair and silently leaves the array in input order.
  const noDemand = [
    { localizedAspectName: "Zeta", aspectConstraint: { aspectUsage: "RECOMMENDED" } },
    { localizedAspectName: "Alpha", aspectConstraint: { aspectUsage: "OPTIONAL" } },
    { localizedAspectName: "Beta", aspectConstraint: { aspectUsage: "RECOMMENDED" } },
  ];
  check(
    "absent searchCount ranks as 0 (RECOMMENDED first, then alphabetical)",
    prioritizeByDemand(specsFromRaw(noDemand), noDemand, 5).map((s) => s.name),
    ["Beta", "Zeta", "Alpha"],
  );

  console.log(failures.length === 0 ? "\nself-test: PASS" : `\nself-test: ${failures.length} FAILED`);
  return failures.length === 0 ? 0 : 1;
}

// ── output ──────────────────────────────────────────────────────────────────

function pct(n) {
  return n === null ? "-" : `${Math.round(n * 100)}%`;
}

function printReport(capture, rep) {
  console.log(
    `eBay ${capture.marketplaceId ?? "?"} tree ${capture.categoryTreeId ?? "?"}, ` +
      `${rep.leafCount} leaf categories under ${capture.rootCategoryId ?? "?"} ` +
      `(captured ${capture.capturedAt ?? "?"})`,
  );
  console.log(
    `aspects per leaf: min ${rep.aspectsPerLeaf.min}, median ${rep.aspectsPerLeaf.median}, ` +
      `p95 ${rep.aspectsPerLeaf.p95}, max ${rep.aspectsPerLeaf.max}`,
  );
  console.log(`cap MAX_AI_ASPECTS = ${rep.cap}; leaves above it: ${rep.leavesOverCap} of ${rep.leafCount}`);
  console.log(
    `relevanceIndicator.searchCount > 0 on ${rep.searchCountRows} of ${rep.aspectRows} aspect rows ` +
      `(${((100 * rep.searchCountRows) / Math.max(1, rep.aspectRows)).toFixed(1)}%)`,
  );
  console.log("");
  console.log("| Aspect | Offered on | RECOMMENDED on | Reaches the schema | Reachable | Mode |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rep.rows) {
    const modes = Object.entries(r.modes)
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => `${m} x${n}`)
      .join(", ");
    console.log(
      `| ${r.name} | ${r.offered} | ${r.recommended} | ${r.recommendedInSchema} | ` +
        `${pct(r.reachable)} | ${modes || "-"} |`,
    );
  }
  console.log("");
  if (rep.cutButCounted.length === 0) {
    console.log(
      `No RECOMMENDED aspect anywhere in this tree is cut by the cap. Every aspect the ` +
        `coverage metric counts is one the model was asked about, so a zero fill rate here ` +
        `is a prompt or evidence problem, not a schema problem.`,
    );
  } else {
    console.log(`${rep.cutButCounted.length} RECOMMENDED aspects are counted by coverage but cut from the schema:`);
    const byAspect = new Map();
    for (const c of rep.cutButCounted) byAspect.set(c.aspect, (byAspect.get(c.aspect) ?? 0) + 1);
    for (const [name, n] of [...byAspect].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`  ${String(n).padStart(4)}  ${name}`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { cap: DEFAULT_CAP, fixture: DEFAULT_FIXTURE, root: "11450", tree: "0", marketplace: "EBAY_US" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--refresh") out.refresh = true;
    else if (a === "--json") out.json = true;
    else if (a === "--cap") out.cap = Number(argv[++i]);
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--tree") out.tree = argv[++i];
    else if (a === "--marketplace") out.marketplace = argv[++i];
    else if (a === "--aspects") out.aspects = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    process.exit(selfTest());
  }

  let capture;
  if (args.refresh) {
    capture = await refresh({
      rootCategoryId: args.root,
      treeId: args.tree,
      marketplaceId: args.marketplace,
      out: args.fixture,
    });
  } else {
    if (!fs.existsSync(args.fixture)) {
      console.error(
        `No capture at ${args.fixture}.\n` +
          `Run with --refresh (needs EBAY_APP_ID / EBAY_CERT_ID) to make one.`,
      );
      process.exit(2);
    }
    capture = JSON.parse(fs.readFileSync(args.fixture, "utf8"));
  }

  const rep = reachabilityReport(capture, { cap: args.cap, aspects: args.aspects });
  if (args.json) {
    console.log(JSON.stringify({ capture: { capturedAt: capture.capturedAt }, report: rep }, null, 2));
  } else {
    printReport(capture, rep);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
