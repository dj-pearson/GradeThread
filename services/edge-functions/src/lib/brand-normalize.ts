// US-544: brand canonicalization + style-code resolution for AutoLister.
//
// The model (and the tag-OCR pass, US-543) emit brand as FREE TEXT — "Levis",
// "levi strauss", "THE NORTHFACE" — and comp search keyed on that raw string.
// eBay's Browse/Marketplace-Insights aspect filter is `Brand:{...}` with an
// EXACT-match value, so a misspelled or non-canonical brand silently drops the
// brand filter to zero matches and prices off an unfiltered category. This
// module:
//
//   1. canonicalizeBrand() — maps a free-text brand onto eBay's canonical brand
//      name via a curated alias table ("Levis" -> "Levi's"), so the comp filter
//      and the Brand item-specific both use the value eBay indexes on.
//   2. resolveStyleCode() — for sneakers/streetwear, turns a style/model code
//      ("CW2288-111") into a canonical product: the authoritative brand, an
//      exact comp query (the code itself returns the SAME shoe, not a fuzzy
//      category match), and auto-filled item specifics.
//
// Everything here is PURE (no network, no DB) so it unit-tests directly.

// ── Brand canonicalization ────────────────────────────────────────────────

/** Normalize to a match key: lowercase, strip everything but [a-z0-9]. Exported
 *  (US-1711) so the brand-knowledge resolver derives brand_key identically to
 *  the 00389 seed (which normalized canonical brands the same way). */
