// Backfill Brand / Size / Color / Material on inventory_items by parsing the
// item Title. Most GradeThread items store their detail inside the title
// ("Burberry's Womens Size 6 Wool Blue Blazer") with the structured columns
// empty; this extracts those attributes so exports/filters work.
//
// Usage:
//   node scripts/backfill-attributes-from-title.mjs <inventory_items_rows.csv> [userId]
//
// The userId is OPTIONAL only when the CSV holds exactly one. A file with two
// sellers in it is refused rather than scoped to whichever one happened to be
// on row 1 (US-3396). Exit 1 also covers "nothing parsed", because the SQL that
// case used to write does not parse.
//
// Emits next to the input:
//   backfill-attributes-review.csv  — every item + what was parsed (eyeball it)
//   backfill-attributes.sql         — one UPDATE … FROM (VALUES …) that fills
//                                     ONLY empty columns (COALESCE), scoped to
//                                     the user. Review, then run in Supabase SQL.
//
// Rule-based + conservative: a field is left blank when not confidently found,
// and the SQL never overwrites a column that already has a value.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ── tiny CSV parser (quotes, embedded newlines) ────────────────────────────
function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], q = false;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;

// ── vocabularies ───────────────────────────────────────────────────────────
// Multi-word brands MUST precede their single-word prefixes; matching prefers a
// start-of-title hit and the longest phrase.
const BRANDS = [
  "Polo Ralph Lauren", "Ralph Lauren", "Lauren Ralph Lauren", "Free People", "Free-est",
  "Peter Millar", "Vineyard Vines", "Eileen Fisher", "Banana Republic", "Rag & Bone",
  "Toad & Co", "Toad&Co", "Beyond Yoga", "Ulla Johnson", "Travis Mathew", "Ermenegildo Zegna",
  "Nic + Zoe", "Nic+Zoe", "American Eagle", "Brooks Brothers", "Tommy Bahama", "Tommy Hilfiger",
  "Calvin Klein", "Saks Fifth Avenue", "James Perse", "Theory", "Vince", "Vuori", "Alo Yoga",
  "Alo", "Athleta", "Lululemon", "Carhartt", "Quince", "Prana", "Patagonia", "Gant",
  "Anthropologie", "Bonobos", "Greyson", "Burberry's", "Burberry", "BYLT", "Nike", "Zara",
  "Escada", "Desigual", "Xirena", "AKRIS", "UNRL", "Josef Seibel", "Sundance", "Adidas",
  "Wilfred", "Mother", "Spanx", "Madewell", "J.Crew", "J. Crew", "Jcrew", "Lacoste",
  "Faherty", "Johnny Was", "Sezane", "Reformation", "Aritzia", "Veronica Beard", "Cuts",
  "Rhone", "Outdoor Voices", "Sweaty Betty", "Marine Layer", "Buck Mason", "Untuckit",
  "Levi's", "Levi", "Wrangler", "Columbia", "North Face", "The North Face", "Arc'teryx",
  "Gap", "Old Navy", "Express", "Loft", "Ann Taylor", "Talbots", "Chico's", "Coldwater Creek",
  "St. John", "St John", "Christian Dior", "Dior", "Gucci", "Prada", "Versace", "Coach",
  "Michael Kors", "Kate Spade", "Tory Burch", "Cole Haan", "Cos", "Everlane", "Uniqlo",
  "Pendleton", "Filson", "Orvis", "L.L. Bean", "LL Bean", "Eddie Bauer", "Duluth Trading",
  // expansion from observed misses + common resale brands
  "Travis Matthew", "Woolrich", "Givenchy", "Max Mara", "Robert Graham", "Chanel",
  "L'Agence", "L' Agence", "Flag & Anthem", "Izod", "Pact", "Lucky Brand", "Lucky",
  "Agolde", "Tuckernuck", "Birddogs", "Lands' End", "Lands End", "Puma", "Timberland",
  "Paka", "David Donahue", "Margaret Godfrey", "Anrabess", "Blue Willi's", "Yogalicious",
  "Amanda Uprichard", "Chicsoul", "Mizzen + Main", "Mizzen+Main", "Johnnie-O", "Southern Tide",
  "Psycho Bunny", "Robert Barakett", "Public Rec", "Fair Harbor", "Chubbies", "State and Liberty",
  "Citizens of Humanity", "Paige", "Joe's Jeans", "Frame", "Sandro", "Maje", "Ba&sh",
  "Hill House", "Veronica Beard", "Cabi", "Boden", "J.Jill", "J. Jill", "Aerie", "Abercrombie",
  "Hollister", "Under Armour", "New Balance", "Hoka", "On Running", "Champion", "Fila",
  "Reebok", "Gymshark", "Smartwool", "Icebreaker", "Cotopaxi", "Kuhl", "Marmot", "Fjallraven",
  "Helly Hansen", "Salomon", "Arcteryx", "Cole Haan", "Vince Camuto", "Tory Burch", "AllSaints",
  "Ted Baker", "Hugo Boss", "Boss", "Lacoste", "Fred Perry", "Patagonia", "Carhartt WIP",
];

