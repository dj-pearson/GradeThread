// US-823: aspect VALUE normalization for SELECTION_ONLY eBay aspects.
//
// The registry (US-822) decides WHICH aspect a canonical field maps to. This
// module decides what VALUE to send once we know the aspect is SELECTION_ONLY —
// i.e. eBay will only accept a value from its `allowedValues` list. Before this,
// matching was case-insensitive + a trailing-"s" plural strip only, so a stored
// size "M" never matched the allowed value "Medium", "Poly" never matched
// "Polyester", "Men's" never matched "Men" — the aspect silently fell back to
// manual entry or became a publish blocker.
//
// normalizeAspectValue() adds curated synonym tables (sizes, materials, colors,
// departments, size types) plus a conservative token/affix fallback that ONLY
// fires when exactly one allowed value is an unambiguous candidate. Design rule
// from the PRD: a wrong auto-mapped aspect is worse than an empty one, so when
// no confident match exists we return null (leave it for manual entry) and we
// NEVER touch FREE_TEXT aspects (the original value passes straight through).
//
// This file is MIRRORED verbatim at src/lib/aspect-normalize.ts (the web
// composer copy) so the edge publish path, the web prefill preview, and iOS
// (server-driven) all normalize identically. Keep the two in sync.

/** The minimal, platform-agnostic shape of an aspect spec we normalize against. */
export interface AspectValueSpec {
  /** eBay aspect display name (e.g. "Size", "Department") — drives table choice. */
  name?: string;
  /** "SELECTION_ONLY" | "FREE_TEXT" | "SUGGESTED" — only SELECTION_ONLY is normalized. */
  mode?: string;
  /** eBay's allowed values for a SELECTION_ONLY aspect. */
  allowedValues?: string[];
}

type SynonymKind = "size" | "size_type" | "material" | "color" | "department";

// ─── Curated equivalence groups ────────────────────────────────────
// Each group is a set of interchangeable spellings. Expansion returns every
// member of the group a value belongs to, which is then matched against the
// category's real allowedValues. Conservative by design — only well-established
// equivalences, never semantic guesses (e.g. Beige ≠ Tan, 1X ≠ XL).

const SIZE_GROUPS: string[][] = [
  ["XXS", "XX-Small", "2XS", "Double Extra Small"],
  ["XS", "X-Small", "Extra Small"],
  ["S", "Small"],
  ["M", "Medium", "Med"],
  ["L", "Large"],
  ["XL", "X-Large", "Extra Large"],
  ["XXL", "XX-Large", "2X-Large"],
  ["XXXL", "XXX-Large", "3X-Large"],
  ["One Size", "One Size Fits All", "OS", "OSFA", "One-Size"],
];

const MATERIAL_GROUPS: string[][] = [
  ["Polyester", "Poly"],
  ["Spandex", "Elastane", "Lycra"],
  ["Nylon", "Polyamide"],
  ["Viscose", "Rayon"],
  ["Faux Leather", "Vegan Leather", "Synthetic Leather", "Pleather"],
];

const COLOR_GROUPS: string[][] = [
  ["Gray", "Grey"],
  ["Multicolor", "Multi-Color", "Multicolour", "Multi-Colour"],
  ["Navy", "Navy Blue"],
  ["Off-White", "Off White"],
];

const DEPARTMENT_GROUPS: string[][] = [
  ["Men", "Men's", "Mens", "Man", "Male", "Menswear"],
  ["Women", "Women's", "Womens", "Woman", "Female", "Ladies", "Womenswear"],
  ["Unisex Adult", "Unisex Adults", "Unisex"],
  ["Boys", "Boy", "Boy's"],
  ["Girls", "Girl", "Girl's"],
  ["Unisex Kids", "Unisex Kid", "Unisex Children", "Kids", "Children"],
  ["Baby", "Babies", "Infant", "Newborn"],
];

const SIZE_TYPE_GROUPS: string[][] = [
  ["Regular", "Standard"],
  ["Plus", "Plus Size"],
  ["Petite", "Petites"],
  ["Big & Tall", "Big and Tall", "Big &amp; Tall"],
  ["Juniors", "Junior", "Jr"],
];

const GROUPS_BY_KIND: Record<SynonymKind, string[][]> = {
  size: SIZE_GROUPS,
  size_type: SIZE_TYPE_GROUPS,
  material: MATERIAL_GROUPS,
  color: COLOR_GROUPS,
  department: DEPARTMENT_GROUPS,
};

// Loose key used for synonym-group membership and exact comparison: lowercased,
// punctuation/whitespace stripped. "Men's" → "mens", "X-Large" → "xlarge".
function loose(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Comparison key for the legacy exact + plural-tolerant match: lowercased,
// trimmed, single trailing "s" removed.
function plural(s: string): string {
  return s.toLowerCase().trim().replace(/s$/, "");
}

// Which curated table (if any) applies to an aspect, by its display name.
function aspectKind(name: string | undefined): SynonymKind | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  if (n.includes("size type")) return "size_type";
  if (n.includes("size")) return "size"; // incl. "US Shoe Size" (no alpha table hits → harmless)
  if (n.includes("material") || n.includes("fabric")) return "material";
  if (n.includes("color") || n.includes("colour")) return "color";
  if (n.includes("department")) return "department";
  return null;
}

