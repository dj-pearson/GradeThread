// US-823: aspect VALUE normalization — exact/plural/synonym/token matching of a
// canonical stored value against an aspect's SELECTION_ONLY allowedValues, with
// a hard "no confident match → null" rule and FREE_TEXT pass-through.
// Pure functions — no env. Fixtures mirror realistic eBay clothing aspects.
//   deno test src/tests/aspect-normalize_test.ts
import { assertEquals } from "@std/assert";
import {
  type AspectValueSpec,
  normalizeAspectValue,
} from "../lib/aspect-normalize.ts";

const sel = (name: string, allowedValues: string[]): AspectValueSpec => ({
  name,
  mode: "SELECTION_ONLY",
  allowedValues,
});

// Realistic eBay clothing allowedValues fixtures.
const SIZE = ["XS", "S", "M", "L", "XL", "XXL"];
const SIZE_PAREN = ["S (Small)", "M (Medium)", "L (Large)"];
const DEPARTMENT = ["Men", "Women", "Unisex Adult", "Boys", "Girls"];
const MATERIAL = ["Cotton", "Polyester", "Wool", "Spandex", "Leather"];
const SIZE_TYPE = ["Regular", "Plus", "Petite", "Big & Tall"];

// ── FREE_TEXT pass-through (AC5) ────────────────────────────────────────────

Deno.test("FREE_TEXT: original value passes through untouched, never normalized", () => {
  assertEquals(
    normalizeAspectValue("M", { name: "Size", mode: "FREE_TEXT", allowedValues: [] }),
    "M",
  );
  // No mode (defaults to free) also passes through.
  assertEquals(normalizeAspectValue("Poly", { name: "Material" }), "Poly");
});

// ── Exact / plural match (legacy regression) ────────────────────────────────

Deno.test("exact match returns the allowed value with eBay's casing", () => {
  assertEquals(normalizeAspectValue("m", sel("Size", SIZE)), "M");
  assertEquals(normalizeAspectValue("WOMEN", sel("Department", DEPARTMENT)), "Women");
});

Deno.test("plural tolerance (Unisex Adult ↔ Unisex Adults)", () => {
  assertEquals(
    normalizeAspectValue("Unisex Adult", sel("Department", ["Unisex Adults"])),
    "Unisex Adults",
  );
});

// ── Synonym rewrites (AC1) ──────────────────────────────────────────────────

Deno.test("size synonyms: M → Medium, S → Small, XL → X-Large", () => {
  const SPELLED = ["Small", "Medium", "Large", "X-Large"];
  assertEquals(normalizeAspectValue("M", sel("Size", SPELLED)), "Medium");
  assertEquals(normalizeAspectValue("S", sel("Size", SPELLED)), "Small");
  assertEquals(normalizeAspectValue("XL", sel("Size", SPELLED)), "X-Large");
  // …and the reverse direction (spelled stored, abbreviated allowed).
  assertEquals(normalizeAspectValue("Medium", sel("Size", SIZE)), "M");
});

Deno.test("material synonyms: Poly → Polyester, Lycra → Spandex", () => {
  assertEquals(normalizeAspectValue("Poly", sel("Material", MATERIAL)), "Polyester");
  assertEquals(normalizeAspectValue("Lycra", sel("Material", MATERIAL)), "Spandex");
  assertEquals(
    normalizeAspectValue("Rayon", sel("Fabric Type", ["Viscose", "Cotton"])),
    "Viscose",
  );
});

Deno.test("department synonyms: Men's / Mens → Men", () => {
  assertEquals(normalizeAspectValue("Men's", sel("Department", DEPARTMENT)), "Men");
  assertEquals(normalizeAspectValue("Mens", sel("Department", DEPARTMENT)), "Men");
  assertEquals(normalizeAspectValue("Ladies", sel("Department", DEPARTMENT)), "Women");
});

Deno.test("size type synonyms: Big and Tall → Big & Tall, Standard → Regular", () => {
  assertEquals(
    normalizeAspectValue("Big and Tall", sel("Size Type", SIZE_TYPE)),
    "Big & Tall",
  );
  assertEquals(normalizeAspectValue("Standard", sel("Size Type", SIZE_TYPE)), "Regular");
});