// Descriptors that often precede the real brand ("Vintage Woolrich", "VTG 80s …").
const PREFIX_RE = /^(?:vintage|vtg|vntg|nwt|nwot|euc|rare)\s+(?:\d{2}s\s+)?/i;

// Brands that are also ordinary words — only trust them at the START of a title
// (never a mid-string match) to avoid false positives like "picture frame".
const COMMON_WORD_BRANDS = new Set(
  ["gap", "express", "theory", "boss", "frame", "cuts", "cos", "mother", "lucky",
   "pact", "champion", "vince", "loft", "boden", "paige", "perch", "legend", "on running"],
);
const COLORS = [
  "heather grey", "heather gray", "black", "white", "ivory", "cream", "grey", "gray",
  "charcoal", "navy", "blue", "teal", "turquoise", "green", "olive", "sage", "mint",
  "red", "burgundy", "maroon", "wine", "pink", "fuchsia", "magenta", "purple", "plum",
  "lavender", "mauve", "brown", "tan", "beige", "khaki", "camel", "taupe", "rust",
  "orange", "coral", "peach", "yellow", "mustard", "gold", "silver", "sandstone",
  "chambray", "denim", "stone",
];
const MATERIALS = [
  "cashmere", "merino wool", "lambswool", "wool", "silk", "linen", "cotton", "tencel",
  "modal", "rayon", "viscose", "polyester", "nylon", "spandex", "elastane", "leather",
  "suede", "shearling", "denim", "velvet", "corduroy", "flannel", "fleece", "tweed",
  "satin", "chiffon", "lace", "mohair", "alpaca", "bamboo", "gauze", "cashmere feel",
];

function wordRegex(term) {
  // word-ish boundaries that tolerate &, +, ', . inside brand names
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i");
}

