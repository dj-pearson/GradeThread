// Reseller condition-vocabulary glossary (US-1671).
//
// A hub at /grading/glossary/ plus one DefinedTerm page per reseller term
// (/grading/glossary/<slug>): EUC, VGUC, GUC, NWT vs NWOT, NIB, HTF, BOLO, death
// pile, comps, flat lay, rag/bale grade, SNAD… The GEO landgrab — zero
// competition, snippet/AI-answer bait — that makes GradeThread own the
// condition-vocabulary answers. Distinct from the grade TIER/FACTOR glossary at
// /grading/<slug> (src/lib/seo/glossary.ts): this is community reseller lingo.
//
// PURE DATA: imports only the PublicRoute TYPE (relative path, so the Vite Node
// config context can resolve it). The JSON-LD composition lives in
// src/pages/marketing/marketing-jsonld.ts (never imported by the registry), and
// the DefinedTerm/DefinedTermSet builders in src/lib/seo/json-ld.ts.
//
// CONTENT RULES (enforced by tests + editorial):
//   - title ≤ 46 chars (the " | GradeThread" suffix brings it to the 60-char
//     SERP cap) and UNIQUE across all public routes.
//   - description 70–160 chars and UNIQUE.
//   - definition ~45–60 words, self-contained + quotable (the snippet/AI unit).
//   - ≥150 words of genuinely distinct content per term across the fields; no
//     auto-generated padding. Near-synonyms cluster onto ONE url (nwt-vs-nwot).

import type { PublicRoute } from "./public-routes";

export const RESELLER_GLOSSARY_HUB_PATH = "/grading/glossary";

export type ResellerTermGroup =
  | "condition-lingo"
  | "workflow"
  | "marketplace"
  | "sourcing"
  | "measurements";

const RESELLER_GROUP_LABELS: Record<ResellerTermGroup, string> = {
  "condition-lingo": "Condition lingo",
  workflow: "Selling workflow",
  marketplace: "Marketplace terms",
  sourcing: "Sourcing & inventory",
  measurements: "Measurements",
};

export interface ResellerTermFaq {
  q: string;
  a: string;
}

export interface ResellerTerm {
  /** URL slug, e.g. "euc" or "nwt-vs-nwot". */
  slug: string;
  /** Display term, e.g. "EUC". */
  term: string;
  /** Full expansions / clustered near-synonyms → DefinedTerm alternateName. */
  alternateNames?: string[];
  group: ResellerTermGroup;
  /** <title> without the " | GradeThread" suffix — ≤ 46 chars, unique. */
  title: string;
  /** Meta description — 70–160 chars, unique. */
  description: string;
  /** On-page H1 (usually question-phrased). */
  h1: string;
  /** Answer-first definition, ~45–60 words, self-contained. */
  definition: string;
  /** How the term shows up in a real listing. */
  usageExample: string;
  /** How the term maps onto the GradeThread 1.0–10.0 grade scale. */
  scaleMapping: string;
  /** 2–3 related term slugs (sideways rule). */
  relatedSlugs: string[];
  /** 1–2 question-phrased Q&A pairs (rendered + FAQPage JSON-LD). */
  faqs: ResellerTermFaq[];
}

/** Absolute path for a term slug. */
export function resellerTermPath(slug: string): string {
  return `${RESELLER_GLOSSARY_HUB_PATH}/${slug}`;
}