// ── Parenthetical abbreviation fallback ─────────────────────────────────────

Deno.test("parenthetical: M → 'M (Medium)', Medium → 'M (Medium)'", () => {
  assertEquals(normalizeAspectValue("M", sel("Size", SIZE_PAREN)), "M (Medium)");
  assertEquals(normalizeAspectValue("Medium", sel("Size", SIZE_PAREN)), "M (Medium)");
});

// ── Whole-word containment fallback ─────────────────────────────────────────

Deno.test("whole-word: Crew → 'Crew Neck' when unambiguous", () => {
  assertEquals(
    normalizeAspectValue("Crew", sel("Neckline", ["Crew Neck", "V-Neck", "Scoop Neck"])),
    "Crew Neck",
  );
});

// ── Ambiguity refusal & null (AC4) ──────────────────────────────────────────

Deno.test("ambiguity: refuses when more than one allowed value contains the token", () => {
  assertEquals(
    normalizeAspectValue("Long", sel("Style", ["Long Sleeve", "Long Coat"])),
    null,
  );
  // Cotton appears in two allowed values → no exact match, refuse.
  assertEquals(
    normalizeAspectValue("Cotton", sel("Material", ["100% Cotton", "Cotton Blend"])),
    null,
  );
});

Deno.test("null: no synonym, no token, no match → left for manual entry", () => {
  // US-3016 changed this deliberately: Chartreuse IS a green, and eBay's Color
  // list has no finer bucket to put it in, so narrowing beats an empty aspect.
  assertEquals(normalizeAspectValue("Chartreuse", sel("Color", ["Red", "Blue", "Green"])), "Green");
  // Still null when NO bucket in its family is offered by the category.
  assertEquals(normalizeAspectValue("Chartreuse", sel("Color", ["Red", "Blue"])), null);
  // SELECTION_ONLY with empty allowed list → null (can't validate).
  assertEquals(normalizeAspectValue("Red", sel("Color", [])), null);
  // Plus-size numeric is deliberately NOT merged with alpha sizes (conservative).
  assertEquals(normalizeAspectValue("1X", sel("Size", ["XL", "XXL"])), null);
});

Deno.test("never guesses across distinct semantic colors (Beige ≠ Tan)", () => {
  assertEquals(normalizeAspectValue("Beige", sel("Color", ["Tan", "Brown"])), null);
  // …but orthographic color variants do match (Grey → Gray).
  assertEquals(normalizeAspectValue("Grey", sel("Color", ["Gray", "Black"])), "Gray");
});

// ── US-3016: descriptive-value family narrowing ─────────────────────────────
//
// eBay's SELECTION_ONLY lists are coarse; the AI capture pass is not. These
// cover the bridge between them. Fixtures are eBay's real apparel lists.

const COLOR = [
  "Beige",
  "Black",
  "Blue",
  "Brown",
  "Gold",
  "Gray",
  "Green",
  "Ivory",
  "Multicolor",
  "Orange",
  "Pink",
  "Purple",
  "Red",
  "Silver",
  "White",
  "Yellow",
];
const DRESS_LENGTH = ["Short", "Knee Length", "Midi", "Long", "Hi-Low", "Asymmetric"];
const SKIRT_LENGTH = ["Mini", "Midi", "Maxi"];
const SLEEVE = ["Sleeveless", "Short Sleeve", "3/4 Sleeve", "Long Sleeve"];
const NECKLINE = ["Crew Neck", "V-Neck", "Scoop Neck", "Collared", "Hooded", "Turtleneck"];
const PATTERN = [
  "Solid",
  "Striped",
  "Plaid",
  "Floral",
  "Animal Print",
  "Graphic Print",
  "Camouflage",
];

