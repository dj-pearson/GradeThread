// US-3016: what eBay actually accepts, and what we are still dropping.
//
// WHY THIS EXISTS. The AI capture pass in lib/ai-extract.ts describes a garment
// in a seller's words ("Taupe", "Sage Green", "Mini"). eBay's aspects have their
// own coarse vocabulary. lib/aspect-normalize.ts is the bridge, and until
// US-3016 it was a handful of spelling equivalences, so most descriptive values
// either fell on the floor (SELECTION_ONLY) or shipped verbatim and dropped out
// of eBay's buyer filters (SUGGESTED).
//
// Nobody needs to research eBay's lists by hand, because we already store them.
// Every category a seller opens in the composer leaves its verbatim
// getItemAspectsForCategory response in public.ebay_category_aspects (30-day
// TTL, shared across all users). That cache IS the reference; this reads it back.
//
// Three modes:
//   --modes       every aspect name, how many categories carry it, and which
//                 aspectMode(s) eBay gives it. Run this FIRST: whether an aspect
//                 is SELECTION_ONLY or SUGGESTED decides what "dropped" means.
//   --coverage    a different question from the rest of this script, and the one
//                 that decides whether a listing is findable: not "is the value
//                 we send usable" but "do we fill the field at all". Reports the
//                 three ways a field goes unfilled by construction — an aspect
//                 past the MAX_AI_ASPECTS cap is never shown to the model; a
//                 SELECTION_ONLY list past MAX_ALLOWED_VALUES_PER_ASPECT has
//                 values the model literally cannot pick; and a required aspect
//                 no registry entry owns depends entirely on the AI pass.
//   --reference   the union of allowed values per aspect name. The one big
//                 reference, harvested rather than researched.
//   (default)     the coverage audit — every value our prompt hints can produce,
//                 run through the real normalizer against each category's real
//                 allowed list, listing what fails to land on a listed value.
//
// READ-ONLY. It selects from one cache table and writes nothing.
//
//   deno run --allow-net --allow-env scripts/aspect-value-coverage.ts --modes
//   deno run --allow-net --allow-env scripts/aspect-value-coverage.ts
//   deno run --allow-net --allow-env scripts/aspect-value-coverage.ts --reference
//   deno run --allow-net --allow-env scripts/aspect-value-coverage.ts --aspect Color

import { createClient } from "@supabase/supabase-js";
import { normalizeAspectValue } from "../src/lib/aspect-normalize.ts";
import {
  MAX_AI_ASPECTS,
  MAX_ALLOWED_VALUES_PER_ASPECT,
} from "../src/lib/aspect-priority.ts";
import { ASPECT_REGISTRY, ownedAspectName } from "../src/lib/aspect-registry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  Deno.exit(1);
}

const args = Deno.args;
const wantReference = args.includes("--reference");
const wantModes = args.includes("--modes");
const wantCoverage = args.includes("--coverage");
const aspectFilterIdx = args.indexOf("--aspect");
const aspectFilter = aspectFilterIdx >= 0 ? args[aspectFilterIdx + 1] ?? null : null;