// ── The terms ───────────────────────────────────────────────────────
// Seeded below; expanded to 40+ terms. Order within a group is display order.
export const RESELLER_TERMS: ResellerTerm[] = [
  {
    slug: "euc",
    term: "EUC",
    alternateNames: ["Excellent Used Condition"],
    group: "condition-lingo",
    title: "EUC Meaning (Excellent Used Condition)",
    description:
      "EUC means Excellent Used Condition — a gently used clothing item with no notable flaws. Here's what it means and how it maps to a 1–10 grade.",
    h1: "What does EUC mean?",
    definition:
      "EUC stands for Excellent Used Condition. It describes a pre-owned garment that has been worn or washed only a handful of times and has no notable flaws — no holes, stains, pilling, or repairs. It looks nearly new, and on the GradeThread scale it anchors an 8 out of 10.",
    usageExample:
      "A Poshmark listing reading “Lululemon Align leggings, EUC, worn twice, no pilling or piling at the seams” is telling buyers the item is gently used with no visible wear.",
    scaleMapping:
      "EUC maps to a grade of 8 (the Excellent tier) on the GradeThread 1.0–10.0 condition scale — one step below New Without Tags (9) and above Very Good Used Condition (VGUC, 7).",
    relatedSlugs: ["vguc", "guc", "nwt-vs-nwot"],
    faqs: [
      {
        q: "What is the difference between EUC and VGUC?",
        a: "EUC (Excellent Used Condition) means essentially no visible wear — it looks nearly new. VGUC (Very Good Used Condition) allows light, even wear that doesn't affect the look or function. On the GradeThread scale, EUC is an 8 and VGUC is a 7.",
      },
    ],
  },
  {
    slug: "vguc",
    term: "VGUC",
    alternateNames: ["Very Good Used Condition"],
    group: "condition-lingo",
    title: "VGUC: What It Means and What It's Worth",
    description:
      "VGUC means Very Good Used Condition, but sellers use it loosely. What VGUC really covers, where it lands on a 1–10 grade, and what to check before you buy.",
    h1: "What does VGUC mean?",
    definition:
      "VGUC stands for Very Good Used Condition. It describes a pre-owned garment with light, even wear consistent with occasional use: maybe slight softening of the fabric or very minor pilling, but no holes, stains, odor, or broken hardware. On the GradeThread scale it anchors a 7 out of 10.",
    usageExample:
      "A Depop listing reading “Carhartt jacket, VGUC, light wear at the cuffs but no damage” signals honest, minor wear rather than a flawless piece.",
    scaleMapping:
      "VGUC maps to a grade of 7 (the Very Good tier) on the GradeThread 1.0–10.0 scale — below EUC (8) and above Good Used Condition (GUC, 6).",
    relatedSlugs: ["euc", "guc", "gently-used"],
    faqs: [
      {
        q: "Is VGUC better than GUC?",
        a: "Yes. VGUC (Very Good Used Condition) has only light, even wear, while GUC (Good Used Condition) has visible but minor wear like pilling or small marks. On the GradeThread scale VGUC is a 7 and GUC is a 6.",
      },
    ],
  },
  {
    slug: "death-pile",
    term: "Death pile",
    alternateNames: ["death stack"],
    group: "workflow",
    title: "Death Pile Meaning in Reselling",
    description:
      "A reseller's death pile is the backlog of sourced inventory that hasn't been listed yet. What it means, why it grows, and how to clear it.",
    h1: "What is a reseller death pile?",
    definition:
      "A death pile is a reseller's backlog of items that have been sourced but not yet cleaned, measured, photographed, or listed. It's the inventory equivalent of a to-do list that keeps growing — capital sitting in bins instead of earning on a marketplace. Clearing the death pile is the classic reseller productivity battle.",
    usageExample:
      "A reseller might post in r/Flipping, “Finally attacked my death pile this weekend — 60 items listed,” meaning they worked through a big backlog of unlisted inventory.",
    scaleMapping:
      "A death pile isn't a condition term, but grading is one of the steps that gates it: standardizing condition up front (a quick 1.0–10.0 grade) speeds cataloging and pricing so items move from pile to listed faster.",
    relatedSlugs: ["sourcing", "comps", "sell-through-rate"],
    faqs: [
      {
        q: "Why do resellers get a death pile?",
        a: "Sourcing is fast and fun; listing is slow and repetitive, so inventory accumulates faster than it gets listed. The pile represents money tied up in unlisted stock, which is why resellers treat clearing it as a priority.",
      },
    ],
  },
  {
    slug: "nwt-vs-nwot",
    term: "NWT vs NWOT",
    alternateNames: ["New With Tags", "New Without Tags"],
    group: "condition-lingo",
    title: "NWT vs NWOT: New With/Without Tags",
    description:
      "NWT means New With Tags; NWOT means New Without Tags. Both are unworn — the difference is the price tag, and how each maps to a 1–10 grade.",
    h1: "What's the difference between NWT and NWOT?",
    definition:
      "NWT (New With Tags) and NWOT (New Without Tags) both describe unworn, never-used garments; the only difference is whether the original retail tags are still attached. NWT items are brand-new store stock, while NWOT items were never worn but lost their tags. On the GradeThread scale, NWT anchors a 10 and NWOT a 9.",
    usageExample:
      "An eBay title like “Zara dress NWT, size M, never worn, tags attached” tells buyers it's brand-new store stock, while “NWOT” would mean unworn but with tags removed.",
    scaleMapping:
      "NWT maps to a grade of 10 (the top NWT tier) and NWOT to a 9 on the GradeThread 1.0–10.0 scale — the two grades reserved for unworn items, above Excellent Used Condition (EUC, 8).",
    relatedSlugs: ["euc", "nwd", "nib"],
    faqs: [
      {
        q: "Is NWOT worth less than NWT?",
        a: "Usually slightly. NWOT (New Without Tags) is unworn just like NWT (New With Tags), but missing tags make some buyers cautious about provenance. On the GradeThread scale NWT is a 10 and NWOT is a 9.",
      },
    ],
  },
  {
    slug: "guc",
    term: "GUC",
    alternateNames: ["Good Used Condition"],
    group: "condition-lingo",
    title: "GUC Meaning (Good Used Condition)",
    description:
      "GUC means Good Used Condition — visible but minor wear that doesn't stop the item being worn. What it means and its 1–10 grade.",
    h1: "What does GUC mean?",
    definition:
      "GUC stands for Good Used Condition. It describes a pre-owned garment with visible, honest wear — light pilling, minor fading, small marks, or slight stretching — but nothing that stops it being worn or that a buyer would call damage. On the GradeThread scale, GUC anchors a 6 out of 10.",
    usageExample:
      "A Mercari listing reading “Levi's 501s, GUC, some fading and light wear at the hem, still solid” sets the expectation of honest, everyday wear.",
    scaleMapping:
      "GUC maps to a grade of 6 (the Good tier) on the GradeThread 1.0–10.0 scale — below VGUC (7) and above Fair (5). It's the honest middle of the used-condition range.",
    relatedSlugs: ["vguc", "euc", "gently-used"],
    faqs: [
      {
        q: "What's the difference between GUC and VGUC?",
        a: "GUC (Good Used Condition) shows visible but minor wear; VGUC (Very Good Used Condition) shows only light, even wear that's easy to miss. On the GradeThread scale GUC is a 6 and VGUC is a 7.",
      },
    ],
  },
  {
    slug: "nwd",
    term: "NWD",
    alternateNames: ["New With Defects"],
    group: "condition-lingo",
    title: "NWD Meaning (New With Defects)",
    description:
      "NWD means New With Defects — a never-worn item with a factory or handling flaw. What it means and how it grades on a 1–10 scale.",
    h1: "What does NWD mean?",
    definition:
      "NWD stands for New With Defects. It describes an unworn item, often store or outlet stock, that carries a disclosed flaw such as a factory second, a snag, a small mark, or a missing button. It was never used but isn't flawless, so on the GradeThread scale it typically lands around a 6–7 depending on the defect.",
    usageExample:
      "An eBay listing titled “Nike hoodie NWD — new, never worn, small pull on left sleeve (pictured)” flags a factory-fresh item with one disclosed flaw.",
    scaleMapping:
      "NWD isn't a single number: an otherwise-new item with a minor disclosed defect usually grades 6–7 on the GradeThread 1.0–10.0 scale, since the flaw pulls it out of the unworn 9–10 range despite never being worn.",
    relatedSlugs: ["nwt-vs-nwot", "as-is", "flaw"],
    faqs: [
      {
        q: "Is NWD the same as used?",
        a: "No. NWD (New With Defects) means the item was never worn but has a manufacturing or handling flaw. It differs from used-condition grades like GUC because the wear isn't from use — it's a factory or handling defect on otherwise-new stock.",
      },
    ],
  },
  {
    slug: "gently-used",
    term: "Gently used",
    group: "condition-lingo",
    title: "Gently Used Meaning in Reselling",
    description:
      "“Gently used” means worn only a few times with minimal wear. What resellers mean by it and how it maps to a 1–10 condition grade.",
    h1: "What does “gently used” mean?",
    definition:
      "Gently used describes a pre-owned garment that has been worn only a handful of times and shows minimal signs of use — no damage, stains, or repairs, just very light softening. It's a casual, subjective phrase resellers use for near-excellent items, roughly overlapping EUC and VGUC, so on the GradeThread scale it maps to about a 7–8.",
    usageExample:
      "A Poshmark caption “gently used, worn a couple times, no flaws” signals a near-new item, though buyers often ask for specifics because the phrase is subjective.",
    scaleMapping:
      "“Gently used” is subjective, but it roughly spans the Very Good to Excellent tiers — about a 7–8 on the GradeThread 1.0–10.0 scale. A standardized grade replaces the vague phrase with a number buyers can trust.",
    relatedSlugs: ["euc", "vguc", "pre-owned"],
    faqs: [
      {
        q: "How gently used is 'gently used'?",
        a: "There's no fixed standard — it generally means worn only a few times with no visible flaws. Because it's subjective, it maps to roughly a 7–8 on the GradeThread scale, spanning the VGUC and EUC tiers.",
      },
    ],
  },
  {
    slug: "pre-owned",
    term: "Pre-owned",
    alternateNames: ["Pre-loved", "Preloved", "Second-hand"],
    group: "condition-lingo",
    title: "Pre-Owned & Pre-Loved Meaning",
    description:
      "“Pre-owned” and “pre-loved” both mean second-hand — previously owned clothing resold on the secondary market. What they mean for condition.",
    h1: "What do “pre-owned” and “pre-loved” mean?",
    definition:
      "Pre-owned (also “pre-loved” or “preloved”) means a garment that has had a previous owner and is being resold second-hand. The term signals only that the item isn't new — it says nothing about condition, which can range from like-new to heavily worn. On the GradeThread scale, pre-owned items span roughly 3 to 9.",
    usageExample:
      "A Depop bio “all items pre-loved unless stated” tells shoppers the whole closet is second-hand, so they should read each listing's condition notes.",
    scaleMapping:
      "“Pre-owned” isn't a condition grade at all — it just means not new. A pre-owned item can grade anywhere from Poor (3) to New Without Tags (9) on the GradeThread 1.0–10.0 scale, which is why a specific grade matters.",
    relatedSlugs: ["gently-used", "vintage", "as-is"],
    faqs: [
      {
        q: "Is pre-loved the same as pre-owned?",
        a: "Yes. “Pre-loved,” “preloved,” and “pre-owned” all mean the same thing — a second-hand item that had a previous owner. They're marketing-friendly synonyms and say nothing specific about condition on their own.",
      },
    ],
  },
  {
    slug: "as-is",
    term: "As-is",
    group: "condition-lingo",
    title: "As-Is Meaning in Reselling",
    description:
      "“As-is” means sold with disclosed flaws and usually no returns. What sellers mean by as-is and how flawed items grade 1–10.",
    h1: "What does “as-is” mean in a listing?",
    definition:
      "As-is means a seller is listing an item with its flaws disclosed and, typically, no returns accepted — the buyer takes it in its current state. It signals notable damage or wear such as stains, holes, or missing parts. On the GradeThread scale, as-is items usually fall in the Fair to Poor range, about a 3 to 5.",
    usageExample:
      "An eBay listing “Vintage coat, sold AS-IS, stain on lining and torn pocket (see photos), no returns” warns buyers the item has real flaws priced in.",
    scaleMapping:
      "As-is usually signals the Fair (5) to Poor (3–4) tiers on the GradeThread 1.0–10.0 scale. Grading an as-is item with specific factor scores turns a vague disclaimer into an itemized, trustworthy flaw report.",
    relatedSlugs: ["nwd", "flaw", "distressed"],
    faqs: [
      {
        q: "Does as-is mean broken?",
        a: "Not necessarily broken, but it means the item has disclosed flaws and is usually sold without returns. As-is items typically grade in the Fair-to-Poor range (3–5) because the seller is signaling damage or heavy wear the buyer accepts up front.",
      },
    ],
  },
  {
    slug: "smoke-free-home",
    term: "Smoke-free home",
    alternateNames: ["Smoke-free", "Pet-free home"],
    group: "condition-lingo",
    title: "Smoke-Free Home Meaning (Listings)",
    description:
      "“Smoke-free home” tells buyers the item was stored away from smoke or pet odor. Why resellers say it and how odor affects a 1–10 grade.",
    h1: "What does “smoke-free home” mean?",
    definition:
      "Smoke-free home is a reseller disclosure meaning the garment was stored and handled in a household without cigarette smoke (and often “pet-free” for animals), so it should arrive without absorbed odor. Odor is a real condition factor buyers can't see in photos. On the GradeThread scale, odor is one of the weighted grading factors.",
    usageExample:
      "A Mercari listing note “comes from a smoke-free, pet-free home” reassures scent-sensitive buyers before they purchase.",
    scaleMapping:
      "Odor is one of GradeThread's weighted grading factors (10% of the overall score on the 1.0–10.0 scale). A smoke-free-home claim maps to a clean odor factor; strong smoke or musty smells pull the overall grade down.",
    relatedSlugs: ["gently-used", "pre-owned", "euc"],
    faqs: [
      {
        q: "Why do sellers say 'smoke-free home'?",
        a: "Because odor is a condition issue buyers can't judge from photos. Stating a smoke-free (and often pet-free) home reassures scent-sensitive shoppers that the item won't arrive smelling of smoke, which on the GradeThread scale keeps the odor factor clean.",
      },
    ],
  },
  {
    slug: "nib",
    term: "NIB",
    alternateNames: ["New In Box", "New With Box", "NWB"],
    group: "condition-lingo",
    title: "NIB Meaning (New In Box)",
    description:
      "NIB means New In Box — an unused item still in its original packaging. What it means for shoes and accessories and its 1–10 grade.",
    h1: "What does NIB mean?",
    definition:
      "NIB stands for New In Box. It describes an unused item — most often shoes or accessories — still in its original, undamaged packaging, exactly as it left the retailer. It's the packaged equivalent of New With Tags. On the GradeThread scale, a genuine NIB item anchors a 10, the top New tier, assuming the contents are flawless.",
    usageExample:
      "A sneaker listing “Jordan 1 NIB, deadstock, box in great shape” tells buyers the shoes are unworn and still boxed.",
    scaleMapping:
      "NIB maps to a grade of 10 (the top New tier) on the GradeThread 1.0–10.0 scale, the same anchor as New With Tags — an unworn item in original packaging. A damaged box may be noted separately without changing the garment's grade.",
    relatedSlugs: ["nwt-vs-nwot", "deadstock", "nwd"],
    faqs: [
      {
        q: "Is NIB the same as deadstock?",
        a: "They overlap. NIB (New In Box) means unused and still boxed. Deadstock (DS) means never worn, often but not always with the original box. All NIB items are effectively deadstock, but deadstock can also describe unboxed unworn items.",
      },
    ],
  },
  {
    slug: "distressed",
    term: "Distressed",
    group: "condition-lingo",
    title: "Distressed vs Damaged Clothing",
    description:
      "Distressing is intentional design wear (rips, fading); damage is unintended. Why the difference is critical for grading a 1–10 condition.",
    h1: "Is distressed the same as damaged?",
    definition:
      "Distressed describes intentional design features — factory rips, fading, frayed hems, or acid washes — built into a garment on purpose, as with distressed denim. It is not damage. Confusing designed distressing with condition flaws is a classic grading error, so on the GradeThread scale intentional distressing is graded against the item's as-made state, not marked down.",
    usageExample:
      "A listing “Distressed boyfriend jeans, factory rips at the knees (by design, not damage)” clarifies the wear is intentional so buyers don't mistake it for a flaw.",
    scaleMapping:
      "Distressing shouldn't lower a grade: GradeThread grades a distressed garment against its intended as-made design, so factory rips and fading don't cost condition points on the 1.0–10.0 scale — only unintended damage beyond the design does.",
    relatedSlugs: ["as-is", "flaw", "vintage"],
    faqs: [
      {
        q: "Does distressed mean damaged?",
        a: "No. Distressed means intentional design wear — factory rips, fading, or fraying built in on purpose. Damage is unintended deterioration. Good grading judges a distressed item against its as-made state, so the designed wear isn't counted as a flaw.",
      },
    ],
  },
  {
    slug: "flaw",
    term: "Flaw",
    alternateNames: ["Flaws noted", "Flaw pictured"],
    group: "condition-lingo",
    title: "Flaw Noted: Reading Condition Flaws",
    description:
      "A “flaw” is any disclosed defect — a stain, hole, pill, or pull — resellers photograph and note. How flaws factor into a 1–10 grade.",
    h1: "What does “flaws noted” mean in a listing?",
    definition:
      "A flaw, in reseller listings, is any specific condition defect a seller discloses and usually photographs: a stain, hole, snag, pull, pilling patch, missing button, or fading. “Flaws noted” or “flaw pictured” signals honest disclosure. On the GradeThread scale, each flaw feeds the cosmetic, structural, or functional factor that composes the overall 1.0–10.0 grade.",
    usageExample:
      "A Poshmark listing “EUC, one small flaw noted — tiny snag on the hem, pictured in photo 4” shows the disclose-and-photograph habit good resellers follow.",
    scaleMapping:
      "Flaws are what move a grade down from New (9–10): each disclosed flaw scores against a specific GradeThread factor — cosmetic, structural, functional, or odor — which combine into the overall 1.0–10.0 grade rather than a single guess.",
    relatedSlugs: ["as-is", "nwd", "distressed"],
    faqs: [
      {
        q: "What does 'flaws noted' mean in a listing?",
        a: "It means the seller has identified and disclosed specific defects, usually with photos. It's a sign of an honest listing. On the GradeThread scale, each noted flaw is scored against a condition factor rather than lumped into a vague overall impression.",
      },
    ],
  },
  {
    slug: "comps",
    term: "Comps",
    alternateNames: ["Sold comps", "Comparables"],
    group: "workflow",
    title: "Comps Meaning (Sold Comparables)",
    description:
      "Comps are sold comparable listings resellers use to price an item. What sold comps are and why condition changes the comp you pick.",
    h1: "What are comps in reselling?",
    definition:
      "Comps (short for comparables) are recently sold listings of the same or similar item that resellers use to price their own. Checking “sold comps” — not active asking prices — shows what buyers actually paid. Condition is a key variable: a mint comp and a flawed comp price very differently, which is where a standardized 1.0–10.0 grade sharpens comping.",
    usageExample:
      "A reseller might say “I pulled the sold comps and this jacket moves at $45 in EUC,” meaning recent sales of similar excellent-condition jackets landed near $45.",
    scaleMapping:
      "Comps aren't a condition grade, but condition drives them: the same item in EUC (8) versus GUC (6) can have very different sold comps. Grading first lets you compare like-for-like and pick the right comparables.",
    relatedSlugs: ["sell-through-rate", "cost-basis", "sourcing"],
    faqs: [
      {
        q: "Should I use active or sold comps to price?",
        a: "Sold comps. Active listings show what sellers are asking, not what buyers pay. Sold comparables reflect real transaction prices. Filter by matching condition, since an EUC item and a GUC item of the same style sell at different prices.",
      },
    ],
  },
  {
    slug: "sourcing",
    term: "Sourcing",
    group: "workflow",
    title: "Sourcing Meaning for Resellers",
    description:
      "Sourcing is how resellers find inventory to flip — thrift stores, estate sales, wholesale lots. What it means and where grading fits in.",
    h1: "What is sourcing in reselling?",
    definition:
      "Sourcing is the reseller process of finding inventory to resell: hunting thrift stores, garage and estate sales, clearance racks, wholesale lots, or online arbitrage for items to flip at a profit. It's the front of the pipeline before cataloging, grading, and listing. Sourcing well means buying quality and condition you can grade and sell.",
    usageExample:
      "A reseller who says “I sourced 40 pieces at the bins this morning” means they bought 40 items to resell from a Goodwill Outlet.",
    scaleMapping:
      "Sourcing isn't a condition grade, but condition is what you're sourcing for: assessing an item's grade (roughly, on the 1.0–10.0 scale) at the point of sourcing prevents buying low-grade stock that won't resell profitably.",
    relatedSlugs: ["thrifting", "bins", "cost-basis"],
    faqs: [
      {
        q: "What does sourcing mean in reselling?",
        a: "Sourcing is finding and buying inventory to resell — from thrift stores, estate sales, clearance, or wholesale lots. It's the first step of the reseller pipeline, before items are cleaned, measured, graded, photographed, and listed.",
      },
    ],
  },
  {
    slug: "thrifting",
    term: "Thrifting",
    group: "workflow",
    title: "Thrifting Meaning for Resellers",
    description:
      "Thrifting is sourcing resale inventory from thrift and charity stores. What it means for resellers and how condition grading pays off.",
    h1: "What is thrifting for resale?",
    definition:
      "Thrifting is sourcing inventory from thrift, charity, and secondhand stores like Goodwill or Value Village, hunting for resellable clothing and goods at low prices. For resellers it's the most common sourcing channel. Because thrifted items are used and unpredictable, assessing condition on the spot — a mental 1.0–10.0 grade — is a core thrifting skill.",
    usageExample:
      "A YouTube reseller titling a video “Thrifting for eBay — $200 profit haul” means they filmed a thrift-store sourcing run for resale.",
    scaleMapping:
      "Thrifting isn't a grade, but it's where grading starts: quickly judging a thrifted item's condition (a rough 1.0–10.0 read) at the rack decides whether it's worth buying, since low-condition items rarely resell for a profit.",
    relatedSlugs: ["sourcing", "thrift-flip", "bins"],
    faqs: [
      {
        q: "What is thrifting for resale?",
        a: "Thrifting for resale is buying secondhand items cheaply from thrift and charity stores to sell for a profit on marketplaces like eBay or Poshmark. Success depends on judging condition and demand quickly at the store.",
      },
    ],
  },
  {
    slug: "cross-listing",
    term: "Cross-listing",
    alternateNames: ["Crosslisting", "Crossposting", "Cross-posting"],
    group: "workflow",
    title: "Cross-Listing Meaning (Crossposting)",
    description:
      "Cross-listing is posting one item on multiple marketplaces at once to sell faster. What it means and why consistent condition data matters.",
    h1: "What is cross-listing?",
    definition:
      "Cross-listing (or crossposting) is listing the same item on multiple marketplaces at once — eBay, Poshmark, Mercari, Depop — to reach more buyers and sell faster, then delisting elsewhere once it sells. The challenge is keeping details consistent across platforms, which is why a single standardized condition grade and description travels well between listings.",
    usageExample:
      "A reseller who says “I cross-list everything to eBay, Posh, and Mercari” means each item is posted on all three platforms to maximize exposure.",
    scaleMapping:
      "Cross-listing isn't a condition term, but a consistent grade helps: reusing one standardized 1.0–10.0 condition grade and report across every platform keeps descriptions honest and identical, avoiding SNAD disputes when the same item is listed in several places.",
    relatedSlugs: ["relist", "sku", "snad"],
    faqs: [
      {
        q: "Does cross-listing get you banned?",
        a: "No, cross-listing across different marketplaces is standard practice. The key is to delist an item everywhere once it sells so you don't oversell. Keeping condition details identical across platforms also prevents not-as-described disputes.",
      },
    ],
  },
  {
    slug: "relist",
    term: "Relist",
    alternateNames: ["Relisting"],
    group: "workflow",
    title: "Relisting Meaning for Resellers",
    description:
      "Relisting is re-posting an unsold item to refresh its visibility and date. What relisting does and why it's part of the selling workflow.",
    h1: "What does relisting do?",
    definition:
      "Relisting is ending an active but unsold listing and posting it again as new, which refreshes its date and can boost visibility in marketplace search and feeds. Resellers relist stale inventory to get it back in front of buyers. It's a workflow tactic, not a condition change — the item and its grade stay the same.",
    usageExample:
      "A reseller who says “I relist anything that hasn't sold in 30 days” refreshes stale listings so they resurface in search results.",
    scaleMapping:
      "Relisting doesn't change condition or grade — the item is identical. It's a visibility tactic. The item keeps whatever grade it held on the GradeThread 1.0–10.0 scale; only the listing's date and search freshness reset.",
    relatedSlugs: ["cross-listing", "sell-through-rate", "comps"],
    faqs: [
      {
        q: "Does relisting actually help items sell?",
        a: "It can. Relisting resets a listing's date so it resurfaces in search and feeds, exposing stale inventory to new buyers. It doesn't change the item's condition or price by itself, but improved visibility often leads to a sale.",
      },
    ],
  },
  {
    slug: "sell-through-rate",
    term: "Sell-through rate",
    alternateNames: ["STR", "Sell-through"],
    group: "workflow",
    title: "Sell-Through Rate (STR) Meaning",
    description:
      "Sell-through rate is the percent of listed inventory that sells in a period. How to calculate STR and why it guides sourcing decisions.",
    h1: "What is sell-through rate?",
    definition:
      "Sell-through rate (STR) is the percentage of listed inventory that actually sells within a set period — sold items divided by total listed, times 100. It measures how quickly stock moves and how well you're sourcing demand. A high STR means healthy turnover; a low STR signals a growing death pile of stale, unsold listings.",
    usageExample:
      "A reseller who says “my sell-through is about 20% a month” means roughly a fifth of their listed items sell every month.",
    scaleMapping:
      "Sell-through rate isn't a condition grade, but condition affects it: accurately graded, honestly described items sell faster and get fewer returns, lifting STR. Overgrading inflates prices and stalls listings, dragging sell-through down.",
    relatedSlugs: ["death-pile", "comps", "cost-basis"],
    faqs: [
      {
        q: "What is a good sell-through rate for resellers?",
        a: "It varies by category and platform, but many resellers aim for 20–30% of listed inventory selling per month. Higher STR means faster turnover and less capital tied up. Accurate condition descriptions help by reducing returns and building buyer trust.",
      },
    ],
  },
  {
    slug: "cost-basis",
    term: "Cost basis",
    alternateNames: ["COGS", "Cost of goods sold"],
    group: "workflow",
    title: "Cost Basis & COGS for Resellers",
    description:
      "Cost basis (COGS) is what you paid for an item plus costs to resell it. How to track it and why it decides real reseller profit.",
    h1: "What is cost basis in reselling?",
    definition:
      "Cost basis, or cost of goods sold (COGS), is the total you invested in an item before profit: the purchase price plus costs like cleaning, repairs, shipping supplies, and fees. Subtracting cost basis from the sale price gives true profit. Tracking it per item is essential for pricing, taxes, and knowing which sourcing actually pays.",
    usageExample:
      "A reseller who says “my cost basis on this coat is $8, so anything over that after fees is profit” is tracking what the item truly cost them.",
    scaleMapping:
      "Cost basis isn't a condition grade, but condition informs it: a lower-grade item may need cleaning or repair costs that raise its cost basis, while its resale price falls. Grading at intake helps predict whether an item's cost basis leaves room for profit.",
    relatedSlugs: ["comps", "sell-through-rate", "sourcing"],
    faqs: [
      {
        q: "What counts toward cost basis in reselling?",
        a: "Cost basis (COGS) includes the item's purchase price plus any costs to get it sold — cleaning, repairs, shipping supplies, and sometimes mileage. Marketplace and payment fees are also deducted when calculating true profit on a sale.",
      },
    ],
  },
  {
    slug: "consignment",
    term: "Consignment",
    group: "workflow",
    title: "Consignment Meaning in Reselling",
    description:
      "Consignment is selling an item on someone's behalf for a cut of the sale. How consignment works and why accurate grading protects both sides.",
    h1: "How does clothing consignment work?",
    definition:
      "Consignment is selling an item on behalf of its owner (the consignor), who keeps ownership until it sells; the shop or reseller (the consignee) lists it and takes an agreed cut of the final price. It lets sellers offer goods without buying them upfront. Because the owner trusts the reseller's condition call, an honest standardized grade protects both parties.",
    usageExample:
      "A boutique that says “we sell your designer bags on consignment for a 40% cut” lists your items and pays you the rest when they sell.",
    scaleMapping:
      "Consignment isn't a condition grade, but grading underpins it: a neutral, standardized 1.0–10.0 condition grade gives the owner and consignee a shared, defensible basis for pricing and for setting buyer expectations, reducing disputes over an item's real condition.",
    relatedSlugs: ["cost-basis", "authentication", "bundle"],
    faqs: [
      {
        q: "How does clothing consignment work?",
        a: "The owner (consignor) hands items to a shop or reseller (consignee) who lists and sells them, keeping ownership until sold. When an item sells, the consignee takes an agreed percentage and pays the owner the rest. Nothing is paid upfront.",
      },
    ],
  },
  {
    slug: "bundle",
    term: "Bundle",
    group: "workflow",
    title: "Bundle Meaning (Poshmark Bundles)",
    description:
      "A bundle groups several items into one order, often for a discount and combined shipping. How bundles work on Poshmark and Mercari.",
    h1: "What is a bundle on Poshmark?",
    definition:
      "A bundle is a group of separate listings a buyer combines into a single order, common on Poshmark and Mercari, usually to unlock a discount and combined shipping. Sellers encourage bundles to raise order value and cut per-item shipping cost. Each item keeps its own condition and grade — a bundle just packages multiple graded pieces together.",
    usageExample:
      "A Poshmark seller who posts “Bundle 2+ items for 15% off and combined shipping” is nudging buyers to buy multiple pieces in one order.",
    scaleMapping:
      "A bundle isn't a condition grade — it's a buyer combining multiple listings. Each item in the bundle still carries its own GradeThread 1.0–10.0 grade, so honest per-item grading matters even when several pieces ship together.",
    relatedSlugs: ["lot", "offer", "closet"],
    faqs: [
      {
        q: "What is a bundle on Poshmark?",
        a: "A bundle is when a buyer adds several of a seller's items to one order, usually to get a discount and pay combined shipping once. Sellers often offer a bundle discount to encourage larger multi-item purchases.",
      },
    ],
  },
  {
    slug: "offer",
    term: "Offer",
    alternateNames: ["Best Offer", "Lowball", "OBO"],
    group: "workflow",
    title: "Best Offer & Lowball Meaning",
    description:
      "An offer is a buyer's proposed price below asking; a lowball is an insultingly low one. How offers and OBO work in reseller negotiations.",
    h1: "What is a lowball offer?",
    definition:
      "An offer is a buyer's proposed price below the listed asking price, enabled by features like eBay Best Offer or Poshmark's offer button; “OBO” (or best offer) invites them. A lowball is an offer far below fair value that sellers usually decline or counter. Offers are negotiation, not condition — though a lower grade justifies accepting less.",
    usageExample:
      "A seller who lists “$40 OBO” is inviting offers, and might complain that a “$10 lowball” came in far under a fair price.",
    scaleMapping:
      "Offers aren't a condition grade, but grade anchors them: a documented GradeThread 1.0–10.0 grade gives a seller a defensible reason to hold firm on a high-grade item or to accept a lower offer on a flawed one, keeping negotiation grounded in condition.",
    relatedSlugs: ["bundle", "comps", "snad"],
    faqs: [
      {
        q: "What is a lowball offer?",
        a: "A lowball is an offer far below an item's fair or listed value — for example, offering $10 on a $40 item in good condition. Sellers typically decline or counter lowballs. Reasonable offers near comps and condition are more likely to be accepted.",
      },
    ],
  },
  {
    slug: "snad",
    term: "SNAD",
    alternateNames: ["Significantly Not As Described", "Item Not As Described"],
    group: "marketplace",
    title: "SNAD Meaning (Not As Described)",
    description:
      "SNAD means Significantly Not As Described — a buyer claim that an item differs from its listing. How to avoid SNAD with accurate grading.",
    h1: "What is a SNAD claim?",
    definition:
      "SNAD stands for Significantly Not As Described, a buyer claim (especially on eBay) that the item received differs materially from the listing — undisclosed flaws, wrong size, or misrepresented condition. SNAD cases usually favor buyers and force returns or refunds. The best defense is precise, honest condition grading and photos so the item matches its description exactly.",
    usageExample:
      "An eBay seller who says “I got a SNAD case because I missed a stain” means a buyer opened a not-as-described claim over an undisclosed flaw.",
    scaleMapping:
      "SNAD isn't a condition grade, but grading prevents it: a documented GradeThread 1.0–10.0 grade with itemized flaws makes the listing's condition claim verifiable, sharply reducing the not-as-described disputes that come from overgraded or vague descriptions.",
    relatedSlugs: ["inr", "flaw", "authentication"],
    faqs: [
      {
        q: "How do I avoid a SNAD claim?",
        a: "Describe condition precisely, disclose every flaw, and photograph them. SNAD (Significantly Not As Described) claims arise when the item doesn't match the listing. An itemized condition grade and clear photos make your description verifiable and hard to dispute.",
      },
    ],
  },
  {
    slug: "inr",
    term: "INR",
    alternateNames: ["Item Not Received"],
    group: "marketplace",
    title: "INR Claims: When a Buyer Says It Never Arrived",
    description:
      "INR means Item Not Received. How an INR claim differs from SNAD, what tracking actually proves, and how to respond so you are not the one eating the loss.",
    h1: "What does INR mean?",
    definition:
      "INR stands for Item Not Received, a buyer claim that a paid-for order never arrived. Unlike SNAD, it's about delivery, not condition. Sellers protect themselves with tracked shipping and proof of delivery, since marketplaces side with buyers when there's no tracking. INR is a fulfillment dispute and has nothing to do with an item's grade.",
    usageExample:
      "A seller who says “opened an INR even though tracking shows delivered” means a buyer claimed a package never arrived despite a delivery scan.",
    scaleMapping:
      "INR is a shipping dispute, not a condition grade — it has no bearing on the GradeThread 1.0–10.0 scale. It's included here because resellers group it with SNAD as the two most common buyer claims, but only SNAD relates to condition.",
    relatedSlugs: ["snad", "sku", "authentication"],
    faqs: [
      {
        q: "What's the difference between INR and SNAD?",
        a: "INR (Item Not Received) is a claim that a paid order never arrived — a delivery problem. SNAD (Significantly Not As Described) is a claim that the item differs from the listing — a condition or accuracy problem. Tracking defends against INR; accurate grading defends against SNAD.",
      },
    ],
  },
  {
    slug: "sku",
    term: "SKU",
    alternateNames: ["Stock Keeping Unit"],
    group: "marketplace",
    title: "SKU Meaning for Resellers",
    description:
      "A SKU is a unique code a reseller assigns to track each inventory item. What SKUs are and why they anchor grading and cross-listing.",
    h1: "What is a SKU in reselling?",
    definition:
      "A SKU (Stock Keeping Unit) is a unique identifier a reseller assigns to each inventory item to track it across storage, listings, and marketplaces. It ties a physical item to its photos, measurements, condition grade, and location, so nothing gets lost in a large inventory. SKUs make cross-listing and reconciliation possible at scale.",
    usageExample:
      "A reseller who writes “SKU A-142” on a poly mailer is matching the shipped item to its inventory record so they know exactly what sold.",
    scaleMapping:
      "A SKU isn't a condition grade, but it's the anchor a grade attaches to: GradeThread's 1.0–10.0 grade, photos, and flaw report all live against an item's SKU, keeping condition data linked to the right physical piece across every marketplace.",
    relatedSlugs: ["cross-listing", "closet", "cost-basis"],
    faqs: [
      {
        q: "Do resellers need SKUs?",
        a: "Once inventory grows past a few dozen items, yes. A SKU uniquely identifies each item so you can find it, match a sold order to the right piece, and keep its photos, measurements, and condition grade attached. Small sellers may skip them.",
      },
    ],
  },
  {
    slug: "closet",
    term: "Closet",
    group: "marketplace",
    title: "Closet Meaning (Poshmark Closet)",
    description:
      "A closet is a seller's storefront of listings on Poshmark. What a closet is, what sharing means, and how condition builds its reputation.",
    h1: "What is a Poshmark closet?",
    definition:
      "A closet is a seller's entire collection of listings on Poshmark — effectively their storefront. Buyers browse and follow closets, and sellers “share” items to feeds and parties for visibility. A closet's reputation rests on accurate listings, so consistent, honest condition grading across every item builds the trust and reviews that grow a following.",
    usageExample:
      "A Poshmark seller who says “sharing my closet twice a day” is re-sharing all their listings to keep them visible in buyers' feeds.",
    scaleMapping:
      "A closet isn't a condition grade — it's a Poshmark storefront. But condition drives its reputation: consistent GradeThread 1.0–10.0 grades across the closet mean fewer surprises, better reviews, and the buyer trust a closet needs to convert follows into sales.",
    relatedSlugs: ["sku", "bundle", "cross-listing"],
    faqs: [
      {
        q: "What is a Poshmark closet?",
        a: "A closet is everything a seller has listed on Poshmark — their storefront. Buyers follow closets and sellers share items to boost visibility. A closet's success depends on accurate descriptions, good photos, and honest condition, which earn reviews and repeat buyers.",
      },
    ],
  },
  {
    slug: "authentication",
    term: "Authentication",
    group: "marketplace",
    title: "Authentication vs Condition Grading",
    description:
      "Authentication verifies an item is genuine; condition grading rates its wear. Why they're different checks and why resellers need both.",
    h1: "Is authentication the same as condition grading?",
    definition:
      "Authentication is verifying that an item is genuine — a real brand, not a counterfeit — through tags, stitching, hardware, and serials. It answers “is it real,” a separate question from condition grading, which answers “what shape is it in.” A bag can be authentic but worn, or fake but pristine, so resellers of luxury goods need both checks.",
    usageExample:
      "A reseller who says “authenticated by a third party, EUC condition” is telling buyers the bag is verified genuine and separately rated for its light wear.",
    scaleMapping:
      "Authentication and condition grading are different: authentication confirms genuineness; the GradeThread 1.0–10.0 scale rates condition. GradeThread grades condition, not authenticity — a fake in mint shape could still score a 9, which is why buyers of luxury goods need an authenticity check too.",
    relatedSlugs: ["grail", "snad", "consignment"],
    faqs: [
      {
        q: "Is condition grading the same as authentication?",
        a: "No. Authentication verifies an item is genuine and not counterfeit. Condition grading rates how worn or flawed it is on a scale. An item can be authentic but heavily used, or a well-made fake — so luxury resellers use both checks independently.",
      },
    ],
  },
  {
    slug: "htf",
    term: "HTF",
    alternateNames: ["Hard To Find"],
    group: "marketplace",
    title: "HTF Meaning (Hard To Find)",
    description:
      "HTF means Hard To Find — a scarce, in-demand item resellers flag to signal rarity. What it means and how scarcity interacts with condition.",
    h1: "What does HTF mean in a listing?",
    definition:
      "HTF stands for Hard To Find, a tag resellers add to scarce, discontinued, or high-demand items to signal rarity and justify a premium. It describes availability, not condition — an HTF piece can be mint or worn. For rare items, condition matters even more, since a top grade on something scarce commands the highest prices.",
    usageExample:
      "An Etsy listing “HTF vintage Coca-Cola sweater, discontinued print” flags the item as scarce to attract collectors.",
    scaleMapping:
      "HTF is about scarcity, not condition, so it maps to no single grade. But condition amplifies value on rare items: an HTF piece graded EUC (8) or higher on the GradeThread 1.0–10.0 scale can command a large premium over a worn example of the same rarity.",
    relatedSlugs: ["bolo", "grail", "deadstock"],
    faqs: [
      {
        q: "What does HTF mean in a listing?",
        a: "HTF means Hard To Find — the item is scarce, discontinued, or in high demand, so the seller is signaling rarity to justify a higher price. It describes availability, not condition, so always check the condition details separately.",
      },
    ],
  },
  {
    slug: "bolo",
    term: "BOLO",
    alternateNames: ["Be On the LookOut"],
    group: "marketplace",
    title: "BOLO Meaning (Be On the LookOut)",
    description:
      "BOLO means Be On the LookOut — a tip about profitable items to hunt while sourcing. What BOLO lists are and how condition decides the payoff.",
    h1: "What is a BOLO in reselling?",
    definition:
      "BOLO stands for Be On the LookOut, a reseller term for brands, styles, or items worth grabbing whenever you spot them while sourcing, because they reliably resell for a profit. BOLO lists circulate in reseller communities. Finding a BOLO item is only half the win — its condition, judged roughly on a 1.0–10.0 scale, decides the actual payoff.",
    usageExample:
      "A reseller Facebook group post “BOLO: vintage Patagonia fleece — grab any you find under $15” tells members to buy that item on sight.",
    scaleMapping:
      "BOLO is a sourcing tip, not a condition grade. But condition governs whether a BOLO find pays: the same sought-after item grades and prices very differently between EUC (8) and Fair (5), so a quick grade check at sourcing time protects the margin.",
    relatedSlugs: ["htf", "sourcing", "grail"],
    faqs: [
      {
        q: "What is a BOLO in reselling?",
        a: "BOLO (Be On the LookOut) is a heads-up about specific brands or items that reliably resell for profit, so you grab them whenever you find them while sourcing. Reseller communities share BOLO lists, but you still must check each item's condition.",
      },
    ],
  },
  {
    slug: "grail",
    term: "Grail",
    group: "marketplace",
    title: "Grail Meaning in Reselling",
    description:
      "A grail is a highly coveted, hard-to-find item a collector or reseller dreams of finding. What grails are and why condition defines their value.",
    h1: "What does grail mean for resellers?",
    definition:
      "A grail is a highly coveted, often rare item that a collector or reseller especially wants to find — the “holy grail” of a category, like a specific vintage band tee or a discontinued sneaker. Grails command premiums driven by desirability and scarcity, but condition sets the ceiling: a mint grail can be worth many times a worn one.",
    usageExample:
      "A sneakerhead who says “finally found my grail, the OG Bred 1s in deadstock condition” means they landed a long-sought pair, unworn.",
    scaleMapping:
      "A grail is about desirability, not condition, so it maps to no fixed grade. But for grails condition is decisive: the GradeThread 1.0–10.0 grade separates a museum-piece deadstock example (9–10) from a beat-up one (5), often a multiple in resale value.",
    relatedSlugs: ["htf", "deadstock", "vintage"],
    faqs: [
      {
        q: "What does grail mean for resellers?",
        a: "A grail is a dream item — highly coveted and hard to find, the “holy grail” of a collecting category. Grails fetch premium prices, but their value swings heavily with condition, so a mint grail is worth far more than a worn one.",
      },
    ],
  },
  {
    slug: "deadstock",
    term: "Deadstock",
    alternateNames: ["DS", "VNDS"],
    group: "marketplace",
    title: "Deadstock (DS) Meaning",
    description:
      "Deadstock (DS) means an item that was never worn or used, often still boxed. What DS means for sneakers and how it maps to a 1–10 grade.",
    h1: "What does deadstock mean for sneakers?",
    definition:
      "Deadstock (DS) means an item — most often sneakers — that was never worn or used, in unused condition, frequently still with its original box and tags. Borrowed from retail's term for unsold stock, in resale it signals brand-new, unworn goods. On the GradeThread scale, genuine deadstock anchors the top New tier, a 9 to 10.",
    usageExample:
      "A sneaker listing “Yeezy 350, deadstock, never tried on, OG box” tells buyers the shoes are completely unworn.",
    scaleMapping:
      "Deadstock maps to the top of the GradeThread 1.0–10.0 scale — a 9 (New Without Tags) to 10 (New With Tags or New In Box) — because the item is unworn. VNDS (“very near deadstock”) drops slightly, into the Excellent range around an 8.",
    relatedSlugs: ["nib", "nwt-vs-nwot", "grail"],
    faqs: [
      {
        q: "What does deadstock mean for sneakers?",
        a: "Deadstock (DS) means the sneakers were never worn — brand-new, often still boxed with tags. It maps to the top New tier of a condition scale (9–10). “VNDS,” very near deadstock, means worn once or twice with barely any wear.",
      },
    ],
  },
  {
    slug: "y2k",
    term: "Y2K",
    group: "marketplace",
    title: "Y2K Fashion Meaning for Resellers",
    description:
      "Y2K refers to late-'90s to mid-2000s fashion that's now highly resold. What the Y2K label means and how its age affects condition grading.",
    h1: "What counts as Y2K fashion?",
    definition:
      "Y2K refers to fashion from roughly 1998 to 2006 — low-rise jeans, baby tees, rhinestones, and logo-heavy pieces — now a booming resale category driven by nostalgia. It's a style-era label, not a condition term, but Y2K items are 20-plus years old, so age-related wear like fading and elastic breakdown factors heavily into their grade.",
    usageExample:
      "A Depop listing “authentic Y2K low-rise cargos, early 2000s” markets the item to shoppers chasing the revived early-2000s aesthetic.",
    scaleMapping:
      "Y2K is a style era, not a condition grade. But its age matters for grading: two-decade-old Y2K pieces often carry wear — fading, pilling, stretched elastic — so honest scoring on the GradeThread 1.0–10.0 scale keeps a trendy label from masking real condition issues.",
    relatedSlugs: ["vintage", "grail", "deadstock"],
    faqs: [
      {
        q: "What counts as Y2K fashion?",
        a: "Y2K fashion is clothing from roughly the late 1990s to mid-2000s — low-rise jeans, baby tees, rhinestones, velour, and bold logos. It's a hugely popular resale trend. Because these pieces are 20-plus years old, check for age-related wear before buying.",
      },
    ],
  },
  {
    slug: "vintage",
    term: "Vintage",
    group: "marketplace",
    title: "Vintage Meaning for Clothing Resale",
    description:
      "Vintage clothing is generally 20+ years old; true vintage differs from “vintage-style.” What qualifies and how age shapes condition grading.",
    h1: "What makes clothing “true vintage”?",
    definition:
      "Vintage clothing is generally defined as at least 20 years old (many collectors use pre-2005), representative of the era it's from, and distinct from newer “vintage-style” reproductions. It's an age category, not a condition grade. Because vintage garments have aged, condition — fading, fabric weakness, repairs — carries extra weight and is graded against the era's original construction.",
    usageExample:
      "An eBay title “True vintage 1980s Levi's denim jacket, single stitch” uses “vintage” to mean genuinely old, not a modern reproduction.",
    scaleMapping:
      "Vintage is an age label, not a condition grade. On the GradeThread 1.0–10.0 scale, a vintage piece is graded against its original as-made construction, so expected age patina isn't over-penalized — but real deterioration like thinning fabric or holes still lowers the grade.",
    relatedSlugs: ["y2k", "distressed", "grail"],
    faqs: [
      {
        q: "What makes clothing 'true vintage'?",
        a: "True vintage generally means the garment is at least 20 years old and actually from that era, not a modern reproduction. Collectors often look for era-specific details like single-stitch hems or union tags. It differs from “vintage-style,” which merely imitates an older look.",
      },
    ],
  },
  {
    slug: "iso",
    term: "ISO",
    alternateNames: ["In Search Of"],
    group: "marketplace",
    title: "ISO Meaning (In Search Of)",
    description:
      "ISO means In Search Of — a buyer post looking for a specific item. What ISO means on Poshmark and Mercari and how sellers use it.",
    h1: "What does ISO mean on Poshmark?",
    definition:
      "ISO stands for In Search Of, a buyer post or comment signaling they're actively looking for a specific item, size, or brand. Sellers watch ISO posts to match inventory to demand and make direct sales. It's a demand signal, not a condition term, though a buyer's ISO usually specifies the condition they'll accept.",
    usageExample:
      "A Poshmark comment “ISO Free People midi dress, size S, EUC or better” tells sellers exactly what item and condition a buyer wants.",
    scaleMapping:
      "ISO is a demand signal, not a condition grade. But it often names condition: buyers commonly post “ISO … EUC or better,” tying the request to a spot on the GradeThread 1.0–10.0 scale so sellers know the minimum condition they'll accept.",
    relatedSlugs: ["htf", "bolo", "closet"],
    faqs: [
      {
        q: "What does ISO mean on Poshmark?",
        a: "ISO means In Search Of — a buyer publicly stating they're looking for a specific item, brand, or size. Sellers respond by tagging matching listings. Buyers often include the condition they want, like “EUC or better,” to filter offers.",
      },
    ],
  },
  {
    slug: "rag-vs-bale-grade",
    term: "Rag grade vs bale grade",
    alternateNames: [
      "Rag grade",
      "Bale grade",
      "Grade A/B/C clothing",
      "Credential clothing",
    ],
    group: "sourcing",
    title: "Rag Grade vs Bale Grade (Wholesale)",
    description:
      "Rag and bale grades (A/B/C) rate wholesale used-clothing lots, not single items. Why this wholesale “grade” is a false friend to condition grading.",
    h1: "Is “Grade A” clothing the same as a condition grade?",
    definition:
      "Rag grade and bale grade are wholesale terms for sorting bulk used clothing into tiers — Grade A, B, or C, or “credential” bales — based on the average resale quality of a whole shipment, not any single garment. It's a purchasing spec for pallets and bales, a false friend to per-item condition grading like GradeThread's 1.0–10.0 scale.",
    usageExample:
      "A wholesale supplier who offers “Grade A credential bales, 100 lbs” is selling a bulk lot sorted by average quality, not individually graded pieces.",
    scaleMapping:
      "Rag/bale grade is NOT the GradeThread condition scale: it rates the average quality of a bulk lot for buyers, whereas GradeThread's 1.0–10.0 grade rates one specific garment. A “Grade A” bale still contains items spanning many individual condition grades.",
    relatedSlugs: ["lot", "sourcing", "bins"],
    faqs: [
      {
        q: "Is 'Grade A' clothing the same as a condition grade?",
        a: "No. Grade A/B/C (rag or bale grade) rates the average quality of a wholesale lot or bale, guiding bulk buyers. It doesn't grade any individual item. A single garment from a Grade A bale still needs its own condition assessment.",
      },
    ],
  },
  {
    slug: "lot",
    term: "Lot",
    alternateNames: ["Bulk lot", "Reseller lot", "Wholesale lot"],
    group: "sourcing",
    title: "Wholesale Lot Meaning (Bulk Resale)",
    description:
      "A lot is a group of items sold together as one purchase, often in bulk. What buying and selling lots means and why per-item grading still applies.",
    h1: "What does “lot” mean on eBay?",
    definition:
      "A lot is a group of items sold together as a single purchase — a “lot of 20 vintage tees” on eBay, or a wholesale pallet. Buyers source lots to get inventory cheaply per piece; sellers move slow or mixed stock fast. A lot's price reflects average condition, so grading each item after buying reveals the real value inside.",
    usageExample:
      "An eBay listing “Lot of 15 women's jeans, various brands, resale bundle” sells the whole group as one purchase for a reseller to sort and flip.",
    scaleMapping:
      "A lot isn't a condition grade — it's a bulk purchase spanning mixed conditions. Grading each item on the GradeThread 1.0–10.0 scale after buying a lot separates the profitable high-grade pieces from the low-grade filler, revealing the lot's true worth.",
    relatedSlugs: ["rag-vs-bale-grade", "bundle", "sourcing"],
    faqs: [
      {
        q: "What does 'lot' mean on eBay?",
        a: "A lot is multiple items sold together as one purchase — for example, “lot of 15 jeans.” Resellers buy lots to get cheap per-item inventory and sell lots to clear mixed stock quickly. Condition usually varies across the items in a lot.",
      },
    ],
  },
  {
    slug: "rn-number",
    term: "RN number",
    alternateNames: ["Registered Identification Number", "RN#"],
    group: "sourcing",
    title: "RN Number on Clothing Tags",
    description:
      "An RN number is a US-issued code identifying a garment's manufacturer. How resellers use RN lookups to date and identify unbranded items.",
    h1: "What is an RN number on a clothing tag?",
    definition:
      "An RN number (Registered Identification Number) is a code the US FTC issues to companies that make or sell textiles, printed on care tags in place of a full name. Resellers look up RN numbers in the FTC database to identify the maker, verify a brand, or date a garment. It aids identification, not condition grading.",
    usageExample:
      "A reseller who says “no brand tag, but the RN number traces it to Pendleton” used the care-tag code to identify an unlabeled garment.",
    scaleMapping:
      "An RN number isn't a condition grade — it identifies the manufacturer, not the wear. It's included because RN lookups often accompany grading: confirming what an unbranded item is comes before assessing its condition on the GradeThread 1.0–10.0 scale.",
    relatedSlugs: ["authentication", "vintage", "sourcing"],
    faqs: [
      {
        q: "How do I look up an RN number?",
        a: "Search the RN number in the US FTC's free RN database (rn.ftc.gov). It returns the company registered to that code, helping identify the maker of an unlabeled or unfamiliar garment. RN numbers can also roughly help date an item.",
      },
    ],
  },
  {
    slug: "thrift-flip",
    term: "Thrift flip",
    group: "sourcing",
    title: "Thrift Flip Meaning (Resale & Upcycle)",
    description:
      "A thrift flip is buying a thrifted item cheap and reselling — or altering — it for profit. What flipping means and where condition grading fits.",
    h1: "What is a thrift flip?",
    definition:
      "A thrift flip is buying a low-cost thrifted item and reselling it for profit, sometimes after cleaning, mending, or altering it (upcycling) to raise its value. The margin comes from the gap between a cheap sourcing price and resale demand. Judging condition at purchase — a rough 1.0–10.0 read — is what separates a profitable flip from a dud.",
    usageExample:
      "A TikTok creator's “$3 thrift flip: I hemmed these curtains into a dress” shows buying cheap and altering an item to resell at a markup.",
    scaleMapping:
      "A thrift flip isn't a condition grade, but condition drives its margin: grading an item at sourcing on the GradeThread 1.0–10.0 scale predicts resale value, and a flip that involves cleaning or mending can lift an item's grade before it's relisted.",
    relatedSlugs: ["thrifting", "sourcing", "cost-basis"],
    faqs: [
      {
        q: "What is a thrift flip?",
        a: "A thrift flip is buying a cheap secondhand item and reselling it for profit, sometimes after cleaning, repairing, or altering it. The profit comes from the difference between the low thrift price and what buyers will pay once it's listed.",
      },
    ],
  },
  {
    slug: "bins",
    term: "The bins",
    alternateNames: ["Goodwill Outlet", "Goodwill bins"],
    group: "sourcing",
    title: "The Bins Meaning (Goodwill Outlet)",
    description:
      "“The bins” is the Goodwill Outlet, where unsold goods are sold by the pound in bins. What sourcing at the bins means and why condition varies wildly.",
    h1: "What are “the bins” in reselling?",
    definition:
      "“The bins” refers to Goodwill Outlet stores, where merchandise that didn't sell in regular thrift shops is dumped into large bins and sold by the pound. It's the cheapest sourcing tier, but condition is chaotic and unsorted, so fast on-the-spot condition assessment — a rough 1.0–10.0 grade — is the core skill for bins sourcing.",
    usageExample:
      "A reseller who says “found this Burberry coat at the bins for $2 a pound” sourced it from a Goodwill Outlet priced by weight.",
    scaleMapping:
      "The bins isn't a condition grade — it's a sourcing venue. But it's where condition judgment matters most: bins items are unsorted and often flawed, so quickly grading each find on the 1.0–10.0 scale decides what's worth the per-pound price.",
    relatedSlugs: ["thrifting", "sourcing", "rag-vs-bale-grade"],
    faqs: [
      {
        q: "What are 'the bins' in reselling?",
        a: "“The bins” are Goodwill Outlet stores, where unsold thrift merchandise is placed in large bins and sold by weight, usually by the pound. It's the cheapest way to source, but items are unsorted and condition varies enormously, so careful inspection is essential.",
      },
    ],
  },
  {
    slug: "pit-to-pit",
    term: "Pit to pit",
    alternateNames: ["Pit-to-pit", "Chest width", "P2P"],
    group: "measurements",
    title: "Pit to Pit Measurement Explained",
    description:
      "Pit to pit is the flat-laid chest width measured armpit to armpit. How to take it and why it beats sizing tags for online fit.",
    h1: "How do you measure pit to pit?",
    definition:
      "Pit to pit is a garment measurement taken across the chest from one armpit seam to the other while the item lies flat; doubling it gives the full chest circumference. Because vanity sizing makes tag sizes unreliable, resellers list pit-to-pit so buyers can match fit to a garment they already own.",
    usageExample:
      "An eBay listing “Pit to pit: 22 in, length: 28 in (measured flat)” gives buyers exact dimensions instead of relying on a tag size.",
    scaleMapping:
      "Pit to pit isn't a condition grade — it's a fit measurement. It's part of the same listing discipline as grading, though: accurate measurements plus a clear GradeThread 1.0–10.0 condition grade together prevent the size and condition SNAD disputes that drive returns.",
    relatedSlugs: ["inseam", "flat-lay", "rise"],
    faqs: [
      {
        q: "How do you measure pit to pit?",
        a: "Lay the garment flat, then measure straight across the chest from the bottom of one armpit seam to the other. That number is the flat chest width; double it for full circumference. Listing pit-to-pit helps buyers judge fit when tag sizes are inconsistent.",
      },
    ],
  },
  {
    slug: "inseam",
    term: "Inseam",
    group: "measurements",
    title: "Inseam Measurement Explained",
    description:
      "Inseam is the length from crotch seam to the bottom hem of pants. How to measure it and why resellers list it for accurate fit.",
    h1: "How is inseam measured on pants?",
    definition:
      "Inseam is the measurement from the crotch seam down the inner leg to the bottom hem, giving the effective leg length of pants, shorts, or jeans. Listed flat, it tells buyers how long a garment will wear regardless of the tag size or brand cut. Inseam is a fit measurement, not a condition grade.",
    usageExample:
      "A listing “32-inch inseam, measured flat from crotch seam to hem” tells buyers exactly how long the jeans are, independent of the tag.",
    scaleMapping:
      "Inseam isn't a condition grade — it's a leg-length fit measurement. Like pit-to-pit, it's part of listing rigor that complements grading: precise measurements plus a GradeThread 1.0–10.0 condition grade give buyers the full picture and cut down on returns.",
    relatedSlugs: ["pit-to-pit", "rise", "flat-lay"],
    faqs: [
      {
        q: "How is inseam measured on pants?",
        a: "Lay the pants flat and measure along the inner leg from the crotch seam straight down to the bottom of the hem. That length is the inseam. Resellers list it because it reflects true leg length better than a tag size.",
      },
    ],
  },
  {
    slug: "rise",
    term: "Rise",
    alternateNames: ["Front rise"],
    group: "measurements",
    title: "Rise Measurement (Front Rise)",
    description:
      "Rise is the measurement from the crotch seam to the top of the waistband. How front rise defines low, mid, or high-waisted fit for buyers.",
    h1: "What does “rise” mean in pants measurements?",
    definition:
      "Rise is the measurement from the crotch seam up to the top of the waistband, defining how high pants sit — low, mid, or high-rise. Front rise is measured up the front and strongly affects fit. Resellers list rise alongside inseam and waist so buyers can judge how a pair will sit. It's a fit spec, not a condition grade.",
    usageExample:
      "A listing “Rise: 11 in (high-waisted), inseam 28 in” tells buyers the jeans sit high on the waist, a key fit detail beyond the tag size.",
    scaleMapping:
      "Rise isn't a condition grade — it's a fit measurement that sets low, mid, or high waist. It belongs to the same listing discipline as grading: exact measurements plus a GradeThread 1.0–10.0 condition grade give buyers both fit and condition, reducing returns.",
    relatedSlugs: ["inseam", "pit-to-pit", "flat-lay"],
    faqs: [
      {
        q: "What does 'rise' mean in pants measurements?",
        a: "Rise is the distance from the crotch seam to the top of the waistband. Front rise is measured up the front. It determines whether pants are low-, mid-, or high-rise and strongly affects fit, so resellers list it alongside waist and inseam.",
      },
    ],
  },
  {
    slug: "flat-lay",
    term: "Flat lay",
    alternateNames: ["Flatlay", "Measured flat", "Measurements taken flat"],
    group: "measurements",
    title: "Flat Lay & Measured Flat Explained",
    description:
      "A flat lay photographs or measures a garment laid flat on a surface. What “measured flat” means and why it standardizes fit and condition.",
    h1: "What does “measured flat” mean?",
    definition:
      "A flat lay is a garment laid flat on a surface to be photographed or measured, rather than worn or hung. “Measured flat” means dimensions like pit-to-pit and inseam are taken in that position, so buyers double widths for circumference. Flat lays also give clean, even lighting that reveals condition — flaws, fading, and wear — for accurate grading.",
    usageExample:
      "A listing note “all measurements taken flat, see flat lay photos” tells buyers the dimensions are laid-flat values they should double for circumference.",
    scaleMapping:
      "A flat lay isn't a condition grade, but it's how condition gets assessed accurately: laying a garment flat under even light exposes flaws and lets consistent measurements be taken, both of which feed a reliable GradeThread 1.0–10.0 grade.",
    relatedSlugs: ["pit-to-pit", "inseam", "rise"],
    faqs: [
      {
        q: "What does 'measured flat' mean?",
        a: "“Measured flat” means the garment was laid flat on a surface and measured across, not around the body. For widths like pit-to-pit or waist, double the number to get full circumference. It's the reseller standard because it's repeatable and easy for buyers to verify.",
      },
    ],
  },
];