Deno.test("color: a single-word descriptive color narrows to its eBay bucket", () => {
  assertEquals(normalizeAspectValue("Taupe", sel("Color", COLOR)), "Beige");
  assertEquals(normalizeAspectValue("Burgundy", sel("Color", COLOR)), "Red");
  assertEquals(normalizeAspectValue("Charcoal", sel("Color", COLOR)), "Gray");
  assertEquals(normalizeAspectValue("Teal", sel("Color", COLOR)), "Blue");
  assertEquals(normalizeAspectValue("Mustard", sel("Color", COLOR)), "Yellow");
  assertEquals(normalizeAspectValue("Cream", sel("Color", COLOR)), "Ivory");
  assertEquals(normalizeAspectValue("Lavender", sel("Color", COLOR)), "Purple");
  assertEquals(normalizeAspectValue("Coral", sel("Color", COLOR)), "Pink");
  assertEquals(normalizeAspectValue("Tie-Dye", sel("Color", COLOR)), "Multicolor");
});

Deno.test("color: a compound color reads right to left to find its base", () => {
  assertEquals(normalizeAspectValue("Sage Green", sel("Color", COLOR)), "Green");
  assertEquals(normalizeAspectValue("Light Blue", sel("Color", COLOR)), "Blue");
  assertEquals(normalizeAspectValue("Dark Olive Green", sel("Color", COLOR)), "Green");
  assertEquals(normalizeAspectValue("Heather Charcoal", sel("Color", COLOR)), "Gray");
  assertEquals(normalizeAspectValue("Rose Gold", sel("Color", COLOR)), "Gold");
});

Deno.test("color: the fallback prefers the exact bucket when the category has it", () => {
  // Navy is its own allowed value here, so step 3's equivalence group wins and
  // the family never runs.
  assertEquals(normalizeAspectValue("Navy Blue", sel("Color", ["Navy", "Blue"])), "Navy");
  // Without Navy, the family lands it on Blue rather than dropping it.
  assertEquals(normalizeAspectValue("Navy", sel("Color", COLOR)), "Blue");
});

Deno.test("length: the same value maps to whichever vocabulary the category uses", () => {
  assertEquals(normalizeAspectValue("Mini", sel("Dress Length", DRESS_LENGTH)), "Short");
  assertEquals(normalizeAspectValue("Mini", sel("Skirt Length", SKIRT_LENGTH)), "Mini");
  assertEquals(normalizeAspectValue("Maxi", sel("Dress Length", DRESS_LENGTH)), "Long");
  assertEquals(normalizeAspectValue("Maxi", sel("Skirt Length", SKIRT_LENGTH)), "Maxi");
  assertEquals(
    normalizeAspectValue("Above the Knee", sel("Dress Length", DRESS_LENGTH)),
    "Short",
  );
  assertEquals(normalizeAspectValue("Tea Length", sel("Dress Length", DRESS_LENGTH)), "Midi");
  assertEquals(normalizeAspectValue("High-Low", sel("Dress Length", DRESS_LENGTH)), "Hi-Low");
  assertEquals(
    normalizeAspectValue("Floor Length", sel("Dress Length", DRESS_LENGTH)),
    "Long",
  );
});

Deno.test("sleeve, neckline and pattern narrow the same way", () => {
  assertEquals(normalizeAspectValue("Tank", sel("Sleeve Length", SLEEVE)), "Sleeveless");
  assertEquals(normalizeAspectValue("Cap Sleeve", sel("Sleeve Length", SLEEVE)), "Short Sleeve");
  assertEquals(normalizeAspectValue("Elbow", sel("Sleeve Length", SLEEVE)), "3/4 Sleeve");
  assertEquals(normalizeAspectValue("Mock Neck", sel("Neckline", NECKLINE)), "Turtleneck");
  assertEquals(normalizeAspectValue("Button-Down", sel("Neckline", NECKLINE)), "Collared");
  assertEquals(normalizeAspectValue("Tartan", sel("Pattern", PATTERN)), "Plaid");
  assertEquals(normalizeAspectValue("Leopard", sel("Pattern", PATTERN)), "Animal Print");
  // ...and refused outright when the category offers no bucket for it.
  assertEquals(normalizeAspectValue("Leopard", sel("Pattern", ["Solid", "Striped"])), null);
  assertEquals(normalizeAspectValue("Camo", sel("Pattern", PATTERN)), "Camouflage");
});