// All interchangeable spellings of `value` for `kind`, including the value
// itself. Returns just [value] when it belongs to no curated group.
function expandSynonyms(value: string, kind: SynonymKind): string[] {
  const key = loose(value);
  for (const group of GROUPS_BY_KIND[kind]) {
    if (group.some((m) => loose(m) === key)) {
      return group;
    }
  }
  return [value];
}

// ─── Descriptive-value families (US-3016) ──────────────────────────
//
// The groups above are EQUIVALENCES: every member means the same thing, so the
// mapping runs in either direction ("M" <-> "Medium"). That handles
// abbreviations and it handles nothing else, which is why the capture pass kept
// losing values.
//
// The capture pass in ai-extract.ts describes a garment the way a seller would:
// "Taupe", "Sage Green", "Mini", "Crew", "Burgundy". eBay's SELECTION_ONLY
// lists are deliberately coarse: Color is roughly the sixteen crayon-box names,
// Dress Length is Short / Knee Length / Midi / Long / Hi-Low / Asymmetric. None
// of those descriptive words is an equivalence of a list entry, so steps 1-5 all
// missed and the aspect was dropped. The seller then saw an empty Color on a
// listing whose photos are unmistakably green.
//
// A family is DIRECTIONAL and narrowing: a specific value names the coarse
// bucket(s) it belongs to, in preference order, and we take the first bucket
// the category actually allows. Sage Green -> Green. Taupe -> Beige, or Brown
// when the category has no Beige. The reverse never happens; Green never
// becomes Sage Green, because that would invent detail we did not observe.
//
// Ordering carries the judgement. Where a value straddles two buckets the first
// entry is the one eBay buyers filter on (Coral sits under Pink, Teal under
// Blue), and where it belongs to neither more than the other it is left out of
// the table so the value falls through to null and a human fills it. The rule
// at the top of this file still holds: a wrong auto-mapped aspect is worse than
// an empty one. A COARSER one is not wrong.

type FamilyKind =
  | "color"
  | "length"
  | "sleeve"
  | "neckline"
  | "pattern"
  | "fit"
  | "rise"
  | "closure"
  | "occasion"
  | "season"
  | "heelHeight"
  | "heelStyle"
  | "legStyle"
  | "toe"
  | "shaft"
  | "strap";

/** loose(value) -> coarse eBay buckets, most-preferred first. */
type FamilyTable = Record<string, string[]>;