// The vocabulary we are checking coverage FOR: the descriptive values our own
// capture prompt tells the model to produce (the `e.g.` words in
// CANONICAL_ATTRIBUTES, lib/ai-extract.ts). Listed here rather than parsed out
// of the prompt, because those strings are prose and reword freely.
//
// ⚠ Keys are matched by EXACT aspect name, plus the aliases below. An earlier
// version matched on substring in both directions, so the aspect "Type" picked
// up the "Strap Type" vocabulary and reported a shoe category as 100% broken.
// A vocabulary aimed at the wrong aspect reads exactly like a real failure.
const PROMPT_VOCABULARY: Record<string, string[]> = {
  Color: [
    "Taupe", "Sage Green", "Burgundy", "Charcoal", "Cream", "Navy", "Olive",
    "Teal", "Mustard", "Blush", "Coral", "Lavender", "Rust", "Camel", "Khaki",
    "Heather Gray", "Off-White", "Light Blue", "Dark Green", "Rose Gold",
    "Maroon", "Mint", "Emerald", "Cobalt", "Chocolate", "Plum", "Peach",
  ],
  "Sleeve Length": [
    "Short Sleeve", "Long Sleeve", "3/4 Sleeve", "Sleeveless", "Cap Sleeve",
    "Tank", "Elbow",
  ],
  Neckline: [
    "Crew Neck", "V-Neck", "Collared", "Hooded", "Turtleneck", "Scoop Neck",
    "Mock Neck", "Boat Neck", "Henley", "Button-Down",
  ],
  Pattern: [
    "Solid", "Striped", "Plaid", "Floral", "Graphic", "Camouflage", "Polka Dot",
    "Tie-Dye", "Houndstooth", "Leopard", "Tartan", "Camo",
  ],
  "Dress Length": [
    "Mini", "Above Knee", "Knee-Length", "Midi", "Maxi", "Tea Length",
    "Floor Length", "High-Low", "Asymmetrical",
  ],
  "Skirt Length": ["Mini", "Above Knee", "Knee-Length", "Midi", "Maxi", "Floor Length"],
  Rise: ["High Rise", "Mid Rise", "Low Rise", "High-Waisted", "Regular"],
  "Boot Shaft Height": [
    "Ankle", "Mid-Calf", "Knee High", "Over the Knee", "Bootie", "Thigh High",
  ],
  "Strap Type": ["Halter", "Racerback", "Spaghetti", "Strapless", "Wide Strap"],
  "Handle Style": [
    "Shoulder Strap", "Crossbody", "Top Handle", "Adjustable", "Detachable",
    "Chain", "Wristlet",
  ],
  "Leg Style": [
    "Skinny", "Straight", "Bootcut", "Flare", "Wide Leg", "Tapered", "Cargo",
    "Cropped", "Jogger",
  ],
  "Heel Style": ["Stiletto", "Block", "Wedge", "Kitten", "Platform", "Cone", "Flat", "Chunky"],
  "Hardware Color": ["Gold-Tone", "Silver-Tone", "Gunmetal", "Rose Gold", "Brass"],
  Fit: [
    "Slim", "Skinny", "Regular", "Relaxed", "Loose", "Oversized", "Bootcut",
    "Wide Leg", "Tapered",
  ],
  Closure: [
    "Zip", "Button", "Snap", "Drawstring", "Elastic", "Pullover", "Lace Up",
    "Hook & Eye", "Buckle",
  ],
  Occasion: ["Casual", "Work", "Formal", "Cocktail", "Wedding", "Athletic", "Beach", "Travel"],
  Season: ["Spring", "Summer", "Fall", "Winter", "All Seasons"],
  "Heel Height": ["Flat", "Low", "Mid", "High", "Very High", "Stiletto"],
  "Toe Shape": ["Round", "Pointed", "Square", "Open", "Peep", "Almond", "Closed"],
};

// eBay names the same field differently per category. An alias points a real
// aspect name at the vocabulary key it should be checked against.
const ALIASES: Record<string, string> = {
  "shoe shaft height": "Boot Shaft Height",
  "boot height": "Boot Shaft Height",
  "shaft height": "Boot Shaft Height",
  "sleeve style": "Sleeve Length",
  "neck line": "Neckline",
  "pattern/design": "Pattern",
  "hem length": "Dress Length",
  "coat length": "Dress Length",
  "garment length": "Dress Length",
  "length": "Dress Length",
  "rise style": "Rise",
  "waist rise": "Rise",
  "fit type": "Fit",
  "style fit": "Fit",
  "closure type": "Closure",
  "fastening": "Closure",
  "occasion type": "Occasion",

  "toe type": "Toe Shape",
  "handle/strap type": "Handle Style",
  "handle type": "Handle Style",
  "leg cut": "Leg Style",
  "heel type": "Heel Style",
  "exterior color": "Color",
  "primary color": "Color",
  "main color": "Color",
  "colour": "Color",
  "hardware colour": "Hardware Color",
  "metal tone": "Hardware Color",
};

function vocabularyFor(aspectName: string): string[] | null {
  const n = aspectName.toLowerCase().trim();
  for (const key of Object.keys(PROMPT_VOCABULARY)) {
    if (key.toLowerCase() === n) return PROMPT_VOCABULARY[key]!;
  }
  const alias = ALIASES[n];
  if (alias) return PROMPT_VOCABULARY[alias] ?? null;
  return null;
}