Deno.test("family kind is picked by the most specific word in the aspect name", () => {
  // "Sleeve Length" is a sleeve, not a hem.
  assertEquals(normalizeAspectValue("Long", sel("Sleeve Length", SLEEVE)), "Long Sleeve");
  assertEquals(normalizeAspectValue("Long", sel("Dress Length", DRESS_LENGTH)), "Long");
  // "Hardware Color" is a color, not a piece of hardware.
  assertEquals(
    normalizeAspectValue("Gunmetal", sel("Hardware Color", ["Gold", "Silver", "Black"])),
    "Silver",
  );
});

Deno.test("no allowed values: an open list keeps the seller's words, a closed one refuses", () => {
  assertEquals(
    normalizeAspectValue("Sage Green", { name: "Color", mode: "FREE_TEXT", allowedValues: [] }),
    "Sage Green",
  );
  assertEquals(normalizeAspectValue("Sage Green", sel("Color", [])), null);
  // No family table for Brand, so an unknown value is still refused on a
  // closed list — and kept verbatim on an open one.
  assertEquals(normalizeAspectValue("Taupe", sel("Brand", ["Nike", "Adidas"])), null);
  assertEquals(
    normalizeAspectValue("Taupe", { name: "Brand", mode: "FREE_TEXT", allowedValues: ["Nike"] }),
    "Taupe",
  );
});

Deno.test("family narrowing runs LAST, so exact and synonym matches still win", () => {
  // Olive is offered outright — do not coarsen it to Green.
  assertEquals(normalizeAspectValue("Olive", sel("Color", ["Olive", "Green"])), "Olive");
  // Grey/Gray is an equivalence (step 3), not a family narrowing.
  assertEquals(normalizeAspectValue("Grey", sel("Color", COLOR)), "Gray");
});

// ── US-3016 second pass: eBay's OPEN lists (measured against prod) ──────────
//
// The first cut of this feature only ran on SELECTION_ONLY aspects, on the
// reasoning that an open list has nothing to match against. Reading the prod
// cache back settled it the other way: across 121 cached categories Color is
// FREE_TEXT in 107 of them and still ships 25 allowed values, Pattern is
// FREE_TEXT in 82 with 222, Neckline FREE_TEXT in 26 with 16. FREE_TEXT means
// eBay will ACCEPT an unlisted value, not that it published none — and its
// buyer filters are built from the list. So "Taupe" was never being dropped;
// it was going live and sitting outside every Beige search.
//
// Every fixture below is verbatim from that cache, mode included.

const PROD_COLOR = [
  "Beige", "Black", "Blue", "Brown", "Clear", "Gold", "Gray", "Green", "Ivory",
  "Multicolor", "Orange", "Pink", "Purple", "Red", "Silver", "Tan", "White",
  "Yellow",
];
const PROD_RISE = [
  "Ultra Low (Less than 8 in)",
  "Low (8-10 in)",
  "Mid (10-12 in)",
  "High (Greater than 12 in)",
];
const PROD_HEEL_HEIGHT = [
  "Flat (Under 1 in)",
  "Low (1-1.9 in)",
  "Mid (2-2.9 in)",
  "High (3-3.9 in)",
  "Ultra High (4 in & Higher)",
];
const PROD_HEEL_STYLE = ["Block", "Cone", "Cuban", "Flat", "Kitten", "Spool", "Stiletto", "Wedge"];
const PROD_TOE = [
  "Almond Toe", "Closed Toe", "Open Toe", "Peep Toe", "Pointed Toe",
  "Round Toe", "Square Toe",
];
const PROD_CLOSURE = [
  "Buckle", "Button", "Drawstring", "Hook & Eye", "Hook & Loop", "Lace Up",
  "Magnetic", "Pull On", "Slip On", "Snap", "Tie", "Zip",
];
const PROD_FIT = ["Athletic", "Classic", "Extra-Slim", "Regular", "Relaxed", "Slim"];
const PROD_NECKLINE = [
  "Boat Neck", "Collared", "Cowl Neck", "Crew Neck", "High Neck", "Mock Neck",
  "Round Neck", "Scoop Neck", "Square Neck", "Turtleneck", "V-Neck",
];
const PROD_SLEEVE = ["Sleeveless", "Short Sleeve", "3/4 Sleeve", "Long Sleeve"];
const PROD_DRESS_LENGTH = ["Short", "Knee Length", "Midi", "Long", "Hi-Low", "Asymmetric"];
const PROD_OCCASION = [
  "Activewear", "Business", "Casual", "Christening", "Formal",
  "Party/Cocktail", "Travel", "Wedding", "Workwear",
];
const PROD_HARDWARE_COLOR = [
  "Beige", "Black", "Blue", "Brown", "Gold", "Gray", "Gunmetal", "Multicolor",
  "Pink", "Purple", "Red", "Silver", "White", "Yellow",
];