// eBay's apparel Color list is essentially: Beige, Black, Blue, Brown, Gold,
// Gray, Green, Ivory, Multicolor, Orange, Pink, Purple, Red, Silver, White,
// Yellow, plus Clear/Bronze/Tan/Cream in some categories (which exact-match
// first anyway, at step 1).
const COLOR_FAMILY: FamilyTable = {
  // Neutrals
  taupe: ["Beige", "Brown", "Gray"],
  khaki: ["Beige", "Green", "Brown"],
  sand: ["Beige", "Tan"],
  camel: ["Beige", "Tan", "Brown"],
  oatmeal: ["Beige", "Ivory"],
  stone: ["Beige", "Gray"],
  nude: ["Beige"],
  buff: ["Beige"],
  cream: ["Ivory", "White", "Beige"],
  ecru: ["Ivory", "Beige"],
  bone: ["Ivory", "White"],
  eggshell: ["Ivory", "White"],
  vanilla: ["Ivory", "White"],
  offwhite: ["Ivory", "White"],
  natural: ["Ivory", "Beige"],
  charcoal: ["Gray", "Black"],
  slate: ["Gray", "Blue"],
  gunmetal: ["Gray", "Silver"],
  pewter: ["Gray", "Silver"],
  ash: ["Gray"],
  smoke: ["Gray"],
  graphite: ["Gray", "Black"],
  onyx: ["Black"],
  jet: ["Black"],
  ebony: ["Black"],
  // Browns
  chocolate: ["Brown"],
  espresso: ["Brown"],
  cognac: ["Brown"],
  chestnut: ["Brown"],
  walnut: ["Brown"],
  mahogany: ["Brown"],
  caramel: ["Brown", "Tan"],
  toffee: ["Brown", "Tan"],
  mocha: ["Brown"],
  rust: ["Orange", "Brown"],
  terracotta: ["Orange", "Brown"],
  copper: ["Brown", "Orange"],
  bronze: ["Brown", "Gold"],
  // Reds and pinks
  burgundy: ["Red", "Purple"],
  maroon: ["Red"],
  wine: ["Red", "Purple"],
  merlot: ["Red", "Purple"],
  crimson: ["Red"],
  scarlet: ["Red"],
  cherry: ["Red"],
  brick: ["Red", "Orange"],
  ruby: ["Red"],
  blush: ["Pink"],
  rose: ["Pink"],
  fuchsia: ["Pink", "Purple"],
  magenta: ["Pink", "Purple"],
  coral: ["Pink", "Orange"],
  salmon: ["Pink", "Orange"],
  peach: ["Pink", "Orange"],
  hotpink: ["Pink"],
  dustyrose: ["Pink"],
  mauve: ["Purple", "Pink"],
  // Purples
  lavender: ["Purple"],
  lilac: ["Purple"],
  violet: ["Purple"],
  plum: ["Purple"],
  eggplant: ["Purple"],
  aubergine: ["Purple"],
  amethyst: ["Purple"],
  periwinkle: ["Purple", "Blue"],
  // Blues
  navy: ["Blue"],
  cobalt: ["Blue"],
  royalblue: ["Blue"],
  cerulean: ["Blue"],
  denim: ["Blue"],
  indigo: ["Blue", "Purple"],
  sapphire: ["Blue"],
  teal: ["Blue", "Green"],
  turquoise: ["Blue", "Green"],
  aqua: ["Blue"],
  aquamarine: ["Blue"],
  cyan: ["Blue"],
  sky: ["Blue"],
  babyblue: ["Blue"],
  powderblue: ["Blue"],
  // Greens
  sage: ["Green"],
  olive: ["Green"],
  forest: ["Green"],
  hunter: ["Green"],
  emerald: ["Green"],
  jade: ["Green"],
  mint: ["Green"],
  moss: ["Green"],
  seafoam: ["Green"],
  lime: ["Green"],
  chartreuse: ["Green", "Yellow"],
  kelly: ["Green"],
  army: ["Green"],
  // Yellows and oranges
  mustard: ["Yellow"],
  lemon: ["Yellow"],
  butter: ["Yellow"],
  canary: ["Yellow"],
  ochre: ["Yellow", "Orange"],
  amber: ["Orange", "Yellow"],
  apricot: ["Orange"],
  tangerine: ["Orange"],
  pumpkin: ["Orange"],
  burntorange: ["Orange"],
  // Metallics
  goldtone: ["Gold"],
  silvertone: ["Silver"],
  champagne: ["Gold", "Beige"],
  rosegold: ["Gold", "Pink"],
  brass: ["Gold"],
  platinum: ["Silver"],
  chrome: ["Silver"],
  metallic: ["Silver"],
  // Multi
  rainbow: ["Multicolor"],
  colorblock: ["Multicolor"],
  ombre: ["Multicolor"],
  tiedye: ["Multicolor"],
  assorted: ["Multicolor"],
  various: ["Multicolor"],
};

// Hem length on a dress, skirt, coat or pair of shorts. eBay runs two different
// vocabularies depending on the category (Short/Knee Length/Midi/Long/Hi-Low
// versus Mini/Midi/Maxi), so most values list both and the category picks.
const LENGTH_FAMILY: FamilyTable = {
  mini: ["Mini", "Short", "Above Knee"],
  micromini: ["Mini", "Short"],
  short: ["Short", "Mini", "Above Knee"],
  aboveknee: ["Above Knee", "Short", "Mini"],
  abovetheknee: ["Above Knee", "Short", "Mini"],
  knee: ["Knee Length", "Knee-Length", "Midi"],
  kneelength: ["Knee Length", "Knee-Length", "Midi"],
  attheknee: ["Knee Length", "Knee-Length", "Midi"],
  belowknee: ["Below Knee", "Midi", "Knee Length"],
  belowtheknee: ["Below Knee", "Midi", "Knee Length"],
  midi: ["Midi", "Mid-Calf", "Below Knee"],
  midcalf: ["Mid-Calf", "Midi"],
  tea: ["Midi", "Tea Length"],
  tealength: ["Midi", "Tea Length"],
  maxi: ["Maxi", "Long", "Full Length"],
  fulllength: ["Full Length", "Long", "Maxi"],
  floor: ["Long", "Maxi", "Full Length"],
  floorlength: ["Long", "Maxi", "Full Length"],
  ankle: ["Ankle", "Maxi", "Long"],
  anklelength: ["Ankle", "Maxi", "Long"],
  long: ["Long", "Maxi"],
  hilow: ["Hi-Low", "High-Low", "Asymmetric"],
  highlow: ["Hi-Low", "High-Low", "Asymmetric"],
  asymmetric: ["Asymmetric", "Asymmetrical", "Hi-Low"],
  asymmetrical: ["Asymmetric", "Asymmetrical", "Hi-Low"],
  cropped: ["Cropped", "Short"],
  crop: ["Cropped", "Short"],
  thigh: ["Thigh Length", "Short"],
  hip: ["Hip Length", "Short"],
  waist: ["Waist Length", "Cropped", "Short"],
  tunic: ["Tunic", "Long"],
};

