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

export const FLAW_LIBRARY_HUB_PATH = "/grading/flaws";

export interface FlawPhoto {
  url: string;
  alt: string;
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
  /** Whether and how it can be fixed. */
  fixability: string;
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
    title: "Pilling on Clothes: Grade Impact",
    description:
      "Pilling is the little fabric bobbles that form where a garment rubs. How to spot it, how much it lowers a condition grade, and whether it's fixable.",
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
    relatedSlugs: ["fabric-thinning", "sun-fading"],
    faqs: [
      {
        q: "Does pilling lower a clothing grade?",
        a: "Yes. Pilling is assessed under the Fabric Condition factor. Light pilling drops an item a tier or so; heavy pilling across the garment can take it to Fair or below. De-pilling before grading can raise the result.",
      },
    ],
  },
  {
    slug: "sun-fading",
    name: "Sun fading",
    alternateNames: ["color fading", "UV fading"],
    title: "Sun Fading on Clothes: Grade Impact",
    description:
      "Sun fading is uneven color loss from UV exposure. How to spot it, how it affects a condition grade, whether it's fixable, and how to disclose it.",
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
    title: "Moth Holes in Clothing: Grade Impact",
    description:
      "Moth holes are small chewed holes in wool and natural fibers. How to spot them, how much they cut a condition grade, and how to disclose them honestly.",
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
    title: "Pit Stains: Grade Impact & Disclosure",
    description:
      "Pit stains are the yellow, crusty underarm buildup from sweat and antiperspirant. How to spot them, how they hit a condition grade, and how to disclose.",
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
    title: "Crocking: Dye Transfer Grade Impact",
    description:
      "Crocking is dye rubbing off a garment onto skin or other fabric, common on raw denim. How to test for it, its grade impact, and honest disclosure.",
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
    title: "Seam Stress & Blown Seams: Grade Impact",
    description:
      "Seam stress is strain or bursting at a garment's stitched joins. How to spot slippage and blown seams, their grade impact, fixability, and disclosure.",
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
    title: "Cracked & Peeling Prints: Grade Impact",
    description:
      "Cracked graphics are splitting, flaking screen prints on tees and hoodies. How to judge patina versus defect, the grade impact, and how to disclose it.",
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
    title: "Missing Buttons: Grade Impact",
    description:
      "Missing buttons leave a shirt, coat, or cardigan unable to close as designed. How to inventory them, their grade impact, fixability, and how to disclose.",
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
    title: "Broken Zipper: Grade Impact",
    description:
      "A broken zipper — stuck, separated, or missing teeth — blocks how a garment is worn. How to test it, the grade impact, fixability, and disclosure.",
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
    title: "Fabric Thinning: Grade Impact",
    description:
      "Fabric thinning is worn-through material that's gone sheer at elbows, knees, or seats. How to spot it before a hole forms, its grade impact, and disclosure.",
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
    title: "Snags & Pulls: Grade Impact",
    description:
      "Snags and pulls are yarn loops dragged out of a knit or weave without a hole. How to spot them, whether they're fixable, and their condition-grade impact.",
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
    title: "Stains on Clothing: Grade Impact",
    description:
      "Stains are set-in discolorations from food, grease, or cosmetics that resist washing. How to inspect for them, their grade impact, and honest disclosure.",
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
    title: "Holes & Tears: Grade Impact",
    description:
      "Holes and tears are open breaks in the fabric, from pinholes to long rips. How to find them, why they cap the grade, and how to disclose them honestly.",
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
    title: "Fraying on Clothes: Grade Impact",
    description:
      "Fraying is loose, unraveling threads at hems, cuffs, and collars. How to tell wear from intended distressing, its grade impact, and how to disclose it.",
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
    title: "Shrinkage: Grade Impact & Sizing",
    description:
      "Shrinkage is permanent size loss after hot washing or drying, common in cotton and wool. How to detect it, why it misrepresents size, and how to disclose.",
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
    title: "Stretching & Bagging: Grade Impact",
    description:
      "Stretching is permanent loss of shape where collars, cuffs, and knees bag out. How to spot it, whether it recovers, and its condition-grade impact.",
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
    title: "Color Bleeding: Grade Impact",
    description:
      "Color bleeding is dye running in the wash and staining other areas or garments. How it differs from crocking, its grade impact, and how to disclose it.",
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
    title: "Deodorant Marks: Grade Impact",
    description:
      "Deodorant marks are white, waxy streaks or stiff buildup at the underarms. How to tell fresh residue from set-in buildup, and their condition-grade impact.",
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
    title: "Smoke Odor: Grade Impact",
    description:
      "Smoke odor is stale cigarette or fire smell absorbed deep into fibers. Why it's invisible in photos, how it hits the grade, and how to disclose it honestly.",
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
    title: "Mildew & Musty Odor: Grade Impact",
    description:
      "Mildew odor is the damp, musty smell of mold from wet or humid storage. How to detect it and any spotting, its grade impact, and how to disclose it.",
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
    title: "Rust Spots: Grade Impact",
    description:
      "Rust spots are orange-brown marks transferred from corroding metal onto fabric. How to find them, whether they lift, and their condition-grade impact.",
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
    title: "Ink Stains: Grade Impact",
    description:
      "Ink stains are stubborn pen or marker marks soaked into fibers. Where they hide, how hard they are to remove, and how they affect a condition grade.",
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
    title: "Bleach Spots: Grade Impact",
    description:
      "Bleach spots are pale, sharp-edged patches where the dye was stripped by chemicals. Why they're permanent, how they differ from fading, and disclosure.",
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
    title: "Hemline Damage: Grade Impact",
    description:
      "Hemline damage is wear along a garment's bottom edge — dropped hems, scuffs, and unraveling. How to inspect it, its grade impact, and how to disclose it.",
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
    title: "Elastic Degradation: Grade Impact",
    description:
      "Elastic degradation is slack, crumbly, or wavy elastic in waistbands and cuffs. How to test the rebound, its grade impact, and how to disclose it.",
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
    title: "Wool Felting: Grade Impact",
    description:
      "Wool felting is the irreversible matting and shrinking of wool knits after hot agitation. How to spot it, why it's permanent, and its condition-grade impact.",
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
    title: "Cuff & Watch Wear: Grade Impact",
    description:
      "Cuff and watch wear is asymmetric abrasion on one sleeve cuff from a watch or bracelet. How to spot the one-sided thinning and its condition-grade impact.",
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
    title: "Belt Loop Damage: Grade Impact",
    description:
      "Belt loop damage is torn, stretched, or missing loops at a trouser waistband. How to inspect them, their grade impact, fixability, and disclosure.",
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
    title: "Lining Tears: Grade Impact",
    description:
      "Lining tears are rips in the inner fabric of jackets, coats, and skirts. Where they hide, why they still lower the grade, and how to disclose them.",
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
    title: "Button Fading: Grade Impact",
    description:
      "Button fading is dulled, chipped, or color-worn buttons that are still attached. How it differs from missing buttons, and its minor condition-grade impact.",
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
    title: "Collar Wear: Grade Impact",
    description:
      "Collar wear is fraying, graying, and thinning where a collar rubs the neck. How to inspect it, why it's an early age sign, and its condition-grade impact.",
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
    title: "Patch Loss & Missing Logos: Grade Impact",
    description:
      "Patch loss is missing, peeling, or torn-off patches and logos that leave residue or outlines. How it affects identity, value, and the condition grade.",
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
