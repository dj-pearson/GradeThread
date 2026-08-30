// US-3016: what eBay actually accepts, and what we are still dropping.
//
// WHY THIS EXISTS. The AI capture pass in lib/ai-extract.ts describes a garment
// in a seller's words ("Taupe", "Sage Green", "Mini"). eBay's SELECTION_ONLY
// aspects accept only their own coarse list. lib/aspect-normalize.ts is the
// bridge, and until US-3016 it was a handful of spelling equivalences, so most
// descriptive values fell on the floor and the seller saw an empty Color.
//
// The fix added family tables to that file. This script is how we know whether
// they are enough — and it does NOT need anyone to research eBay's lists by
// hand, because we already store them. Every category a seller has ever opened
// in the composer left its verbatim getItemAspectsForCategory response in
// public.ebay_category_aspects (30-day TTL, shared across all users). That
// cache IS the reference; this reads it back.
//
// Two outputs:
//   --reference   the union of allowed values per aspect name, across every
//                 cached category. Paste-able as the one big reference.
//   (default)     the coverage audit: every value our family tables and the
//                 ai-extract prompt hints can produce, run against each cached
//                 category's real allowed list, listing the ones that resolve
//                 to null. Each line is a value a seller will lose today.
//
// READ-ONLY. It selects from one cache table and writes nothing.
//
//   deno run --allow-net --allow-env scripts/aspect-value-coverage.ts
//   deno run --allow-net --allow-env scripts/aspect-value-coverage.ts --reference
//   deno run --allow-net --allow-env scripts/aspect-value-coverage.ts --aspect Color

import { createClient } from "@supabase/supabase-js";
import { normalizeAspectValue } from "../src/lib/aspect-normalize.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  Deno.exit(1);
}

const args = Deno.args;
const wantReference = args.includes("--reference");
const aspectFilterIdx = args.indexOf("--aspect");
const aspectFilter = aspectFilterIdx >= 0 ? args[aspectFilterIdx + 1] ?? null : null;

// The vocabulary we are checking coverage FOR: every descriptive value that can
// reach normalizeAspectValue from our own code. Two sources, both in-repo:
//   1. the `e.g.` words in CANONICAL_ATTRIBUTES (lib/ai-extract.ts) — what the
//      capture prompt tells the model to produce;
//   2. the family-table keys in lib/aspect-normalize.ts — what we claim to map.
// (2) is read by re-running each key through the normalizer below. (1) is
// listed here because the prompt strings are prose, not data, and parsing them
// would break the moment someone rewords a description.
const PROMPT_VOCABULARY: Record<string, string[]> = {
  Color: [
    "Taupe", "Sage Green", "Burgundy", "Charcoal", "Cream", "Navy", "Olive",
    "Teal", "Mustard", "Blush", "Coral", "Lavender", "Rust", "Camel", "Khaki",
    "Heather Gray", "Off-White", "Light Blue", "Dark Green", "Rose Gold",
  ],
  "Sleeve Length": [
    "Short Sleeve", "Long Sleeve", "3/4 Sleeve", "Sleeveless", "Cap Sleeve",
  ],
  Neckline: [
    "Crew Neck", "V-Neck", "Collared", "Hooded", "Turtleneck", "Scoop Neck",
    "Mock Neck", "Boat Neck", "Henley",
  ],
  Pattern: [
    "Solid", "Striped", "Plaid", "Floral", "Graphic", "Camouflage", "Polka Dot",
    "Tie-Dye", "Houndstooth", "Leopard",
  ],
  "Dress Length": [
    "Mini", "Above Knee", "Knee-Length", "Midi", "Maxi", "Tea Length",
    "Floor Length", "High-Low",
  ],
  Rise: ["High Rise", "Mid Rise", "Low Rise"],
  "Boot Shaft Height": [
    "Ankle", "Mid-Calf", "Knee High", "Over the Knee",
  ],
  "Strap Type": [
    "Shoulder Strap", "Crossbody", "Top Handle", "Adjustable", "Detachable",
    "Chain", "Ankle Strap",
  ],
  "Hardware Color": [
    "Gold-Tone", "Silver-Tone", "Gunmetal", "Rose Gold", "Brass",
  ],
};

