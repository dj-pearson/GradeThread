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
  // Aerie is American Eagle's intimates/loungewear sub-brand and its tag often
  // says only "aerie". Same band as the parent -> folds. NOTE "aerie" is an
  // ordinary English noun (an eagle's nest); it is safe as an alias KEY because
  // keys match the WHOLE brand field, and it never enters CANONICAL_BRANDS (that
  // is built from the VALUES), so detectBrandInText can't fire on the word.
  aerie: "American Eagle",
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
};

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

/** True when the brand resolves to a curated canonical entry (vs. passthrough). */
export function isKnownBrand(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const cleaned = cleanBrand(String(raw));
  return cleaned !== "" && brandKey(cleaned) in BRAND_ALIASES;
}

/** Unique canonical brand names, longest-first so multi-word brands ("Polo
 *  Ralph Lauren") win over a contained shorter one ("Ralph Lauren"). */
const CANONICAL_BRANDS: readonly string[] = Array.from(
  new Set(Object.values(BRAND_ALIASES)),
).sort((a, b) => b.length - a.length);

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