interface EbayAspectValue {
  localizedValue?: string;
}
interface EbayAspectConstraint {
  aspectMode?: string;
  itemToAspectCardinality?: string;
  aspectRequired?: boolean;
  aspectUsage?: string;
}
interface EbayAspect {
  localizedAspectName?: string;
  aspectConstraint?: EbayAspectConstraint;
  aspectValues?: EbayAspectValue[];
  relevanceIndicator?: { searchCount?: number };
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

interface CatEntry {
  id: string;
  name: string;
  mode: string;
  allowed: string[];
}

// aspect name -> one entry per category that carries it
const perAspect = new Map<string, CatEntry[]>();
// aspect name -> allowed value -> how many categories offer it
const valueCounts = new Map<string, Map<string, number>>();

for (const row of rows) {
  for (const a of row.aspects?.aspects ?? []) {
    const name = a.localizedAspectName?.trim();
    if (!name) continue;
    if (aspectFilter && name.toLowerCase() !== aspectFilter.toLowerCase()) continue;
    const mode = a.aspectConstraint?.aspectMode ?? "UNSPECIFIED";
    const allowed = (a.aspectValues ?? [])
      .map((v) => v.localizedValue?.trim() ?? "")
      .filter((v) => v.length > 0);

    const list = perAspect.get(name) ?? [];
    list.push({
      id: row.category_id,
      name: row.category_name ?? "(unnamed)",
      mode,
      allowed,
    });
    perAspect.set(name, list);

    if (allowed.length > 0) {
      let counts = valueCounts.get(name);
      if (!counts) {
        counts = new Map();
        valueCounts.set(name, counts);
      }
      for (const v of allowed) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
}

const aspectNames = [...perAspect.keys()].sort(
  (x, y) =>
    (perAspect.get(y)?.length ?? 0) - (perAspect.get(x)?.length ?? 0) ||
    x.localeCompare(y),
);

console.log(`# ebay_category_aspects: ${rows.length} cached categories\n`);

// ── --coverage ────────────────────────────────────────────────────────
//
// The rest of this script asks whether the value we send is one eBay lists.
// This asks the prior question: does the field get filled at all? A blank
// specific costs a buyer filter just as completely as a wrong one, and there
// are exactly three ways one goes blank BY CONSTRUCTION rather than because
// the garment did not answer it.
if (wantCoverage) {
  // Which item_category the registry is evaluated for. byCategory candidates
  // extend the defaults per vertical, so shoes reach "US Shoe Size" and
  // clothing does not.
  const VERTICALS = ["clothing", "shoes", "bags", "accessories"];

  let overCap = 0;
  let totalAspects = 0;
  let totalRequired = 0;
  const truncated = new Map<string, { cats: number; worst: number }>();
  const droppedTail = new Map<string, number>();
  const requiredUnowned = new Map<string, number>();
  const requiredSeen = new Map<string, number>();

  for (const row of rows) {
    const list = row.aspects?.aspects ?? [];
    if (list.length === 0) continue;
    totalAspects += list.length;

    const specs = list.map((a) => ({
      name: (a.localizedAspectName ?? "").trim(),
      required: a.aspectConstraint?.aspectRequired === true,
      searchCount: a.relevanceIndicator?.searchCount ?? 0,
      usage: a.aspectConstraint?.aspectUsage ?? "OPTIONAL",
      mode: a.aspectConstraint?.aspectMode ?? "",
      values: (a.aspectValues ?? []).length,
    })).filter((x) => x.name.length > 0);

    const req = specs.filter((x) => x.required);
    totalRequired += req.length;
    for (const r of req) requiredSeen.set(r.name, (requiredSeen.get(r.name) ?? 0) + 1);

    // 1. Past the cap — never shown to the model. Mirror prioritizeByDemand:
    //    required first in eBay's order, then searchCount desc, then
    //    RECOMMENDED before OPTIONAL, then name.
    if (specs.length > MAX_AI_ASPECTS) {
      overCap++;
      const rest = specs.filter((x) => !x.required).sort((a, b) =>
        b.searchCount - a.searchCount ||
        (a.usage === b.usage ? 0 : a.usage === "RECOMMENDED" ? -1 : 1) ||
        a.name.localeCompare(b.name)
      );
      const room = Math.max(0, MAX_AI_ASPECTS - req.length);
      for (const cut of rest.slice(room)) {
        droppedTail.set(cut.name, (droppedTail.get(cut.name) ?? 0) + 1);
      }
    }

    // 2. A SELECTION_ONLY list longer than the enum cap has values the model
    //    cannot choose, because they are not in the schema it is given.
    for (const x of specs) {
      if (x.mode !== "SELECTION_ONLY") continue;
      if (x.values <= MAX_ALLOWED_VALUES_PER_ASPECT) continue;
      const prev = truncated.get(x.name) ?? { cats: 0, worst: 0 };
      truncated.set(x.name, {
        cats: prev.cats + 1,
        worst: Math.max(prev.worst, x.values),
      });
    }

    // 3. A required aspect no registry entry owns is filled only if the AI
    //    refine pass answers it. Deterministic coverage is the safer half.
    const registryAspects = specs.map((x) => ({
      name: x.name,
      mode: x.mode,
      multi: false,
      allowedValues: [],
    }));
    const owned = new Set<string>();
    for (const vertical of VERTICALS) {
      for (const entry of ASPECT_REGISTRY.entries) {
        const n = ownedAspectName(entry, vertical, registryAspects);
        if (n) owned.add(n);
      }
    }
    for (const r of req) {
      if (!owned.has(r.name)) {
        requiredUnowned.set(r.name, (requiredUnowned.get(r.name) ?? 0) + 1);
      }
    }
  }

  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

  console.log(
    `${totalAspects} aspects across ${rows.length} categories ` +
      `(${(totalAspects / rows.length).toFixed(1)} each), ` +
      `${totalRequired} required (${(totalRequired / rows.length).toFixed(1)} each).\n`,
  );

  console.log(`## 1. Past the MAX_AI_ASPECTS cap of ${MAX_AI_ASPECTS}`);
  console.log(
    `${overCap}/${rows.length} categories have more aspects than the cap, so their`,
  );
  console.log("tail is never shown to the model. Most often dropped:");
  if (droppedTail.size === 0) console.log("   (none)");
  for (const [name, n] of top(droppedTail, 20)) {
    console.log(`   - ${name} — cut in ${n} categories`);
  }
  console.log();

  console.log(
    `## 2. SELECTION_ONLY lists past the ${MAX_ALLOWED_VALUES_PER_ASPECT}-value enum cap`,
  );
  console.log("The model is handed an enum, so a value past the cut CANNOT be chosen.");
  if (truncated.size === 0) console.log("   (none)");
  for (const [name, v] of [...truncated.entries()].sort((a, b) => b[1].cats - a[1].cats)) {
    console.log(
      `   - ${name} — ${v.cats} categories, worst list ${v.worst} values ` +
        `(${v.worst - MAX_ALLOWED_VALUES_PER_ASPECT} unpickable)`,
    );
  }
  console.log();

  console.log("## 3. Required aspects no registry entry owns");
  console.log("These are filled only if the AI refine pass answers them.");
  if (requiredUnowned.size === 0) console.log("   (none)");
  for (const [name, n] of top(requiredUnowned, 25)) {
    console.log(`   - ${name} — required in ${n} categories`);
  }
  console.log();

  console.log("## Required aspects overall, by how many categories demand them");
  for (const [name, n] of top(requiredSeen, 25)) {
    const owned = requiredUnowned.has(name) ? "AI only" : "registry";
    console.log(`   - ${name.padEnd(32)} ${String(n).padStart(4)}  ${owned}`);
  }
  Deno.exit(0);
}

// ── --modes ───────────────────────────────────────────────────────────
if (wantModes) {
  console.log(
    "aspect".padEnd(34) + "cats".padStart(5) + "  modes (categories)".padEnd(40) +
      "  values",
  );
  for (const name of aspectNames) {
    const entries = perAspect.get(name)!;
    const modes = new Map<string, number>();
    for (const e of entries) modes.set(e.mode, (modes.get(e.mode) ?? 0) + 1);
    const modeStr = [...modes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${m}:${c}`)
      .join(" ");
    const distinct = valueCounts.get(name)?.size ?? 0;
    const known = vocabularyFor(name) ? " *" : "";
    console.log(
      name.slice(0, 33).padEnd(34) +
        String(entries.length).padStart(5) +
        "  " + modeStr.padEnd(38) +
        "  " + String(distinct) + known,
    );
  }
  console.log("\n* = this script has a prompt vocabulary aimed at that aspect.");
  Deno.exit(0);
}

// ── --reference ───────────────────────────────────────────────────────
if (wantReference) {
  for (const name of aspectNames) {
    const counts = valueCounts.get(name);
    if (!counts || counts.size === 0) continue;
    const entries = perAspect.get(name)!;
    const values = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v]) => v);
    console.log(`## ${name}  (${entries.length} categories, ${values.length} distinct values)`);
    console.log(values.join(" | "));
    console.log();
  }
  Deno.exit(0);
}

// ── Coverage audit ────────────────────────────────────────────────────
//
// "Dropped" means two different things and the report keeps them apart:
//   SELECTION_ONLY — the normalizer returned null, so the aspect ships EMPTY.
//   SUGGESTED      — the value ships verbatim, which eBay accepts but which
//                    falls outside its buyer filters. Still a loss, softer.

let selChecks = 0, selMisses = 0;
let sugChecks = 0, sugUnlisted = 0;
let audited = 0;

for (const name of aspectNames) {
  const vocabulary = vocabularyFor(name);
  if (!vocabulary) continue;
  const entries = perAspect.get(name)!.filter((e) => e.allowed.length > 0);
  if (entries.length === 0) continue;
  audited++;

  const empties = new Map<string, number>();   // SELECTION_ONLY -> null
  const unlisted = new Map<string, number>();  // SUGGESTED -> not on the list

  for (const cat of entries) {
    const selection = cat.mode === "SELECTION_ONLY";
    for (const value of vocabulary) {
      const hit = normalizeAspectValue(value, {
        name,
        mode: cat.mode,
        allowedValues: cat.allowed,
      });
      if (selection) {
        selChecks++;
        if (hit === null) {
          selMisses++;
          empties.set(value, (empties.get(value) ?? 0) + 1);
        }
      } else {
        sugChecks++;
        // Non-SELECTION_ONLY passes through unchanged; ask whether the value it
        // ships is one eBay's own filters recognize.
        const onList = cat.allowed.some(
          (a) => a.toLowerCase().trim() === (hit ?? value).toLowerCase().trim(),
        );
        if (!onList) {
          sugUnlisted++;
          unlisted.set(value, (unlisted.get(value) ?? 0) + 1);
        }
      }
    }
  }

  const selCats = entries.filter((e) => e.mode === "SELECTION_ONLY").length;
  const sugCats = entries.length - selCats;
  console.log(
    `## ${name} — ${entries.length} categories ` +
      `(${selCats} SELECTION_ONLY, ${sugCats} other), ${vocabulary.length} values checked`,
  );
  const sample = entries[0]!;
  console.log(`   e.g. ${sample.name} [${sample.mode}] allows: ${sample.allowed.slice(0, 14).join(", ")}`);

  if (empties.size === 0 && unlisted.size === 0) {
    console.log("   every value lands on a listed value in every category.\n");
    continue;
  }
  if (empties.size > 0) {
    console.log(`   SHIPS EMPTY (SELECTION_ONLY, normalizer returned null):`);
    for (const [v, n] of [...empties.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     - "${v}" in ${n}/${selCats}`);
    }
  }
  if (unlisted.size > 0) {
    console.log(`   SHIPS OFF-LIST (accepted by eBay, invisible to its filters):`);
    for (const [v, n] of [...unlisted.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     - "${v}" in ${n}/${sugCats}`);
    }
  }
  console.log();
}

if (audited === 0) {
  console.log(
    "No cached aspect name matched a prompt vocabulary key. Run --modes to see\n" +
      "the real aspect names and add the ones that matter to PROMPT_VOCABULARY\n" +
      "or ALIASES at the top of this file.",
  );
  Deno.exit(0);
}

console.log(
  `SELECTION_ONLY: ${selChecks - selMisses}/${selChecks} land on a listed value ` +
    `(${selMisses} ship empty).\n` +
    `Other modes:    ${sugChecks - sugUnlisted}/${sugChecks} land on a listed value ` +
    `(${sugUnlisted} ship off-list).\n` +
    `Fix both by adding buckets to the family tables in ` +
    `services/edge-functions/src/lib/aspect-normalize.ts, then copy the file ` +
    `verbatim to src/lib/aspect-normalize.ts.`,
);