const SLEEVE_FAMILY: FamilyTable = {
  sleeveless: ["Sleeveless"],
  none: ["Sleeveless"],
  tank: ["Sleeveless"],
  strapless: ["Sleeveless"],
  cap: ["Cap Sleeve", "Short Sleeve"],
  capsleeve: ["Cap Sleeve", "Short Sleeve"],
  short: ["Short Sleeve"],
  shortsleeve: ["Short Sleeve"],
  elbow: ["Elbow-Length", "3/4 Sleeve", "Short Sleeve"],
  half: ["Half Sleeve", "Short Sleeve"],
  threequarter: ["3/4 Sleeve", "Long Sleeve"],
  "34": ["3/4 Sleeve", "Long Sleeve"],
  "34sleeve": ["3/4 Sleeve", "Long Sleeve"],
  bracelet: ["3/4 Sleeve", "Long Sleeve"],
  long: ["Long Sleeve"],
  longsleeve: ["Long Sleeve"],
  full: ["Long Sleeve"],
  extralong: ["Long Sleeve"],
};

const NECKLINE_FAMILY: FamilyTable = {
  crew: ["Crew Neck", "Round Neck"],
  crewneck: ["Crew Neck", "Round Neck"],
  round: ["Round Neck", "Crew Neck"],
  roundneck: ["Round Neck", "Crew Neck"],
  jewel: ["Round Neck", "Crew Neck"],
  v: ["V-Neck", "V Neck"],
  vneck: ["V-Neck", "V Neck"],
  deepv: ["V-Neck", "V Neck"],
  scoop: ["Scoop Neck", "Round Neck"],
  scoopneck: ["Scoop Neck", "Round Neck"],
  boat: ["Boat Neck", "Bateau"],
  bateau: ["Boat Neck", "Bateau"],
  square: ["Square Neck"],
  sweetheart: ["Sweetheart"],
  halter: ["Halter"],
  offshoulder: ["Off the Shoulder", "Off-the-Shoulder"],
  offtheshoulder: ["Off the Shoulder", "Off-the-Shoulder"],
  cowl: ["Cowl Neck"],
  mock: ["Mock Neck", "Turtleneck"],
  mockneck: ["Mock Neck", "Turtleneck"],
  turtle: ["Turtleneck", "Turtle Neck"],
  turtleneck: ["Turtleneck", "Turtle Neck"],
  funnel: ["Funnel Neck", "Mock Neck"],
  hooded: ["Hooded", "Hood"],
  hood: ["Hooded", "Hood"],
  collared: ["Collared", "Point Collar"],
  collar: ["Collared", "Point Collar"],
  buttondown: ["Collared", "Point Collar"],
  polo: ["Collared", "Polo"],
  keyhole: ["Keyhole"],
  strapless: ["Strapless"],
  oneshoulder: ["One Shoulder"],
  henley: ["Henley", "Crew Neck", "Round Neck"],
};

const PATTERN_FAMILY: FamilyTable = {
  solid: ["Solid"],
  plain: ["Solid"],
  none: ["Solid"],
  stripe: ["Striped", "Stripes"],
  striped: ["Striped", "Stripes"],
  pinstripe: ["Striped", "Pinstripe"],
  plaid: ["Plaid", "Check", "Checked"],
  tartan: ["Plaid", "Check"],
  check: ["Check", "Checked", "Plaid"],
  checked: ["Check", "Checked", "Plaid"],
  gingham: ["Gingham", "Check", "Plaid"],
  houndstooth: ["Houndstooth", "Check", "Checked", "Plaid"],
  windowpane: ["Check", "Plaid"],
  floral: ["Floral"],
  flower: ["Floral"],
  botanical: ["Floral"],
  paisley: ["Paisley"],
  polkadot: ["Polka Dot", "Polka Dots", "Dots"],
  dot: ["Polka Dot", "Polka Dots", "Dots"],
  dotted: ["Polka Dot", "Polka Dots", "Dots"],
  animal: ["Animal Print"],
  leopard: ["Animal Print", "Leopard"],
  cheetah: ["Animal Print", "Leopard"],
  zebra: ["Animal Print", "Zebra"],
  snakeskin: ["Animal Print", "Snakeskin"],
  camo: ["Camouflage"],
  camouflage: ["Camouflage"],
  graphic: ["Graphic Print", "Graphic", "Logo", "Novelty", "Print"],
  logo: ["Logo", "Graphic Print", "Graphic", "Novelty"],
  novelty: ["Novelty", "Graphic Print", "Graphic"],
  geometric: ["Geometric"],
  abstract: ["Abstract", "Geometric"],
  tiedye: ["Tie-Dye", "Tie Dye", "Abstract", "Graphic Print"],
  colorblock: ["Colorblock", "Color Block"],
  argyle: ["Argyle"],
  chevron: ["Chevron", "Geometric"],
  herringbone: ["Herringbone"],
  marled: ["Heathered", "Marled"],
  heather: ["Heathered", "Heather"],
  heathered: ["Heathered", "Heather"],
  embroidered: ["Embroidered"],
  tropical: ["Tropical", "Floral"],
};