/** A FREE_TEXT aspect that still carries an allowed list — prod's normal case. */
const open = (name: string, allowedValues: string[]): AspectValueSpec => ({
  name,
  mode: "FREE_TEXT",
  allowedValues,
});

Deno.test("open list: the reported Color bug, against prod's real Color list", () => {
  assertEquals(normalizeAspectValue("Taupe", open("Color", PROD_COLOR)), "Beige");
  assertEquals(normalizeAspectValue("Sage Green", open("Color", PROD_COLOR)), "Green");
  assertEquals(normalizeAspectValue("Burgundy", open("Color", PROD_COLOR)), "Red");
  assertEquals(normalizeAspectValue("Charcoal", open("Color", PROD_COLOR)), "Gray");
  assertEquals(normalizeAspectValue("Cream", open("Color", PROD_COLOR)), "Ivory");
  assertEquals(normalizeAspectValue("Heather Gray", open("Color", PROD_COLOR)), "Gray");
  assertEquals(normalizeAspectValue("Off-White", open("Color", PROD_COLOR)), "Ivory");
  // Tan IS on this list, so it is returned outright rather than coarsened.
  assertEquals(normalizeAspectValue("Tan", open("Color", PROD_COLOR)), "Tan");
});

Deno.test("open list: a value in no family keeps the seller's own words", () => {
  // Nothing is ever LOST on an open list — worst case it ships as written,
  // exactly as it did before US-3016.
  assertEquals(
    normalizeAspectValue("Iridescent Oil-Slick", open("Color", PROD_COLOR)),
    "Iridescent Oil-Slick",
  );
});

Deno.test("prod states Rise and Heel Height as a measured range", () => {
  assertEquals(
    normalizeAspectValue("High Rise", open("Rise", PROD_RISE)),
    "High (Greater than 12 in)",
  );
  assertEquals(normalizeAspectValue("Mid Rise", open("Rise", PROD_RISE)), "Mid (10-12 in)");
  assertEquals(normalizeAspectValue("Low Rise", open("Rise", PROD_RISE)), "Low (8-10 in)");
  assertEquals(
    normalizeAspectValue("High-Waisted", open("Rise", PROD_RISE)),
    "High (Greater than 12 in)",
  );
  assertEquals(
    normalizeAspectValue("Flat", open("Heel Height", PROD_HEEL_HEIGHT)),
    "Flat (Under 1 in)",
  );
  // "Low" must not be able to pick "Ultra Low (Less than 8 in)" by accident.
  assertEquals(normalizeAspectValue("Low", open("Rise", PROD_RISE)), "Low (8-10 in)");
});

Deno.test("Heel Height and Heel Style take different answers", () => {
  // A stiletto is reliably a high heel, so the height question can take it.
  assertEquals(
    normalizeAspectValue("Stiletto", open("Heel Height", PROD_HEEL_HEIGHT)),
    "High (3-3.9 in)",
  );
  // A wedge or a block heel comes in every height there is. Refusing to guess
  // one is the point; it ships as written instead.
  assertEquals(normalizeAspectValue("Wedge", open("Heel Height", PROD_HEEL_HEIGHT)), "Wedge");
  // The style question takes the shape and not the height.
  assertEquals(normalizeAspectValue("Wedge", open("Heel Style", PROD_HEEL_STYLE)), "Wedge");
  assertEquals(normalizeAspectValue("Chunky", open("Heel Style", PROD_HEEL_STYLE)), "Block");
  assertEquals(normalizeAspectValue("High", open("Heel Style", PROD_HEEL_STYLE)), "High");
});