function findBrand(title) {
  // Try a start-of-title match on the raw title AND on a version with a leading
  // "Vintage/Vtg/NWT…" descriptor stripped, so "Vintage Woolrich …" → Woolrich.
  const starts = [title.toLowerCase(), title.replace(PREFIX_RE, "").toLowerCase()];
  let best = null;
  for (const b of BRANDS) {
    const bl = b.toLowerCase();
    for (const s of starts) {
      if (s.startsWith(bl) && (s[bl.length] === undefined || /[^a-z0-9]/.test(s[bl.length]))) {
        return b; // start match wins
      }
    }
    if (
      !COMMON_WORD_BRANDS.has(b.toLowerCase()) &&
      wordRegex(b).test(title) &&
      (!best || b.length > best.length)
    ) {
      best = b;
    }
  }
  return best;
}
function findFirstVocab(title, vocab) {
  let bestIdx = Infinity, bestTerm = null;
  for (const term of vocab) {
    const m = wordRegex(term).exec(title);
    if (m) {
      const idx = m.index + m[1].length;
      // earliest mention wins; ties → longer term
      if (idx < bestIdx || (idx === bestIdx && (!bestTerm || term.length > bestTerm.length))) {
        bestIdx = idx; bestTerm = term;
      }
    }
  }
  return bestTerm;
}
function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
function findSize(title) {
  // 1) explicit "Size X" / "Sz X"
  let m = title.match(/\b(?:size|sz)\s*[:#]?\s*(xxs|xs|xl|xxl|xxxl|x-?small|x-?large|small|medium|large|petite|\d{1,2}(?:\.5)?)\b/i);
  // 2) standalone unambiguous letter/word sizes (avoid bare S/M/L false positives)
  if (!m) m = title.match(/\b(xxs|xs|xxl|xxxl|xl|x-?small|x-?large|xsmall|xlarge|small|medium|large)\b/i);
  if (!m) return "";
  let s = m[1].toLowerCase().replace(/[-\s]/g, "");
  const map = { xsmall: "XS", xlarge: "XL", small: "S", medium: "M", large: "L", petite: "Petite" };
  if (map[s]) return map[s];
  return s.toUpperCase().match(/^X+[SL]$|^XS$|^XL$|^XXL$|^XXXL$|^XXS$/) ? s.toUpperCase() : m[1];
}

// ── run ─────────────────────────────────────────────────────────────────────
function die(msg) {
  console.error(`[backfill-attributes] ${msg}`);
  process.exit(1);
}

const inPath = process.argv[2] || "inventory_items_rows.csv";
const text = readFileSync(inPath, "utf8");
const rows = parseCSV(text);
const header = rows[0];
if (!header || header.length === 0) die(`${inPath} has no header row.`);
const ix = Object.fromEntries(header.map((h, i) => [h, i]));
const allRows = rows.slice(1).filter((r) => r.length > 1);

// US-3396: THE SCOPING USER ID USED TO BE GUESSED FROM CSV ROW 1.
//
// The generated SQL ends `AND i.user_id = '<that guess>'`, so a CSV holding two
// sellers' items produced one UPDATE that silently matched only the first
// seller's rows and dropped the rest - with a success line, a review CSV
// listing every item, and nothing anywhere saying which half was written. A
// guess that is right most of the time is the worst kind.
//
// So: the id is either passed explicitly, or the CSV holds exactly one and it
// is read rather than guessed. A mixed file is a refusal, and the rows are
// filtered to the chosen id so the review CSV and the SQL describe the same set.
const explicitUserId = (process.argv[3] || "").trim();
const hasUserCol = ix.user_id !== undefined;
const csvUserIds = hasUserCol
  ? [...new Set(allRows.map((r) => (r[ix.user_id] || "").trim()).filter(Boolean))]
  : [];

let userId = explicitUserId;
if (!userId) {
  if (!hasUserCol) {
    die(
      `${inPath} has no user_id column, so the UPDATE cannot be scoped. Pass the ` +
        `id: node scripts/backfill-attributes-from-title.mjs ${inPath} <userId>`,
    );
  }
  if (csvUserIds.length === 0) {
    die(`${inPath} has a user_id column but every value is blank. Pass the id explicitly.`);
  }
  if (csvUserIds.length > 1) {
    die(
      `${inPath} holds ${csvUserIds.length} different user_id values ` +
        `(${csvUserIds.slice(0, 4).join(", ")}${csvUserIds.length > 4 ? ", ..." : ""}). ` +
        `One UPDATE can only be scoped to one of them, and the others would be ` +
        `dropped without a word. Re-run once per user, passing the id as the ` +
        `second argument.`,
    );
  }
  userId = csvUserIds[0];
}

const data = hasUserCol
  ? allRows.filter((r) => (r[ix.user_id] || "").trim() === userId)
  : allRows;
const droppedForOtherUsers = allRows.length - data.length;
if (data.length === 0) {
  die(
    `${allRows.length} row(s) in ${inPath}, none of them belonging to ${userId}. ` +
      `Nothing to do; no files written.`,
  );
}
if (droppedForOtherUsers > 0) {
  console.log(
    `[backfill-attributes] ${droppedForOtherUsers} of ${allRows.length} row(s) ` +
      `belong to another user and are EXCLUDED from both output files.`,
  );
}

const reviewRows = [["id", "sku", "title", "brand", "size", "color", "material"]];
const updates = [];
const cov = { brand: 0, size: 0, color: 0, material: 0, any: 0 };

for (const r of data) {
  const title = (r[ix.title] || "").trim();
  if (!title) continue;
  const brand = findBrand(title) || "";
  const size = findSize(title) || "";
  const colorRaw = findFirstVocab(title, COLORS) || "";
  const material = findFirstVocab(title, MATERIALS) || "";
  const color = colorRaw ? titleCase(colorRaw) : "";
  const mat = material ? titleCase(material) : "";

  if (brand) cov.brand++;
  if (size) cov.size++;
  if (color) cov.color++;
  if (mat) cov.material++;

  reviewRows.push([r[ix.id], r[ix.sku] || "", title, brand, size, color, mat]);
  if (brand || size || color || mat) {
    cov.any++;
    updates.push(
      `  (${sqlStr(r[ix.id])}, ${sqlStr(brand)}, ${sqlStr(size)}, ${sqlStr(color)}, ${sqlStr(mat)})`,
    );
  }
}

const outDir = dirname(inPath);
writeFileSync(join(outDir, "backfill-attributes-review.csv"), reviewRows.map((r) => r.map(csvCell).join(",")).join("\n"));

// US-3396: zero parsed attributes used to emit `FROM (VALUES\n) AS v(...)`,
// which is a syntax error, alongside "Wrote ... backfill-attributes.sql (0 update
// rows)" and exit 0. Nothing is written now, and the run fails, because a file
// that cannot be executed is not an output.
if (updates.length === 0) {
  console.error(
    `[backfill-attributes] Parsed ${data.length} item(s) and matched NO brand, ` +
      `size, color or material in any title. No SQL was written - an empty ` +
      `VALUES list does not parse. backfill-attributes-review.csv is still ` +
      `there; check the title format and the vocab lists in this script.`,
  );
  process.exit(1);
}

const sql = `-- Backfill Brand/Size/Color/Material from item titles (generated).
-- Fills ONLY empty columns via COALESCE — never overwrites your existing data.
-- Scoped to user ${userId}. Review backfill-attributes-review.csv first.
UPDATE public.inventory_items AS i SET
  brand    = COALESCE(i.brand,    NULLIF(v.brand, '')),
  size     = COALESCE(i.size,     NULLIF(v.size, '')),
  color    = COALESCE(i.color,    NULLIF(v.color, '')),
  material = COALESCE(i.material,  NULLIF(v.material, ''))
FROM (VALUES
${updates.join(",\n")}
) AS v(id, brand, size, color, material)
WHERE i.id = v.id::uuid
  AND i.user_id = ${sqlStr(userId)};
`;
writeFileSync(join(outDir, "backfill-attributes.sql"), sql);

const n = data.length;
console.log(`Parsed ${n} items for user ${userId}. Coverage:`);
for (const k of ["brand", "size", "color", "material", "any"]) {
  console.log(`  ${k.padEnd(9)} ${cov[k]}/${n}  (${Math.round((cov[k] / n) * 100)}%)`);
}
console.log(`\nWrote backfill-attributes-review.csv and backfill-attributes.sql (${updates.length} update rows).`);
console.log(`The UPDATE is scoped to user_id = ${userId}. Nothing else is touched.`);