const FIT_FAMILY: FamilyTable = {
  slim: ["Slim", "Slim Fit"],
  skinny: ["Skinny", "Slim"],
  fitted: ["Slim", "Slim Fit", "Fitted"],
  tailored: ["Slim", "Tailored"],
  athletic: ["Athletic", "Slim"],
  regular: ["Regular", "Classic", "Straight"],
  classic: ["Classic", "Regular"],
  straight: ["Straight", "Regular", "Classic"],
  standard: ["Regular", "Classic"],
  relaxed: ["Relaxed", "Loose"],
  loose: ["Loose", "Relaxed"],
  baggy: ["Loose", "Relaxed", "Oversized"],
  oversized: ["Oversized", "Loose", "Relaxed"],
  boxy: ["Oversized", "Relaxed"],
  boyfriend: ["Boyfriend", "Relaxed"],
  // Leg shapes reach eBay's Fit list only through the widths it does offer;
  // the shape itself belongs to Leg Style. Ordering the real value first means
  // a category that DOES list Bootcut still gets Bootcut.
  bootcut: ["Bootcut", "Boot Cut"],
  flare: ["Flare", "Flared", "Bootcut"],
  flared: ["Flare", "Flared", "Bootcut"],
  wideleg: ["Wide Leg", "Relaxed", "Loose"],
  tapered: ["Tapered", "Slim"],
  jogger: ["Jogger", "Tapered", "Slim"],
  extraslim: ["Extra-Slim", "Slim"],
};

// Prod ships Rise as a measured range: "Ultra Low (Less than 8 in)", "Low
// (8-10 in)", "Mid (10-12 in)", "High (Greater than 12 in)". Every bucket
// therefore ends with the bare label, which matchFamily compares against the
// part before the parenthesis.
const RISE_FAMILY: FamilyTable = {
  high: ["High Rise", "High-Rise", "High Waist", "High"],
  highrise: ["High Rise", "High-Rise", "High Waist", "High"],
  highwaist: ["High Rise", "High Waist", "High-Rise", "High"],
  highwaisted: ["High Rise", "High Waist", "High-Rise", "High"],
  ultrahigh: ["Ultra High", "High Rise", "High"],
  mid: ["Mid Rise", "Mid-Rise", "Regular Rise", "Mid"],
  midrise: ["Mid Rise", "Mid-Rise", "Regular Rise", "Mid"],
  regular: ["Regular Rise", "Mid Rise", "Mid-Rise", "Mid"],
  low: ["Low Rise", "Low-Rise", "Low"],
  lowrise: ["Low Rise", "Low-Rise", "Low"],
  ultralow: ["Ultra Low", "Low Rise", "Low"],
};

const CLOSURE_FAMILY: FamilyTable = {
  zip: ["Zip", "Zipper"],
  zipper: ["Zipper", "Zip"],
  zipup: ["Zip", "Zipper"],
  fullzip: ["Zip", "Zipper"],
  halfzip: ["Zip", "Zipper"],
  button: ["Button", "Buttons", "Button-Up"],
  buttons: ["Button", "Buttons", "Button-Up"],
  buttonup: ["Button", "Button-Up", "Buttons"],
  buttondown: ["Button", "Button-Up", "Buttons"],
  snap: ["Snap", "Snaps"],
  hookandeye: ["Hook & Eye", "Hook and Eye"],
  tie: ["Tie", "Drawstring"],
  drawstring: ["Drawstring", "Elastic Waist"],
  elastic: ["Elastic Waist", "Pull On", "Pullover"],
  elasticwaist: ["Elastic Waist", "Pull On"],
  pullon: ["Pull On", "Pullover", "Elastic Waist"],
  pullover: ["Pullover", "Pull On"],
  none: ["Pullover", "Pull On"],
  velcro: ["Hook & Loop", "Velcro"],
  laceup: ["Lace Up", "Lace-Up"],
  buckle: ["Buckle"],
  magnetic: ["Magnetic"],
};

const OCCASION_FAMILY: FamilyTable = {
  casual: ["Casual", "Everyday"],
  everyday: ["Casual", "Everyday"],
  work: ["Business", "Work", "Career"],
  business: ["Business", "Work", "Career"],
  office: ["Business", "Work", "Career"],
  career: ["Career", "Business", "Work"],
  formal: ["Formal", "Cocktail"],
  blacktie: ["Formal"],
  cocktail: ["Cocktail", "Party/Cocktail", "Formal"],
  party: ["Party/Cocktail", "Cocktail", "Party"],
  evening: ["Formal", "Cocktail", "Party/Cocktail"],
  wedding: ["Wedding", "Formal"],
  prom: ["Prom", "Formal"],
  athletic: ["Activewear", "Athletic", "Sports"],
  gym: ["Activewear", "Athletic", "Sports"],
  workout: ["Activewear", "Athletic", "Sports"],
  sport: ["Sports", "Activewear", "Athletic"],
  outdoor: ["Outdoor", "Casual"],
  beach: ["Beach", "Vacation", "Casual"],
  travel: ["Travel", "Vacation", "Casual"],
  lounge: ["Loungewear", "Casual"],
  sleep: ["Sleepwear", "Loungewear"],
};