Deno.test("open list: shoes, closures, fit and necklines against prod", () => {
  assertEquals(normalizeAspectValue("Round", open("Toe Shape", PROD_TOE)), "Round Toe");
  assertEquals(normalizeAspectValue("Peep", open("Toe Shape", PROD_TOE)), "Peep Toe");
  assertEquals(normalizeAspectValue("Elastic", open("Closure", PROD_CLOSURE)), "Pull On");
  assertEquals(normalizeAspectValue("Pullover", open("Closure", PROD_CLOSURE)), "Pull On");
  assertEquals(normalizeAspectValue("Skinny", open("Fit", PROD_FIT)), "Slim");
  assertEquals(normalizeAspectValue("Oversized", open("Fit", PROD_FIT)), "Relaxed");
  assertEquals(normalizeAspectValue("Wide Leg", open("Fit", PROD_FIT)), "Relaxed");
  // Bootcut is a leg SHAPE; prod's Fit list holds only widths, so it is left
  // alone rather than guessed onto Regular.
  assertEquals(normalizeAspectValue("Bootcut", open("Fit", PROD_FIT)), "Bootcut");
  assertEquals(normalizeAspectValue("Henley", open("Neckline", PROD_NECKLINE)), "Crew Neck");
  assertEquals(normalizeAspectValue("Button-Down", open("Neckline", PROD_NECKLINE)), "Collared");
  // eBay's Neckline list has no hood, and inventing one would misdescribe it.
  assertEquals(normalizeAspectValue("Hooded", open("Neckline", PROD_NECKLINE)), "Hooded");
  assertEquals(normalizeAspectValue("Tank", open("Sleeve Length", PROD_SLEEVE)), "Sleeveless");
  assertEquals(
    normalizeAspectValue("Cap Sleeve", open("Sleeve Length", PROD_SLEEVE)),
    "Short Sleeve",
  );
});

Deno.test("open list: hem length, occasion and hardware tone against prod", () => {
  assertEquals(normalizeAspectValue("Mini", open("Dress Length", PROD_DRESS_LENGTH)), "Short");
  assertEquals(normalizeAspectValue("Maxi", open("Dress Length", PROD_DRESS_LENGTH)), "Long");
  assertEquals(
    normalizeAspectValue("Asymmetrical", open("Dress Length", PROD_DRESS_LENGTH)),
    "Asymmetric",
  );
  assertEquals(normalizeAspectValue("Work", open("Occasion", PROD_OCCASION)), "Business");
  assertEquals(
    normalizeAspectValue("Cocktail", open("Occasion", PROD_OCCASION)),
    "Party/Cocktail",
  );
  assertEquals(normalizeAspectValue("Athletic", open("Occasion", PROD_OCCASION)), "Activewear");
  assertEquals(
    normalizeAspectValue("Gold-Tone", open("Hardware Color", PROD_HARDWARE_COLOR)),
    "Gold",
  );
  assertEquals(
    normalizeAspectValue("Gunmetal", open("Hardware Color", PROD_HARDWARE_COLOR)),
    "Gunmetal",
  );
});

Deno.test("the guessy containment step stays off open lists", () => {
  // Prod ships Brand as FREE_TEXT with 27,421 values. A lone containment hit
  // in a list that size is coincidence far more often than intent, so step 5
  // is closed-list only and the value ships as the seller wrote it.
  const brands = ["Nike Golf", "Adidas Originals", "Puma"];
  assertEquals(
    normalizeAspectValue("Golf", { name: "Brand", mode: "FREE_TEXT", allowedValues: brands }),
    "Golf",
  );
  // The same aspect as a closed list still resolves it.
  assertEquals(normalizeAspectValue("Golf", sel("Brand", brands)), "Nike Golf");
});