// ── Lookups + route registration ────────────────────────────────────

const TERM_BY_SLUG = new Map(RESELLER_TERMS.map((t) => [t.slug, t]));
const TERM_BY_PATH = new Map(
  RESELLER_TERMS.map((t) => [resellerTermPath(t.slug), t]),
);

export function getResellerTermBySlug(slug: string): ResellerTerm | undefined {
  return TERM_BY_SLUG.get(slug);
}
export function getResellerTermByPath(path: string): ResellerTerm | undefined {
  return TERM_BY_PATH.get(path);
}
export function isResellerGlossaryHubPath(path: string): boolean {
  return path === RESELLER_GLOSSARY_HUB_PATH;
}

/** Terms grouped for the hub's chapter layout. */
export function resellerTermsByGroup(): Array<{
  group: ResellerTermGroup;
  label: string;
  terms: ResellerTerm[];
}> {
  const groups = Object.keys(RESELLER_GROUP_LABELS) as ResellerTermGroup[];
  return groups
    .map((group) => ({
      group,
      label: RESELLER_GROUP_LABELS[group],
      terms: RESELLER_TERMS.filter((t) => t.group === group),
    }))
    .filter((g) => g.terms.length > 0);
}

/**
 * PublicRoute entries for the hub + every term page, spread into PUBLIC_ROUTES so
 * they auto-flow into the manifest → sitemap + IndexNow + prerender.
 */
export function resellerGlossaryRoutes(): PublicRoute[] {
  const hub: PublicRoute = {
    path: RESELLER_GLOSSARY_HUB_PATH,
    title: "Reseller Condition Terms, Mapped to a Grade",
    description:
      "EUC, VGUC, NWT vs NWOT, SNAD, death pile, comps. Every reseller condition term, what it actually covers, and where it lands on a 1–10 grade.",
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "DefinedTermSet",
  };
  const terms: PublicRoute[] = RESELLER_TERMS.map((t) => ({
    path: resellerTermPath(t.slug),
    title: t.title,
    description: t.description,
    changefreq: "monthly",
    priority: 0.5,
    jsonLdType: "DefinedTerm",
  }));
  return [hub, ...terms];
}

/** Breadcrumb trail (relative) for a term page: GradeThread → Glossary → term. */
export function resellerTermTrail(
  term: ResellerTerm,
): Array<{ name: string; path: string }> {
  return [
    { name: "GradeThread", path: "/" },
    { name: "Condition glossary", path: RESELLER_GLOSSARY_HUB_PATH },
    { name: term.term, path: resellerTermPath(term.slug) },
  ];
}
