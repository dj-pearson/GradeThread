// Flaw library pSEO (US-1683).
//
// A hub at /grading/flaws/ plus one page per flaw type (/grading/flaws/<slug>):
// pilling, moth holes, sun fading, pit stains, crocking, seam stress, cracked
// graphics, missing buttons… Each is the vocabulary of the grading model's
// output — image-rich, hyper-specific, zero competition — and certificates
// deep-link each detected flaw to its page (the internal-link flywheel).
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD (DefinedTerm/Article +
// the hub DefinedTermSet) is composed in src/pages/marketing/marketing-jsonld.ts.
//
// CONTENT RULES (enforced by tests + editorial): title ≤ 46 & unique;
// description 70–160 & unique; definition ~45–60 words, self-contained; ≥150
// words of distinct editorial per flaw (detect / grade impact / fixability /
// disclosure); no auto-generated padding. `photos` is populated from the graded
// corpus by content ops (the page renders them when present).

import type { PublicRoute } from "./public-routes";

// US-9012: moved from /grading/flaws to /care on 2026-08-18.
//
// TWO REASONS, and the second is the load-bearing one. The pages were written
// disclosure-first, for a seller deciding how to word a listing; they are now
// removal-first, for the person holding the stained garment, and /grading/ is
// the wrong promise to make that reader.
//
// The containment reason: the US-9011 SERP check found every one of the 39
// results for the repair terms is a craft blog, a brand blog, a UGC thread or a
// charity shop, and NOT ONE is a resale or grading site. That is the
// neighbourhood this content gets filed in. Keeping it under /grading/ invites
// Google to read the grading spine as part of that neighbourhood. Its own
// prefix is the cheap version of the fix; US-9015 adds the guards.
//
// Old URLs 301 here from public/_redirects, covered by
// src/test/care-redirects.test.ts so a rename cannot silently orphan them.
export const FLAW_LIBRARY_HUB_PATH = "/care";

/** Where the flaw library used to live. Kept for the redirect map. */
export const FLAW_LIBRARY_LEGACY_HUB_PATH = "/grading/flaws";

/** The legacy URL for a slug, for the redirect map and its test. */
export function legacyFlawPath(slug: string): string {
  return `${FLAW_LIBRARY_LEGACY_HUB_PATH}/${slug}`;
}

export interface FlawPhoto {
  url: string;
  alt: string;
}

/** One step of a repair, in the shape schema.org HowToStep expects. */
export interface RepairStep {
  /** Short imperative label. Becomes HowToStep.name. */
  name: string;
  /** What to actually do, and where it goes wrong. Becomes HowToStep.text. */
  text: string;
}

/**
 * A step-by-step repair guide (US-9013), emitted as HowTo JSON-LD.
 *
 * Every field here maps to something schema.org HowTo asks for. We do not
 * invent a totalTime or an estimatedCost we have not thought about, because a
 * fabricated number in structured data is a lie a machine repeats.
 */
export interface RepairGuide {
  /** HowTo.name. The task, phrased as the reader would say it. */
  name: string;
  difficulty: "Easy" | "Moderate" | "Hard";
  /** Realistic minutes for someone who has not done it before. HowTo.totalTime. */
  minutes: number;
  /** HowTo.estimatedCost, in plain words rather than a fake precise figure. */
  cost: string;
  /** HowTo.tool: things you keep. */
  tools: string[];
  /** HowTo.supply: things you use up. May be empty, and often is. */
  supplies: string[];
  steps: RepairStep[];
}

/**
 * One way of removing a flaw, rated against the others (US-9019).
 *
 * WHY A RANKED TABLE AND NOT MORE PROSE. The pilling SERP was measured on
 * 2026-08-28 and two of the three reachable results are built this way:
 * Gentleman's Gazette ranks nine methods with a summary table, and Vogue
 * compares tools. A reader on this query is choosing between methods, not
 * looking for one. Prose that describes a single method loses to a table that
 * settles an argument.
 *
 * `risk` is the field that earns the page. Every competing article lists the
 * disposable-razor trick; the useful thing to say about it is what it costs
 * you when it goes wrong.
 */
export interface RemovalMethod {
  name: string;
  verdict: "best" | "good" | "situational" | "avoid";
  /** Roughly what it costs to acquire, in plain words. */
  cost: string;
  /** What it is good at, in one sentence. */
  works: string;
  /** How it damages the garment when it goes wrong. Never omitted. */
  risk: string;
}

/**
 * A band on the flaw's own severity scale, tied to the grade (US-9019).
 *
 * THIS IS THE PART NO COMPETING PAGE CAN WRITE. A laundry blog can tell you how
 * to shave a sweater. Only a grading company can tell you what each amount of
 * pilling is worth, and that is the honest bridge from a care query back to the
 * product. It is also the answer to the question the reader actually has, which
 * is not "how do I remove this" but "does this matter".
 */
export interface SeverityBand {
  /** What the reader sees on the garment. */
  label: string;
  /** How to recognise this band rather than the one either side of it. */
  looksLike: string;
  /** Where it lands on the 1.0-10.0 scale. Prose, because it is a range. */
  grade: string;
  /** What to do about it. */
  action: string;
}

export interface FlawEntry {
  slug: string;
  name: string;
  alternateNames?: string[];
  /** <title> without the " | GradeThread" suffix — ≤ 46, unique. */
  title: string;
  /** Meta description — 70–160, unique. */
  description: string;
  h1: string;
  /** Answer-first definition, ~45–60 words. */
  definition: string;
  /** How to detect/inspect for this flaw. */
  howToDetect: string[];
  /** How it affects / caps the GradeThread 1.0–10.0 grade. */
  gradeImpact: string;
  /** Whether and how it can be fixed. One sentence; the detail is in `removal`. */
  fixability: string;
  /**
   * US-9012. The honest verdict, which drives the order of the page and the
   * hinge at the bottom of it.
   *
   * "no" is used for 11 of the 32 and that is the point: a laundry blog has to
   * promise a fix to justify its page. We do not, so the page that says "this
   * is permanent, here is what it costs you" is the one that can lead somewhere
   * useful instead of wasting the reader's afternoon.
   */
  comesOut: "yes" | "sometimes" | "no";
  /** H2 for the removal block. Written as the reader's question, not ours. */
  removalHeading: string;
  /** Ordered steps. For a "no" entry, why not, and what to do instead. */
  removal: string[];
  /**
   * US-9019. Methods compared against each other, for the entries where the
   * reader's real question is which tool to use. Only `pilling` carries one so
   * far: it is 152,400 searches a month, the largest cluster either keyword
   * pull has produced, and the reachable results on that SERP are all built
   * this way.
   */
  methods?: RemovalMethod[];
  /**
   * US-9019. The flaw's own severity scale, tied to the grade. See
   * SeverityBand: this is the section a laundry blog cannot write.
   */
  severity?: SeverityBand[];
  /** One paragraph on stopping it happening again. */
  prevention: string;
  /**
   * US-9013. A full step-by-step repair guide, present only on the entries
   * where somebody is actually going to pick up a needle.
   *
   * IT LIVES ON THE EXISTING ENTRY rather than at a second /care/repair/<slug>
   * URL. One URL per intent: a reader searching "how to fix a snag in a
   * sweater" and one searching "what is a snag" want the same page, and
   * splitting them leaves two thin URLs competing for one query. It drives the
   * HowTo JSON-LD, which is what the repair SERPs actually reward.
   *
   * Seven entries carry one, chosen by the US-9011 SERP gate rather than by
   * volume. `missing-buttons` deliberately does NOT, even though
   * "how to sew on a button" is 50,000/mo, because it is the purest
   * non-adjacent intent in the set: someone searching it wants to sew a button,
   * not to sell a garment.
   */
  repair?: RepairGuide;
  /** How to disclose it honestly in a listing. */
  disclosure: string;
  /** 2–3 related flaw slugs. */
  relatedSlugs: string[];
  faqs: Array<{ q: string; a: string }>;
  /** Real graded-corpus photos (populated by content ops; rendered when present). */
  photos?: FlawPhoto[];
}

export function flawPath(slug: string): string {
  return `${FLAW_LIBRARY_HUB_PATH}/${slug}`;
}

export const FLAW_ENTRIES: FlawEntry[] = [
  {
    slug: "pilling",
    name: "Pilling",
    alternateNames: ["bobbling", "fuzzballs"],
    title: "How to Remove Pilling From Clothes",
    description:
      "Pills are abrasion, not dirt. How to shave them off without cutting the knit, why they form where they do, and what is left underneath when they are gone.",
    h1: "Pilling",
    definition:
      "Pilling is the small balls of tangled fibers that form on a fabric's surface where it rubs against itself or other surfaces — common on knits, under the arms, and at the cuffs. It's one of the most frequent signs of wear on used clothing and a key input to the fabric-condition grade.",
    howToDetect: [
      "Look at high-friction zones: underarms, inner thighs, cuffs, and collar",
      "Angle the garment under light — pills cast tiny shadows",
      "Run a hand across the surface; pilled fabric feels rough, not smooth",
    ],
    gradeImpact:
      "Pilling drives the Fabric Condition factor (30% of the grade). Light, sparse pilling nudges an item from Excellent (8) toward Good (6); heavy, widespread pilling that dulls the whole surface pushes it into Fair (5) or lower.",
    fixability:
      "Often improvable: a fabric shaver or sweater comb removes surface pills, though it can't restore fibers already thinned by abrasion. De-pilling before photographing can legitimately raise the grade.",
    disclosure:
      "Note it plainly ('light pilling at the cuffs') and show a close-up. Disclosed pilling rarely causes a return; undisclosed pilling in a 'like new' listing does.",
    comesOut: "yes",
    removalHeading: "How to get pills off a garment",
    removal: [
      "Lay the garment flat on a hard surface. Doing this on your lap stretches the knit, the fabric lifts into the blade, and the shaver cuts it.",
      "Work out how loose the knit is first. If you can see daylight between the stitches, or the fibre is cashmere, mohair or angora, use a comb rather than a blade.",
      "Go over the pilled area with a fabric shaver on its lowest setting, holding it flat and letting its own weight do the work. Pressing down is what makes a hole.",
      "Work in one direction, in short strokes, and empty the shaver often. A full chamber stops cutting and starts pressing pills back into the fabric.",
      "Stop when the surface reads smooth from a low angle. Chasing the last few pills is how people shave a hole in a sleeve, and the last few are not the ones anybody notices.",
      "Look at what is underneath. Pills are fibre that has already left the yarn, so a patch that reads thin or shiny after shaving was thin before you started. That is fabric thinning, not pilling, and it does not come back.",
    ],
    methods: [
      {
        name: "Electric fabric shaver",
        verdict: "best",
        cost: "About $15 to $25",
        works: "Fastest on a firmly knitted jumper, a fleece or a sweatshirt, and the only method that stays even across a large area.",
        risk: "Cuts a hole in seconds on a loose knit or over a seam, and the damage is not repairable. Lowest setting, no downward pressure, and never over a raised seam.",
      },
      {
        name: "Sweater comb or stone",
        verdict: "good",
        cost: "About $8 to $15",
        works: "The right tool for cashmere, mohair, angora and anything loosely knitted, because it catches the pill without a blade near the yarn.",
        risk: "Slow, and it drags a delicate knit out of shape if you pull rather than sweep. Support the fabric with your other hand.",
      },
      {
        name: "Disposable razor",
        verdict: "situational",
        cost: "You already own one",
        works: "Genuinely fine on a flat, firmly woven surface when you have one jumper and no shaver, which is why every article recommends it.",
        risk: "The reason every article should qualify it: a razor has no guard and no depth stop, so it removes pills and good yarn at the same rate. Use a blunt blade, hold it almost flat, and never on a loose knit.",
      },
      {
        name: "Pumice stone",
        verdict: "situational",
        cost: "A few dollars",
        works: "Good on heavy cotton and fleece, where it lifts pills without cutting anything.",
        risk: "Abrades the surface it is dragged across, so it dulls a dark colour over repeated use and is wrong for anything fine.",
      },
      {
        name: "Sticky tape or a lint roller",
        verdict: "avoid",
        cost: "You already own one",
        works: "Nothing, for this. It lifts loose fluff sitting on the surface.",
        risk: "No damage, but no result either. A pill is anchored by fibres still attached to the yarn, which is the whole difference between a pill and lint.",
      },
      {
        name: "Scissors",
        verdict: "avoid",
        cost: "Free",
        works: "Snipping individual pills is precise on the two or three you can see.",
        risk: "It is also how a small hole starts, because a pill sits directly on the yarn holding it. On a knit, one cut stitch runs.",
      },
    ],
    severity: [
      {
        label: "None to trace",
        looksLike: "Surface reads smooth from a low angle. A few pills at one cuff at most.",
        grade: "No effect. Excellent (8) and above is still available.",
        action: "Nothing. Do not shave a garment that does not need it.",
      },
      {
        label: "Light",
        looksLike: "Visible pills in the friction zones only: underarms, inner thighs, the side you carry a bag on.",
        grade: "Nudges Fabric Condition down. Typically Excellent (8) toward Good (6.5 to 7).",
        action: "Worth de-pilling. This is the band where twenty minutes of work moves the grade.",
      },
      {
        label: "Moderate",
        looksLike: "Pills across whole panels rather than just the friction zones, and the surface has lost its finish.",
        grade: "Good (6) toward Fair (5).",
        action: "De-pill and then look again. Some of this comes back to light; some of it turns out to be thinning.",
      },
      {
        label: "Heavy",
        looksLike: "The whole garment reads dull and matted. Pills come away in the hand.",
        grade: "Fair (5) or below, and de-pilling will not recover it.",
        action: "The yarn is already gone. Shaving reveals thinning rather than fixing it, so disclose and price accordingly.",
      },
    ],
    prevention: "Pilling is abrasion, so it comes from friction rather than dirt, and washing more often makes it worse rather than better. Turn knitwear inside out, use a mesh bag, wash cold on a gentle cycle and skip the dryer, where the tumbling does in one cycle what a week of wear does. Wash synthetics separately from cotton, because a polyester pill is anchored by a fibre stronger than the yarn around it and rubbing the two together is what forms them. The underarm and the side you carry a bag on will always go first, whatever you do.",
    relatedSlugs: ["fabric-thinning", "sun-fading"],
    faqs: [
      {
        q: "Does pilling lower a clothing grade?",
        a: "Yes. Pilling is assessed under the Fabric Condition factor, which is 30% of the overall grade. Light pilling in the friction zones drops an item a tier or so; pilling across whole panels takes it toward Fair (5) or below. De-pilling before grading can legitimately raise the result, because the grade is of the garment in front of the camera.",
      },
      {
        q: "Why do clothes pill in the first place?",
        a: "Friction, not dirt. Every rub breaks a few fibres loose from the yarn; they stay attached at one end and tangle with each other into a ball. That is why it appears at the underarm, the inner thigh and wherever a bag strap sits, and why a garment that is never worn never pills however long it hangs there.",
      },
      {
        q: "Do some fabrics pill more than others?",
        a: "Yes, and the reason is counter-intuitive. Pilling starts on almost everything; what differs is whether the pill falls off. Short-staple natural fibres shed their pills, so cotton and wool look better than they are. Synthetics do not: a polyester or nylon fibre is stronger than the yarn holding it, so the pill stays put and accumulates. Blends are the worst of both, which is why a 50/50 sweatshirt pills more visibly than either fibre alone.",
      },
      {
        q: "Will removing pills damage the garment?",
        a: "It can, and the two ways it happens are avoidable. Cutting a hole comes from pressing down, working over a seam, or using a blade on a loose knit; hold the tool flat, let its weight do the work and use a comb on anything you can see daylight through. The subtler one is that shaving does not put fibre back, so a patch that has pilled and been shaved repeatedly gets genuinely thin. At that point you are managing thinning, not pilling.",
      },
      {
        q: "Can you stop clothes pilling permanently?",
        a: "No, because the cause is wear. You can slow it a lot: inside out, mesh bag, cold gentle cycle, no dryer, and synthetics washed apart from cotton. What you cannot do is stop a jumper you wear weekly from pilling at the underarm, and a garment sold as never pilling is either unworn or made of something that sheds its pills rather than never forming them.",
      },
      {
        q: "Should I de-pill a garment before selling it?",
        a: "Usually yes, for the light and moderate bands, because a smooth surface photographs honestly and the grade is of what the buyer receives. Two caveats. Do not shave a heavily pilled garment expecting it to come back; you will expose thinning and have less to sell. And do not shave it and then describe it as never pilled, because it will pill again in the same places and that is the return.",
      },
    ],
  },
  {
    slug: "sun-fading",
    name: "Sun fading",
    alternateNames: ["color fading", "UV fading"],
    title: "Sun-Faded Clothes: Can It Be Fixed?",
    description:
      "Sun fading is dye that has been destroyed, so nothing lifts it. What dyeing can and cannot do, and how to stop the shoulder of a garment fading first.",
    h1: "Sun fading",
    definition:
      "Sun fading is the loss of color caused by prolonged UV exposure — often uneven, showing up on shoulders, folds, or one side of a garment that hung in light. Unlike intentional acid or bleach washes, it's incidental damage the maker never designed, so it counts against the grade.",
    howToDetect: [
      "Compare shoulders and folds against shadowed areas like seams and hems",
      "Check for a color line where a garment was folded on a hanger",
      "Look inside a pocket or under the collar for the original, unfaded shade",
    ],
    gradeImpact:
      "Fading hits both Fabric Condition and Cosmetic Appearance. Slight, even fading is minor; pronounced or uneven fading that changes how the piece reads is a Fair (5) signal — unless the wash is clearly an intentional design, which isn't penalized.",
    fixability:
      "Rarely reversible. Dye or color-restore products are inconsistent on blends and can worsen unevenness. Usually best disclosed rather than treated.",
    disclosure:
      "Call it out and photograph the faded area next to an unfaded one. Buyers accept honest fading; a surprise faded panel triggers 'not as described'.",
    comesOut: "no",
    removalHeading: "Sun fading does not come out",
    removal: [
      "Nothing removes it. UV has broken the dye molecules; there is no dye left to lift or redistribute.",
      "Dyeing the whole garment can even it out, but it changes the colour for good and rarely matches the original.",
      "For a black garment gone brown, a black dye bath is the only honest option, and it will not restore the original shade.",
    ],
    prevention: "Dry clothes in shade or inside out, and never store anything on a windowsill or in a car. A single summer in a sunlit wardrobe will fade the shoulder of a hanging garment while the rest stays true, which is the pattern that makes fading obvious.",
    relatedSlugs: ["pilling", "crocking"],
    faqs: [
      {
        q: "Is sun fading treated as damage or design?",
        a: "Incidental sun fading is damage and lowers the grade. A deliberate acid or bleach wash is design and is graded against the garment's as-made state, so it isn't penalized. Telling them apart is part of the grade.",
      },
    ],
  },
  {
    slug: "moth-holes",
    name: "Moth holes",
    alternateNames: ["moth damage"],
    title: "How to Darn a Hole in a Sweater",
    description:
      "Kill whatever is still in the fibres first, then harvest matching yarn from an inside seam and weave the darn in two directions. Above 5mm it shows.",
    h1: "Moth holes",
    definition:
      "Moth holes are small, irregular holes chewed by clothes-moth larvae, most common in wool, cashmere, and other animal fibers. They're often clustered and can be tiny, so they're easy to miss — and because they're structural damage, they weigh heavily on the grade.",
    howToDetect: [
      "Hold the garment up to a light — pinholes glow through",
      "Check knit underarms, cuffs, and folded areas where larvae feed undisturbed",
      "Look for clusters of small holes rather than a single clean cut",
    ],
    gradeImpact:
      "Moth holes hit Structural Integrity (25%). Even a single small hole rules out the Excellent tier; multiple holes push a piece to Fair (5) or Poor (3–4), often making it a 'for repair' item rather than a wearable one.",
    fixability:
      "Small holes can be professionally reweaved or discreetly darned, which can recover some grade, but the repair itself must then be disclosed. Untreated, they tend to spread.",
    disclosure:
      "Always disclose and photograph every hole with a scale reference. Moth holes are the classic hidden flaw that drives wool-resale disputes.",
    comesOut: "no",
    removalHeading: "Moth holes cannot be removed, only mended",
    removal: [
      "First, kill whatever is still in the fibres: 72 hours in a sealed bag in the freezer, or a hot tumble if the fabric allows.",
      "Wash or dry-clean before mending, because larvae feed on the body oils in the fabric, not the wool itself.",
      "For a hole under about 5mm, darn it with matching yarn pulled from an inside seam allowance.",
      "For anything larger, invisible mending by a specialist is the only result that does not read as a repair, and it costs more than most garments are worth.",
    ],
    prevention: "Moths eat protein fibres and are drawn to sweat and food traces, so store wool clean and never store it dirty for a season. Cedar and lavender deter, they do not kill. Airtight containers work; a full wardrobe with airflow does not.",
    repair: {
      name: "Darn a moth hole in a sweater",
      difficulty: "Moderate",
      minutes: 40,
      cost: "Free if you harvest the yarn",
      tools: ["Darning needle", "Darning mushroom or a smooth round object"],
      supplies: ["Matching yarn, ideally pulled from an inside seam of the garment"],
      steps: [
        {
          name: "Kill whatever is still in the fibres first",
          text: "72 hours sealed in a bag in the freezer. Mending a garment that still has larvae in it produces a second hole beside your repair.",
        },
        {
          name: "Wash or dry-clean before mending",
          text: "Larvae feed on the body oils in the wool rather than the wool itself, so a clean garment is a much less attractive one.",
        },
        {
          name: "Harvest matching yarn from the garment",
          text: "Pull a length from an inside seam allowance or the hem. Nothing you buy will match an aged garment as well as the garment does.",
        },
        {
          name: "Support the hole from behind",
          text: "A darning mushroom under the hole keeps the tension even. Without it the darn puckers and pulls the surrounding knit in.",
        },
        {
          name: "Lay parallel threads across the hole",
          text: "Anchor in sound fabric well outside the opening, and run threads across in one direction first, close together.",
        },
        {
          name: "Weave the second direction through",
          text: "Go over and under the first set at right angles. Density is what makes a darn hold and what makes it disappear.",
        },
        {
          name: "Know the limit",
          text: "Above about 5mm this stops being invisible. Specialist invisible mending is the only result that does not read as a repair, and it costs more than most garments are worth.",
        },
      ],
    },
    relatedSlugs: ["fabric-thinning", "seam-stress"],
    faqs: [
      {
        q: "How much do moth holes lower a grade?",
        a: "A lot — they're structural damage. A single small hole caps an item below Excellent; several push it to Fair or Poor. Disclosed and photographed, moth-damaged pieces still sell as repair or reweave projects.",
      },
    ],
  },
  {
    slug: "pit-stains",
    name: "Pit stains",
    alternateNames: ["armpit stains", "sweat stains", "yellow underarm stains"],
    title: "How to Get Underarm Stains Out",
    description:
      "Yellow underarm marks are aluminium bonded to protein, not sweat. The enzyme-then-oxygen sequence that shifts them, and the dryer step that sets them forever.",
    h1: "Pit stains",
    definition:
      "Pit stains are the yellow, crusty discoloration under the arms of shirts, formed when sweat reacts with antiperspirant aluminum and body oils. Over months they stiffen the fabric, resist ordinary washing, and often spread to the collar — counting against both odor-and-cleanliness and fabric-condition on the grade.",
    howToDetect: [
      "Turn the shirt inside out and check the underarm panel for yellowing",
      "Feel for stiffness — set-in stains harden the fabric",
      "Look along the inner collar, where the same residue tends to migrate",
    ],
    gradeImpact:
      "Pit stains hit Odor & Cleanliness (10%) and Fabric Condition (30%). Faint, washable shadowing keeps an item in Good (6); crusted, stiffened yellowing that won't lift caps it at Fair (5) or Poor (3–4), especially on light dress shirts.",
    fixability:
      "Sometimes improvable. Fresh marks respond to oxygen soaks or enzyme presoaks; set-in aluminum staining that has stiffened the weave is usually permanent. Treat before photographing, and never bleach — chlorine locks the yellow in.",
    disclosure:
      "State it directly ('light underarm shadowing, does not lift fully') and show an inside-out close-up. It's the number-one hidden shirt flaw, so a surprise pit stain almost always triggers a return.",
    comesOut: "sometimes",
    removalHeading: "How to get underarm staining out",
    removal: [
      "Work out which problem you have. A yellow crust is aluminium from antiperspirant bonded to protein; a dulled, stiff patch is fabric damage underneath it.",
      "Soak the area in an enzyme detergent solution for at least an hour, longer for old marks.",
      "For yellowing, make a paste of oxygen bleach and warm water, work it in, and leave it 30 minutes before washing.",
      "Wash on the hottest setting the label allows, and air dry. Heat from a dryer sets anything left behind permanently.",
      "Repeat once. If two rounds have not shifted it, the fibres are stained through and it will not move.",
    ],
    prevention: "The yellowing is aluminium, so it is the antiperspirant rather than the sweat. Let it dry fully before dressing, wash shirts after every wear rather than airing them, and never put an unwashed shirt through a hot dryer.",
    relatedSlugs: ["deodorant-marks", "stains-general", "collar-wear"],
    faqs: [
      {
        q: "Can pit stains be removed before selling?",
        a: "Fresh underarm stains often lift with an oxygen or enzyme presoak, but set-in yellowing that has stiffened the fabric is usually permanent. Never use chlorine bleach — it reacts with the residue and locks the yellow color in.",
      },
    ],
  },
  {
    slug: "crocking",
    name: "Crocking",
    alternateNames: ["dye transfer", "color rub-off", "dye crocking"],
    title: "Crocking: Dye That Rubs Off",
    description:
      "Crocking is unfixed dye leaving the garment, so there is nothing to remove. How to stop it marking everything else, and how to treat what it already stained.",
    h1: "Crocking (dye transfer)",
    definition:
      "Crocking is the rubbing-off of dye from one fabric onto another or onto skin, typical of raw denim, dark dyes, and cheaply finished garments. It shows as color transfer at pockets, cuffs, and collars, and because it signals unstable dye it lowers both cosmetic and fabric-condition grades.",
    howToDetect: [
      "Rub a damp white cloth firmly across a dark panel and check for color pickup",
      "Inspect where dark fabric meets light — waistbands, pocket bags, inner cuffs",
      "Look for blue or black tinting on the garment's own lighter contrast areas",
    ],
    gradeImpact:
      "Crocking is weighed under Cosmetic Appearance (20%) and Fabric Condition (30%). Minor dry rub on raw denim is expected and stays near Very Good (7); heavy transfer that stains adjacent panels or won't stop after washes pushes toward Fair (5).",
    fixability:
      "Partly manageable, not curable. Repeated cold washes with a dye fixative or vinegar rinse reduce loose surface dye, but the tendency stays. It's a property of the dye, so it can be lessened, never fully removed.",
    disclosure:
      "Warn buyers explicitly ('raw denim, will crock onto light surfaces until washed'). Crocking that ruins a buyer's couch or shirt is a classic dispute, and the warning shifts responsibility fairly.",
    comesOut: "no",
    removalHeading: "Crocking cannot be reversed: the dye has already gone",
    removal: [
      "Nothing brings it back. Crocking is unfixed dye rubbing off onto something else, so the damage is a loss from the garment, not a deposit on it.",
      "Washing a crocking garment removes the loose surface dye, which stops it marking other things but leaves the faded look.",
      "The dye it deposited on other garments is a separate problem: treat that as a colour-bleed stain, quickly, before it sets.",
    ],
    prevention: "Wash new dark denim and anything raw or overdyed on its own, cold, inside out, before the first wear. A cup of white vinegar in the first wash is folklore for setting dye and does very little; washing separately does the work.",
    relatedSlugs: ["color-bleeding", "sun-fading"],
    faqs: [
      {
        q: "Is crocking the same as color bleeding?",
        a: "No. Crocking is dry dye rubbing off from friction onto skin or fabric, while color bleeding is dye running out into water during a wash. Both come from unstable dye, but crocking happens dry and bleeding happens wet.",
      },
    ],
  },
  {
    slug: "seam-stress",
    name: "Seam stress",
    alternateNames: ["seam slippage", "blown seams", "open seams"],
    title: "How to Fix a Split or Stressed Seam",
    description:
      "Where a seam failed decides whether it resews. The interfacing step that stops a repair tearing again, and the allowance that means it will not hold.",
    h1: "Seam stress and blown seams",
    definition:
      "Seam stress is the strain, slippage, or bursting of a garment's stitched joins, where threads pull open and let daylight show through the seam. It appears at shoulders, side seams, crotches, and armholes, and because it undermines how the piece holds together it weighs on structural integrity.",
    howToDetect: [
      "Gently pull the fabric either side of a seam and watch for a widening gap",
      "Hold high-stress seams (crotch, underarm, shoulder) to the light for pinholes",
      "Check for a row of stitch holes where thread has already snapped",
    ],
    gradeImpact:
      "Seam stress lands on Structural Integrity (25%). Slight puckering or a single loose stitch stays around Very Good (7); visible slippage that gaps open, or a fully blown seam, drops the item to Fair (5) or Poor (3–4) as a repair piece.",
    fixability:
      "Usually repairable. A restitch or serge closes an open seam and can recover grade, and slippage-prone loose weaves can be reinforced. Any repair must then be disclosed, since restitched seams change the original construction.",
    disclosure:
      "Say where and how bad ('side seam starting to slip near the hem'). Photograph the gap against light. Seam failures spread under wear, so understating them reliably leads to returns.",
    comesOut: "sometimes",
    removalHeading: "How to deal with a stressed or split seam",
    removal: [
      "Turn the garment inside out and find where the stitching has actually gone. Puckering usually starts before the thread breaks.",
      "A split seam on a straight run resews easily: backstitch by hand or run it through a machine 3mm outside the original line.",
      "Where the fabric itself has pulled away from the stitch line, add a strip of fusible interfacing behind it first. Sewing straight back into torn fibres tears again.",
      "Seams under real tension (crotch, armhole, waistband on a fitted garment) need the seam allowance checked. If there is under 6mm to work with, a repair will not hold.",
    ],
    prevention: "Most seam stress is a sizing problem rather than a quality one. Buy for the widest part, do not force a fastening, and hang trousers rather than folding them at the hip.",
    relatedSlugs: ["holes-tears", "fraying", "lining-tears"],
    faqs: [
      {
        q: "What's the difference between seam stress and a hole?",
        a: "Seam stress is the stitching giving way along a join, so the fabric separates where two panels meet. A hole is a break in the fabric itself. Seam failures are often repairable by restitching; a hole in the panel is harder to fix invisibly.",
      },
    ],
  },
  {
    slug: "cracked-graphics",
    name: "Cracked graphics",
    alternateNames: ["cracked print", "peeling print", "distressed graphic"],
    title: "Cracked Print on a Shirt: Any Fix?",
    description:
      "A cracked screen print cannot be repaired, and ironing it makes it worse. Why some cracking raises the price instead, and how to stop the rest from spreading.",
    h1: "Cracked and peeling graphics",
    definition:
      "Cracked graphics are the splits, flaking, and peeling of a screen-printed or heat-pressed design, where the plastisol ink hardens and breaks along fold lines. Common on vintage tees and logo hoodies, it can be an authentic patina or a defect, and it counts under cosmetic appearance.",
    howToDetect: [
      "Flex the printed area gently and watch for the ink to crack or lift",
      "Look along fold and stretch lines, where plastisol splits first",
      "Check for missing flakes that leave gaps in letters or the logo",
    ],
    gradeImpact:
      "Cracked graphics sit under Cosmetic Appearance (20%). On a vintage tee, even, intentional-looking cracking is desirable patina and barely moves an Excellent (8) grade; on a newer piece, heavy peeling that erases the design pulls it toward Good (6) or Fair (5).",
    fixability:
      "Essentially permanent. There's no reliable way to re-bond flaked plastisol at home, and heat can worsen it. For vintage buyers the cracking is often the appeal, so it's disclosed as patina rather than repaired.",
    disclosure:
      "Describe the print state ('graphic has authentic vintage cracking, no flaking loss') and photograph it close. Distinguish stable patina from active flaking, since buyers price those very differently.",
    comesOut: "no",
    removalHeading: "Cracked prints do not come back",
    removal: [
      "There is no repair. A screen print cracks because the plastisol has aged and gone brittle, and the missing pieces are gone.",
      "Do not iron it to flatten the cracks. Direct heat melts what is left and welds it to the plate or the iron.",
      "Some cracking is desirable and prices upward. Vintage tees are often bought FOR the cracked print, so check the comps before you treat it as damage at all.",
    ],
    prevention: "Wash inside out, cold, and never tumble dry a printed tee. Heat and abrasion are what crack a print, and the dryer supplies both at once.",
    relatedSlugs: ["patch-loss", "button-fading"],
    faqs: [
      {
        q: "Does a cracked graphic always lower the grade?",
        a: "Not much on vintage pieces, where even cracking reads as desirable patina and is graded lightly. On newer garments, heavy peeling that removes parts of the design is a defect and pulls the cosmetic grade down toward Good or Fair.",
      },
    ],
  },
  {
    slug: "missing-buttons",
    name: "Missing buttons",
    alternateNames: ["lost buttons", "absent fasteners"],
    title: "How to Replace a Missing Button",
    description:
      "Where the spare is hidden, why you take the replacement from the bottom of the shirt, and the shank wrap that stops the next button falling off.",
    h1: "Missing buttons",
    definition:
      "Missing buttons are fasteners that have fallen off a shirt, coat, or cardigan, leaving empty thread shanks or bare holes where they belong. They interrupt closure, are easy to overlook on a spare cuff button, and count under functional elements because they affect whether the garment can be worn as designed.",
    howToDetect: [
      "Count buttons against buttonholes — one extra hole means one is gone",
      "Check the spare-button pocket and cuff plackets, where losses hide",
      "Look for loose, dangling buttons that will be missing on arrival",
    ],
    gradeImpact:
      "Missing buttons are graded under Functional Elements (15%). A single missing spare or interior button is minor and stays near Very Good (7); a missing front or cuff button that stops the garment closing properly pushes it to Good (6) or Fair (5).",
    fixability:
      "Easily fixed and often worth it. A matching replacement, or moving a spare from an inside seam, restores function and grade. Mismatched replacements should themselves be disclosed as non-original.",
    disclosure:
      "State which button is gone ('missing second-from-top front button') and whether a spare is included. Buyers forgive a disclosed missing button; a photo that hides the gap does not.",
    comesOut: "yes",
    removalHeading: "How to replace a missing button properly",
    removal: [
      "Check the inside seam first. Most shirts and coats carry a spare stitched into the placket or the lining.",
      "If there is no spare, take a button from the lowest point of the shirt, where it tucks in and is never seen, and put the odd one there.",
      "Sew with doubled thread, and put a matchstick across the button as you stitch so it ends with a shank. A button sewn flat against the fabric will not sit or fasten properly.",
      "Wrap the thread six times around the shank before you finish. That wrap is what stops the next one falling off.",
    ],
    prevention: "Buttons go because the thread abrades, not because the button fails. When one starts to loosen, resew all of them; the rest are the same age.",
    relatedSlugs: ["broken-zipper", "button-fading"],
    faqs: [
      {
        q: "How much does one missing button lower the grade?",
        a: "A single missing interior or spare button is minor and barely moves the grade. A missing functional front or cuff button that stops the garment closing as designed is weighed under Functional Elements and drops it toward Good or Fair.",
      },
    ],
  },
  {
    slug: "broken-zipper",
    name: "Broken zipper",
    alternateNames: ["stuck zipper", "separated zipper", "faulty zip"],
    title: "How to Fix a Broken Zipper",
    description:
      "Nine times in ten it is the slider, not the teeth. How to tell which you have, how to crimp it safely, and the one failure that means the zip is finished.",
    h1: "Broken zipper",
    definition:
      "Broken zippers are fasteners that no longer function — a separated slider, missing teeth, a stuck pull, or a zip that splits open after closing. Found on jackets, jeans, and boots, they directly block how a garment is worn and are judged under functional elements on the grade.",
    howToDetect: [
      "Zip the closure fully up and down several times, feeling for catches",
      "After closing, tug the two sides apart to check the zip doesn't split",
      "Inspect the teeth or coil for gaps, bends, or a slider that skips",
    ],
    gradeImpact:
      "A broken zipper is a Functional Elements (15%) issue and often decisive. A sticky pull that still works stays near Good (6); a zipper that won't close, separates under load, or has lost teeth caps the item at Fair (5) or Poor (3–4) until repaired.",
    fixability:
      "Frequently repairable. A new slider, stops, or a full zipper replacement by a tailor restores function, though it's a paid repair. A replaced zipper is non-original and should be disclosed as such.",
    disclosure:
      "Describe the exact failure ('zipper separates at the base when closed'). A broken main closure is a grade-defining flaw, so buyers must know before they pay, not discover it at home.",
    comesOut: "sometimes",
    removalHeading: "How to fix a zipper that is not closing",
    removal: [
      "Work out which part failed. Nine times in ten it is the slider, not the teeth.",
      "If the teeth separate behind the slider as you zip, the slider has worn open. Squeeze it very gently with pliers, a fraction at a time, and test between squeezes.",
      "If a tooth is bent, straighten it with needle-nose pliers before touching the slider. A bent tooth destroys a new slider immediately.",
      "If the slider has come off entirely, pry off the metal stop at the bottom, feed both sides back through, and crimp the stop back on.",
      "If teeth are missing, the zip is finished. Replacement is the only fix and on most garments it costs more than the garment.",
    ],
    prevention: "Zip a garment up before washing it. An open zip in a machine is what bends teeth, and it also snags everything else in the drum.",
    repair: {
      name: "Fix a zipper that will not stay closed",
      difficulty: "Moderate",
      minutes: 15,
      cost: "Free, or under $5 for a replacement slider",
      tools: ["Needle-nose pliers"],
      supplies: ["Replacement slider, only if crimping fails"],
      steps: [
        {
          name: "Work out what actually failed",
          text: "Zip it and watch. If the teeth separate behind the slider as it passes, the slider has worn open. If a tooth is bent or missing, that is a different problem and the slider is fine.",
        },
        {
          name: "Straighten any bent tooth first",
          text: "Grip the tooth with needle-nose pliers and ease it back into line. Skipping this destroys a new slider on its first pass.",
        },
        {
          name: "Crimp the slider a fraction at a time",
          text: "Squeeze the back of the slider gently, top and bottom, and test after every squeeze. Overtightening jams it permanently, and there is no way back from that.",
        },
        {
          name: "Refeed the slider if it came off",
          text: "Pry the metal stop off the bottom of the zip, feed both tapes back through the slider evenly, run it up to check, then crimp the stop back on.",
        },
        {
          name: "Know when to stop",
          text: "If teeth are missing rather than bent, the zip is finished. Replacement is the only fix, and on most garments a tailor charges more than the garment is worth.",
        },
      ],
    },
    relatedSlugs: ["missing-buttons", "elastic-degradation"],
    faqs: [
      {
        q: "Is a broken zipper worth repairing before resale?",
        a: "Often yes. A tailor can replace a slider or the whole zipper, which restores function and lifts the grade out of the Fair or Poor range. Factor the repair cost against the item's value, and disclose that the zipper is a non-original replacement.",
      },
    ],
  },
  {
    slug: "fabric-thinning",
    name: "Fabric thinning",
    alternateNames: ["worn-thin fabric", "sheer wear", "threadbare"],
    title: "Thin, Worn Fabric: What Can Be Done",
    description:
      "Thinning cannot be reversed because the fibres are gone. How to stop it becoming a hole, and the wash habits that cause most of it.",
    h1: "Fabric thinning",
    definition:
      "Fabric thinning is the loss of material where a textile has been abraded so much that it grows sheer, weak, and close to wearing through. It appears at elbows, knees, seats, and collar folds, often before an actual hole forms, and it weighs heavily on the fabric-condition factor.",
    howToDetect: [
      "Hold high-wear zones to a light — thinned areas glow noticeably brighter",
      "Gently stretch the seat or knees; thin fabric feels weak and gauzy",
      "Compare an elbow or knee against an unworn area of the same panel",
    ],
    gradeImpact:
      "Fabric thinning is a Fabric Condition (30%) flaw and a pre-failure signal. Slight sheerness at one elbow keeps an item in Good (6); widespread thinning that's about to open into holes drops it to Fair (5) or Poor (3–4).",
    fixability:
      "Not truly fixable. Iron-on backing or reinforcement patches can delay a blowout but can't restore lost fibers, and they change the garment. It's best treated as a disclosed, terminal-stage wear flaw.",
    disclosure:
      "Call it out honestly ('fabric worn thin at the seat, near see-through'). Thinning that photographs fine but tears on first wear is a top return driver, so a light-through photo is worth including.",
    comesOut: "no",
    removalHeading: "Thin fabric cannot be thickened",
    removal: [
      "Nothing restores it. The fibres have abraded away and what is left is what you have.",
      "Fusible interfacing on the back stops it becoming a hole and stiffens the area visibly. On a garment worth keeping, that trade is often worth it.",
      "Do not press a thin area with a hot iron. It will go through.",
    ],
    prevention: "Thinning is friction plus washing. Wash less, wash cold, skip the dryer, and rotate what you wear. A garment worn twice a week thins about three times as fast as the same garment worn weekly.",
    relatedSlugs: ["pilling", "holes-tears", "collar-wear"],
    faqs: [
      {
        q: "Is fabric thinning the same as a hole?",
        a: "No — thinning is the stage before a hole. The material is worn sheer and weak but still intact, whereas a hole is already open. Thinning graded under Fabric Condition warns that a hole is imminent at that spot on the next wear.",
      },
    ],
  },
  {
    slug: "snags-pulls",
    name: "Snags and pulls",
    alternateNames: ["pulled threads", "snagged yarn", "loops"],
    title: "How to Fix a Snag in a Sweater",
    description:
      "Never cut a snag. Pull the loop through to the inside and spread the slack along the row, and the knit closes back over it as if nothing happened.",
    h1: "Snags and pulls",
    definition:
      "Snags and pulls are loops of yarn dragged out of a weave or knit by a sharp object, leaving raised threads or puckered dimples without an actual hole. Common on sweaters, tights, and silky fabrics, they read as cosmetic when few but signal fragile fabric-condition when widespread across a piece.",
    howToDetect: [
      "Angle the garment under light to catch raised loops casting shadows",
      "Look for puckered dimples where a pull has tightened the surrounding weave",
      "Run a hand over knits and delicate wovens to feel snags you can't see",
    ],
    gradeImpact:
      "Snags are weighed under Fabric Condition (30%). A stray snag or two is cosmetic and keeps an item near Excellent (8); many snags, or a large pull that distorts the weave, drop it toward Good (6) or Fair (5).",
    fixability:
      "Often improvable. A snag tool or crochet hook can draw a pulled loop back to the wrong side, smoothing the surface, though a pull that has already puckered the weave may not fully relax.",
    disclosure:
      "Note quantity and location ('a few small snags on the left sleeve'). Snags photograph poorly, so a raking-light close-up prevents the 'more than expected' complaint on delicate knits.",
    comesOut: "yes",
    removalHeading: "How to fix a snag without making a hole",
    removal: [
      "Never cut it. A cut loop unravels along the row and turns a snag into a hole.",
      "Gently stretch the fabric across the snag in both directions. Some of the pulled yarn retracts on its own.",
      "Push a snag needle or fine crochet hook through from the inside, catch the loop, and pull it through to the wrong side.",
      "Work the remaining slack outward along the row a stitch at a time, in both directions, so no single stitch carries the excess.",
      "Steam the area and let it dry flat. Most snags become invisible at this point.",
    ],
    prevention: "Snags come from jewellery, velcro, rough nails and zips in the same wash load. Rings and watches off before dressing, knitwear in a mesh bag, and fasten every zip in the drum.",
    repair: {
      name: "Fix a snag in a sweater",
      difficulty: "Easy",
      minutes: 10,
      cost: "Under $10 for a snag needle",
      tools: ["Snag needle or fine crochet hook", "Steam iron or kettle"],
      supplies: [],
      steps: [
        {
          name: "Do not cut it",
          text: "A cut loop unravels along the row and turns a ten-minute fix into a hole. Whatever else you do, the loop stays attached.",
        },
        {
          name: "Stretch the fabric across the snag",
          text: "Hold the knit either side of the pull and stretch gently, first along the row and then across it. Some of the yarn retracts on its own before you touch a tool.",
        },
        {
          name: "Push the needle through from the wrong side",
          text: "Work from inside the garment. Push the snag needle through at the base of the pulled loop so its latch or hook comes up beside the loop on the right side.",
        },
        {
          name: "Catch the loop and draw it inside",
          text: "Hook the loop, then pull the needle back through. The pulled yarn now sits on the inside of the garment where nobody sees it.",
        },
        {
          name: "Spread the slack along the row",
          text: "The yarn is still too long, so the stitches around it are still distorted. Work the excess outward a stitch at a time in both directions until no single stitch is carrying it.",
        },
        {
          name: "Steam and dry flat",
          text: "Steam relaxes the fibres back into shape. Lay the garment flat to dry. Most snags are invisible at this point.",
        },
      ],
    },
    relatedSlugs: ["pilling", "fabric-thinning"],
    faqs: [
      {
        q: "Can a snag be fixed without leaving a mark?",
        a: "Usually. A snag tool or crochet hook pulls the loose loop through to the inside, which smooths the surface for most knits and wovens. A pull that has already puckered the surrounding weave may relax only partway and stay faintly visible.",
      },
    ],
  },
  {
    slug: "stains-general",
    name: "Stains",
    alternateNames: ["spots", "marks", "discoloration"],
    title: "How to Get a Stain Out of Clothing",
    description:
      "Blot, cold water, outside-in, and never the dryer. The order that decides whether a stain comes out, and why how long it sat matters more than the product.",
    h1: "Stains on clothing",
    definition:
      "Stains are localized discolorations left by food, drink, grease, cosmetics, or bodily fluids that soak into fibers and resist casual washing. They range from a faint water ring to a set-in grease mark, appear anywhere on a garment, and count against both cleanliness and cosmetic appearance depending on size and visibility.",
    howToDetect: [
      "Inspect in bright, even light and again at a raking angle for sheen",
      "Check high-risk zones: front chest, lap, cuffs, and collar",
      "Turn the piece to catch grease marks that only show as a subtle gloss",
    ],
    gradeImpact:
      "Stains split across Odor & Cleanliness (10%) and Cosmetic Appearance (20%). A small, hidden mark keeps an item near Very Good (7); a prominent front-and-center stain that won't wash out pulls it to Fair (5) or below.",
    fixability:
      "Depends on the stain. Fresh water-based marks often wash out; set-in grease, ink, and protein stains resist and may be permanent. Always attempt cleaning before grading, since a lifted stain can meaningfully raise the result.",
    disclosure:
      "Pinpoint it ('quarter-sized faint stain on lower front'), give a size reference, and photograph it. A disclosed stain is priced accordingly; a hidden one that shows up in daylight drives 'not as described' claims.",
    comesOut: "sometimes",
    removalHeading: "How to approach a stain you cannot identify",
    removal: [
      "Blot, never rub. Rubbing drives the stain into the fibre and abrades the surface around it, which shows even after the stain goes.",
      "Start with cold water. Heat sets protein stains, which is most of the ones on clothing, and once set they never come out.",
      "Work from the outside of the mark inward, or you will spread it into a larger, fainter ring.",
      "If cold water alone does nothing, use an enzyme detergent and give it an hour, not five minutes.",
      "Air dry and check in daylight before it goes anywhere near a dryer. A dryer is the step that makes a nearly-gone stain permanent.",
    ],
    prevention: "The single biggest factor is how long it sat. A fresh stain rinsed in cold water usually goes; the same stain found six months later usually does not, whatever you put on it.",
    relatedSlugs: ["ink-stains", "rust-spots", "bleach-spots"],
    faqs: [
      {
        q: "Should I try to remove a stain before grading an item?",
        a: "Yes. Many fresh, water-based stains wash out, and a lifted stain can raise the grade a full tier. Set-in grease, ink, or protein stains may be permanent — grade and disclose those honestly rather than hiding them in a flattering photo.",
      },
    ],
  },
  {
    slug: "holes-tears",
    name: "Holes and tears",
    alternateNames: ["rips", "punctures", "splits"],
    title: "How to Fix a Hole in Jeans or Anything",
    description:
      "Stabilise the edges first, then pick ladder stitch, a backing patch, or machine darning by what kind of opening you actually have.",
    h1: "Holes and tears",
    definition:
      "Holes and tears are breaks in the fabric where fibers have been severed or ripped apart, from a small puncture to a long split along a seam or panel. Unlike thinning, the material is already open, so they are structural damage that caps the grade well below the Excellent tiers.",
    howToDetect: [
      "Hold the garment up to a light and scan for pinholes glowing through",
      "Check pocket corners, hems, and belt lines where tears start",
      "Stretch suspect areas gently to reveal a small hole hiding in the weave",
    ],
    gradeImpact:
      "Holes and tears are Structural Integrity (25%) damage. A single tiny pinhole caps an item below Excellent, landing near Good (6); an obvious hole or a long tear drops it to Fair (5) or Poor (3–4) as a repair or reclaim piece.",
    fixability:
      "Repairable but rarely invisible. Darning, patching, or reweaving closes a hole and can lift a Poor piece to a sellable repaired grade; the mend itself must then be disclosed as a repair.",
    disclosure:
      "Measure and locate each one ('1 cm hole near left pocket') and photograph with a scale. A hole is the flaw buyers least tolerate as a surprise, so precise disclosure is essential.",
    comesOut: "sometimes",
    removalHeading: "How to mend a hole or a tear",
    removal: [
      "Stabilise the edges before anything else. A few drops of fray stopper or a running stitch around the opening stops it growing while you work.",
      "For a clean tear along the grain, close it with a ladder stitch from the right side; it disappears into the weave.",
      "For a hole with missing fabric, back it with a patch cut 25mm larger than the hole on every side and secure from the inside.",
      "On denim, darn across the hole with a machine in matching thread over a backing patch. That is what every commercial repair does.",
      "Accept that a mend shows. The goal is a repair that reads as deliberate, not one that reads as hidden.",
    ],
    prevention: "Most holes on used clothing start as thinning or a snag, both of which are visible months earlier. Catching them at that stage is the whole game.",
    repair: {
      name: "Mend a hole in jeans",
      difficulty: "Moderate",
      minutes: 30,
      cost: "Under $10",
      tools: ["Sewing machine, or a needle for hand darning", "Scissors", "Pins"],
      supplies: ["Backing patch in matching denim", "Thread matching the fabric"],
      steps: [
        {
          name: "Stabilise the edges",
          text: "A running stitch or a few drops of fray stopper around the opening stops it growing while you work. Skip this and the hole is bigger by the time you finish.",
        },
        {
          name: "Wash and dry the garment first",
          text: "Denim shrinks. Patching before the first wash means the patch puckers afterwards.",
        },
        {
          name: "Cut the backing patch oversized",
          text: "At least 25mm larger than the hole on every side, so the stitching lands on sound fabric rather than on the weakened edge.",
        },
        {
          name: "Pin the patch inside, aligned with the grain",
          text: "Match the direction of the weave. A patch set across the grain reads as a repair from across a room.",
        },
        {
          name: "Darn across the opening",
          text: "Straight rows of machine stitching across the hole, then a second set at right angles. This is what a commercial repair does, and the density of the rows is what decides whether it holds.",
        },
        {
          name: "Press and check from the right side",
          text: "A mend shows. The goal is a repair that reads as deliberate rather than as concealment.",
        },
      ],
    },
    relatedSlugs: ["moth-holes", "fabric-thinning", "seam-stress"],
    faqs: [
      {
        q: "Can a hole be repaired well enough to raise the grade?",
        a: "Yes. Professional reweaving or careful darning can close a hole and lift a Poor piece into a sellable repaired grade. The repair is rarely fully invisible, though, so disclose that the area was mended rather than presenting it as undamaged.",
      },
    ],
  },
  {
    slug: "fraying",
    name: "Fraying",
    alternateNames: ["frayed edges", "unraveling", "worn edges"],
    title: "How to Stop a Frayed Edge Spreading",
    description:
      "Trim flush, never pull. Fray stopper, when to turn and restitch instead, and when a frayed denim hem is worth more left alone.",
    h1: "Fraying",
    definition:
      "Fraying is the unraveling of fabric edges where threads work loose and hang free, most often along hems, cuffs, collars, and unfinished seams. It can be incidental wear or an intended distressed look; when unintended it signals declining construction and weighs on both structural integrity and cosmetic appearance.",
    howToDetect: [
      "Run a finger along hems and cuffs to catch loose, lifting threads",
      "Check collar points and pocket edges, where fraying starts early",
      "Decide if the edge is finished-then-worn or designed raw and distressed",
    ],
    gradeImpact:
      "Fraying is weighed under Cosmetic Appearance (20%) and Structural Integrity (25%). Light edge fuzz keeps an item near Very Good (7); heavy fraying that unravels a hem or eats into a cuff pushes it to Good (6) or Fair (5) — unless the raw edge is clearly by design.",
    fixability:
      "Often stabilized rather than reversed. A tailor can re-hem or overlock a fraying edge, and fray-check sealant halts unraveling, but lost threads don't return. Any re-hem shortens or alters the garment and should be noted.",
    disclosure:
      "Distinguish designed from damaged ('hem fraying from wear, not distressing'). Buyers accept honest edge wear, but selling worn fraying as an intended raw hem invites disputes.",
    comesOut: "sometimes",
    removalHeading: "How to stop a frayed edge getting worse",
    removal: [
      "Trim the loose threads flush. Do not pull them, which drags more thread out of the weave.",
      "Run a thin line of fray stopper along the edge and let it dry fully. It stiffens slightly and darkens light fabrics, so test somewhere hidden.",
      "For a frayed hem or cuff, the durable fix is to turn and restitch it, which shortens the garment by the amount you turn.",
      "On denim, a light fray at the hem is often desirable and sells well. Check before you fix it.",
    ],
    prevention: "Fraying starts where a cut edge was never finished or where the finishing has worn through. Wash cold, skip the dryer, and repair a hem the first time it lets go rather than the third.",
    relatedSlugs: ["hemline-damage", "seam-stress", "collar-wear"],
    faqs: [
      {
        q: "How do I know if fraying is a flaw or a design feature?",
        a: "Check whether the edge was originally finished. A hem or cuff that was sewn and has since unraveled is wear and lowers the grade. A raw, deliberately distressed edge built that way by the maker is design and is graded against the as-made state.",
      },
    ],
  },
  {
    slug: "shrinkage",
    name: "Shrinkage",
    alternateNames: ["shrunk garment", "size loss"],
    title: "How to Unshrink Clothes",
    description:
      "Conditioner relaxes the fibres and detergent does not. The 30-minute soak and flat-stretch that recovers most of the size, and the point where it stops working.",
    h1: "Shrinkage",
    definition:
      "Shrinkage is the permanent reduction in a garment's dimensions after hot washing or drying, most severe in untreated cotton, wool, and rayon. It shows as short sleeves, a cropped body, or tight fit versus the labeled size, and while not damage exactly, it misrepresents size and affects fit-driven grading.",
    howToDetect: [
      "Measure the garment flat and compare to the brand's size chart",
      "Check for a body length or sleeve that reads short for the tag size",
      "Look for a puckered, distorted print where the fabric shrank around it",
    ],
    gradeImpact:
      "Shrinkage is judged against the garment's fit and sizing accuracy rather than surface wear. A slightly shrunk piece with honest measurements can still grade Very Good (7); a badly shrunk item that no longer matches its label reads down toward Good (6) with a strong sizing note.",
    fixability:
      "Occasionally partly reversible. Soaking wool in hair conditioner and gently stretching can recover some size; cotton and synthetics rarely bounce back. Most shrinkage is treated as permanent and handled by re-measuring.",
    disclosure:
      "Sell by measurement, not tag ('labeled L but shrunk to fit like M — see measurements'). Shrinkage that isn't disclosed produces a fit complaint even when the item is otherwise flawless.",
    comesOut: "sometimes",
    removalHeading: "How to unshrink a garment",
    removal: [
      "Fill a basin with lukewarm water and add a capful of hair conditioner or baby shampoo. The conditioner relaxes the fibres; detergent will not.",
      "Soak for up to 30 minutes. Wool and cotton both need the full time.",
      "Squeeze the water out without rinsing, then roll the garment in a towel and press to get it damp rather than wet.",
      "Lay it flat and stretch it gently back to size a section at a time, working outward from the middle. Pin it to shape on a towel if it will not hold.",
      "Let it dry flat, fully, before you move it. Most of the recovery is lost if you hang it wet.",
    ],
    prevention: "Cotton shrinks from heat, wool shrinks from agitation plus heat, and both are irreversible once felting has started. Wash cold, and air dry anything you care about.",
    repair: {
      name: "Unshrink a shrunken garment",
      difficulty: "Easy",
      minutes: 45,
      cost: "A capful of conditioner",
      tools: ["Basin or sink", "Two dry towels"],
      supplies: ["Hair conditioner or baby shampoo"],
      steps: [
        {
          name: "Fill a basin with lukewarm water",
          text: "Lukewarm, not hot. Heat is what shrank it and more heat will shrink it further.",
        },
        {
          name: "Add conditioner, not detergent",
          text: "One capful of hair conditioner or baby shampoo. Conditioner coats the fibres and lets them slide past each other; detergent does the opposite and will do nothing here.",
        },
        {
          name: "Soak for up to 30 minutes",
          text: "Cotton and wool both need the full time. This is the step that does the work, and rushing it is why most attempts fail.",
        },
        {
          name: "Squeeze out the water without rinsing",
          text: "Leave the conditioner in. Press the water out rather than wringing, which twists fibres you are about to stretch.",
        },
        {
          name: "Roll in a towel",
          text: "Lay the garment on a dry towel, roll the two together, and press. You want it damp rather than wet, because a soaking garment tears when stretched.",
        },
        {
          name: "Stretch back to size on a second towel",
          text: "Work outward from the middle, a section at a time, easing rather than yanking. Pin it to shape if it will not hold.",
        },
        {
          name: "Dry flat and completely",
          text: "Do not move it until it is dry. Hanging it wet undoes most of what you just recovered.",
        },
      ],
    },
    relatedSlugs: ["felting", "stretching"],
    faqs: [
      {
        q: "Should I list a shrunk item by its tag size?",
        a: "No. List it by actual flat measurements and note that it has shrunk from the labeled size. Tag size is meaningless once a cotton or wool piece has shrunk, and selling on the tag alone reliably produces a fit-based return.",
      },
    ],
  },
  {
    slug: "stretching",
    name: "Stretching",
    alternateNames: ["bagging", "misshapen", "stretched out"],
    title: "How to Fix a Stretched Out Collar",
    description:
      "Cotton comes back with heat and wool with careful felting; anything with failed elastane does not come back at all. Which one you have decides everything.",
    h1: "Stretching and bagging",
    definition:
      "Stretching is the permanent loss of a garment's original shape, where knit collars, cuffs, waistbands, and knees bag out and no longer recover. Caused by wear, hanging, or blown-out elastic, it leaves the piece misshapen and loose, and it weighs on structural integrity and how the item reads cosmetically.",
    howToDetect: [
      "Check knit collars and cuffs for a wavy, loose edge that won't snap back",
      "Look for bagged knees, elbows, and seats that hold a stretched shape",
      "Pull a waistband and release it — worn elastic stays slack",
    ],
    gradeImpact:
      "Stretching sits across Structural Integrity (25%) and Cosmetic Appearance (20%). A slightly relaxed cuff stays near Very Good (7); a permanently bagged collar, knees, or waistband that changes the silhouette drops the item toward Good (6) or Fair (5).",
    fixability:
      "Sometimes partly recoverable. Steaming and reshaping tightens mildly stretched knits, and a tailor can take in a bagged waist; badly stretched ribbing and elbows usually stay misshapen for good.",
    disclosure:
      "Describe where it's lost shape ('collar stretched and no longer sits flat'). Stretching is subtle in flat-lay photos, so mention it and show the garment on a form if you can.",
    comesOut: "sometimes",
    removalHeading: "How to shrink a stretched garment back",
    removal: [
      "Identify the fibre first. Cotton and wool can be brought back; anything with elastane that has gone slack is finished, because the elastic itself has failed.",
      "For cotton, wash hot and tumble dry. That is the exact process everyone else is trying to avoid, and here it is the fix.",
      "For wool, wet the stretched area with warm water, work it gently between your hands, and lay it flat to reshape. Stop early; this is felting under control and it does not reverse.",
      "For a stretched neckline or cuff specifically, steam it and let it dry flat, which recovers more than washing does.",
    ],
    prevention: "Hanging is what stretches knitwear, at the shoulders and down the body. Fold anything knitted. Hang anything woven.",
    repair: {
      name: "Fix a stretched-out collar or cuff",
      difficulty: "Easy",
      minutes: 20,
      cost: "Free",
      tools: ["Steam iron or kettle", "Towel"],
      supplies: [],
      steps: [
        {
          name: "Check the fibre before you do anything",
          text: "Cotton and wool come back. Anything with elastane that has gone slack does not, because the elastic itself has failed and no amount of heat restores it.",
        },
        {
          name: "Wet the stretched area only",
          text: "Warm water on the collar or cuff, not the whole garment. Treating the whole thing shrinks parts that were fine.",
        },
        {
          name: "Work it gently between your hands",
          text: "For wool, a small amount of controlled friction pulls the fibres back together. Stop early. This is felting under control and it does not reverse.",
        },
        {
          name: "Steam and reshape",
          text: "Steam the area and ease it back to the shape it should be, then hold it there for a few seconds as it cools.",
        },
        {
          name: "Dry flat",
          text: "Lay it on a towel in the right shape. Hanging it puts the weight of the garment straight back into the part you just fixed.",
        },
      ],
    },
    relatedSlugs: ["elastic-degradation", "shrinkage"],
    faqs: [
      {
        q: "Will a stretched-out collar go back to normal?",
        a: "Only partly. Steaming and reshaping can tighten a mildly relaxed knit collar, but ribbing that has permanently lost its recovery stays wavy and loose. Grade and disclose a badly stretched collar as a lasting shape flaw rather than assuming it will fix.",
      },
    ],
  },
  {
    slug: "color-bleeding",
    name: "Color bleeding",
    alternateNames: ["dye run", "color run", "wash bleeding"],
    title: "How to Get Bled Dye Out of Clothing",
    description:
      "Do not dry it. Rewash cold immediately, then colour-run remover on the exact packet timing, because these strip the garment's own colour too.",
    h1: "Color bleeding",
    definition:
      "Color bleeding is the migration of dye from one area or garment into another during washing, leaving pink-tinged whites or muddied panels. Distinct from crocking's dry rub, it happens wet and often ruins a light section permanently, so it counts against cosmetic appearance and, when severe, fabric-condition.",
    howToDetect: [
      "Inspect white or light panels next to dark ones for pink or grey tinting",
      "Check collars, plackets, and colorblocked seams where dye pools",
      "Look for an overall dulled, muddied cast on a formerly crisp color",
    ],
    gradeImpact:
      "Color bleeding is weighed under Cosmetic Appearance (20%). Faint, even tinting keeps an item near Good (6); a clearly bled panel or a ruined white section that can't be restored pulls it to Fair (5) or Poor (3–4).",
    fixability:
      "Occasionally rescued if caught fast. Re-washing immediately with a color-run remover can lift fresh bleeding; once the dye has set through a dryer cycle it's usually permanent, and bleaching risks new damage.",
    disclosure:
      "State it plainly ('white stripe has picked up a faint pink cast'). Bleeding onto light areas is obvious to buyers in person, so disclosing it up front keeps a transaction from turning into a return.",
    comesOut: "sometimes",
    removalHeading: "How to get bled dye out of a garment",
    removal: [
      "Do not dry it. Every attempt below stops working once the garment has been through heat.",
      "Rewash immediately, cold, on its own, with detergent and no other garments to bleed onto.",
      "If that fails, soak in a colour-run remover following the packet timing exactly. These are reducing agents and they will strip the garment's own colour if left too long.",
      "For white cotton only, oxygen bleach and a long soak is the safer second attempt.",
      "Check in daylight while damp. Dye looks lighter wet than it will dry.",
    ],
    prevention: "Separate by colour and wash anything new on its own the first time. A colour catcher sheet works and costs pennies against the garment it saves.",
    relatedSlugs: ["crocking", "bleach-spots"],
    faqs: [
      {
        q: "How is color bleeding different from crocking?",
        a: "Color bleeding happens wet — dye runs out during a wash and stains other fabric. Crocking happens dry — dye rubs off through friction onto skin or clothing. Both stem from unstable dye, but they're caused, tested, and disclosed differently.",
      },
    ],
  },
  {
    slug: "deodorant-marks",
    name: "Deodorant marks",
    alternateNames: ["antiperspirant buildup", "white marks", "deodorant residue"],
    title: "How to Remove Deodorant Marks",
    description:
      "A fresh smear rubs straight off with a dry sponge. Built-up crust needs a vinegar soak, and the yellowing underneath is a different problem entirely.",
    h1: "Deodorant marks",
    definition:
      "Deodorant marks are the white, waxy streaks or stiff buildup left by antiperspirant on the inside and underarms of tops. Often mistaken for staining, fresh marks brush off while long-term buildup sets into the weave, and they count under odor-and-cleanliness and, if crusted in, fabric-condition.",
    howToDetect: [
      "Turn the top inside out and look for waxy white streaking at the underarms",
      "Rub the area — surface residue smears while set-in buildup stays crusty",
      "Feel for stiffness in the underarm panel where product has accumulated",
    ],
    gradeImpact:
      "Deodorant marks fall under Odor & Cleanliness (10%). Light surface residue that brushes off is negligible and stays near Excellent (8); crusted, set-in buildup that has stiffened the underarm weave drops the item toward Good (6).",
    fixability:
      "Usually removable. A white-vinegar soak, an old nylon rubbed over the streak, or an enzyme wash lifts most buildup. Clean it before photographing, since residue reads as a permanent stain to buyers otherwise.",
    disclosure:
      "If it fully cleans, no note is needed; if buildup has stiffened the fabric, disclose that ('slight underarm residue that did not fully release'). Don't let removable residue photograph as a stain.",
    comesOut: "yes",
    removalHeading: "How to get deodorant build-up out",
    removal: [
      "For a fresh white smear, rub the fabric against itself, or use a dry sponge or a pair of tights. It lifts straight off.",
      "For built-up crust, soak the area in white vinegar for an hour, then work it with a soft brush.",
      "Follow with an enzyme detergent wash on the warmest setting the label allows.",
      "For yellowing underneath, treat it as a pit stain instead: this is aluminium bonded to protein and vinegar alone will not shift it.",
    ],
    prevention: "Apply less than feels necessary and let it dry completely before dressing. Most build-up comes from putting a shirt on over wet product.",
    relatedSlugs: ["pit-stains", "stains-general"],
    faqs: [
      {
        q: "Are deodorant marks the same as pit stains?",
        a: "No. Deodorant marks are surface product buildup — white, waxy streaks that usually wash out. Pit stains are yellow discoloration from sweat reacting with antiperspirant over time, which soaks in and often won't fully lift. One is cleanable, the other frequently permanent.",
      },
    ],
  },
  {
    slug: "smoke-odor",
    name: "Smoke odor",
    alternateNames: ["cigarette smell", "smoke smell", "tobacco odor"],
    title: "How to Get Smoke Smell Out of Clothes",
    description:
      "Airing outdoors removes more than any product. Then vinegar in the drum, baking soda in a bag, and never the dryer between attempts.",
    h1: "Smoke odor",
    definition:
      "Smoke odor is the stale, clinging smell of cigarette or fire smoke absorbed deep into fibers, padding, and linings. Invisible in photos but obvious on arrival, it is a leading cause of resale returns, resists a single wash, and is graded strictly under the odor-and-cleanliness factor.",
    howToDetect: [
      "Smell the underarms, lining, and any padding, where odor concentrates",
      "Seal the item in a bag briefly, then reopen and smell the trapped air",
      "Check structured or lined pieces most carefully — they hold smoke longest",
    ],
    gradeImpact:
      "Smoke odor is judged entirely under Odor & Cleanliness (10%) and it caps that factor hard. A faint smell that airs out keeps an item near Good (6); a strong, clinging smoke odor that survives washing drops it to Fair (5) or below regardless of visual condition.",
    fixability:
      "Often treatable, sometimes stubborn. Airing out, vinegar or baking-soda washes, and ozone treatment reduce or remove it; heavily saturated padding and linings can hold smoke through multiple attempts.",
    disclosure:
      "Always disclose ('comes from a smoke-free home' or 'faint smoke odor remains after washing'). Odor is the single most common invisible-flaw complaint, and no photo can substitute for the warning.",
    comesOut: "sometimes",
    removalHeading: "How to get smoke smell out of clothing",
    removal: [
      "Air it outdoors first, ideally in moving air, for a full day. This alone removes more than any product.",
      "Wash with an ordinary detergent plus a cup of white vinegar in the drum. Vinegar neutralises rather than masks.",
      "If it persists, seal the garment in a bag with an open box of baking soda for 48 hours, then rewash.",
      "Do not tumble dry between attempts. Heat bakes smoke residue into the fibres and after that nothing works.",
      "Accept that heavy, long-term smoke exposure in wool or a lined coat often does not come out at all.",
    ],
    prevention: "Smoke binds to oils in the fabric, so a clean garment holds less of it. Store clean, and never bag a garment that smells; enclosed air concentrates it.",
    relatedSlugs: ["mildew-odor", "stains-general"],
    faqs: [
      {
        q: "Can smoke odor be washed out completely?",
        a: "Often, but not always. Airing, vinegar or baking-soda washes, and ozone treatment remove most smoke odor from unlined garments. Structured pieces with padding and linings can trap smoke through several washes, so test by smell before grading and disclose any that remains.",
      },
    ],
  },
  {
    slug: "mildew-odor",
    name: "Mildew odor",
    alternateNames: ["musty smell", "mold smell", "damp odor"],
    title: "How to Get Mildew Smell Out of Clothes",
    description:
      "Sunlight kills what is producing the smell and it is the step people skip. Then a vinegar soak and the hottest wash the label allows.",
    h1: "Mildew and musty odor",
    definition:
      "Mildew odor is the damp, musty smell of mold that grows when fabric is stored wet or humid, sometimes with grey or black speckling. It penetrates fibers and can spread to nearby garments, signals possible staining and fiber weakening, and is judged under odor-and-cleanliness with a cosmetic penalty if spotting shows.",
    howToDetect: [
      "Smell for a damp, earthy, basement-like note, strongest at folds",
      "Inspect for grey, black, or pink speckling in creases and along hems",
      "Check storage-prone areas — pockets, cuffs, and the inside of collars",
    ],
    gradeImpact:
      "Mildew odor is weighed under Odor & Cleanliness (10%), with a Cosmetic Appearance (20%) hit if it has left spotting. A faint musty smell that airs out stays near Good (6); a strong odor plus visible mold speckling drops the item to Fair (5) or Poor (3–4).",
    fixability:
      "Sometimes removable. A vinegar soak, sunlight, and thorough drying kill light mildew and clear the smell; deep-set mold spotting can permanently discolor fibers and may return in humidity.",
    disclosure:
      "Disclose both smell and any marks ('musty odor with light grey speckling at the hem'). Mildew hints at how the piece was stored, and buyers who receive an undisclosed musty item almost always return it.",
    comesOut: "sometimes",
    removalHeading: "How to get mildew smell out",
    removal: [
      "Get it dry and get it into sunlight. UV kills the mould that is producing the smell, and this is the step people skip.",
      "Brush off any visible growth outdoors, not over a laundry basket.",
      "Soak in a solution of one part white vinegar to four parts water for an hour.",
      "Wash on the hottest setting the label allows, with detergent, and dry fully in the sun.",
      "If the smell returns as the garment warms, the growth is still in the fibres. Repeat once, then stop; a third round will not work either.",
    ],
    prevention: "Mildew needs damp and darkness. Never store anything even slightly damp, never leave a wash in the drum overnight, and do not store clothing in a sealed plastic tub in an unheated space.",
    relatedSlugs: ["smoke-odor", "rust-spots"],
    faqs: [
      {
        q: "Does mildew odor mean there's mold damage too?",
        a: "Often. The musty smell comes from mold, which can also leave grey, black, or pink speckling and weaken fibers where it grew. Inspect creases and hems for spotting whenever you detect the odor, and grade both the smell and any staining you find.",
      },
    ],
  },
  {
    slug: "rust-spots",
    name: "Rust spots",
    alternateNames: ["rust stains", "iron marks", "metal transfer"],
    title: "How to Get Rust Stains Out of Fabric",
    description:
      "Never use chlorine bleach on rust; it sets the mark permanently and darker. Lemon and salt in sun for whites, oxalic acid for everything else.",
    h1: "Rust spots",
    definition:
      "Rust spots are orange-brown stains transferred from corroding metal — hangers, snaps, zippers, or pins — onto fabric where moisture let the iron oxide migrate. Small and easy to miss on prints, they often set permanently into fibers, so they weigh against cosmetic appearance and cleanliness on the grade.",
    howToDetect: [
      "Look for orange-brown dots near metal hardware, snaps, and zipper teeth",
      "Check shoulders and hanger-contact points, where rust transfers from wire",
      "Distinguish rust's orange tone from the yellow of sweat or age spots",
    ],
    gradeImpact:
      "Rust spots are graded under Cosmetic Appearance (20%) and Cleanliness (10%). A single tiny spot in a hidden area is minor and stays near Very Good (7); prominent rust staining on a light front panel pulls the item toward Fair (5).",
    fixability:
      "Sometimes removable, never with bleach. Acidic treatments like lemon juice and salt or a dedicated rust remover can lift fresh spots; chlorine sets rust permanently, and old spots may resist all treatment.",
    disclosure:
      "Locate and photograph them ('two small rust spots near the zipper'). Rust is easy to overlook when listing, so a deliberate hardware-area inspection prevents an 'undisclosed staining' complaint.",
    comesOut: "sometimes",
    removalHeading: "How to get rust marks out of fabric",
    removal: [
      "Do not use chlorine bleach. It reacts with iron and sets the stain permanently, darker than it started. This is the single most common mistake on rust.",
      "For white cotton, cover the mark with lemon juice and salt and put it in direct sun until it dries.",
      "Rinse and repeat rather than leaving it on for hours; lemon juice in strong sun will weaken the fibre.",
      "For coloured fabric or anything delicate, use a commercial oxalic-acid rust remover and follow the timing exactly.",
      "Rust that has come from a corroding metal fastening on the garment itself will come back. Replace the fastening or the mark returns.",
    ],
    prevention: "Rust marks on stored clothing almost always come from the hanger, the zip or a stud, plus damp. Dry storage and plastic or wooden hangers remove the cause.",
    relatedSlugs: ["stains-general", "ink-stains"],
    faqs: [
      {
        q: "Can I bleach out a rust spot?",
        a: "No — chlorine bleach reacts with iron oxide and sets rust permanently, often darkening it. Use an acidic approach instead, such as lemon juice and salt in sunlight or a dedicated rust remover. Fresh spots lift more readily than old, set-in ones.",
      },
    ],
  },
  {
    slug: "ink-stains",
    name: "Ink stains",
    alternateNames: ["pen marks", "marker stains", "ink marks"],
    title: "How to Get Ink Out of Clothes",
    description:
      "Put a cloth underneath first, or the ink goes through to the other side. Alcohol, blot, move to clean cloth, repeat. Ballpoint goes; marker does not.",
    h1: "Ink stains",
    definition:
      "Ink stains are dark marks from pens, markers, or laundry mishaps that soak into fibers and are among the hardest stains to remove. Usually found on shirt pockets, cuffs, and hems, they range from a faint dot to a spreading blot and count against cosmetic appearance and cleanliness.",
    howToDetect: [
      "Inspect shirt pockets and cuffs, where pens leak and rub",
      "Look for blue, black, or red marks that follow no wear pattern",
      "Check for a feathered blot where ink has wicked outward into the weave",
    ],
    gradeImpact:
      "Ink stains are weighed under Cosmetic Appearance (20%) and Cleanliness (10%). A tiny pen dot inside a pocket is minor and stays near Very Good (7); a visible ink blot on a front or cuff that won't lift pulls the item to Fair (5).",
    fixability:
      "Hit or miss. Alcohol, hairspray, or a dedicated ink remover lift some fresh ballpoint marks; permanent marker and laundry-ink stains usually stay. Attempt removal before grading, but expect many to be permanent.",
    disclosure:
      "Be specific ('small blue ink dot on the shirt pocket'). Ink is a stain buyers scrutinize closely, so a clear close-up and location note keep an honest listing from reading as concealment.",
    comesOut: "sometimes",
    removalHeading: "How to get ink out of clothing",
    removal: [
      "Put an absorbent cloth underneath the stain. Everything you dissolve has to go somewhere, and without a backing it goes through to the other side of the garment.",
      "Dab isopropyl alcohol or hand sanitiser onto the mark from above and let it sit 30 seconds.",
      "Blot with the backing cloth, moving to a clean part of it constantly. Reusing the same spot puts the ink straight back.",
      "Repeat until no more ink transfers, then wash cold with detergent.",
      "Ballpoint usually goes. Permanent marker and gel ink usually do not, and printer toner never does.",
    ],
    prevention: "Pens in a shirt pocket nib-up, and check pockets before every wash. One pen through a hot wash marks an entire load.",
    relatedSlugs: ["stains-general", "bleach-spots"],
    faqs: [
      {
        q: "Is it worth trying to remove an ink stain before selling?",
        a: "Yes, briefly. Alcohol, hairspray, or a purpose-made ink remover lift some fresh ballpoint marks and can raise the grade. Permanent marker and set-in laundry ink usually resist everything, so if a quick attempt fails, grade and disclose the stain honestly.",
      },
    ],
  },
  {
    slug: "bleach-spots",
    name: "Bleach spots",
    alternateNames: ["bleach stains", "discoloration spots", "chemical spots"],
    title: "Bleach Stains: Why They Never Come Out",
    description:
      "There is nothing to remove; the dye is destroyed and the fabric is fine. Dye pens, over-dyeing, and where most bleach spots actually come from.",
    h1: "Bleach spots",
    definition:
      "Bleach spots are lightened or discolored patches where chlorine, cleaning products, or acne medication stripped the dye, leaving pale orange or white marks. Unlike fading, they are sharp-edged and localized, cannot be washed back in, and count against cosmetic appearance as permanent, irreversible damage on the grade.",
    howToDetect: [
      "Look for pale spots with crisp, defined edges rather than soft gradients",
      "Check collars, cuffs, and towel-contact areas near where products are used",
      "Note an orange or brassy cast on black fabric, a classic bleach tell",
    ],
    gradeImpact:
      "Bleach spots are graded under Cosmetic Appearance (20%) and read as permanent. A pinhead spot in a hidden spot is minor and stays near Good (6); obvious bleach marks on a visible panel pull the item to Fair (5) or Poor (3–4), since the color can't be restored.",
    fixability:
      "Not removable, only disguised. Fabric markers or a careful re-dye can mask small spots but rarely match perfectly. Most bleach damage is disclosed as permanent rather than treated.",
    disclosure:
      "State it clearly ('small bleach spot on the left cuff, color loss is permanent'). Because bleach marks look like they might wash out, spelling out that they're permanent avoids a disappointed buyer.",
    comesOut: "no",
    removalHeading: "Bleach spots are permanent",
    removal: [
      "There is nothing to remove. Bleach has destroyed the dye in that spot; the fabric is undamaged and simply has no colour left.",
      "A fabric marker or dye pen matched to the garment will disguise a small spot and will not survive many washes.",
      "Dyeing the whole garment a darker shade is the only durable option, and it changes everything including the stitching, which usually takes dye differently and ends up a different colour.",
      "On a garment with several spots, over-dyeing to black is the realistic answer.",
    ],
    prevention: "Most bleach spots come from splashback while cleaning, or from an acne or whitening product on a towel or pillowcase, not from laundry bleach. Change before you clean, and keep pale bathroom textiles away from those products.",
    relatedSlugs: ["color-bleeding", "stains-general"],
    faqs: [
      {
        q: "How can I tell a bleach spot from sun fading?",
        a: "Bleach spots are sharp-edged and localized, often with an orange or brassy cast where dye was stripped by a chemical. Sun fading is soft and gradual, spread across sun-exposed areas like shoulders. Bleach damage is permanent; both are graded under Cosmetic Appearance.",
      },
    ],
  },
  {
    slug: "hemline-damage",
    name: "Hemline damage",
    alternateNames: ["fallen hem", "worn hem", "hem wear"],
    title: "How to Repair a Hem That Came Down",
    description:
      "An unpicked hem resews; a worn-through edge does not. Press the original crease back first, because it shows you exactly where the hem sat.",
    h1: "Hemline damage",
    definition:
      "Hemline damage is wear along a garment's bottom edge — dropped stitches, unraveling, dragging scuffs, or a fallen hem hanging loose. Common on long jeans, coats, and dresses that brush the ground, it reads as both a structural and cosmetic flaw and pulls the grade toward the Good and Fair tiers.",
    howToDetect: [
      "Run the whole hem through your fingers, feeling for loose or dropped stitches",
      "Check the back hem of long jeans for dragging scuffs and abrasion",
      "Look for a section of hem hanging down where the stitching has released",
    ],
    gradeImpact:
      "Hemline damage spans Structural Integrity (25%) and Cosmetic Appearance (20%). Light scuffing at the back hem keeps an item near Very Good (7); a fallen hem or frayed, shredded edge drops it to Good (6) or Fair (5).",
    fixability:
      "Usually repairable. A tailor can re-hem a dropped or worn edge, and fusible hem tape is a quick fix; a re-hem may slightly shorten the garment and should be disclosed as an alteration.",
    disclosure:
      "Describe the hem state ('back hem scuffed from dragging, one section dropped'). Hems are easy to skip when photographing, so a dedicated hem shot heads off the 'didn't see that' complaint.",
    comesOut: "sometimes",
    removalHeading: "How to repair a hem",
    removal: [
      "Look at whether the hem is unpicked or the fabric is worn through. Unpicked resews; worn through does not.",
      "For an unpicked hem, press the fold back into place first. The crease line tells you exactly where the original hem sat.",
      "Slip stitch by hand for anything visible, or use hemming tape for a temporary fix that survives a handful of washes.",
      "For a worn edge, the fix is to take the hem up, which shortens the garment. On trousers that is often fine; on a dress it changes the proportion.",
    ],
    prevention: "Trouser hems wear from the ground, so length is the variable. A pair worn with flat shoes when it was hemmed for heels will destroy its own hem in a season.",
    relatedSlugs: ["fraying", "seam-stress"],
    faqs: [
      {
        q: "Is a dropped hem an easy fix?",
        a: "Usually yes. A tailor can restitch a dropped or worn hem, and fusible hem tape works as a fast home fix. A re-hem can shorten the garment slightly, so measure afterward and disclose it as an alteration when the length changes.",
      },
    ],
  },
  {
    slug: "elastic-degradation",
    name: "Elastic degradation",
    alternateNames: ["dead elastic", "worn elastic", "shot elastic"],
    title: "Perished Elastic: Replace, Not Revive",
    description:
      "Stretched-out elastane never recovers. How to replace elastic in a casing, and why leggings and swimwear are finished when the fabric itself goes.",
    h1: "Elastic degradation",
    definition:
      "Elastic degradation is the breakdown of stretch fibers in waistbands, cuffs, and straps, where the elastic goes slack, crumbly, or wavy and no longer rebounds. Age, heat, and washing accelerate it, leaving the garment loose and unsupportive, and it weighs on functional elements and structural integrity.",
    howToDetect: [
      "Stretch the waistband or cuff and release — dead elastic stays slack",
      "Look for a wavy, rippled band where the elastic has lost tension",
      "Feel inside the casing for crumbling or powdery, broken-down elastic",
    ],
    gradeImpact:
      "Elastic degradation is judged under Functional Elements (15%) and Structural Integrity (25%). Slightly relaxed elastic that still holds stays near Good (6); a waistband or cuff that no longer stays up or grips drops the item to Fair (5) or Poor (3–4).",
    fixability:
      "Repairable on many garments. A tailor can replace elastic in a casing to restore function; on bonded or knit-in elastic it's often impractical, and the piece stays permanently slack.",
    disclosure:
      "State the function loss ('waistband elastic is shot and no longer holds'). Dead elastic is invisible in a flat photo but obvious in wear, so disclosing it is essential to avoid a fit-based return.",
    comesOut: "no",
    removalHeading: "Perished elastic cannot be revived",
    removal: [
      "Nothing restores it. The elastane has broken down chemically and stretched-out elastic never recovers.",
      "The fix is replacement: unpick one end of the casing, pull the old elastic out, feed new elastic through on a safety pin, overlap and stitch.",
      "On a waistband with the elastic sewn directly to the fabric rather than in a casing, replacement means rebuilding the whole waistband.",
      "Leggings and swimwear with degraded elastane through the body of the fabric are finished. There is no casing to replace.",
    ],
    prevention: "Heat, chlorine and body oils all break down elastane. Wash cold, never tumble dry anything stretchy, and rinse swimwear immediately after use.",
    relatedSlugs: ["stretching", "broken-zipper"],
    faqs: [
      {
        q: "Can worn-out elastic be replaced?",
        a: "Often. When the elastic runs through a fabric casing, a tailor can pull it out and thread in fresh elastic, restoring function and grade. Elastic that's bonded or knitted directly into the fabric usually can't be replaced, so that garment stays permanently slack.",
      },
    ],
  },
  {
    slug: "felting",
    name: "Wool felting",
    alternateNames: ["felted wool", "matted knit", "wool matting"],
    title: "Felted Wool: Why It Cannot Be Undone",
    description:
      "Felting is wool scales locked together, a physical change rather than a stain. What a conditioner soak recovers, and what to do with the rest.",
    h1: "Wool felting",
    definition:
      "Wool felting is the matting of animal-fiber knits into a dense, fuzzy, shrunken surface after agitation in heat and water. Irreversible, it stiffens the fabric, blurs the stitch definition, and shrinks the piece all at once, so it weighs on both fabric-condition and the garment's fit-driven grade.",
    howToDetect: [
      "Look for a dense, matted surface where individual stitches are no longer distinct",
      "Feel for stiffness and a fuzzy, compressed texture unlike normal knit",
      "Compare dimensions to the tag size — felting shrinks the piece markedly",
    ],
    gradeImpact:
      "Felting combines Fabric Condition (30%) with sizing loss. Light surface matting keeps a wool piece near Good (6); heavy felting that has stiffened the fabric, erased the stitch pattern, and shrunk the garment drops it to Fair (5) or Poor (3–4).",
    fixability:
      "Not reversible. Felting permanently fuses the fibers, so no soak or stretch fully undoes it. A lightly felted piece can sometimes be repurposed as craft wool, but it can't be restored to its knit state.",
    disclosure:
      "Disclose it as permanent ('wool has felted — matted texture and shrunk from tag size'). Because felting shrinks and stiffens at once, pair the note with actual measurements so buyers know the true size.",
    comesOut: "no",
    removalHeading: "Felting is not reversible",
    removal: [
      "It cannot be undone. Felting is the wool scales interlocking permanently, which is a physical change rather than a stain.",
      "A conditioner soak and gentle stretching recovers a little size on a lightly felted garment, and it will not restore the texture.",
      "Heavily felted knitwear is best repurposed. Felted wool does not fray, which makes it good material for something else.",
    ],
    prevention: "Agitation plus heat plus moisture is what felts wool, and all three have to be present. Hand wash cool, do not wring, dry flat. A machine's gentle cycle still agitates.",
    relatedSlugs: ["shrinkage", "pilling"],
    faqs: [
      {
        q: "Can felted wool be unshrunk?",
        a: "No. Felting permanently interlocks the wool fibers, so unlike simple shrinkage it can't be reversed by soaking and stretching. A lightly felted item might be repurposed as craft material, but it will never return to its original knit texture and size.",
      },
    ],
  },
  {
    slug: "watch-wear",
    name: "Cuff and watch wear",
    alternateNames: ["cuff abrasion", "wristwatch wear", "sleeve cuff wear"],
    title: "Worn Cuffs: Turning Them, and the Cost",
    description:
      "Cuff wear is abrasion, so washing changes nothing. What turning a cuff involves, what it costs, and the habit that wears one side first.",
    h1: "Cuff and watch wear",
    definition:
      "Cuff and watch wear is the localized abrasion on a left or right sleeve cuff where a watch, bracelet, or desk edge rubs it thin and frays the fabric. Subtle but asymmetric, it appears on one cuff more than the other and weighs on fabric-condition and cosmetic appearance.",
    howToDetect: [
      "Compare the two cuffs directly — watch wear shows on one side only",
      "Look at the cuff's outer edge for thinning, fraying, or a shiny worn patch",
      "Check the underside of the cuff, where a watch back rubs against fabric",
    ],
    gradeImpact:
      "Watch wear is weighed under Fabric Condition (30%) and Cosmetic Appearance (20%). A faintly worn cuff edge keeps a shirt near Very Good (7); a cuff frayed or thinned through on one side pulls it toward Good (6) or Fair (5).",
    fixability:
      "Sometimes patchable. A tailor can turn or reinforce a worn cuff, and de-fuzzing helps lightly abraded fabric; a cuff worn through to thinness usually can't be fully restored.",
    disclosure:
      "Point to the asymmetry ('right cuff worn from watch, left is clean'). Because the wear is one-sided, a photo of both cuffs together makes the honest condition obvious at a glance.",
    comesOut: "no",
    removalHeading: "Cuff wear does not come out",
    removal: [
      "The fabric has abraded, so there is nothing to lift. Washing changes nothing.",
      "On a shirt, a tailor can turn the cuffs, which puts the worn edge inside. It is a real repair and costs about as much as a cheap shirt.",
      "Fusible interfacing behind a thin cuff stops it becoming a hole without improving how it looks.",
    ],
    prevention: "It is friction from a watch or a desk, always on the same side. Rotate which wrist carries the watch, and roll sleeves rather than resting cuffs on a desk edge.",
    relatedSlugs: ["fabric-thinning", "collar-wear"],
    faqs: [
      {
        q: "Why is one cuff more worn than the other?",
        a: "It's watch or bracelet wear. The wrist that carries a watch, band, or bracelet rubs that cuff against hard edges all day, thinning and fraying it while the other cuff stays clean. The tell-tale sign is abrasion concentrated on a single sleeve.",
      },
    ],
  },
  {
    slug: "belt-loop-damage",
    name: "Belt loop damage",
    alternateNames: ["torn belt loop", "missing belt loop", "broken loop"],
    title: "How to Fix a Broken Belt Loop",
    description:
      "The original stitch holes show you exactly where it belongs. Bar tack both ends, or it pulls straight out again on the first tug.",
    h1: "Belt loop damage",
    definition:
      "Belt loop damage is the tearing, stretching, or complete loss of the loops that hold a belt at a trouser or jean waistband. Caused by yanking a snug belt, it leaves a frayed stub or a bare waistband, interrupts intended function, and is graded under functional elements with a cosmetic note.",
    howToDetect: [
      "Count the loops against the design and check none are torn off",
      "Tug each loop gently to find one detaching at a bar-tack",
      "Look for stretched, distorted loops that no longer sit flat",
    ],
    gradeImpact:
      "Belt loop damage is weighed under Functional Elements (15%). A single stretched loop is minor and stays near Very Good (7); a torn-off or dangling loop that leaves the belt unsupported pulls the item toward Good (6).",
    fixability:
      "Easily repaired. A tailor can re-tack a loose loop or sew on a replacement cut from a hidden seam, restoring function and grade. A replacement loop from other fabric should be noted as non-original.",
    disclosure:
      "Say which loop and how bad ('rear belt loop torn at one end'). It's a small flaw, but on jeans that need a belt it affects wearability, so buyers should know.",
    comesOut: "yes",
    removalHeading: "How to reattach a belt loop",
    removal: [
      "Find both original stitch points; the holes are still there and they are where the loop belongs.",
      "Fold the raw ends under, position the loop, and sew through all layers with a heavy-duty or topstitch thread.",
      "Bar tack each end: eight to ten close stitches across the width, backstitched. A single row of stitching pulls out again on the first tug.",
      "If the loop itself has torn through, cut a new one from the inside of a hem or a pocket bag on the same garment so the fabric matches.",
    ],
    prevention: "Belt loops fail from being pulled to hoist trousers up. Lift by the waistband, and if you are lifting often the trousers are the wrong size.",
    repair: {
      name: "Reattach a torn belt loop",
      difficulty: "Easy",
      minutes: 15,
      cost: "Under $5",
      tools: ["Needle", "Thimble"],
      supplies: ["Heavy-duty or topstitch thread"],
      steps: [
        {
          name: "Find the original stitch holes",
          text: "They are still in the waistband and they are where the loop belongs. Guessing a new position leaves the belt sitting crooked.",
        },
        {
          name: "Fold the raw ends under",
          text: "Turn about 6mm under at each end so the loop cannot fray out from under the stitching.",
        },
        {
          name: "Sew through every layer",
          text: "Waistbands are thick. Use a thimble, and go through the loop, the waistband facing and the outer fabric together rather than just the top layer.",
        },
        {
          name: "Bar tack both ends",
          text: "Eight to ten close stitches across the full width of the loop, backstitched at each end. A single row of stitching pulls out again on the first tug, which is what happened the first time.",
        },
        {
          name: "Replace the loop if it tore through itself",
          text: "Cut a new one from the inside of a hem or a pocket bag on the same garment, so the fabric and the fade match.",
        },
      ],
    },
    relatedSlugs: ["seam-stress", "missing-buttons"],
    faqs: [
      {
        q: "Does a torn belt loop matter if I don't wear a belt?",
        a: "It still lowers the grade, since Functional Elements assesses the garment as designed, and a belt loop that won't hold a belt is a lost function. It's a quick tailor fix, though, so many sellers repair a torn loop before listing.",
      },
    ],
  },
  {
    slug: "lining-tears",
    name: "Lining tears",
    alternateNames: ["torn lining", "ripped lining", "lining damage"],
    title: "How to Repair a Torn Jacket Lining",
    description:
      "Turn the garment through the lining's own opening. Ladder stitch a panel tear, interface behind it, and know when replacement costs more than the coat.",
    h1: "Lining tears",
    definition:
      "Lining tears are rips and separations in the inner fabric of jackets, coats, and skirts, often hidden until the garment is turned inside out. They form at armholes, vents, and pockets under stress, and while less visible than shell damage, they still weigh on structural integrity and functional wear.",
    howToDetect: [
      "Turn the garment inside out and inspect the full lining, not just the shell",
      "Check armhole seams, vents, and pocket bags, where linings split first",
      "Look for a loose flap of lining hanging free or a ripped pocket bag",
    ],
    gradeImpact:
      "Lining tears are graded under Structural Integrity (25%). A small tear in a hidden lining seam keeps an item near Very Good (7); a shredded lining or a torn-out pocket bag that affects use pulls it toward Good (6) or Fair (5).",
    fixability:
      "Repairable, sometimes cheaply. A tailor can restitch a torn lining seam or replace a pocket bag; a fully deteriorated lining may need full replacement, which is costlier but restores the piece.",
    disclosure:
      "Photograph the inside ('lining torn at the right armhole, shell is clean'). Because linings hide from a standard photo, an inside-out shot is what keeps a lining tear from being a surprise.",
    comesOut: "sometimes",
    removalHeading: "How to repair a torn lining",
    removal: [
      "Turn the garment inside out through the lining's own opening, usually a gap left in a sleeve or the hem.",
      "For a split seam, restitch along the original line; lining fabric is slippery, so pin more than feels necessary.",
      "For a tear in the middle of a panel, back it with lightweight fusible interfacing and close it with a small ladder stitch.",
      "Where the lining has shredded across an armhole or seat, replacement is the only real answer, and a tailor charges more for it than most secondhand garments are worth.",
    ],
    prevention: "Linings wear faster than shells because they take the friction. Do not carry heavy things in a lined pocket, and get a small tear fixed before it runs along the seam.",
    relatedSlugs: ["seam-stress", "holes-tears"],
    faqs: [
      {
        q: "Does a torn lining matter if the outside looks perfect?",
        a: "Yes. Lining tears are graded under Structural Integrity even when the shell is flawless, because they affect durability and use. They're often an inexpensive tailor repair, but buyers should still see an inside-out photo before purchase.",
      },
    ],
  },
  {
    slug: "button-fading",
    name: "Button fading",
    alternateNames: ["worn buttons", "faded buttons", "dulled buttons"],
    title: "Faded Buttons: Replace the Whole Set",
    description:
      "Colour cannot be restored to a faded button. Why one new button looks worse than eight old ones, and why keeping the originals protects the value.",
    h1: "Button fading",
    definition:
      "Button fading is the dulling, chipping, or color loss of a garment's buttons themselves — brass gone dull, painted logos worn off, or dyed buttons sun-bleached. Distinct from missing buttons, the fastener is present but tired, so it reads as a minor cosmetic flaw that nudges the grade down a notch.",
    howToDetect: [
      "Inspect each button for dulled metal, chipped paint, or worn branding",
      "Compare front buttons to a hidden spare — the spare shows original color",
      "Check for a logo or engraving rubbed faint on branded buttons",
    ],
    gradeImpact:
      "Button fading is a small Cosmetic Appearance (20%) item. Slightly dulled buttons barely move an Excellent (8) grade; noticeably chipped or discolored buttons on a dress piece nudge it toward Very Good (7).",
    fixability:
      "Cheaply improved. Swapping in matching replacement buttons or polishing metal ones refreshes the look and can recover the small grade loss; non-original replacements should be disclosed.",
    disclosure:
      "Mention it only if visible ('front buttons show some wear to the finish'). It's a minor point, but on branded or dress garments buyers notice tired buttons, so a quick note keeps expectations honest.",
    comesOut: "no",
    removalHeading: "Faded buttons are replaced, not restored",
    removal: [
      "Colour cannot be brought back to a plastic or dyed-shell button. The fix is replacement.",
      "Replace the whole set rather than one. A single new button next to seven old ones is more obvious than eight faded ones.",
      "Keep the originals. On a branded garment the buttons are part of what a buyer authenticates against, and a replaced set lowers value even when it looks better.",
    ],
    prevention: "Buttons fade from UV and from dry-cleaning solvent. Wash inside out, dry in shade, and ask a cleaner to foil branded buttons.",
    relatedSlugs: ["missing-buttons", "cracked-graphics"],
    faqs: [
      {
        q: "Is button fading a big deal for the grade?",
        a: "No — it's a minor cosmetic flaw graded under Cosmetic Appearance, since the buttons still work. It only matters much on dress or branded pieces where worn buttons stand out. Swapping in matching replacements is a cheap way to recover the small loss.",
      },
    ],
  },
  {
    slug: "collar-wear",
    name: "Collar wear",
    alternateNames: ["worn collar", "collar fraying", "ring around the collar"],
    title: "How to Clean and Fix a Worn Collar",
    description:
      "A grey collar is oil and comes out; a frayed edge is abrasion and does not. Shampoo works on the first because collar grime is mostly skin and hair oil.",
    h1: "Collar wear",
    definition:
      "Collar wear is the fraying, graying, and thinning along a shirt or jacket collar where it rubs the neck and jaw all day. Often paired with a stubborn ring of grime, it is one of the first places a dress shirt shows age and weighs on both fabric-condition and cleanliness.",
    howToDetect: [
      "Inspect the collar fold and points for fraying and thinning threads",
      "Look for a grey or yellow grime ring along the inside collar edge",
      "Check where the collar meets the neckband for a worn, shiny patch",
    ],
    gradeImpact:
      "Collar wear spans Fabric Condition (30%) and Cleanliness (10%). Light edge fuzz or a washable grime ring keeps a shirt near Good (6); a frayed, thinned, or permanently grey collar pulls it to Fair (5), since the collar frames the whole garment.",
    fixability:
      "Partly fixable. A grime ring often washes out with a pretreat, and dress-shirt collars can sometimes be turned by a tailor to hide fraying; thinned or frayed fabric itself doesn't recover.",
    disclosure:
      "Describe the collar honestly ('collar edge lightly frayed with a faint grime line'). The collar is the first thing a buyer inspects on a shirt, so glossing over its wear invites disappointment.",
    comesOut: "sometimes",
    removalHeading: "How to clean and repair a worn collar",
    removal: [
      "Separate the two problems: a grey collar is soil and comes out, a frayed collar edge is abrasion and does not.",
      "For soiling, work an enzyme detergent or a little shampoo directly into the fold, leave it 30 minutes, then wash warm. Shampoo works because collar grime is mostly hair and skin oil.",
      "For light fraying, trim the loose fibres flush and press. It buys time and does not fix anything.",
      "For a worn collar on a shirt worth keeping, a tailor can turn it, the same operation as turning cuffs.",
    ],
    prevention: "Wash shirts after every wear rather than airing them. Collar soil is oil, oil oxidises, and an oxidised collar mark is significantly harder to remove than a fresh one.",
    relatedSlugs: ["fabric-thinning", "pit-stains"],
    faqs: [
      {
        q: "Can a worn shirt collar be fixed?",
        a: "Partly. A grime ring usually washes out with a pretreatment, and a tailor can sometimes turn a dress-shirt collar to hide the fraying on the reverse. Fabric that's actually thinned or frayed through can't be restored and should be disclosed.",
      },
    ],
  },
  {
    slug: "patch-loss",
    name: "Patch loss",
    alternateNames: ["missing patch", "peeling patch", "lost logo"],
    title: "Lost Patch: The Shadow It Leaves",
    description:
      "The fabric under a patch did not fade with the rest, so the outline usually stays. Adhesive removal, sizing a replacement, and what the loss does to value.",
    h1: "Patch loss and missing logos",
    definition:
      "Patch loss is the missing, peeling, or torn-off patches, appliqués, and woven logos that a garment originally carried, leaving glue residue, stitch holes, or a shadow outline. Common on workwear, varsity jackets, and branded caps, it changes the piece's identity and value and counts under cosmetic appearance.",
    howToDetect: [
      "Look for a clean shadow outline or unfaded rectangle where a patch sat",
      "Check for leftover stitch holes or glue residue at the patch location",
      "Compare against the model's original design to spot a logo that's gone",
    ],
    gradeImpact:
      "Patch loss is weighed under Cosmetic Appearance (20%), and on branded pieces it also affects desirability. A peeling patch with the design intact stays near Very Good (7); a missing signature patch or logo that leaves a bare outline pulls the item toward Good (6) or Fair (5).",
    fixability:
      "Sometimes replaceable. A loose patch can be restitched and a reproduction sewn back on, but original-patch collectors treat replacements as a value hit, so a non-original patch must be disclosed.",
    disclosure:
      "State exactly what's gone ('chest logo patch missing, leaves a faint outline'). On branded and vintage pieces the patch is much of the value, so its absence is a material fact buyers must know.",
    comesOut: "no",
    removalHeading: "A lost patch is gone, and the mark it leaves is not",
    removal: [
      "The patch itself cannot be recovered, and the outline usually can not either: the fabric under it did not fade with the rest of the garment.",
      "Remove any remaining adhesive with a little isopropyl alcohol on a cloth before doing anything else.",
      "A replacement patch of the same size covers the shadow. A smaller one makes it more obvious, not less.",
      "On a garment where the patch was the brand marker, its absence changes what the item is and what it is worth, regardless of how the fabric looks.",
    ],
    prevention: "Iron-on patches fail in the wash and in the dryer. Anything you want to keep should be stitched around its edge, whether or not it also has adhesive.",
    relatedSlugs: ["cracked-graphics", "missing-buttons"],
    faqs: [
      {
        q: "Does a missing patch hurt value more than the grade suggests?",
        a: "Often, yes. On branded, workwear, or vintage pieces the patch or logo carries much of the appeal, so its loss can cut resale value beyond the cosmetic grade change. Sewing on a reproduction is possible, but disclose it — collectors price non-original patches down.",
      },
    ],
  },
];

const FLAW_BY_SLUG = new Map(FLAW_ENTRIES.map((f) => [f.slug, f]));
const FLAW_BY_PATH = new Map(FLAW_ENTRIES.map((f) => [flawPath(f.slug), f]));

export function getFlawBySlug(slug: string): FlawEntry | undefined {
  return FLAW_BY_SLUG.get(slug);
}
export function getFlawByPath(path: string): FlawEntry | undefined {
  return FLAW_BY_PATH.get(path);
}
export function isFlawHubPath(path: string): boolean {
  return path === FLAW_LIBRARY_HUB_PATH;
}

/** PublicRoute entries for the hub + every flaw page. */
export function flawLibraryRoutes(): PublicRoute[] {
  const hub: PublicRoute = {
    path: FLAW_LIBRARY_HUB_PATH,
    title: "Clothing Flaw Library for Grading",
    description:
      "A library of clothing flaws — pilling, moth holes, sun fading, crocking and more — how to detect each, its grade impact, fixability, and disclosure.",
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "DefinedTermSet",
  };
  const flaws: PublicRoute[] = FLAW_ENTRIES.map((f) => ({
    path: flawPath(f.slug),
    title: f.title,
    description: f.description,
    changefreq: "monthly",
    priority: 0.5,
    jsonLdType: "Article",
  }));
  return [hub, ...flaws];
}

/** Breadcrumb trail (relative) for a flaw page. */
export function flawTrail(
  flaw: FlawEntry,
): Array<{ name: string; path: string }> {
  return [
    { name: "GradeThread", path: "/" },
    { name: "Flaw library", path: FLAW_LIBRARY_HUB_PATH },
    { name: flaw.name, path: flawPath(flaw.slug) },
  ];
}