interface EbayAspectValue {
  localizedValue?: string;
}
interface EbayAspectConstraint {
  aspectMode?: string;
  itemToAspectCardinality?: string;
}
interface EbayAspect {
  localizedAspectName?: string;
  aspectConstraint?: EbayAspectConstraint;
  aspectValues?: EbayAspectValue[];
}
interface CacheRow {
  category_id: string;
  category_name: string | null;
  aspects: { aspects?: EbayAspect[] } | null;
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await supabase
  .from("ebay_category_aspects")
  .select("category_id, category_name, aspects");

if (error) {
  console.error("read failed:", error.message);
  Deno.exit(1);
}

const rows = (data ?? []) as CacheRow[];
if (rows.length === 0) {
  console.error(
    "The cache is empty. It fills as sellers open categories in the composer;\n" +
      "warm it by hitting GET /api/flipdesk/ebay/category/:id/aspects for the\n" +
      "categories you care about, then run this again.",
  );
  Deno.exit(1);
}

// aspect name -> allowed value -> how many categories offer it
const byAspect = new Map<string, Map<string, number>>();
// aspect name -> [{ categoryId, categoryName, allowed[] }]
const perCategory = new Map<
  string,
  Array<{ id: string; name: string; allowed: string[] }>
>();

for (const row of rows) {
  for (const a of row.aspects?.aspects ?? []) {
    const name = a.localizedAspectName?.trim();
    if (!name) continue;
    if (aspectFilter && name.toLowerCase() !== aspectFilter.toLowerCase()) continue;
    if ((a.aspectConstraint?.aspectMode ?? "") !== "SELECTION_ONLY") continue;
    const allowed = (a.aspectValues ?? [])
      .map((v) => v.localizedValue?.trim() ?? "")
      .filter((v) => v.length > 0);
    if (allowed.length === 0) continue;

    let counts = byAspect.get(name);
    if (!counts) {
      counts = new Map();
      byAspect.set(name, counts);
    }
    for (const v of allowed) counts.set(v, (counts.get(v) ?? 0) + 1);

    const list = perCategory.get(name) ?? [];
    list.push({ id: row.category_id, name: row.category_name ?? "(unnamed)", allowed });
    perCategory.set(name, list);
  }
}

const aspectNames = [...byAspect.keys()].sort((x, y) =>
  (perCategory.get(y)?.length ?? 0) - (perCategory.get(x)?.length ?? 0) ||
  x.localeCompare(y)
);

console.log(
  `# eBay allowed values, harvested from ${rows.length} cached categories\n`,
);

if (wantReference) {
  for (const name of aspectNames) {
    const counts = byAspect.get(name)!;
    const cats = perCategory.get(name)!.length;
    const values = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v]) => v);
    console.log(`## ${name}  (SELECTION_ONLY in ${cats} categories, ${values.length} distinct values)`);
    console.log(values.join(" | "));
    console.log();
  }
  Deno.exit(0);
}

// ── Coverage audit ────────────────────────────────────────────────────
// For each aspect, take every value we can produce and ask the real normalizer
// what it resolves to against each cached category's real allowed list.

let totalChecks = 0;
let totalMisses = 0;

for (const name of aspectNames) {
  const vocabulary = new Set<string>();
  // Prompt vocabulary keyed by the closest aspect-name match we have.
  for (const [key, words] of Object.entries(PROMPT_VOCABULARY)) {
    if (name.toLowerCase().includes(key.toLowerCase()) ||
        key.toLowerCase().includes(name.toLowerCase())) {
      for (const w of words) vocabulary.add(w);
    }
  }
  if (vocabulary.size === 0) continue;

  // value -> categories where it resolves to null
  const misses = new Map<string, string[]>();
  for (const cat of perCategory.get(name)!) {
    for (const value of vocabulary) {
      totalChecks++;
      const hit = normalizeAspectValue(value, {
        name,
        mode: "SELECTION_ONLY",
        allowedValues: cat.allowed,
      });
      if (hit === null) {
        totalMisses++;
        const list = misses.get(value) ?? [];
        list.push(`${cat.id} ${cat.name}`);
        misses.set(value, list);
      }
    }
  }

  if (misses.size === 0) {
    console.log(`## ${name} — every value maps in all ${perCategory.get(name)!.length} categories`);
    console.log();
    continue;
  }

  console.log(`## ${name} — ${misses.size} value(s) still dropped`);
  for (const [value, cats] of [...misses.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sample = perCategory.get(name)!.find((c) => cats[0]?.startsWith(c.id));
    console.log(
      `- "${value}" -> null in ${cats.length}/${perCategory.get(name)!.length} categories` +
        (sample ? `; e.g. ${sample.name} allows: ${sample.allowed.slice(0, 12).join(", ")}` : ""),
    );
  }
  console.log();
}

console.log(
  `${totalChecks - totalMisses}/${totalChecks} value-category pairs resolve ` +
    `(${totalMisses} dropped). Add the misses to the family tables in ` +
    `src/lib/aspect-normalize.ts — and mirror the file to the web copy.`,
);