const SEASON_FAMILY: FamilyTable = {
  spring: ["Spring", "Spring/Summer"],
  summer: ["Summer", "Spring/Summer"],
  springsummer: ["Spring/Summer", "Spring", "Summer"],
  fall: ["Fall", "Autumn", "Fall/Winter"],
  autumn: ["Autumn", "Fall", "Fall/Winter"],
  winter: ["Winter", "Fall/Winter"],
  fallwinter: ["Fall/Winter", "Fall", "Winter"],
  allseason: ["All Seasons", "All Season"],
  allseasons: ["All Seasons", "All Season"],
  yearround: ["All Seasons", "All Season"],
};

// eBay asks TWO heel questions and they take different answers. Heel Height
// is a measured range ("Flat (Under 1 in)", "Mid (2-2.9 in)", "Ultra High
// (4 in & Higher)"); Heel Style is a shape (Block, Cone, Cuban, Flat, Kitten,
// Spool, Stiletto, Wedge). Stiletto is not a height and Mid is not a shape, so
// one table answering both put a wrong value in one of them every time.
const HEEL_HEIGHT_FAMILY: FamilyTable = {
  flat: ["Flat", "No Heel"],
  noheel: ["No Heel", "Flat"],
  low: ["Low"],
  kitten: ["Low"],
  mid: ["Mid", "Medium"],
  medium: ["Mid", "Medium"],
  high: ["High"],
  veryhigh: ["Ultra High", "Very High", "High"],
  ultrahigh: ["Ultra High", "Very High", "High"],
  // Shapes that imply a height, for the category that asks only for height.
  stiletto: ["High"],
};

const HEEL_STYLE_FAMILY: FamilyTable = {
  stiletto: ["Stiletto"],
  block: ["Block", "Chunky"],
  chunky: ["Block", "Chunky"],
  wedge: ["Wedge"],
  platform: ["Platform"],
  kitten: ["Kitten"],
  cone: ["Cone"],
  spool: ["Spool"],
  cuban: ["Cuban", "Block"],
  flat: ["Flat"],
  noheel: ["Flat"],
};

// Leg shape is its own eBay aspect. It used to live in FIT_FAMILY, which was
// wrong in both directions: prod's Fit list is Athletic / Classic / Extra-Slim
// / Regular / Relaxed / Slim, so Bootcut and Wide Leg could never land there,
// and Leg Style never got a table of its own.
const LEG_STYLE_FAMILY: FamilyTable = {
  skinny: ["Skinny", "Slim"],
  slim: ["Slim", "Skinny", "Straight Leg"],
  straight: ["Straight Leg", "Straight", "Regular"],
  regular: ["Straight Leg", "Straight", "Regular"],
  bootcut: ["Bootcut", "Boot Cut", "Flare"],
  flare: ["Flare", "Flared", "Bootcut"],
  flared: ["Flare", "Flared", "Bootcut"],
  wideleg: ["Wide Leg", "Wide-Leg", "Relaxed"],
  wide: ["Wide Leg", "Wide-Leg", "Relaxed"],
  tapered: ["Tapered", "Slim"],
  jogger: ["Jogger", "Tapered"],
  cargo: ["Cargo"],
  cropped: ["Cropped", "Capri"],
  capri: ["Capri", "Cropped"],
  baggy: ["Wide Leg", "Relaxed"],
};

const TOE_FAMILY: FamilyTable = {
  round: ["Round Toe", "Round"],
  roundtoe: ["Round Toe", "Round"],
  almond: ["Almond Toe", "Round Toe", "Round"],
  pointed: ["Pointed Toe", "Pointy Toe", "Pointed"],
  pointy: ["Pointed Toe", "Pointy Toe", "Pointed"],
  square: ["Square Toe", "Square"],
  open: ["Open Toe", "Peep Toe"],
  peep: ["Peep Toe", "Open Toe"],
  peeptoe: ["Peep Toe", "Open Toe"],
  closed: ["Closed Toe", "Round Toe"],
  moc: ["Moc Toe", "Round Toe"],
  captoe: ["Cap Toe"],
  cap: ["Cap Toe"],
  apron: ["Apron Toe", "Moc Toe"],
};

const SHAFT_FAMILY: FamilyTable = {
  ankle: ["Ankle", "Ankle Boot"],
  bootie: ["Ankle", "Ankle Boot"],
  midcalf: ["Mid-Calf", "Mid Calf"],
  calf: ["Mid-Calf", "Mid Calf"],
  knee: ["Knee High", "Knee-High"],
  kneehigh: ["Knee High", "Knee-High"],
  overtheknee: ["Over the Knee", "Over-the-Knee", "Thigh High"],
  thigh: ["Thigh High", "Over the Knee", "Over-the-Knee"],
  thighhigh: ["Thigh High", "Over the Knee", "Over-the-Knee"],
};