export function brandKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Collapse internal whitespace and trim — the cleaned passthrough for an
 *  unknown brand (we keep the seller's casing rather than guessing). */
function cleanBrand(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

// Curated alias key (brandKey-normalized) -> eBay canonical brand name. The
// VALUES are the strings eBay's Brand aspect indexes on (note "adidas" is
// lowercase, "GUESS" is upper — these are eBay-canonical, not stylistic). Add
// rows as misspellings surface in production; the table is intentionally a flat
// map so it stays cheap to extend.
const BRAND_ALIASES: Record<string, string> = {
  // Denim / Americana
  levis: "Levi's",
  levi: "Levi's",
  levistrauss: "Levi's",
  levistraussco: "Levi's",
  wrangler: "Wrangler",
  lee: "Lee",
  dickies: "Dickies",
  carhartt: "Carhartt",
  // US-1735 premium & vintage denim group. Wrangler + Lee were already above;
  // these four were passthrough-only, so the pack rendered the seller's own
  // casing ("true religion") into the prompt block and the eBay Brand aspect.
  bluebell: "Wrangler", // the pre-1986 parent's mark — a Blue Bell tag IS a Wrangler
  bluebellwrangler: "Wrangler",
  hdlee: "Lee",
  leejeans: "Lee",
  "7forallmankind": "7 For All Mankind",
  sevenforallmankind: "7 For All Mankind",
  "7fam": "7 For All Mankind",
  truereligion: "True Religion",
  truereligionbrandjeans: "True Religion",
  truereligionapparel: "True Religion",
  // CANONICAL IS "AG Jeans", NOT "AG" — deliberately. detectBrandInText scans
  // CANONICAL_BRANDS against free text, and a two-letter "AG" would fire on any
  // stray word-bounded "ag"; sizing-charts.ts matches brandMatch by SUBSTRING,
  // where "ag" is contained in "patAGonia". Keeping the short form as an
  // exact-key ALIAS only (this map is an exact lookup, so it is safe here) gives
  // us the recovery without either hazard.
  ag: "AG Jeans",
  agjeans: "AG Jeans",
  adrianogoldschmied: "AG Jeans",
  agadrianogoldschmied: "AG Jeans",
  citizensofhumanity: "Citizens of Humanity",
  coh: "Citizens of Humanity",
  // AGOLDE is a Citizens of Humanity label, NOT an AG Jeans one despite the
  // name. Mapping it to its own canonical keeps the two from merging.
  agolde: "AGOLDE",
  // Premium denim tier 2 (US-1984, migration 00464). All eight were passthrough.
  diesel: "Diesel",
  dieseljeans: "Diesel",
  dieselindustry: "Diesel",
  dieselblackgold: "Diesel",
  "55dsl": "Diesel",
  gstar: "G-Star RAW",
  gstarraw: "G-Star RAW",
  // "Gap Star" was G-Star's 1989-1994 name and is NOT Gap — the collision is
  // exactly why the company renamed. Mapping it here stops an early tag from
  // resolving to the wrong (and far cheaper) brand.
  gapstar: "G-Star RAW",
  paige: "PAIGE",
  paigedenim: "PAIGE",
  paigejeans: "PAIGE",
  paigeadamsgeller: "PAIGE",
  // FRAME and MOTHER are ORDINARY ENGLISH WORDS. They are safe as alias KEYS
  // (this map is an exact whole-field lookup, so it only fires when the seller's
  // entire brand field is the word), but NOT as canonical VALUES scanned over
  // prose — see DETECT_EXCLUDED_FROM_TEXT below, which is what protects them.
  frame: "FRAME",
  framedenim: "FRAME",
  framejeans: "FRAME",
  mother: "MOTHER",
  motherdenim: "MOTHER",
  motherjeans: "MOTHER",
  // brandKey() STRIPS the ampersand, so "rag & bone" -> ragbone but "rag and
  // bone" -> ragandbone. These are DIFFERENT keys and sellers type both, so both
  // must be listed — it looks like a duplicate line and is not.
  ragbone: "Rag & Bone",
  ragandbone: "Rag & Bone",
  // CANONICAL IS "Hudson Jeans", NOT "Hudson" — the AG Jeans play above. A bare
  // "Hudson" is an ordinary place name and surname, and a canonical is scanned
  // over free text by detectBrandInText; the short form stays an exact-key alias.
  hudson: "Hudson Jeans",
  hudsonjeans: "Hudson Jeans",
  hudsondenim: "Hudson Jeans",
  joesjeans: "Joe's Jeans",
  // A bare "joes" is safe as a KEY (exact whole-field lookup) though it would be
  // unsafe as a canonical. A bare "joe" is deliberately absent — too ordinary
  // even for an exact match (the same rule that keeps "bean" off L.L.Bean).
  joes: "Joe's Jeans",
  // Outdoor
  thenorthface: "The North Face",
  northface: "The North Face",
  tnf: "The North Face",
  patagonia: "Patagonia",
  columbia: "Columbia",
  columbiasportswear: "Columbia",
  llbean: "L.L.Bean",
  eddiebauer: "Eddie Bauer",
  marmot: "Marmot",
  arcteryx: "Arc'teryx",
  pendleton: "Pendleton",
  // US-1734 outdoor & technical group. Columbia/L.L.Bean/Marmot/Arc'teryx were
  // already above; these two were passthrough-only, so the pack rendered the
  // seller's casing ("rei co-op") into the prompt block and the eBay Brand
  // aspect. NOTE: a bare "bean" is deliberately NOT aliased to L.L.Bean — it's an
  // ordinary word, and mapping it would rebrand anything tagged "bean".
  reicoop: "REI Co-op",
  rei: "REI Co-op",
  recreationalequipmentinc: "REI Co-op",
  mountainhardwear: "Mountain Hardwear",
  // US-1981 luxury outerwear & down group. ALL SIX were passthrough-only — none
  // had even a bare alias-only row from 00389 — so "moncler" rendered the seller's
  // own casing into the prompt block and the eBay Brand aspect on the most
  // expensive garments the KB touches.
  //
  // A BARE "goose" IS DELIBERATELY NOT AN ALIAS. It is an ordinary word that this
  // product's own material text emits constantly ("goose down"), so mapping it
  // would rebrand every down garment in the catalog to Canada Goose. Same rule as
  // L.L.Bean's "bean" (00453) and the Anthropologie "moth" trap — an alias key is
  // an exact WHOLE-FIELD lookup, which is safe, but the VALUES build
  // CANONICAL_BRANDS, which detectBrandInText regex-scans over free text.
  moncler: "Moncler",
  monclergrenoble: "Moncler",
  monclergenius: "Moncler",
  monclerenfant: "Moncler",
  canadagoose: "Canada Goose",
  snowgoose: "Canada Goose",
  metrosportswear: "Canada Goose",
  mackage: "Mackage",
  herno: "Herno",
  hernolaminar: "Herno",
  woolrich: "Woolrich",
  woolrichjohnrichbros: "Woolrich",
  woolrichjohnrichandbros: "Woolrich",
  johnrichbros: "Woolrich",
  woolrichwoolenmills: "Woolrich",
  woolrichinternational: "Woolrich",
  bogner: "Bogner",
  willybogner: "Bogner",
  // Fire + Ice is Bogner's diffusion LINE and it prints its own name, never the
  // parent's — so a seller types the sub-label and nothing resolves. Folded onto
  // the parent (the MK/house-label precedent): same price band, not an order of
  // magnitude apart. brandKey strips the "+", so all three spellings land here.
  fireice: "Bogner",
  fireandice: "Bogner",
  bognerfireice: "Bogner",
  bognerfireandice: "Bogner",
  // Athletic / sneakers
  nike: "Nike",
  adidas: "adidas",
  jordan: "Jordan",
  airjordan: "Jordan",
  puma: "PUMA",
  reebok: "Reebok",
  newbalance: "New Balance",
  underarmour: "Under Armour",
  ua: "Under Armour",
  vans: "Vans",
  converse: "Converse",
  // US-1740 footwear group. New Balance, Vans and Converse were already above; the
  // other four were passthrough-only, so the pack rendered the seller's own casing
  // ("doc martens", "birkenstocks") into the prompt block and the eBay Brand aspect.
  //
  // PLURALIZATION IS THE FOOTWEAR NORM and it is why this group adds more plural
  // keys than any prior one: shoes are worn and named in PAIRS ("UGGs", "Birks",
  // "Docs", "Chucks"), where garments are not. The plural belongs HERE, as an alias
  // KEY, because keys are an exact WHOLE-FIELD lookup — they can never fire on a
  // word inside surrounding text. Contrast the two matchers this group is the first
  // to see diverge: findSizingCharts' brandTextMatches is LEADING-boundary only, so
  // "uggs" reaches UGG's charts; detectBrandInText is bounded on BOTH sides, so
  // "UGGs" does NOT resolve there. That asymmetry is CORRECT and must not be
  // "fixed" — the trailing boundary is what stops "Gap" firing on "gaps", and
  // rebranding every "gaps" is a worse bug than missing a plural in a barcode title.
  newbalances: "New Balance",
  nb: "New Balance",
  drmartens: "Dr. Martens",
  drmarten: "Dr. Martens",
  doctormartens: "Dr. Martens",
  docmartens: "Dr. Martens",
  docmarten: "Dr. Martens",
  docmartins: "Dr. Martens",
  // AirWair is Dr. Martens' OWN registered mark for the air-cushioned sole and is
  // printed on the yellow heel loop ("AirWair with Bouncing Soles"). It is a COINED
  // term, so — unlike the far more famous article numbers (1460/1461/2976), which
  // are four digits and could be anything — it genuinely identifies the brand.
  airwair: "Dr. Martens",
  // DELIBERATELY ABSENT, on the rule that keeps a bare "bean" off L.L.Bean:
  //   * "docs"   — an ordinary English word this product's own text emits ("the
  //                docs", "documents"), and the brand's nickname. Never mapped.
  //   * "birks"  — Birks is a Canadian jeweller; the nickname is not worth the
  //                collision.
  //   * "chucks" — a person's name and an ordinary verb.
  //   * "1460"   — four digits is not a brand. See the drmartens row in 00459.
  ugg: "UGG",
  uggs: "UGG",
  uggaustralia: "UGG",
  uggboots: "UGG",
  birkenstock: "Birkenstock",
  birkenstocks: "Birkenstock",
  colehaan: "Cole Haan",
  colehaans: "Cole Haan",
  vansoffthewall: "Vans",
  // Vault by Vans is the premium OG-spec LINE, not a second brand: same catalogue
  // brand on eBay, so it FOLDS with the line carried in `style` (the Gap Factory
  // play). Contrast Fear of God Essentials, which is 10x apart and earns its own
  // canonical.
  vaultbyvans: "Vans",
  chucktaylor: "Converse",
  chuck70: "Converse",
  asics: "ASICS",
  fila: "Fila",
  champion: "Champion",
  lululemon: "Lululemon",
  gymshark: "Gymshark",
  // US-1733 athleisure group. Under Armour + Gymshark were already above; these
  // four were passthrough-only, so the pack rendered the seller's casing
  // ("beyond yoga") into the prompt block and the eBay Brand aspect.
  vuori: "Vuori",
  fabletics: "Fabletics",
  beyondyoga: "Beyond Yoga",
  sweatybetty: "Sweaty Betty",
  // US-1985 activewear group (tier 2). Champion, Fila, PUMA, Reebok and ASICS
  // are already above — they canonicalized from the 00389 stub rows and 00465
  // promotes those stubs to full packs, so the only NEW work here is aliases the
  // stubs never had plus the four brands that were passthrough-only.
  championusa: "Champion",
  championproducts: "Champion",
  // "Reverse Weave" is Champion's own trademarked construction and no other
  // brand uses the term — safe as an exact-key alias and genuinely typed by
  // sellers, who often list the construction as the brand.
  reverseweave: "Champion",
  championreverseweave: "Champion",
  filaitalia: "Fila",
  filasport: "Fila",
  filavintage: "Fila",
  pumasports: "PUMA",
  reeboks: "Reebok",
  reebokclassic: "Reebok",
  reebokclassics: "Reebok",
  // ASICS Tiger (no Onitsuka) IS the ASICS sportstyle sub-line and folds here.
  // ONITSUKA TIGER DELIBERATELY DOES NOT: ASICS owns it, but it is a separate
  // CURRENT label with its own tag, its own buyer and its own comps — folding it
  // would retitle a fashion sneaker as ASICS and comp it against a Gel-Kayano.
  // The AGOLDE/Miu Miu rule: a parent company never decides a fold. Left as a
  // passthrough, which preserves the seller's own text (the correct outcome).
  asicstiger: "ASICS",
  // CANONICAL IS "On Running", NOT "On" — the AG Jeans / Hudson Jeans play, and
  // the most extreme case of it in the epic: a bare "On" as a canonical would be
  // regex-scanned by detectBrandInText over EVERY listing in the catalogue, and
  // "on" is among the most common words in English. The short form survives as an
  // exact-key alias only, which is safe because keys are a whole-field lookup.
  //
  // The long form is NOT sufficient on its own either — "great grip on running
  // trails" contains it verbatim — so On Running is ALSO in
  // DETECT_EXCLUDED_FROM_TEXT below. It is the only brand needing BOTH defences.
  on: "On Running",
  onrunning: "On Running",
  oncloud: "On Running",
  oncloudshoes: "On Running",
  onag: "On Running",
  onholding: "On Running",
  cloudtec: "On Running",
  onshoes: "On Running",
  // HOKA ONE ONE renamed to HOKA in 2021. Both spellings are the SAME brand and
  // must reach the same row — never two canonicals. (Maori-derived, pronounced
  // OH-nay OH-nay; it is not the number one twice.) A bare "one one" is
  // deliberately NOT a key: ordinary words, and no seller types it alone.
  hoka: "HOKA",
  hokaoneone: "HOKA",
  hokaone: "HOKA",
  hokas: "HOKA",
  outdoorvoices: "Outdoor Voices",
  // "ov" is safe as a KEY (an exact whole-field lookup, so it only fires when the
  // seller's ENTIRE brand field is "OV") and would be catastrophic as a canonical
  // or a brandMatch token — the "ag"-hands-Patagonia-AG's-charts bug (US-1735).
  ov: "Outdoor Voices",
  girlfriendcollective: "Girlfriend Collective",
  // Same rule as "ov": an ordinary word, safe ONLY as an exact-match key.
  girlfriend: "Girlfriend Collective",
  // Mall / mainstream
  tommyhilfiger: "Tommy Hilfiger",
  ralphlauren: "Ralph Lauren",
  poloralphlauren: "Polo Ralph Lauren",
  calvinklein: "Calvin Klein",
  guess: "GUESS",
  abercrombiefitch: "Abercrombie & Fitch",
  abercrombie: "Abercrombie & Fitch",
  // HOLLISTER DOES NOT FOLD INTO ABERCROMBIE — deliberately, and it is the
  // counter-example to the folds added below (US-1739). A&F Co OWNS Hollister,
  // but Hollister is not a house LABEL: it is separately branded, separately
  // searched, and sits at a LOWER price band, so it keeps its own canonical.
  // The parent COMPANY is never what decides a fold — the price band and the
  // eBay catalogue are.
  hollister: "Hollister",
  americaneagle: "American Eagle",
  aeropostale: "Aeropostale",
  gap: "Gap",
  oldnavy: "Old Navy",
  bananarepublic: "Banana Republic",
  jcrew: "J.Crew",
  uniqlo: "Uniqlo",
  // US-1739 basics/mall group. Every brand in the pack ALREADY canonicalized (they
  // are all above); what was missing is the SUB-LABELS and OUTLET LINES, which
  // were passthrough-only — so an "aerie" tag rendered "aerie" into the prompt
  // block and the eBay Brand aspect instead of "American Eagle".
  //
  // These all FOLD onto the parent, the Michael Kors / Aritzia play: each shares
  // its parent's price band, so folding costs no comp accuracy, and the line is
  // preserved in `style` rather than dropped. Contrast Hollister above (lower
  // band, own canonical) and Fear of God Essentials (10x apart, own canonical).
  thegap: "Gap",
  gapinc: "Gap",
  // babyGap / GapKids / GapFit / GapBody are DEPARTMENTS, not price tiers.
  babygap: "Gap",
  gapkids: "Gap",
  gapfit: "Gap",
  gapbody: "Gap",
  // The OUTLET lines fold for a reason the sub-labels don't need: eBay has no
  // separate catalogue brand for "Gap Factory", so a split would invent one and
  // mis-map the Brand aspect on every listing. The line is a lower-spec product at
  // a lower band, so it is DISCLOSED via brand_styles + a tell, never dropped.
  gapfactory: "Gap",
  bananarepublicfactory: "Banana Republic",
  bananarepublicfactorystore: "Banana Republic",
  // ⚠ "aerie" USED TO FOLD HERE onto American Eagle (US-1739). US-1991 PROMOTED
  // Aerie to its own canonical for the intimates category (eBay has a first-class
  // Aerie brand; it comps on its own ladder), so the `aerie` key now lives in the
  // US-1991 block below. American Eagle's OWN store forms still fold here.
  americaneagleoutfitters: "American Eagle",
  aeo: "American Eagle",
  abercrombieandfitch: "Abercrombie & Fitch",
  anf: "Abercrombie & Fitch",
  abercrombiekids: "Abercrombie & Fitch",
  // Tommy Jeans IS a Tommy Hilfiger line and folds. A bare "tommy" is DELIBERATELY
  // NOT aliased: TOMMY BAHAMA (Oxford Industries) is a different company sharing
  // the first name — 00457's Vince / Vince Camuto shape. The structural difference
  // is that neither FULL name contains the other ("Tommy Hilfiger" does not
  // contain "Tommy Bahama"), so unlike Vince Camuto no protective canonical entry
  // is needed: full-name matching already separates them. The danger is only in
  // the bare first name, so the bare first name is simply never mapped.
  tommyjeans: "Tommy Hilfiger",
  tommyhilfigerdenim: "Tommy Hilfiger",
  hilfiger: "Tommy Hilfiger",
  // Uniqlo U is a LINE (Lemaire), not a season -> folds with the line in `style`.
  uniqlou: "Uniqlo",
  uniqlojapan: "Uniqlo",
  hanes: "Hanes",
  gildan: "Gildan",
  nautica: "Nautica",
  // US-1986 fast-fashion & mall group (tier 2). ALL TEN were passthrough-only, so
  // a "brandy melville" tag rendered the seller's own casing into the prompt block
  // and the eBay Brand aspect on some of the highest-VOLUME garments in resale.
  // Complements 00458 (basics/mall), which is not re-touched.
  //
  // THIS GROUP IS MOSTLY RETAILERS, NOT MAKERS, and that is its defining problem —
  // see the two "Third-Party Brand at ..." rows in migration 00466. The alias work
  // here is therefore dominated by HOUSE LABELS: the tag says BDG or Bullhead, and
  // never says the store's name, so without these keys the house label is what
  // reaches the eBay Brand aspect.
  zara: "Zara",
  // Zara Basic / Woman / TRF / Man / Kids are LINES (and Basic is a dating tell —
  // see 00466's tag_eras), not price tiers: one eBay catalogue brand, so they FOLD
  // and the line rides in `style`. The Gap/babyGap play.
  zarabasic: "Zara",
  zarawoman: "Zara",
  zaratrf: "Zara",
  // TRF = TRAFALUC, Zara's youth line. Sellers type both the initials and the
  // full word, and neither means anything on its own without this.
  trf: "Zara",
  trafaluc: "Zara",
  zaratrafaluc: "Zara",
  zaraman: "Zara",
  zarakids: "Zara",
  // ⚠ ZARA HOME IS **NOT** ALIASED. It looks exactly like the lines above and is
  // not one: it is a SEPARATE retail chain with its own stores selling homewares,
  // not a Zara clothing line. Folding it would attribute a bath towel to a
  // garment brand. The pattern-match ("it starts with Zara") is precisely the
  // reasoning that has to be resisted — see also Modern Amusement under PacSun.
  //
  // ⚠ NOR IS "INDITEX", and it is the tempting one: Inditex is Zara's PARENT, and
  // it also owns Bershka, Pull&Bear, Massimo Dutti, Stradivarius and Oysho. So an
  // Inditex mark identifies the GROUP, not the brand — mapping it to Zara would
  // retitle a Bershka garment. Exactly the URBN rule (RN 66170 names URBN, not
  // Urban Outfitters) and the H&M Group rule below: the parent never decides.
  // brandKey("H&M") STRIPS the ampersand -> "hm", so THAT is the key (and the
  // brand_key 00466 seeds the row under). A seller typing "H and M" keys as
  // "handm" — a different string, so it needs its own line. The Rag & Bone rule.
  hm: "H&M",
  handm: "H&M",
  hennesmauritz: "H&M",
  hennesandmauritz: "H&M",
  // H&M's OWN in-store labels fold onto it. "Divided" and "L.O.G.G." are the two a
  // seller actually finds on a tag with no "H&M" beside it. NOTE "divided" is an
  // ordinary English word: safe here because BRAND_ALIASES is an exact WHOLE-FIELD
  // lookup, and it never enters CANONICAL_BRANDS (that is built from the VALUES),
  // so detectBrandInText can never mint H&M from the word. The `aerie` precedent.
  divided: "H&M",
  hmdivided: "H&M",
  logg: "H&M",
  hmlogg: "H&M",
  hmstudio: "H&M",
  hmman: "H&M",
  // ⚠ COS, Monki, Arket, & Other Stories and Weekday are H&M GROUP brands and
  // DELIBERATELY DO NOT FOLD ONTO H&M. This is the Hollister rule (00458) and the
  // AGOLDE/Miu Miu rule: the parent COMPANY never decides a fold. They are
  // separately branded, separately searched, and COS in particular sells ABOVE
  // H&M — folding it would price a COS coat off an H&M ladder. Left as
  // passthroughs, which preserves the seller's own text (the correct outcome)
  // until they earn their own packs.
  urbanoutfitters: "Urban Outfitters",
  urbanoutfitterinc: "Urban Outfitters",
  // "uo" and "urban" are safe ONLY as exact whole-field keys — the "ag"/"ch"/"ov"
  // precedent. Neither could ever be a canonical or a brandMatch token.
  uo: "Urban Outfitters",
  urban: "Urban Outfitters",
  // The UO HOUSE LABELS. Their tags carry the house name and NOT "Urban
  // Outfitters", so a seller reading the tag types "BDG" and gets nothing. Same
  // band as the parent -> they fold, and the label rides in `style` (the
  // Maeve/Wilfred play from 00457).
  bdg: "Urban Outfitters",
  outfromunder: "Urban Outfitters",
  silencenoise: "Urban Outfitters",
  silenceandnoise: "Urban Outfitters",
  ecote: "Urban Outfitters",
  kimchiblue: "Urban Outfitters",
  urbanrenewal: "Urban Outfitters",
  ietsfrans: "Urban Outfitters",
  lightbeforedark: "Urban Outfitters",
  // ⚠ ANTHROPOLOGIE AND FREE PEOPLE ARE **NOT** ALIASED HERE despite sharing the
  // URBN parent — they are sibling brands with their OWN packs (00457 and 00449)
  // and their own target customers (URBN's 10-K: UO 18-28, Free People 25-30,
  // Anthropologie 28-45). Folding them would be the worst kind of merge: it would
  // silently retitle an Anthropologie dress as Urban Outfitters. URBN is the
  // parent; Urban Outfitters is a SIBLING, not the parent (a common web error).
  // This is also why 00466 seeds NO OB###### decoder — see that migration.
  express: "Express",
  expressinc: "Express",
  expressmen: "Express",
  expresswomen: "Express",
  limitedexpress: "Express",
  // DELIBERATELY ABSENT: "structure". Structure was genuinely Express's menswear
  // label (1989-2001, reabsorbed as "Express Men"), BUT Express SOLD the name to
  // Sears in 2003 — so a "Structure" tag is Express only in one era and Sears'
  // after it, and the word itself is ordinary. An alias cannot express "only when
  // pre-2003", so the fact is carried as a tag_era on the Express row in 00466
  // instead: reachable as KNOWLEDGE, never used to mint a brand. The "bean"/"docs"
  // rule, applied to a date rather than to a word.
  loft: "LOFT",
  anntaylorloft: "LOFT",
  loftoutlet: "LOFT",
  anntaylor: "Ann Taylor",
  anntaylorfactory: "Ann Taylor",
  // ⚠ LOFT DOES NOT FOLD INTO ANN TAYLOR even though they are sister brands under
  // one owner and LOFT was literally TAGGED "Ann Taylor LOFT" until the ~2010
  // rebrand. This is Hollister again: LOFT sits at a LOWER price band and is
  // separately searched on eBay, so it keeps its own canonical. Note the direction
  // of `anntaylorloft` above — an "Ann Taylor LOFT" tag is a LOFT garment, so it
  // resolves to LOFT, not to the parent whose name it carries. The era is a
  // tag_era in 00466, the Burberrys-with-an-S play.
  // DELIBERATELY ABSENT: a bare "ann" (an ordinary given name) and a bare "taylor"
  // (an ordinary surname — and Taylor is other brands' name outright).
  talbots: "Talbots",
  thetalbots: "Talbots",
  // CANONICAL IS "Lucky Brand", NOT "Lucky" — the AG Jeans / Hudson Jeans / On
  // Running play. "Lucky" is an ordinary adjective and a canonical is regex-scanned
  // over free text by detectBrandInText, so the short form survives as an exact-key
  // alias only. The long form is NOT ordinary prose, so unlike "On Running" it
  // needs no second defence in DETECT_EXCLUDED_FROM_TEXT.
  lucky: "Lucky Brand",
  luckybrand: "Lucky Brand",
  luckybrandjeans: "Lucky Brand",
  luckyjeans: "Lucky Brand",
  luckybranddungarees: "Lucky Brand",
  brandymelville: "Brandy Melville",
  brandymelvilleusa: "Brandy Melville",
  // A bare "brandy" is safe ONLY as an exact whole-field key (it is a given name
  // and a drink) — the "spider"/"girlfriend" precedent. It never reaches
  // detectBrandInText, which scans the VALUES.
  brandy: "Brandy Melville",
  pacsun: "PacSun",
  pacificsunwear: "PacSun",
  pacificsunwearofcalifornia: "PacSun",
  // The PacSun HOUSE labels (named as proprietary brands in PacSun's own 10-K:
  // Bullhead, Kirra, LA Hearts, On the Byas, Black Poppy, Nollie). Their tags never
  // say "PacSun", so each is the only string a seller can read off the garment.
  // "Bullhead Denim Co." is also a DATING tell (renamed PacSun Denim ~2016) and is
  // carried as a tag_era in 00466.
  bullhead: "PacSun",
  bullheaddenim: "PacSun",
  bullheaddenimco: "PacSun",
  bullheadblack: "PacSun",
  pacsundenim: "PacSun",
  kirra: "PacSun",
  lahearts: "PacSun",
  onthebyas: "PacSun",
  blackpoppy: "PacSun",
  nollie: "PacSun",
  // ⚠ MODERN AMUSEMENT AND KENDALL + KYLIE ARE **NOT** ALIASED. Both look like
  // PacSun house labels and neither is: PacSun LICENSED Modern Amusement from a
  // third party (Dirty Bird Productions) from fiscal 2010, and Kendall + Kylie was
  // a PacSun-EXCLUSIVE collab that later sold well beyond PacSun. Folding either
  // would attribute another company's garment to PacSun. The exclusivity of a line
  // is not the same fact as the ownership of a mark.
  // Streetwear / heritage
  supreme: "Supreme",
  stussy: "Stüssy",
  harleydavidson: "Harley-Davidson",
  // US-1737 streetwear & hype group. Supreme + Stüssy were already above; the
  // rest were passthrough-only, so the pack rendered the seller's own casing
  // ("bape", "fear of god") into the prompt block and the eBay Brand aspect.
  supremenewyork: "Supreme",
  supremenyc: "Supreme",
  bape: "BAPE",
  abathingape: "BAPE",
  bathingape: "BAPE",
  kith: "Kith",
  kithnyc: "Kith",
  kithnewyork: "Kith",
  palace: "Palace",
  palaceskateboards: "Palace",
  fearofgod: "Fear of God",
  // ESSENTIALS IS ITS OWN CANONICAL, not a Fear of God alias — deliberately.
  // Mainline and Essentials are one designer's two lines an ORDER OF MAGNITUDE
  // apart in price, so folding them (the Michael Kors play, where every tier is
  // the one eBay brand) would comp a $90 hoodie against a $900 one. This follows
  // the AGOLDE precedent instead: a sibling label earns its own canonical.
  // detectBrandInText is safe here because CANONICAL_BRANDS is sorted
  // longest-first, so "Fear of God Essentials" is tested before "Fear of God".
  fearofgodessentials: "Fear of God Essentials",
  essentialsfearofgod: "Fear of God Essentials",
  essentialsbyfearofgod: "Fear of God Essentials",
  fogessentials: "Fear of God Essentials",
  // DELIBERATELY ABSENT, on the same rule that keeps a bare "bean" off L.L.Bean
  // and a bare "tory" off Tory Burch — an ordinary word must not mint a brand:
  //   * "essentials" — adidas, Nike and H&M all ship an "Essentials" line.
  //   * "fog"        — an ordinary English word.
  //   * "ape"        — likewise, and AAPE ("AAPE BY *A BATHING APE*") is BAPE's
  //     own diffusion SIBLING at a fraction of the price, so it must stay a
  //     passthrough rather than fold into BAPE (the Miu Miu / AGOLDE rule).
  // Guarded by tests in streetwear-content_test.ts.
  // Luxury / accessories
  michaelkors: "Michael Kors",
  coach: "Coach",
  katespade: "Kate Spade",
  gucci: "Gucci",
  versace: "Versace",
  burberry: "Burberry",
  // US-1736 (luxury & designer group). Without these, canonicalizeBrand passed
  // the seller's own casing straight through into the prompt block and the eBay
  // Brand aspect.
  chanel: "Chanel",
  cocochanel: "Chanel",
  chanelparis: "Chanel",
  prada: "Prada",
  pradamilano: "Prada",
  toryburch: "Tory Burch",
  // "Burberrys" (with the S) is the pre-1999 label — it IS a Burberry tag, so it
  // canonicalizes to Burberry. The spelling is a dating tell, carried as a
  // tag_era in migration 00455, not a separate brand.
  burberrys: "Burberry",
  burberryslondon: "Burberry",
  burberrysoflondon: "Burberry",
  burberrylondon: "Burberry",
  // The MK line hierarchy (Collection >> KORS >> MICHAEL) is a STYLE, not a
  // brand — all three labels are the eBay brand "Michael Kors". Keeping the line
  // out of `brand` is what lets brand_styles rank it (00455).
  mk: "Michael Kors",
  kors: "Michael Kors",
  michaelmichaelkors: "Michael Kors",
  korsmichaelkors: "Michael Kors",
  michaelkorscollection: "Michael Kors",
  katespadenewyork: "Kate Spade",
  ksny: "Kate Spade",
  // US-1982 luxury RTW & leather group (tier 2). Seven of the eight were
  // passthrough-only and Versace had only the bare alias above, so a "balenciaga"
  // tag rendered the seller's own casing into the prompt block and the eBay Brand
  // aspect on the most expensive garments the KB touches.
  //
  // ⚠ brandKey() STRIPS ACCENTS (it keeps [a-z0-9] only), so "Hermès" keys as
  // "herms" and "Céline" as "cline" — BOTH the accented and unaccented spellings
  // need a key or a seller who types the accent gets nothing. The canonical
  // "Hermès" keeps its accent (the eBay-indexed mark, and the Stüssy precedent),
  // which is why migration 00461 seeds it under brand_key 'herms'.
  hermes: "Hermès",
  herms: "Hermès", // brandKey("Hermès") — the accented spelling lands here
  hermesparis: "Hermès",
  hermsparis: "Hermès",
  hermessellier: "Hermès",
  dior: "Dior",
  christiandior: "Dior",
  diorhomme: "Dior",
  diormen: "Dior",
  babydior: "Dior",
  // The 2012 rename is a DATE, not a different house: Hedi Slimane dropped YVES
  // from the RTW label, but the YSL monogram survived on hardware. All the
  // spellings are the same brand and fold onto one canonical; the era lives in
  // tag_eras (00461), the same way "Burberrys" with the S does.
  saintlaurent: "Saint Laurent",
  saintlaurentparis: "Saint Laurent",
  yvessaintlaurent: "Saint Laurent",
  ysl: "Saint Laurent",
  yslrivegauche: "Saint Laurent",
  balenciaga: "Balenciaga",
  cristobalbalenciaga: "Balenciaga",
  balenciagaparis: "Balenciaga",
  bottegaveneta: "Bottega Veneta",
  bottega: "Bottega Veneta",
  fendi: "Fendi",
  fendiroma: "Fendi",
  // CELINE, not Céline — the house itself DROPPED the accent in Hedi Slimane's
  // 2018 rebrand, so the current mark is unaccented (and keys cleanly as
  // "celine"). The accented spelling is a genuine Phoebe-Philo-era DATING tell,
  // carried as a tag_era in 00461 rather than as a second brand — the Burberrys
  // play again. brandKey("Céline") = "cline", hence that key.
  celine: "Celine",
  cline: "Celine",
  celineparis: "Celine",
  // Gianni Versace is the founder's own pre-1997 label — it IS a Versace tag, so
  // it canonicalizes to Versace. The era is a price ladder and lives in tag_eras.
  gianniversace: "Versace",
  versaceatelier: "Versace",
  atelierversace: "Versace",
  // ⚠ THE DIFFUSION LABELS GET THEIR OWN CANONICALS AND DO **NOT** FOLD ONTO
  // VERSACE. This is the AGOLDE/Miu Miu rule, not the Fire+Ice/Michael Kors one:
  // Versace Jeans Couture, Versus Versace and Versace Collection sell an ORDER OF
  // MAGNITUDE below mainline Versace, and they are the most common Versace-marked
  // items in resale by a wide margin. Folding them would silently retitle a $150
  // VJC tee as "Versace" — a misrepresentation and a comp catastrophe, since the
  // eBay Brand aspect would then price it against mainline.
  //
  // Safe despite containing the parent's name: CANONICAL_BRANDS is sorted
  // LONGEST-FIRST, so detectBrandInText tests "Versace Jeans Couture" before
  // "Versace" and never mis-attributes the sub-label (the Vince Camuto precedent).
  // A bare "versus" is deliberately NOT a key — it is an ordinary English word,
  // and the alias map is what a seller's whole brand field is looked up in. Same
  // rule as the bare "goose" (00460) and "bean" (00453).
  versacejeanscouture: "Versace Jeans Couture",
  vjc: "Versace Jeans Couture",
  versacejeans: "Versace Jeans Couture",
  versusversace: "Versus Versace",
  versacecollection: "Versace Collection",
  // US-1738 contemporary women's group. All seven were passthrough-only, so the
  // pack rendered the seller's own casing ("aritzia", "eileen fisher") into the
  // prompt block and the eBay Brand aspect.
  //
  // THE HOUSE LABELS FOLD ONTO THE PARENT. Anthropologie and Aritzia are
  // RETAILERS whose garments are labeled with in-house brand names and never say
  // the parent's name — the tag reads MAEVE or WILFRED. Unlike Fear of God vs
  // Essentials (an ORDER OF MAGNITUDE apart, so they earned two canonicals),
  // these sub-labels share a price band with each other, so folding them costs no
  // comp accuracy — this is the Michael Kors play, and the line lives in `style`.
  // It also KEEPS THE SHORT TOKENS OUT of CANONICAL_BRANDS: "tna" would be an
  // AG-grade hazard as a canonical; as an alias resolving to "Aritzia" it never
  // reaches detectBrandInText at all.
  anthropologie: "Anthropologie",
  anthro: "Anthropologie",
  maeve: "Anthropologie",
  pilcro: "Anthropologie",
  dailypractice: "Anthropologie",
  heihei: "Anthropologie",
  aritzia: "Aritzia",
  wilfred: "Aritzia",
  wilfredfree: "Aritzia",
  babaton: "Aritzia",
  tna: "Aritzia",
  sundaybest: "Aritzia",
  talula: "Aritzia",
  talulababaton: "Aritzia",
  goldenbytna: "Aritzia",
  // Sézane needs BOTH keys: brandKey() strips the accented "é" with every other
  // non-[a-z0-9] char, so brandKey("Sézane") is "szane" while brandKey("Sezane")
  // is "sezane". Seeding only the plain spelling would leave the ACCENTED form a
  // passthrough — the trap Stüssy fell into above, where only `stussy` is mapped
  // and "Stüssy" survives solely because the passthrough happens to be right.
  // Migration 00457 keys the brand_knowledge row 'szane' to match.
  sezane: "Sézane",
  szane: "Sézane",
  maisonsezane: "Sézane",
  sezaneparis: "Sézane",
  reformation: "Reformation",
  thereformation: "Reformation",
  vince: "Vince",
  // VINCE CAMUTO EARNS ITS OWN CANONICAL and this entry is PROTECTIVE, not
  // cosmetic. Vince Camuto (Camuto Group) is a DIFFERENT COMPANY from Vince
  // (Vince Holding Corp) — not a diffusion line, just a shared first name — so it
  // must never fold into Vince. It is listed rather than left a passthrough
  // because CANONICAL_BRANDS is sorted longest-first: with "Vince Camuto" in the
  // set, detectBrandInText tests it BEFORE the "Vince" it contains, so a "Vince
  // Camuto Dress" title stops resolving to Vince. That is the mechanism that
  // makes the Fear of God / Essentials pair safe, used here deliberately — and it
  // is the fix the pre-existing "Gucci GG Supreme" hazard has no equivalent of.
  // (The in-code SIZING chart collision is separate and is solved differently:
  // Vince is deliberately absent from SIZING_CHARTS. See sizing-charts.ts.)
  vincecamuto: "Vince Camuto",
  theory: "Theory",
  theorynyc: "Theory",
  // Theyskens' Theory IS a Theory line (Olivier Theyskens, ~2011-2014, retired),
  // so it folds — the exact opposite call from Vince Camuto above, on an
  // identical-looking containing-name shape. The corporate fact decides, not the
  // string. Theory Luxe is the Japan line: also genuinely Theory, but its SIZING
  // is the Japanese grade (flagged in 00457's brand_styles + chart note).
  theyskenstheory: "Theory",
  theoryluxe: "Theory",
  eileenfisher: "Eileen Fisher",
  eileenfisherrenew: "Eileen Fisher",
  // DELIBERATELY ABSENT, on the rule that keeps a bare "bean" off L.L.Bean, a
  // bare "tory" off Tory Burch and a bare "essentials" off Fear of God — this
  // group has the worst ordinary-word density in the epic because the words ARE
  // the brand names:
  //   * "moth"  — Anthropologie's knit label, but "moth" is a garment-DAMAGE term
  //     ("moth holes", "moth damage") that appears constantly in the condition
  //     text this product itself generates. An alias would mint Anthropologie off
  //     a description of the damage. It is reachable only as a brand_style.
  //   * "ref"   — an ordinary abbreviation; must not mint Reformation.
  //   * "fisher" / "eileen" — ordinary surname and given name.
  //   * "vince" IS mapped (the brand is exactly that string), but see the Vince
  //     Camuto note above for why the containing name had to be listed too.
  // Guarded by tests in contemporary-womens-content_test.ts.

  // US-1983 new-generation streetwear & hype group. 00456 took the established
  // canon (Supreme/Stüssy/BAPE/Palace/Kith/Fear of God); these nine are the
  // generation after it and ALL NINE were passthrough-only, so a "sp5der" tag
  // rendered the seller's own casing into the prompt block and the eBay Brand
  // aspect on some of the fastest-moving garments in resale.
  offwhite: "Off-White",
  offwhitecovirgilabloh: "Off-White",
  owca: "Off-White",
  chromehearts: "Chrome Hearts",
  chromeheartshollywood: "Chrome Hearts",
  // "ch" is a two-letter alias, safe ONLY because this map is an exact
  // WHOLE-FIELD lookup (the "ag"/AG Jeans precedent). It never reaches
  // detectBrandInText, which scans the VALUES.
  ch: "Chrome Hearts",
  // TWO KEYS, AND IT IS NOT A DUPLICATE. brandKey() keeps [a-z0-9] only, so it
  // DELETES the accented character rather than folding it to its ASCII base:
  //   "Aimé Leon Dore" -> `aimleondore`   (no "e" — the é is GONE)
  //   "Aime Leon Dore" -> `aimeleondore`  (an ordinary "e" survives)
  // Both spellings are typed by sellers constantly, so both must resolve or the
  // one who bothers with the accent gets a passthrough. `aimleondore` is also the
  // brand_key 00462 seeds the row under (the Hermès/'herms' precedent, 00461) —
  // it looks like a typo and is not.
  aimleondore: "Aimé Leon Dore",
  aimeleondore: "Aimé Leon Dore",
  ald: "Aimé Leon Dore",
  aimeleondorenewyork: "Aimé Leon Dore",
  gallerydept: "Gallery Dept.",
  gallerydepartment: "Gallery Dept.",
  denimtears: "Denim Tears",
  rhude: "Rhude",
  sp5der: "Sp5der",
  sp5derworldwide: "Sp5der",
  spiderworldwide: "Sp5der",
  // A bare "spider" IS mapped, and it is safe for the same reason "ch" is: an
  // exact whole-field tag lookup. It is NOT in CANONICAL_BRANDS (the value is
  // "Sp5der"), so detectBrandInText can never mint this brand from the ordinary
  // word "spider" in free text — which matters, because a spider is also a
  // common graphic SUBJECT this product's own description text emits.
  spider: "Sp5der",
  hellstar: "Hellstar",
  hellstarstudios: "Hellstar",
  antisocialsocialclub: "Anti Social Social Club",
  assc: "Anti Social Social Club",
  antisocialclub: "Anti Social Social Club",
  // DELIBERATELY ABSENT: a bare "gallery", "tears", "hell" or "star" — all
  // ordinary words. Same rule as "bean"/"moth"/"goose".

  // US-1987 preppy & contemporary men's group (migration 00467). All nine were
  // passthrough-only. This group's signature fact is that THE FIT NAME is the
  // garment-defining attribute and it is TAG-ONLY — none of that lives here, but
  // two things about the ALIAS side are worth spelling out:
  //
  //   1. A BARE "brooks" IS DELIBERATELY NOT MAPPED. Brooks Running (Ghost,
  //      Adrenaline — a Berkshire Hathaway company) is a DIFFERENT COMPANY and is
  //      not in this KB, so `brooks: "Brooks Brothers"` would silently retitle
  //      every Brooks Running shoe whose brand field is literally "Brooks". The
  //      two companies actually litigated the name (Brooks Sports sued Brooks
  //      Brothers in 2020 over their 1980 coexistence agreement), which is about
  //      as clear as a signal gets. This is the AG Jeans / Hudson Jeans / Lucky
  //      Brand play: the canonical stays the LONG form and the short token is not
  //      an alias at all — not even an exact-key one, because a bare "Brooks" in a
  //      brand field is genuinely ambiguous rather than merely ordinary.
  //   2. A BARE "buck" IS NOT MAPPED EITHER — Buck Knives collides hard enough
  //      that it swamps every search for the apparel brand.
  vineyardvines: "Vineyard Vines",
  vineyardvine: "Vineyard Vines",
  // A very common misspelling — the brand is "vineyard", not "vinyard".
  vinyardvines: "Vineyard Vines",
  // The 2019 Target collaboration is a DISTINCT (and much cheaper) quality tier,
  // but its tag still says vineyard vines — so it folds, with the tier disclosed
  // in the pack rather than split into a canonical (the Gap Factory play, 00458).
  vineyardvinesfortarget: "Vineyard Vines",
  shepshirt: "Vineyard Vines",
  brooksbrothers: "Brooks Brothers",
  brooksbros: "Brooks Brothers",
  // The singular appears inside BB's own trademark text, so sellers type it.
  brooksbrother: "Brooks Brothers",
  brookbrothers: "Brooks Brothers",
  // BB's SUB-LABELS, which are the only string on some tags. All fold onto Brooks
  // Brothers: they are tiers of one brand, not separate marks with their own eBay
  // nodes. ⚠ "Golden Fleece" / "Black Fleece" / "Red Fleece" LOOK like colourways
  // and are not — Red Fleece does not mean the garment is red. They are safe as
  // alias KEYS (an exact whole-field lookup) though "goldenfleece" would be unsafe
  // as a canonical VALUE. NOT MAPPED: "346" and "1818" — bare digit runs.
  goldenfleece: "Brooks Brothers",
  blackfleece: "Brooks Brothers",
  redfleece: "Brooks Brothers",
  brooksgate: "Brooks Brothers",
  brooksease: "Brooks Brothers",
  southwick: "Brooks Brothers",
  bonobos: "Bonobos",
  bonobo: "Bonobos",
  bonobosguideshop: "Bonobos",
  // Bonobos' golf line, ~2014 — a real tag string that never says "Bonobos".
  maide: "Bonobos",
  maidebybonobos: "Bonobos",
  // ⚠ "ayr" IS DELIBERATELY ABSENT. AYR launched UNDER Bonobos in 2014 and later
  // became an INDEPENDENT brand, so folding it would mis-brand every later AYR
  // garment — the Modern Amusement rule (00466): a line's origin is not ownership
  // forever, and exclusivity of a line is not ownership of a mark.
  faherty: "Faherty",
  fahertybrand: "Faherty",
  sunsessions: "Faherty",
  cloudcashmere: "Faherty",
  petermillar: "Peter Millar",
  // "Peter Miller" is the misspelling this brand actually attracts.
  petermiller: "Peter Millar",
  petermillarcollection: "Peter Millar",
  // PM's tier labels. Crown Crafted prints its OWN dark navy label, so the tier
  // name can be the only string a seller can read (the BDG play, 00466). NOT
  // MAPPED: a bare "crown" (ordinary word) or "gfore" — G/FORE is a DIFFERENT
  // BRAND (a Peter Millar subsidiary 2018-2025, then moved OUT to become its own
  // Richemont Maison in Feb 2025) and must never fold onto Peter Millar.
  crowncrafted: "Peter Millar",
  crownsport: "Peter Millar",
  toddsnyder: "Todd Snyder",
  toddsnydernewyork: "Todd Snyder",
  // The collab attribution rule, implemented as an alias: a "Todd Snyder +
  // Champion" tag names BOTH brands, and it resolves to TODD SNYDER — TS owns the
  // design, sells it through its own channels and prices it at ~3x a standard
  // Reverse Weave, so Champion is the manufacturing input and TS is the commercial
  // identity. Resolving it the other way drags a $168 garment onto a mass-market
  // canonical. Both spellings are separate keys because brandKey() keeps the "x".
  toddsnyderchampion: "Todd Snyder",
  toddsnyderxchampion: "Todd Snyder",
  toddsnyderwhitelabel: "Todd Snyder",
  buckmason: "Buck Mason",
  buckmasonknittingmills: "Buck Mason",
  untuckit: "UNTUCKit",
  untuckedit: "UNTUCKit",
  untuckitllc: "UNTUCKit",
  // brandKey() STRIPS THE HYPHEN, so "Johnnie-O", "Johnnie O" and "JohnnieO" ALL
  // collapse to `johnnieo` and one key covers every spelling a seller types —
  // unlike the Rag & Bone / Aimé Leon Dore cases, where the punctuation produced
  // genuinely different keys. The brand's own casing is time-dependent (its older
  // press uses a lowercase "johnnie-O", its current site a capital J) and the
  // lookup is case-insensitive anyway, so the canonical is the current form.
  johnnieo: "Johnnie-O",
  // The phonetic misspelling this brand actually attracts.
  johnnyo: "Johnnie-O",
  johnnieogolf: "Johnnie-O",
  tweenerbutton: "Johnnie-O",
  prepformance: "Johnnie-O",

  // ── US-1988: handbags & accessories (migration 00468) ──────────────────────
  // The KB's first ACCESSORY-FIRST group: every pack before this graded GARMENTS.
  // The refusals here are unusually load-bearing, and there are FOUR of them:
  //   1. A bare "minkoff" is NOT mapped — URI MINKOFF IS A DISTINCT LABEL (his
  //      own collection page, his own Poshmark brand node), so folding the surname
  //      would mis-brand his menswear. The AYR rule from 00467.
  //   2. A bare "rm" is NOT mapped — real collector shorthand for Rebecca Minkoff,
  //      but not brand-unique, and a 2-letter key is the worst possible false
  //      positive. Only accept it alongside a style token.
  //   3. "d&b"/"db" are NOT mapped — a FOUR-way collision: Dun & Bradstreet,
  //      Dolce & Gabbana in some seller usage, Dooney's OWN reversed-D monogram,
  //      and Dooney's own SKU prefix. Unresolvable from the token alone.
  //   4. Skagen / Michele / Relic / Zodiac are NOT mapped onto Fossil. They are
  //      Fossil GROUP-owned (its 10-K lists them as owned brands, and Skagen is
  //      OWNED not licensed — a common error), but a shared corporate parent is
  //      not a shared brand. Folding them is the Todd Snyder / American Eagle
  //      mistake from 00467. Likewise MICHAEL KORS / ARMANI / DIESEL are LICENSED
  //      to Fossil and are emphatically not Fossil — Michael Kors is already its
  //      own canonical here, and ~47% of Fossil Group's output is not Fossil.
  longchamp: "Longchamp",
  // Named for the Paris Longchamp RACECOURSE (singular) — so the trailing-s is
  // the misspelling this brand actually attracts, and it is high-volume.
  longchamps: "Longchamp",
  longchamppars: "Longchamp",
  // Le Pliage is the line a seller can read when nothing else is legible; Roseau
  // is a DISTINCT line and folds to the house, not to Le Pliage.
  lepliage: "Longchamp",
  lepliageoriginal: "Longchamp",
  roseau: "Longchamp",
  // The trademark registrant. NOT MAPPED: a bare "cassegrain" (a surname, and an
  // optical-telescope design).
  jeancassegrain: "Longchamp",
  marcjacobs: "Marc Jacobs",
  markjacobs: "Marc Jacobs",
  marcjacob: "Marc Jacobs",
  themarcjacobs: "Marc Jacobs",
  marcjacobsinternational: "Marc Jacobs",
  littlemarcjacobs: "Marc Jacobs",
  // ⚠ "Marc by Marc Jacobs" is DELIBERATELY **NOT** an alias of Marc Jacobs — it
  // is a SEPARATE node. Different line, different era, and a different price
  // band; folding it would erase the distinction resale actually pays for. And
  // the rule has a live expiry: the mark was RE-FILED at USPTO on 15 June 2026
  // (serial 99885050), so a revived line may ship new goods under it.
  marcbymarcjacobs: "Marc by Marc Jacobs",
  mbmj: "Marc by Marc Jacobs",
  rebeccaminkoff: "Rebecca Minkoff",
  rminkoff: "Rebecca Minkoff",
  rebeccaminkoffhandbags: "Rebecca Minkoff",
  fossil: "Fossil",
  fossilgroup: "Fossil",
  fossilwatches: "Fossil",
  fossilinc: "Fossil",
  verabradley: "Vera Bradley",
  verabradly: "Vera Bradley",
  verabradely: "Vera Bradley",
  verabradleydesigns: "Vera Bradley",
  verabradleysales: "Vera Bradley",
  // ⚠ brandKey() STRIPS THE AMPERSAND but KEEPS the spelled-out word, so
  // "Dooney & Bourke" -> dooneybourke while "Dooney and Bourke" -> dooneyandbourke.
  // These are DIFFERENT KEYS and sellers type both — it looks like a duplicate
  // line and is not (the Rag & Bone case, one pack over).
  dooneybourke: "Dooney & Bourke",
  dooneyandbourke: "Dooney & Bourke",
  // The brand's OWN shorthand ("Register My Dooney", "Dooney HQ", ilovedooney.com),
  // so it is safe as an exact whole-field key in a way a bare "d&b" is not.
  dooney: "Dooney & Bourke",
  dooneyburke: "Dooney & Bourke",
  dooneybourk: "Dooney & Bourke",
  downeybourke: "Dooney & Bourke",
  allweatherleather: "Dooney & Bourke",
  ilovedooney: "Dooney & Bourke",
  brahmin: "Brahmin",
  brahminleatherworks: "Brahmin",
  brahminhandbags: "Brahmin",
  bramin: "Brahmin",
  brhamin: "Brahmin",
  // NOT MAPPED: "brahman" — a cattle breed AND a leather term, so it is a genuine
  // ambiguity rather than a mere misspelling.
  tumi: "Tumi",
  tumiinc: "Tumi",
  tumiholdings: "Tumi",
  alphabravo: "Tumi",
  tumitracer: "Tumi",
  // CANONICAL IS THE FULL "Herschel Supply Co." — the brand's own name and the
  // form the eBay Brand aspect carries. brandKey() drops the period, so every
  // spelling collapses onto `herschelsupplyco`.
  herschelsupplyco: "Herschel Supply Co.",
  herschel: "Herschel Supply Co.",
  // The single-s misspelling this brand actually attracts.
  hershel: "Herschel Supply Co.",
  herschell: "Herschel Supply Co.",
  herschelsupply: "Herschel Supply Co.",
  herschelsupplycompany: "Herschel Supply Co.",
  littleamerica: "Herschel Supply Co.",
  // ── US-1989: heritage & workwear (migration 00469) ──────────────────────────
  // Dickies + Pendleton already carried alias-only rows above (00389); the other
  // six were passthrough-only. For this group the TAG ERA is the price driver, so
  // canonicalizing the brand correctly is what routes a piece to the pack that
  // knows how to date it. Two load-bearing refusals:
  //   1. A bare "duluth" is NOT Duluth Trading — "Duluth" is a Minnesota city AND
  //      DULUTH PACK (est. 1882), an unrelated waxed-canvas pack maker. Folding
  //      the bare token would retitle a Duluth Pack canoe pack as the Fire Hose
  //      work-pant company (the Longchamp-Fabrics trap, 00468). Only the two-word
  //      forms are aliased.
  //   2. "Red Wing" is aliased for a TAG but is excluded from FREE-TEXT detection
  //      (DETECT_EXCLUDED_FROM_TEXT below) — "Detroit Red Wings" and the red-wing
  //      blackbird would otherwise mint the boot house out of prose.
  filson: "Filson",
  ccfilson: "Filson",
  ccfilsonco: "Filson",
  filsonco: "Filson",
  // brandKey() strips the space, so "red wing" -> redwing. The Heritage sub-line
  // and the Irish Setter line both fold to the house here.
  redwing: "Red Wing",
  redwingshoes: "Red Wing",
  redwingheritage: "Red Wing",
  redwingshoecompany: "Red Wing",
  irishsetter: "Red Wing",
  timberland: "Timberland",
  timberlands: "Timberland",
  timbs: "Timberland",
  timberlandpro: "Timberland",
  abingtonshoe: "Timberland",
  // ⚠ CANONICAL IS THE FULL "Duluth Trading Co." — a bare "duluth" is DELIBERATELY
  // NOT a key (Duluth Pack collision, see above).
  duluthtrading: "Duluth Trading Co.",
  duluthtradingco: "Duluth Trading Co.",
  duluthtradingcompany: "Duluth Trading Co.",
  barbour: "Barbour",
  jbarbour: "Barbour",
  jbarboursons: "Barbour",
  barbourinternational: "Barbour",
  barbourbeacon: "Barbour",
  orvis: "Orvis",
  theorvis: "Orvis",
  orviscompany: "Orvis",
  // Promote the two shallow 00389 rows' extra spellings (Dickies/Pendleton are
  // already mapped above; these add the fuller-name variants the packs seed).
  williamsondickie: "Dickies",
  williamsondickies: "Dickies",
  pendletonwoolenmills: "Pendleton",
  sirpendleton: "Pendleton",

  // ── US-1990: footwear tier 2 (migration 00470) ──────────────────────────────
  // ALL TEN were passthrough-only. For footwear the SIZE SYSTEM is the key signal
  // (the charts are US/UK/EU translators), and canonicalizing the brand correctly
  // is what routes a shoe to the pack that knows its sizing. Two collision refusals
  // live below in DETECT_EXCLUDED_FROM_TEXT (Brooks, KEEN):
  //   ⚠ A BARE "brooks" IS DELIBERATELY NOT MAPPED — Brooks Running (this pack, a
  //     Berkshire Hathaway company) and Brooks Brothers (00467) are DIFFERENT
  //     companies that litigated the name, so a bare "Brooks" brand field is
  //     genuinely ambiguous (the 00467 call). Only the unambiguous forms are
  //     aliased; a bare "Brooks" passes through unchanged — which happens to equal
  //     the running brand's eBay canonical, so the pack (brand_key 'brooks') stays
  //     reachable via brandKey() of the passthrough. "Brooks" is ALSO excluded from
  //     FREE-TEXT detection (an ordinary word — "babbling brooks").
  clarks: "Clarks",
  clark: "Clarks",
  clarksoriginals: "Clarks",
  clarksengland: "Clarks",
  cjclark: "Clarks",
  candjclark: "Clarks",
  merrell: "Merrell",
  merrells: "Merrell",
  merrellfootwear: "Merrell",
  // "keen" is an ordinary English adjective, safe here as an exact whole-field KEY
  // (the "aerie"/"divided" precedent); the free-text hazard is handled by
  // DETECT_EXCLUDED_FROM_TEXT below.
  keen: "KEEN",
  keenfootwear: "KEEN",
  keenshoes: "KEEN",
  sorel: "Sorel",
  sorels: "Sorel",
  sorelfootwear: "Sorel",
  // Brooks Running — bare "brooks" NOT mapped (see the header note). Only the
  // unambiguous compound forms resolve.
  brooksrunning: "Brooks",
  brooksshoes: "Brooks",
  brookssports: "Brooks",
  brooksrunninginc: "Brooks",
  saucony: "Saucony",
  sauconys: "Saucony",
  sauconyoriginals: "Saucony",
  stevemadden: "Steve Madden",
  stevemaddens: "Steve Madden",
  // DELIBERATELY ABSENT: a bare "madden" (John Madden / Madden NFL) and "madden
  // girl" (a lower-priced diffusion line kept as its own passthrough for comp
  // accuracy — the AGOLDE/Circus rule).
  samedelman: "Sam Edelman",
  samedelmans: "Sam Edelman",
  // DELIBERATELY ABSENT: a bare "edelman" (Julian Edelman / Richard Edelman) and
  // "circus by sam edelman" (a lower-priced diffusion line, its own passthrough).
  allenedmonds: "Allen Edmonds",
  allenedmond: "Allen Edmonds",
  crocs: "Crocs",
  crocsinc: "Crocs",
  // US-1991 intimates, loungewear & shapewear group. Six were passthrough-only;
  // Calvin Klein is PROMOTED from its shallow 00389 shell (its `calvinklein` key
  // is above, in the mall block); the two sub-brand calls (Aerie, PINK) are the
  // interesting part — see below and DETECT_EXCLUDED_FROM_TEXT.
  skims: "SKIMS",
  skimsbody: "SKIMS",
  skimssolutionwear: "SKIMS",
  spanx: "Spanx",
  spanxinc: "Spanx",
  spanxshapewear: "Spanx",
  // Victoria's Secret — brandKey("Victoria's Secret") STRIPS the apostrophe, so
  // "victoriassecret" is the key. "victoriasecret" catches the common single-s
  // misspelling. A bare "vs" is DELIBERATELY ABSENT — it is an ordinary
  // abbreviation ("versus") and far too generic even for an exact whole-field key.
  victoriassecret: "Victoria's Secret",
  victoriasecret: "Victoria's Secret",
  victoriassecrets: "Victoria's Secret",
  vslingerie: "Victoria's Secret",
  // PINK (Victoria's Secret PINK) — ITS OWN CANONICAL, deliberately NOT folded
  // onto Victoria's Secret: a lower-band, separately-searched collegiate line (the
  // Hollister rule, 00458 — the parent never decides a fold). "pink" is an
  // ordinary COLOUR word, safe here ONLY as an exact whole-field KEY (this map is
  // an exact lookup); the free-text hazard is handled by DETECT_EXCLUDED_FROM_TEXT
  // below (the MOTHER/FRAME/Express play). The compound forms fold onto the same
  // canonical so a "Victoria's Secret PINK" tag lands on the PINK pack, not VS.
  pink: "PINK",
  vspink: "PINK",
  victoriassecretpink: "PINK",
  pinknation: "PINK",
  // AERIE — PROMOTED to its own canonical, REVERSING the US-1739 fold onto
  // American Eagle (which lived here as `aerie: "American Eagle"`). That fold was
  // a mall/basics call ("same band → fold"); it is WRONG for intimates, where
  // eBay has a first-class "Aerie" brand and Aerie bralettes / OFFLINE leggings
  // comp on their own ladder, nothing like American Eagle denim. "aerie" is an
  // ordinary noun (an eagle's nest), safe as an exact KEY; the free-text hazard is
  // handled by DETECT_EXCLUDED_FROM_TEXT below (the KEEN precedent). OFFLINE is
  // Aerie's activewear line and folds onto it.
  aerie: "Aerie",
  aeriereal: "Aerie",
  aerieoffline: "Aerie",
  offlinebyaerie: "Aerie",
  // ⚠ A bare "offline" is DELIBERATELY ABSENT — it is an ordinary word ("offline
  // mode") and would be catastrophic; only the compound Aerie forms resolve.
  savagexfenty: "Savage X Fenty",
  savagex: "Savage X Fenty",
  savagefenty: "Savage X Fenty",
  // Calvin Klein — `calvinklein` is already keyed above (mall block). Its
  // intimates/underwear LINES and the "CK" short forms fold onto the same
  // canonical. "ck" is safe as an exact whole-field KEY (the "ov"/"ag" play — it
  // only fires when the seller's ENTIRE brand field is "ck"); it would be
  // catastrophic as a canonical/brandMatch token, so it is a KEY only.
  ck: "Calvin Klein",
  ckjeans: "Calvin Klein",
  calvinkleinjeans: "Calvin Klein",
  ckunderwear: "Calvin Klein",
  calvinkleinunderwear: "Calvin Klein",
  ckone: "Calvin Klein",
  // Tommy John — a bare "tommy" is already NOT mapped (Tommy Bahama/Tommy
  // Hilfiger, US-1739), so only the full two-word form resolves. "Tommy John
  // surgery" (baseball) is a free-text collision, but it does not appear in the
  // CLOTHING titles detectBrandInText scans, so no exclusion is needed.
  tommyjohn: "Tommy John",
  tommyjohnunderwear: "Tommy John",
  // US-1992 outdoor & technical (tier 2) group. All eight were passthrough-only.
  // The value read is the MODEL NAME + the FABRIC TECHNOLOGY, never a tag-printed
  // brand-unique code (see migration 00472). Two of the eight are ordinary words
  // and live in DETECT_EXCLUDED_FROM_TEXT below (Rab, Kühl).
  //
  // ⚠ brandKey() KEEPS [a-z0-9] ONLY, so it STRIPS the å/ä/ü diacritics: the
  // accented tag "Fjällräven" keys as "fjllrven" and "Kühl" as "khl", while the
  // common unaccented spellings key as "fjallraven" / "kuhl". Both spellings are
  // separate keys so either resolves.
  fjllrven: "Fjällräven", // brandKey("Fjällräven") — accented spelling lands here
  fjallraven: "Fjällräven", // the common unaccented spelling
  knken: "Fjällräven", // brandKey("Kånken") — the flagship pack, searched by name
  kanken: "Fjällräven",
  salomon: "Salomon",
  cotopaxi: "Cotopaxi",
  khl: "Kühl", // brandKey("Kühl") — accented spelling lands here
  kuhl: "Kühl", // the common unaccented spelling
  hellyhansen: "Helly Hansen",
  // "hh" is safe as an exact whole-field KEY (this map is an exact lookup — the
  // "ck"/"ov" play); it fires only when the seller's ENTIRE brand field is "hh".
  hh: "Helly Hansen",
  mammut: "Mammut",
  // "rab" is safe as an exact whole-field KEY (a brand field of literally "rab"
  // means the down house); the FREE-TEXT hazard is handled in
  // DETECT_EXCLUDED_FROM_TEXT below (the KEEN precedent).
  rab: "Rab",
  outdoorresearch: "Outdoor Research",
  // ⚠ A bare "or" is DELIBERATELY ABSENT — it is the English word / the state
  // Oregon, catastrophic even as an exact whole-field key; only the full form
  // resolves.

  // US-1993 kids & baby group. All six were passthrough-only. The identifier is a
  // NAME (a garment type, a print, a vintage collection), never a tag-printed
  // brand-unique code (see migration 00473), and ⚠ a KIDS SIZE (24M / 4T) is the
  // SIZE, not a code. NONE of the six CANONICALS is an ordinary word, so NONE is
  // added to DETECT_EXCLUDED_FROM_TEXT — the hazards are all in the SHORT forms,
  // handled by keeping the bare tokens OUT of this map (the "ck"/"tcp" play).
  //
  // brandKey() KEEPS [a-z0-9] ONLY, so it STRIPS apostrophes and spaces:
  // "Carter's" keys as "carters" and "The Children's Place" as "thechildrensplace"
  // (the leading "the" is kept, exactly like "thenorthface").
  carters: "Carter's", // brandKey("Carter's") strips the apostrophe → "carters"
  // ⚠ a bare "carter" is DELIBERATELY ABSENT — a common surname; only "carters" /
  // "Carter's" resolve. Carter's stays reachable by detectBrandInText because its
  // canonical is the possessive "Carter's" (a bare "carter" never matches it), and
  // "Carter's" dominates the childrenswear title corpus, so it is NOT excluded.
  justoneyou: "Carter's", // Target's Carter's-made sub-label
  justoneyoubycarters: "Carter's",
  childofmine: "Carter's", // Walmart's Carter's-made sub-label
  simplejoys: "Carter's", // Amazon's Carter's-made sub-label
  // ⚠ OshKosh (Carter's-owned) is DELIBERATELY NOT folded — a shared parent is not
  // a signal; OshKosh keeps its own identity / passthrough.
  hannaandersson: "Hanna Andersson", // brandKey strips the space
  hannaanderson: "Hanna Andersson", // the common single-s misspelling
  // ⚠ a bare "hanna" is DELIBERATELY ABSENT — a first name; only the full
  // "Hanna Andersson" resolves.
  miniboden: "Mini Boden",
  minibodenkids: "Mini Boden",
  babyboden: "Mini Boden", // the youngest Mini Boden line
  // ⚠ a bare "boden" is DELIBERATELY ABSENT — it is the ADULT parent brand; folding
  // it onto the kids line would mis-key adult Boden. Only the "Mini Boden" forms
  // resolve (a shared name is not a fold — the Hollister/Aerie rule).
  janieandjack: "Janie and Jack", // brandKey("Janie and Jack") = "janieandjack"
  janiejack: "Janie and Jack", // brandKey("Janie & Jack") strips the "&" → "janiejack"
  thechildrensplace: "The Children's Place", // brandKey keeps "the" (the "thenorthface" play)
  childrensplace: "The Children's Place", // the form without a leading "the"
  // "tcp" is safe as an exact whole-field KEY (this map is an exact lookup — the
  // "ck"/"hh" play); it fires only when the seller's ENTIRE brand field is "tcp".
  tcp: "The Children's Place",
  // ⚠ a bare "place" is DELIBERATELY ABSENT — an ordinary word; only the full forms
  // and the exact "tcp" key resolve.
  gymboree: "Gymboree",
  gymbo: "Gymboree", // a common nickname, safe as an exact whole-field key

  // US-2221 headwear group (migration 00574). All four were absent from the KB
  // entirely — no row, no alias, no chart — which is a weaker start than the
  // "passthrough-only" every group since 00443 began from.
  //
  // ⚠ THE HAZARD HERE IS THE CANONICAL, NOT THE KEYS: "New Era" is an ordinary
  // English phrase, so it goes into DETECT_EXCLUDED_FROM_TEXT below. The keys
  // themselves are safe — brandKey() strips spaces and punctuation, so a brand
  // field of literally "new era" means the cap house.
  newera: "New Era",
  neweracap: "New Era",
  neweracapcompany: "New Era",
  newerahats: "New Era",
  // ⚠ a bare "era" is DELIBERATELY ABSENT — an ordinary English noun, and it is
  // this KB's OWN vocabulary for a tag generation (brand_knowledge.tag_eras),
  // so it appears in seeded prose constantly. Only the compound forms resolve.
  stetson: "Stetson",
  johnbstetson: "Stetson", // the founder's name, as printed in vintage sweatbands
  stetsonhats: "Stetson",
  kangol: "Kangol",
  kangolheadwear: "Kangol",
  goorin: "Goorin Bros.",
  goorinbros: "Goorin Bros.", // brandKey("Goorin Bros.") strips the period
  goorinbrothers: "Goorin Bros.", // the 1921-1949 registered form, still on labels

  // US-2221 eyewear group (migration 00575). Also absent from the KB entirely.
  //
  // NONE of these four is added to DETECT_EXCLUDED_FROM_TEXT, and that was
  // checked rather than assumed. "Oakley" is the only near-miss — it is a
  // surname (Annie Oakley) and a California city — but the false positive is
  // rare in clothing copy while the true positive is one of the most common
  // eyewear strings there is, and nothing in the KB's own seeded prose emits it
  // in the other sense. That is the opposite balance to "New Era" (00574),
  // where the phrase is stock marketing copy AND clusters in the brand's own
  // category. Revisit if western-wear listings start mis-branding.
  rayban: "Ray-Ban", // brandKey("Ray-Ban") strips the hyphen
  raybans: "Ray-Ban", // the plural is how sellers actually type it
  raybansunglasses: "Ray-Ban",
  // ⚠ a bare "ray" is DELIBERATELY ABSENT — a first name and an ordinary noun.
  // ⚠ "RB" is DELIBERATELY ABSENT as an alias: it is the DECODER prefix, and a
  // two-letter key is the worst possible false positive. The decoder recovers
  // the brand from RB3025 inside an already-resolved pack; a bare "RB" in a
  // brand field means nothing.
  oakley: "Oakley",
  oakleysunglasses: "Oakley",
  persol: "Persol",
  warbyparker: "Warby Parker",
  // ⚠ a bare "warby" is DELIBERATELY ABSENT — half a brand name is not a brand,
  // and the full form is what every tag and listing carries.

  // US-2221 jewelry group (migration 00576). Also absent from the KB entirely.
  //
  // THE ORDINARY-WORD CHECK CAME OUT DIFFERENTLY FOR EACH OF THESE, so it is
  // written down rather than waved at:
  //
  //   • "Pandora" IS an ordinary word (Pandora's box) and the canonical is the
  //     bare word, so it is the one that could false-fire. It is NOT excluded:
  //     the phrase is rare in resale copy while the brand is one of the most
  //     common strings in jewelry listings, and nothing in the KB's own seeded
  //     prose emits it in the other sense. The opposite balance to "New Era"
  //     (00574), where the phrase is stock copy AND clusters in the brand's own
  //     category. Revisit if it starts mis-branding.
  //   • "Tiffany" is a GIVEN NAME and "Tiffany blue" is a live colour term — but
  //     the CANONICAL is "Tiffany & Co.", and neither collision contains that
  //     string, so detectBrandInText is safe without an exclusion. The bare
  //     "tiffany" KEY is fine on the usual asymmetry: BRAND_ALIASES is an exact
  //     whole-field lookup, so a brand field of literally "Tiffany" means the
  //     jeweler.
  pandora: "Pandora",
  pandorajewelry: "Pandora",
  pandorajewellery: "Pandora", // the British spelling, which Pandora itself uses
  tiffany: "Tiffany & Co.",
  tiffanyco: "Tiffany & Co.", // brandKey("Tiffany & Co.") strips the & and the .
  tiffanyandco: "Tiffany & Co.", // the spelled-out form is a different key
  davidyurman: "David Yurman",
  yurman: "David Yurman", // a distinctive surname, safe as a whole-field key
  jamesavery: "James Avery",
  jamesaverycraftsman: "James Avery", // the early stamp, still on vintage pieces
  // ⚠ a bare "avery" is DELIBERATELY ABSENT — a given name and a surname; only
  // the full forms resolve. Same call as "carter" and "hanna".
  // ⚠ a bare "james" is absurd and is likewise absent.

  // US-2221 small-leather-goods group (migration 00577), the last of the four.
  //
  // ⚠ "Ridge" IS AN ORDINARY WORD and this one DOES need the exclusion, which is
  // why the canonical is the long form. "ridge" turns up in ordinary garment
  // copy — a ridged knit, a mountain ridge on a graphic tee, Blue Ridge on a
  // souvenir sweatshirt — and it would beat a real "Nike" (4) on length. The
  // canonical is therefore "The Ridge", and even that is excluded from prose
  // detection below, because "the ridge" is a phrase before it is a brand.
  // Reachable BY TAG as always.
  ridge: "The Ridge",
  ridgewallet: "The Ridge",
  theridge: "The Ridge", // brandKey("The Ridge") keeps the leading "the"
  bellroy: "Bellroy",
  secrid: "Secrid",
  bosca: "Bosca",
  hugobosca: "Bosca", // the founder's name, as it appears on older marks

  // US-2220 vintage / band-tee BLANK MAKERS (migration 00579). These are not the
  // brand a seller means — that is the BAND. They are the tag sewn into the
  // collar, and they exist here to DATE a shirt, never to price one.
  //
  // ⚠ "Giant" is the hazard and it needs BOTH halves of the usual treatment. As
  // a canonical it is an ordinary English adjective that clothing copy emits
  // constantly ("giant logo", "giant floral print"), and at 5 characters it
  // would beat a real "Nike" (4) on longest-first ordering — so it goes into
  // DETECT_EXCLUDED_FROM_TEXT. As an alias KEY it is kept, because a brand field
  // of literally "giant" on a TEE means the blank; note the known collision that
  // this accepts, the bicycle manufacturer of the same name, which is out of
  // scope for a garment-grading corpus but is the reason this is written down.
  screenstars: "Screen Stars",
  screenstarsbest: "Screen Stars", // the sub-line resolves to the house
  brockum: "Brockum",
  brockumgroup: "Brockum",
  giant: "Giant",
  giantbytultex: "Giant", // the original branding
  tultexgiant: "Giant",
  winterland: "Winterland",
  winterlandproductions: "Winterland",
  // ⚠ a bare "tultex" is DELIBERATELY ABSENT — Tultex is the PARENT that made
  // Giant, and it printed its own blanks under its own name. Folding it would be
  // the parent-attributes-a-sibling error the decoder bar refuses in code form.
};

/**
 * Canonical brands that must NEVER be minted out of FREE TEXT, even though they
 * are correct canonical values for a tag (US-1983).
 *
 * The hazard is structural: CANONICAL_BRANDS is built from BRAND_ALIASES'
 * VALUES, and detectBrandInText regex-scans those over arbitrary prose. An alias
 * KEY that is an ordinary word is safe (the map is an exact whole-field lookup —
 * the "ag"/"spider"/"ch" play), but a canonical VALUE that is an ordinary word
 * has no such protection.
 *
 * "Off-White" is exactly that, and it is the worst case the KB has: it is a real
 * hype brand AND the single most common neutral COLOUR word in clothing. The
 * word-boundary guard cannot help — an off-white garment's title contains the
 * brand name EXACTLY. Without this exclusion, "Nike tee, off-white, medium" from
 * a barcode/UPC title match resolves to brand "Off-White", and longest-first
 * ordering makes it BEAT the real "Nike" sitting in the same string. That
 * mis-brands an ordinary tee as a hype label and prices it off the wrong ladder.
 * The KB already treats the phrase as a colour elsewhere — 00455 seeds
 * "off-white" as an alias of Prada's Talco COLORWAY.
 *
 * So this brand is reachable by TAG (canonicalizeBrand/isKnownBrand still
 * resolve it, which is what the eBay Brand aspect and the comp filter need) but
 * is never GUESSED from prose. That is the KB's never-guess principle applied to
 * detection: decline rather than false-fire.
 *
 * This is opt-in and additive — no other brand's behavior changes. Contrast the
 * "Gucci GG Supreme" → Supreme mis-detection, which is NOT this problem: we do
 * want Supreme detected, so it needs a positional rule in the shared matcher,
 * not an exclusion.
 *
 * US-1984 (00464) is why this is a SET and not a special case: premium denim
 * brought two more ordinary-word brands, and one is worse than Off-White.
 *
 *   • MOTHER (the LA denim house) — "mother of pearl" buttons is one of the most
 *     common phrases in vintage listing copy, so the false positive is not a
 *     corner case, it is routine. Longest-first ordering makes it actively
 *     harmful rather than merely noisy: in "Gap blouse with mother of pearl
 *     buttons", "MOTHER" (6 chars) BEATS the real "Gap" (3) and the garment is
 *     mis-branded onto a premium-denim ladder it has nothing to do with.
 *   • FRAME (the LA/London denim house) — "frame" is a common noun in clothing
 *     copy (a sunglasses frame, the frame of a bag).
 *
 * Both stay reachable by TAG, exactly as Off-White does. Note the asymmetry that
 * makes this work: an ordinary-word alias KEY is safe (BRAND_ALIASES is an exact
 * whole-field lookup — a seller whose brand field is literally "mother" means the
 * brand), so only the VALUE side scanned over prose needs excluding.
 */
const DETECT_EXCLUDED_FROM_TEXT: ReadonlySet<string> = new Set([
  "Off-White", // a colour word (US-1983)
  "MOTHER", // "mother of pearl" (US-1984)
  "FRAME", // "sunglasses frame" (US-1984)
  // US-1985. The worst instance of this trap so far, and the only brand needing
  // TWO defences: the canonical is already the long form (a bare "On" would be
  // scanned over every listing in the catalogue), and the long form is STILL
  // ordinary prose — "great grip on running trails" contains "on running"
  // verbatim. Longest-first ordering makes that actively harmful rather than
  // merely noisy: "On Running" (10 chars) BEATS a real "Nike" (4) sitting in the
  // same string. Verified empirically in activewear-content_test.ts; the brand
  // stays fully reachable by TAG, which is what the eBay aspect and the comp
  // filter read.
  "On Running",
  // US-1988. "fossil" is an ordinary English noun, and unlike MOTHER/FRAME the
  // false positives are not even clothing copy — they are a different DOMAIN
  // entirely ("fossil fuel", a paleontology or mineral listing, and Arc'teryx's
  // own logo, which 00453 describes as "a fossil skeleton"). That last one is the
  // sharpest: the KB's OWN seeded prose for another brand contains the word, so a
  // prose scan can mint "Fossil" off an Arc'teryx description. The brand stays
  // reachable by TAG, which is what the eBay Brand aspect and the comp filter
  // read — a seller whose brand field is literally "fossil" means the watch house.
  "Fossil",
  // US-1986. This group is the DENSEST instance of the trap so far — two of its
  // ten brands are ordinary words, and both are words that THIS PRODUCT'S OWN
  // TEXT emits, which is what makes them routine rather than corner cases:
  //
  //   • Express — "express shipping" / "free express delivery" is boilerplate in
  //     the eBay titles detectBrandInText is pointed at (the barcode/UPC intake,
  //     US-598). Longest-first ordering makes it actively harmful: in "Nike tee,
  //     free express shipping", "Express" (7) BEATS the real "Nike" (4).
  //   • LOFT — "loft" is the standard term for the fill/insulation of a down
  //     garment ("800-fill loft", "the loft has flattened"), so the KB's OWN
  //     outdoor and luxury-outerwear packs (00453, 00460) emit it constantly in
  //     exactly the copy this scans. It also beats a real "Gap" (3) on length.
  //     The match is case-insensitive, so the all-caps canonical is no defence.
  //
  // Both stay fully reachable by TAG (canonicalizeBrand/isKnownBrand still resolve
  // them, which is what the eBay Brand aspect and the comp filter read) and are
  // simply never GUESSED from prose. Verified empirically in
  // fast-fashion-mall-content_test.ts by mutation, not argued.
  //
  // KNOWN, ACCEPTED LIMIT: excluding LOFT means "Ann Taylor LOFT blouse" in prose
  // resolves to Ann Taylor — the parent whose name it carries, at an adjacent
  // band — rather than to LOFT. There is no rule that recovers LOFT from prose
  // without also minting it off every down jacket, and a sister brand is a far
  // cheaper miss than that. Declining beats false-firing (the never-guess rule).
  "Express",
  "LOFT",
  // US-1989. "Red Wing" is the boot house's canonical, but the two-word phrase is
  // a live free-text collision: "Detroit Red Wings" (the NHL team) and the
  // red-wing blackbird both contain it at a word boundary, and longest-first
  // ordering would let "Red Wing" (8) beat a real "Nike" (4) in a "Red Wings
  // jersey" title. The brand stays fully reachable BY TAG (canonicalizeBrand/
  // isKnownBrand still resolve it, which is what the eBay Brand aspect and the
  // comp filter read) and is simply never GUESSED from prose. Verified by
  // mutation in heritage-workwear-content_test.ts.
  "Red Wing",
  // US-1990. Two footwear brands whose canonical is an ordinary word:
  //   • Brooks (running) — "Brooks" is an ordinary English word ("babbling
  //     brooks") AND a live brand collision: Brooks Brothers (00467) contains it,
  //     though longest-first ordering already tests "Brooks Brothers" first. A
  //     bare "brooks" in prose must not mint the running brand. It stays reachable
  //     BY TAG (canonicalizeBrand of a "Brooks" passthrough resolves to the same
  //     string, and brandKey('Brooks')='brooks' finds the pack).
  //   • KEEN — an ordinary English ADJECTIVE ("a keen interest"). The match is
  //     case-insensitive, so the all-caps canonical is no defence; it would fire
  //     on "keen" in any listing prose. Reachable by tag, never guessed from text.
  // Both verified by mutation in footwear-tier2-content_test.ts.
  "Brooks",
  "KEEN",
  // US-1991. Two intimates canonicals that are ordinary words:
  //   • PINK (Victoria's Secret PINK) — "pink" is one of the most common COLOUR
  //     words in clothing copy ("pink floral blouse", "dusty pink"). The match is
  //     case-insensitive, so the all-caps canonical is no defence; without this it
  //     would fire on "pink" in nearly every listing and, longest-first, could
  //     beat a real short brand in the same title. Reachable BY TAG (a brand field
  //     of literally "PINK" resolves), never GUESSED from prose.
  //   • Aerie — an ordinary noun (an eagle's nest). US-1991 promoted it to its own
  //     canonical (out of the American Eagle fold), which is exactly what puts it
  //     on the prose-scan path for the first time, so it must be excluded here (it
  //     never was before, when its canonical was "American Eagle"). Reachable by
  //     tag, never minted from "an aerie of birds". Both verified by mutation in
  //     intimates-loungewear-content_test.ts.
  "PINK",
  "Aerie",
  // US-1992. Two outdoor/technical canonicals that are ordinary words:
  //   • Rab (the British down house) — "Rab" is an ordinary short token AND a
  //     given name (Rab). The match is case-insensitive, so the all-caps/any-case
  //     canonical is no defence; a bare "rab" in prose must not mint the brand,
  //     and at 3 chars it could beat a real short brand in the same title
  //     (longest-first). Reachable BY TAG (a brand field of literally "Rab"
  //     resolves), never GUESSED from prose (the KEEN / Brooks precedent, 00470).
  //   • Kühl — the German word for "cool". "kühl" appears in prose as the
  //     adjective (and in translated/technical copy), so the canonical must not be
  //     minted from free text. Reachable by TAG (the `khl`/`kuhl` keys resolve a
  //     tag), never guessed from prose. Both verified by mutation in
  //     outdoor-technical-content_test.ts.
  "Rab",
  "Kühl",
  // US-2221 (00574). "New Era" is the most ORDINARY of the phrases in this set:
  // it is not a noun that happens to be a brand, it is a stock marketing phrase
  // — "a new era of comfort", "a new era for the franchise" — and it turns up in
  // exactly the eBay-title corpus detectBrandInText is pointed at. Longest-first
  // ordering makes it actively harmful rather than merely noisy: in "Nike tee,
  // a new era of comfort", "New Era" (7) BEATS the real "Nike" (4), and the
  // garment is mis-branded onto a licensed-headwear ladder.
  //
  // Worse than the Express/LOFT case in one respect: the collision is with the
  // brand's OWN category adjacent copy — sports listings say "a new era" about
  // teams constantly, and a New Era cap is a licensed sports product, so the
  // false positives cluster exactly where the true positives live.
  //
  // Reachable BY TAG as always (canonicalizeBrand/isKnownBrand resolve it, which
  // is what the eBay Brand aspect and the comp filter read), never GUESSED from
  // prose. Verified by mutation in headwear-content_test.ts.
  //
  // Stetson, Kangol and Goorin Bros. are NOT excluded: none is an ordinary word,
  // and losing prose detection for them would cost real recall for nothing.
  "New Era",
  // US-2221 (00577). "The Ridge" is a PHRASE before it is a brand — a trail, a
  // mountain, a neighbourhood, a Blue Ridge souvenir sweatshirt — and at 9
  // characters it would beat a real "Nike" (4) in the same title. The bare
  // "ridge" is already kept out of the canonical for the same reason; excluding
  // the long form closes the other half. Reachable BY TAG, never guessed from
  // prose. Verified by mutation in small-leather-goods-content_test.ts.
  //
  // Bellroy, Secrid and Bosca are NOT excluded — none is an ordinary word in
  // English, and Bosca's only collision is the founder's surname, which means
  // the same house.
  "The Ridge",
  // US-2220 (00579). "Giant" is an ordinary English adjective and one clothing
  // copy reaches for constantly — "giant logo", "giant floral print", "giant
  // check". At 5 characters it beats a real "Nike" (4) on longest-first
  // ordering, so a prose scan would mis-brand an ordinary tee onto a
  // vintage-blank ladder. Reachable BY TAG, never guessed from prose.
  //
  // Screen Stars, Brockum and Winterland are NOT excluded — none is an ordinary
  // word, and a prose mention of any of them in a listing genuinely does mean
  // the blank.
  "Giant",
]);

/**
 * Canonicalize a free-text brand against the known-brand table. Returns the
 * eBay-canonical spelling when recognized (`"Levis"` -> `"Levi's"`), otherwise
 * the cleaned (whitespace-collapsed, trimmed) input unchanged. Returns `null`
 * for an empty/blank input so callers can treat "no brand" uniformly.
 */
export function canonicalizeBrand(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const cleaned = cleanBrand(String(raw));
  if (cleaned === "") return null;
  return BRAND_ALIASES[brandKey(cleaned)] ?? cleaned;
}

/**
 * The brand_key for a RAW brand string as a seller supplies it — alias-resolved.
 *
 * This is the only correct way to turn seller input into a key that joins
 * brand_knowledge. `brandKey(raw)` alone is NOT equivalent: it skips
 * canonicalizeBrand, so "YSL" keys as `ysl` while the KB row is
 * `yvessaintlaurent`, and the two never meet. That mismatch is silent — the
 * lookup simply returns nothing, which is indistinguishable from a brand we have
 * no knowledge of.
 *
 * Exported so the golden set, the tell-candidate aggregator and per-brand
 * accuracy all bucket under the SAME key. They were each hand-rolling
 * `brandKey(raw)` and would have split one brand across its alias spellings.
 */
export function brandKeyForRaw(raw: string | null | undefined): string | null {
  const canonical = canonicalizeBrand(raw);
  return canonical ? brandKey(canonical) : null;
}

/** True when the brand resolves to a curated canonical entry (vs. passthrough). */
export function isKnownBrand(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const cleaned = cleanBrand(String(raw));
  return cleaned !== "" && brandKey(cleaned) in BRAND_ALIASES;
}

/** Unique canonical brand names, longest-first so multi-word brands ("Polo
 *  Ralph Lauren") win over a contained shorter one ("Ralph Lauren"). Brands in
 *  DETECT_EXCLUDED_FROM_TEXT are omitted — they are valid canonicals for a TAG
 *  but must never be minted out of prose (US-1983; see that set's comment). */
const CANONICAL_BRANDS: readonly string[] = Array.from(
  new Set(Object.values(BRAND_ALIASES)),
).filter((b) => !DETECT_EXCLUDED_FROM_TEXT.has(b))
  .sort((a, b) => b.length - a.length);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect a known brand inside free text — e.g. an eBay product title from a
 * barcode (UPC/EAN) match ("The North Face Men's Apex Jacket Medium" ->
 * "The North Face"). Used by the barcode scan-to-autofill intake (US-598) to
 * pull a canonical brand off a matched listing's title. Word-boundary matched
 * (so "Gap" doesn't fire on "Gaps") and longest-brand-first. Returns the
 * eBay-canonical brand string, or null when no known brand appears.
 */
export function detectBrandInText(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const brand of CANONICAL_BRANDS) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(brand)}(?![A-Za-z0-9])`, "i");
    if (re.test(text)) return brand;
  }
  return null;
}

// ── Style-code resolution ─────────────────────────────────────────────────

export interface StyleResolution {
  /** Authoritative brand the code belongs to (already canonical). */
  brand: string;
  /** The normalized style code (uppercased, single-spaced). */
  styleCode: string;
  /** Exact comp query — the code returns the same product, not a fuzzy match. */
  compQuery: string;
  /** Auto-fillable eBay item specifics derived from the resolved product. */
  aspects: Record<string, string[]>;
  /** True when matched against the curated product table (vs. format-inferred). */
  exact: boolean;
}

interface StyleProduct {
  brand: string;
  model?: string; // product line, e.g. "Air Force 1 '07"
  department?: string; // Men / Women / Unisex Adult / ...
  type?: string; // Athletic / Sneakers / ...
}

/**
 * Curated style-code -> canonical product table. Keys are the canonical
 * (dash-form) code. Kept conservative: only fields we're confident about per
 * code, so we never fabricate a colorway. Extend as the catalog grows; unknown
 * codes still resolve a brand via format inference below.
 */
const STYLE_CODE_PRODUCTS: Record<string, StyleProduct> = {
  "CW2288-111": { brand: "Nike", model: "Air Force 1 '07", department: "Men", type: "Athletic" },
  "DD1391-100": { brand: "Nike", model: "Dunk Low", department: "Men", type: "Athletic" },
  "315122-111": { brand: "Nike", model: "Air Force 1 '07", department: "Men", type: "Athletic" },
  "555088-101": { brand: "Jordan", model: "Air Jordan 1 Retro High OG", department: "Men", type: "Athletic" },
  "DZ5485-612": { brand: "Jordan", model: "Air Jordan 1 Retro High OG", department: "Men", type: "Athletic" },
};

/** Normalize a raw style code: uppercase, trim, collapse internal whitespace. */
function cleanStyleCode(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Infer the brand from a style-code FORMAT alone, for codes not in the curated
 * table. Returns null when the string doesn't look like a recognized brand's
 * style code (so a generic "Style: Slim Fit" tag value isn't mistaken for one).
 */
function brandFromStyleFormat(code: string): string | null {
  const c = code.replace(/\s+/g, "");
  // Nike/Jordan: two letters + 4 digits + "-" + 3 digits (CW2288-111), or the
  // older all-numeric 6+3 form (555088-101).
  if (/^[A-Z]{2}\d{4}-\d{3}$/.test(c)) return "Nike";
  if (/^\d{6}-\d{3}$/.test(c)) return "Nike";
  // adidas: two letters + 4 digits, no dash (GZ5230, BB6168), or 1 letter + 5
  // digits (S79166).
  if (/^[A-Z]{2}\d{4}$/.test(c)) return "adidas";
  if (/^[A-Z]\d{5}$/.test(c)) return "adidas";
  // New Balance: M/W/U + 3-4 digits + optional trailing letters/digit (M990GL6).
  // NOTE this format is NOT exclusive to New Balance — Converse's classic style
  // codes are also M + 4 digits (US-1740). That collision is why resolveStyleCode
  // lets an explicit brand outrank this inference; see the note there.
  if (/^[MWU]\d{3,4}[A-Z]{0,3}\d?$/.test(c)) return "New Balance";
  return null;
}

/**
 * Resolve a style/model code to a canonical product for sneakers/streetwear.
 * Tries the curated product table first (exact: true), then brand-by-format
 * inference (exact: false). Returns null when the value isn't a recognizable
 * style code, so non-sneaker "style" fields (e.g. "Slim Fit") are left alone.
 *
 * `brandHint` (an already-canonical brand) does two things, both gated on it
 * being a known sneaker brand:
 *   - it OUTRANKS a format inference that disagrees with it (US-1740 — several
 *     brands share a code shape, so a brand read off the tag beats a guess made
 *     from the code's shape alone);
 *   - it rescues an unrecognized format — a known sneaker brand + a short
 *     alphanumeric code is still treated as a code so its brand keys the comp
 *     search.
 * The curated table outranks both.
 */
export function resolveStyleCode(
  raw: string | null | undefined,
  brandHint?: string | null,
): StyleResolution | null {
  if (raw == null) return null;
  const code = cleanStyleCode(String(raw));
  if (code === "") return null;

  // Curated exact match (try both as-typed and dash-normalized spacing forms).
  const dashForm = code.replace(/\s+/g, "-");
  const product = STYLE_CODE_PRODUCTS[code] ?? STYLE_CODE_PRODUCTS[dashForm];
  if (product) {
    return buildResolution(dashForm, product, true);
  }

  // Format inference — but an EXPLICIT brand outranks it (US-1740).
  //
  // This ordering is load-bearing and it fixes a real, live mis-branding bug found
  // while wiring the New Balance decoder. brandFromStyleFormat reads "New Balance"
  // out of any M+4-digit code — and CONVERSE's classic style codes are ALSO
  // M + 4 digits (M9160 is a Chuck Taylor). Because ai-listing.ts takes
  // `styleResolution?.brand ?? canonicalBrand`, a format GUESS was overriding the
  // brand read off the actual tag: a Converse Chuck with a legible M-code was
  // silently relisted as a New Balance, taking the eBay Brand aspect and the comp
  // filter with it.
  //
  // The fix is not a bigger code table (we cannot enumerate Converse's codes with a
  // citation, and a half-remembered list is worse than none). It is precedence: a
  // canonical brand from the tag is DIRECT evidence, while a format match is an
  // inference from shape alone — so when both speak and disagree, the tag wins.
  // The curated STYLE_CODE_PRODUCTS table still outranks both, because an exact
  // code→product match is stronger evidence than either.
  //
  // Note this only engages when the hint is a known sneaker brand: an apparel
  // brandHint must not suppress a sneaker code's inference (a Nike code on an item
  // mis-tagged "Hanes" should still resolve to Nike).
  const inferredBrand = brandFromStyleFormat(code);
  if (inferredBrand) {
    const hintOverrides = brandHint && brandHint !== inferredBrand &&
      SNEAKER_BRANDS.has(brandHint);
    return buildResolution(code, { brand: hintOverrides ? brandHint : inferredBrand }, false);
  }

  // Last resort: a known sneaker brand + a plausible alphanumeric code (letters
  // AND digits, no spaces) — treat as a code so comps key on it, but only when
  // the hint says this is footwear-ish so we don't grab "Style: Relaxed".
  if (brandHint && SNEAKER_BRANDS.has(brandHint) && /^[A-Z0-9-]{5,12}$/.test(code) && /[A-Z]/.test(code) && /\d/.test(code)) {
    return buildResolution(code, { brand: brandHint }, false);
  }

  return null;
}

const SNEAKER_BRANDS: ReadonlySet<string> = new Set([
  "Nike",
  "Jordan",
  "adidas",
  "New Balance",
  "PUMA",
  "Reebok",
  "ASICS",
  "Vans",
  "Converse",
]);

function buildResolution(
  styleCode: string,
  product: StyleProduct,
  exact: boolean,
): StyleResolution {
  const aspects: Record<string, string[]> = { Brand: [product.brand] };
  if (product.model) aspects["Model"] = [product.model];
  if (product.department) aspects["Department"] = [product.department];
  if (product.type) aspects["Type"] = [product.type];
  return {
    brand: product.brand,
    styleCode,
    // The style code is the single most precise comp key for sneakers — the
    // SAME product, regardless of how the title is phrased.
    compQuery: styleCode,
    aspects,
    exact,
  };
}

// ── Applying the canonical brand + style aspects to item specifics ─────────

/**
 * Fold the canonical brand and any style-resolved product aspects into a
 * listing's item specifics.
 *
 * - Brand: the canonical value WINS (replaces whatever the model emitted), since
 *   a misspelled Brand aspect is both a comp-filter miss and a buyer-trust hit.
 *   Forced unconditionally unless an `allowedNames` constraint excludes Brand.
 * - Other style aspects (Model/Department/Type): only applied when the resolved
 *   category permits the aspect (`allowedNames` contains it) AND the listing
 *   doesn't already have a non-empty value — we never clobber a model-determined
 *   specific, and never push an aspect the category would reject at publish.
 *   With no `allowedNames` constraint, these are skipped (safe default).
 *
 * Pure — returns a new map.
 */
export function applyCanonicalBrandAndStyle(
  specifics: Record<string, string[]>,
  brand: string | null,
  resolution: StyleResolution | null,
  allowedNames?: Iterable<string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...specifics };
  const allowed = allowedNames
    ? new Map([...allowedNames].map((n) => [n.toLowerCase(), n]))
    : null;
  const constrained = !!allowed && allowed.size > 0;
  const canonicalName = (name: string): string | null => {
    if (!constrained) return name;
    return allowed!.get(name.toLowerCase()) ?? null;
  };

  if (brand) {
    // Brand is universally accepted by apparel/shoe categories; force it even
    // when unconstrained, but honor an explicit constraint that omits it.
    const bn = constrained ? allowed!.get("brand") ?? null : "Brand";
    if (bn) out[bn] = [brand];
  }

  if (resolution) {
    for (const [name, values] of Object.entries(resolution.aspects)) {
      if (name.toLowerCase() === "brand") continue; // handled above
      // Product aspects only land when the category explicitly allows them.
      if (!constrained) continue;
      const cn = canonicalName(name);
      if (!cn) continue;
      const existing = out[cn];
      const hasValue = Array.isArray(existing) &&
        existing.some((v) => typeof v === "string" && v.trim() !== "");
      if (hasValue) continue; // never clobber a model-determined value
      out[cn] = values;
    }
  }

  return out;
}