const STRAP_FAMILY: FamilyTable = {
  shoulder: ["Shoulder Strap", "Shoulder"],
  shoulderstrap: ["Shoulder Strap", "Shoulder"],
  crossbody: ["Crossbody", "Cross Body", "Shoulder Strap"],
  sling: ["Crossbody", "Cross Body"],
  tophandle: ["Top Handle", "Handle"],
  handle: ["Handle", "Top Handle"],
  handheld: ["Handle", "Top Handle"],
  doublehandle: ["Double Handle", "Top Handle", "Handle"],
  chain: ["Chain", "Chain Strap"],
  adjustable: ["Adjustable", "Adjustable Strap"],
  detachable: ["Detachable", "Removable Strap"],
  removable: ["Removable Strap", "Detachable"],
  backpack: ["Backpack Straps", "Shoulder Strap"],
  wristlet: ["Wristlet", "Wrist Strap"],
  anklestrap: ["Ankle Strap"],
  slipon: ["Slip On", "None"],
  none: ["None", "Strapless"],
};

const FAMILIES_BY_KIND: Record<FamilyKind, FamilyTable> = {
  color: COLOR_FAMILY,
  length: LENGTH_FAMILY,
  sleeve: SLEEVE_FAMILY,
  neckline: NECKLINE_FAMILY,
  pattern: PATTERN_FAMILY,
  fit: FIT_FAMILY,
  rise: RISE_FAMILY,
  closure: CLOSURE_FAMILY,
  occasion: OCCASION_FAMILY,
  season: SEASON_FAMILY,
  heelHeight: HEEL_HEIGHT_FAMILY,
  heelStyle: HEEL_STYLE_FAMILY,
  legStyle: LEG_STYLE_FAMILY,
  toe: TOE_FAMILY,
  shaft: SHAFT_FAMILY,
  strap: STRAP_FAMILY,
};

// eBay's coarse color buckets, as the compound-value fallback recognizes them.
const BASE_COLORS = new Set([
  "beige",
  "black",
  "blue",
  "brown",
  "gold",
  "gray",
  "grey",
  "green",
  "ivory",
  "multicolor",
  "orange",
  "pink",
  "purple",
  "red",
  "silver",
  "tan",
  "white",
  "yellow",
]);

// Which family table (if any) an aspect's display name selects. Order matters:
// "Hardware Color" has to reach `color` and "Sleeve Length" has to reach
// `sleeve` rather than `length`, so the more specific test runs first.
function familyKind(name: string | undefined): FamilyKind | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  if (n.includes("sleeve")) return "sleeve";
  if (n.includes("neck") || n.includes("collar")) return "neckline";
  if (n.includes("shaft") || n.includes("boot height")) return "shaft";
  if (n.includes("heel")) {
    return n.includes("height") || n.includes("drop") ? "heelHeight" : "heelStyle";
  }
  if (n.includes("toe")) return "toe";
  if (n.includes("leg style") || n.includes("leg cut")) return "legStyle";
  if (n.includes("strap") || n.includes("handle")) return "strap";
  if (n.includes("closure") || n.includes("fastening")) return "closure";
  if (n.includes("rise") || n.includes("waist height")) return "rise";
  if (n.includes("pattern") || n.includes("print")) return "pattern";
  if (n.includes("occasion")) return "occasion";
  if (n.includes("season")) return "season";
  if (n.includes("color") || n.includes("colour")) return "color";
  if (n.includes("length") || n.includes("hem")) return "length";
  if (n.includes("fit") || n.includes("silhouette")) return "fit";
  return null;
}

// The buckets a descriptive value belongs to, most-preferred first. Empty when
// the value is in no family.
function familyBuckets(value: string, kind: FamilyKind): string[] {
  const table = FAMILIES_BY_KIND[kind];
  const direct = table[loose(value)];
  if (direct) return direct;

  // Compound values no table can enumerate: "Sage Green", "Light Blue", "Dark
  // Olive Green", "Heather Charcoal", "Above the Knee". Read right to left and
  // take the first token that names a bucket. The last word of an English color
  // or length phrase is the base term, and the modifiers in front of it are
  // exactly the detail eBay's coarse list throws away.
  const tokens = value.split(/[\s\-/]+/).filter((t) => t.length > 0);
  if (tokens.length > 1) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i]!;
      const hit = table[loose(t)];
      if (hit) return hit;
      // The token may already BE a bucket ("Sage Green" -> "Green"), which no
      // family table lists because it needs no narrowing.
      if (kind === "color" && BASE_COLORS.has(loose(t))) {
        return [t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()];
      }
    }
  }
  return [];
}

/**
 * Narrow a descriptive value onto the coarsest allowed value that still
 * describes it. Returns null when the aspect has no family table, the value is
 * in no family, or none of its buckets is in this category's allowed list.
 */
function matchFamily(
  value: string,
  spec: AspectValueSpec,
  allowed: string[],
): string | null {
  const kind = familyKind(spec.name);
  if (!kind) return null;
  for (const bucket of familyBuckets(value, kind)) {
    const bl = loose(bucket);
    const hit = allowed.find((a) => loose(a) === bl);
    if (hit) return hit;
    // eBay states several vocabularies as a label plus a measured range:
    // Rise is "High (Greater than 12 in)", Heel Height "Mid (2-2.9 in)".
    // The bucket names the label, so compare against the label alone. Only
    // when exactly one allowed value carries it, so "Low" cannot pick between
    // "Low (1-1.9 in)" and "Ultra Low (Less than 8 in)" by accident.
    const labelled = allowed.filter((a) => loose(labelOf(a)) === bl);
    if (labelled.length === 1) return labelled[0]!;
  }
  return null;
}

/** "High (Greater than 12 in)" -> "High"; anything else unchanged. */
function labelOf(allowedValue: string): string {
  const m = allowedValue.match(/^(.+?)\s*\([^)]*\)\s*$/);
  return m ? m[1]!.trim() : allowedValue;
}

/**
 * Resolve a canonical stored value to one of an aspect's allowed values, or
 * null when no confident match exists. FREE_TEXT (and any non-SELECTION_ONLY)
 * aspects pass the original value straight through unchanged.
 *
 * Cascade (first hit wins, all case-insensitive):
 *  1. exact match
 *  2. plural-tolerant match (legacy behavior — "Unisex Adult" ↔ "Unisex Adults")
 *  3. curated synonym expansion ("M" → "Medium", "Poly" → "Polyester", "Men's" → "Men")
 *  4. parenthetical abbreviation ("M" → "M (Medium)", "Medium" → "M (Medium)")
 *  5. single unambiguous whole-word containment ("Crew" → "Crew Neck")
 *  6. descriptive-value family narrowing ("Sage Green" -> "Green", "Taupe" -> "Beige")
 * Steps 4–5 fire ONLY when exactly one allowed value is a candidate.
 */
export function normalizeAspectValue(
  value: string,
  spec: AspectValueSpec,
): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  // WHO GETS NORMALIZED, corrected 2026-08-30 by measuring prod rather than
  // reasoning about it. This used to return `raw` untouched for anything that
  // was not SELECTION_ONLY, on the assumption that a non-closed list has
  // nothing to match against. eBay disagrees: across 121 cached categories,
  // Color is FREE_TEXT in 107 of them AND ships 25 allowed values, Pattern is
  // FREE_TEXT in 82 with 222, Neckline FREE_TEXT in 26 with 16. FREE_TEXT there
  // means "we will accept a value we did not list", not "we listed none".
  //
  // The list is the one eBay's own buyer filters are built from, so a garment
  // sent as "Taupe" publishes fine and then sits outside every Beige search.
  // That is the failure the seller actually sees, and the early return meant
  // NONE of the matching below ever ran for the fields they complained about.
  //
  // What changes for a non-closed list: we try to land on a listed value, and
  // fall back to the seller's own words when we cannot. Nothing is ever
  // dropped that was not dropped before.
  const selection = (spec.mode ?? "") === "SELECTION_ONLY";
  /** Non-closed lists keep the original value; a closed list must refuse. */
  const noMatch = selection ? null : raw;

  const allowed = (spec.allowedValues ?? []).filter((v) => v && v.trim().length > 0);
  if (allowed.length === 0) return noMatch;

  // 1. exact (case-insensitive, trimmed)
  const lc = raw.toLowerCase();
  const exact = allowed.find((a) => a.toLowerCase().trim() === lc);
  if (exact) return exact;

  // 2. plural-tolerant (legacy)
  const pv = plural(raw);
  const pluralHit = allowed.find((a) => plural(a) === pv);
  if (pluralHit) return pluralHit;

  // 3. curated synonyms
  const kind = aspectKind(spec.name);
  if (kind) {
    for (const cand of expandSynonyms(raw, kind)) {
      const clc = cand.toLowerCase().trim();
      const cp = plural(cand);
      const hit = allowed.find((a) => a.toLowerCase().trim() === clc || plural(a) === cp);
      if (hit) return hit;
    }
  }

  // 4. parenthetical abbreviation: "Label (ABBR)" — match either part.
  const parenHits = allowed.filter((a) => {
    const m = a.match(/^(.+?)\s*\(([^)]+)\)$/);
    if (!m) return false;
    const label = m[1]!.toLowerCase().trim();
    const abbr = m[2]!.toLowerCase().trim();
    return label === lc || abbr === lc;
  });
  if (parenHits.length === 1) return parenHits[0]!;

  // 5. whole-word containment, only for a multi-word allowed value and a
  // sufficiently specific (≥3 char) single-token value, and only when exactly
  // one allowed value contains it as a standalone word.
  //
  // CLOSED LISTS ONLY. On an open list this is the step most likely to be
  // wrong, and it has the least to gain: the lists that are open are also the
  // enormous ones (Brand ships 27,421 values, Model 17,374, Character 13,713),
  // where a lone containment hit is coincidence far more often than intent.
  if (selection && raw.length >= 3 && !/\s/.test(raw)) {
    const wordRe = new RegExp(`\\b${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const wordHits = allowed.filter((a) => /\s/.test(a) && wordRe.test(a));
    if (wordHits.length === 1) return wordHits[0]!;
  }

  // 6. family narrowing. Last, so every exact/equivalence path above still
  // wins: an aspect that lists both "Navy" and "Blue" keeps Navy.
  const family = matchFamily(raw, spec, allowed);
  if (family) return family;

  return noMatch;
}
