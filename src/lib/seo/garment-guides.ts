// Garment-type grading guides pSEO (US-1682).
//
// A hub at /grading/guides/ plus one guide per garment type
// (/grading/guides/<slug>): "How to grade a used {denim jacket}" — the flaws to
// check, a photo/inspection checklist, and graded examples. This is the
// proprietary flaw taxonomy + rubric rendered as content (the good kind of pSEO)
// — garment-specific criteria that rank for hyper-specific, zero-competition
// queries.
//
// PURE DATA: imports only the PublicRoute TYPE. HowTo JSON-LD is composed in
// src/pages/marketing/marketing-jsonld.ts.
//
// CONTENT RULES: title ≤ 46 & unique; description 70–160 & unique; intro
// ~45–60 words self-contained; ≥50% unique data/editorial (the garment-specific
// criteria + steps ARE the proprietary rubric); merge pages whose rubric is
// identical. `photos` (≥3 real flaw photos) is populated from the graded corpus
// by content ops (the page renders them when present).

import type { PublicRoute } from "./public-routes";

export const GARMENT_GUIDES_HUB_PATH = "/grading/guides";

export interface GuidePhoto {
  url: string;
  alt: string;
}

export interface GuideStep {
  name: string;
  text: string;
}

export interface GradedExample {
  grade: string;
  note: string;
}

export interface GarmentGuide {
  slug: string;
  /** The garment, e.g. "Denim jacket". */
  garment: string;
  alternateNames?: string[];
  /** <title> without the " | GradeThread" suffix — ≤ 46, unique. */
  title: string;
  /** Meta description — 70–160, unique. */
  description: string;
  h1: string;
  /** Self-contained intro (~45–60 words). */
  intro: string;
  /** Garment-specific criteria — what makes or breaks this garment's grade. */
  criteria: string[];
  /** Ordered HowTo steps for grading this garment. */
  steps: GuideStep[];
  /** Graded examples described (grade + why). */
  gradedExamples: GradedExample[];
  /** Related flaw-library slugs to deep-link (US-1683). */
  relatedFlawSlugs: string[];
  faqs: Array<{ q: string; a: string }>;
  /** ≥3 real flaw photos — populated from the graded corpus by content ops. */
  photos?: GuidePhoto[];
}

export function guidePath(slug: string): string {
  return `${GARMENT_GUIDES_HUB_PATH}/${slug}`;
}

export const GARMENT_GUIDES: GarmentGuide[] = [
  {
    slug: "denim-jacket",
    garment: "Denim jacket",
    alternateNames: ["jean jacket", "trucker jacket"],
    title: "How to Grade a Used Denim Jacket",
    description:
      "How to grade a used denim jacket: flaws to check, a photo checklist, and graded examples — from blown seams to intentional fading.",
    h1: "Grading a used denim jacket",
    intro:
      "Grading a used denim jacket comes down to structure and honest fading. Denim is durable, so the grade usually turns on stress points — the inseams of the arms, the button placket, and the pocket corners — plus telling intentional wash and whiskering apart from wear the maker never intended.",
    criteria: [
      "Stress points: cuff plackets, pocket corners, and the button-fly/placket",
      "Fading — intentional wash vs. incidental sun fading on shoulders",
      "Hardware: buttons, rivets, and the main snap or button function",
      "Hem and cuff fraying beyond the designed finish",
    ],
    steps: [
      {
        name: "Check the structure first",
        text: "Inspect the placket, cuffs, and pocket corners for stress, thread pulls, or splits. Denim rarely pills, so structural soundness leads the grade.",
      },
      {
        name: "Read the fading honestly",
        text: "Decide whether fading and whiskering are the garment's intended wash or incidental sun fading. As-made distressing isn't penalized; sun fading is.",
      },
      {
        name: "Test the hardware",
        text: "Work every button, rivet, and snap. A seized or missing metal shank button is a functional-elements hit that caps the grade.",
      },
      {
        name: "Photograph the checklist",
        text: "Shoot the front, back, both cuffs, the placket, and any flaw close-up with a scale reference, so the grade is verifiable.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Unworn, tags removed, crisp indigo with no wear at any stress point." },
      { grade: "7 (Very Good)", note: "Light honest wear, minor fraying at one cuff, all hardware works." },
      { grade: "4 (Poor)", note: "Blown-out underarm seam and a missing shank button — a repair project." },
    ],
    relatedFlawSlugs: ["sun-fading", "seam-stress"],
    faqs: [
      {
        q: "Does distressed denim get a lower grade?",
        a: "Not for the distressing itself. A denim jacket is graded against its intended, as-made state, so factory whiskering and fading aren't penalized. It loses points only for wear or damage on top of the design — a torn pocket, a blown seam, or incidental sun fading.",
      },
    ],
  },
  {
    slug: "leather-jacket",
    garment: "Leather jacket",
    alternateNames: ["moto jacket", "biker jacket"],
    title: "How to Grade a Used Leather Jacket",
    description:
      "How to grade a used leather jacket: cracking, dryness, lining and zipper condition, and graded examples on the 1–10 scale — where patina ends and damage begins.",
    h1: "Grading a used leather jacket",
    intro:
      "Grading a used leather jacket turns on the hide and the hardware. Real leather develops patina that isn't damage, so the grade separates desirable softening from true harm — cracking, dryness, and peeling finish — while checking the zippers and lining that fail long before the leather does.",
    criteria: [
      "Hide: suppleness vs. dryness, cracking, or peeling finish coat",
      "Patina (desirable) vs. abrasion and color loss at cuffs and elbows",
      "Zippers and snaps — the most common functional failure",
      "Lining: tears, sweat staining, and seam separation",
    ],
    steps: [
      {
        name: "Feel the hide",
        text: "Flex the leather at the elbows and cuffs. Supple, evenly-colored leather grades high; dry, stiff, or cracking leather caps the grade regardless of looks.",
      },
      {
        name: "Separate patina from damage",
        text: "Even darkening and softening is patina and isn't penalized. Surface cracking, peeling finish, and abraded color loss are damage.",
      },
      {
        name: "Work every zipper",
        text: "Run the main and pocket zippers full-travel. A catching or broken zip is a functional-elements hit that often defines the grade.",
      },
      {
        name: "Check the lining",
        text: "Inspect the lining for tears, sweat stains, and seam separation, and photograph the hide, hardware, and any flaw.",
      },
    ],
    gradedExamples: [
      { grade: "8 (Excellent)", note: "Supple hide, even patina, all zippers glide, clean lining." },
      { grade: "6 (Good)", note: "Minor cuff abrasion and light lining wear; fully functional." },
      { grade: "3 (Poor)", note: "Cracked, peeling finish and a broken main zipper — for parts or restoration." },
    ],
    relatedFlawSlugs: ["crocking", "seam-stress"],
    faqs: [
      {
        q: "Is patina on leather a flaw?",
        a: "No. Even patina — the softening and darkening leather earns with use — is desirable and isn't penalized. Cracking, dryness, peeling finish, and abraded color loss are damage and do lower the grade.",
      },
    ],
  },
  {
    slug: "knit-sweater",
    garment: "Knit sweater",
    alternateNames: ["pullover", "jumper"],
    title: "How to Grade a Used Knit Sweater",
    description:
      "How to grade a used knit sweater: pilling, moth holes, and shape recovery, with a photo checklist and graded examples on the 1–10 condition scale.",
    h1: "Grading a used knit sweater",
    intro:
      "Grading a used knit sweater is mostly about pilling and shape. Knits stretch, snag, and felt in ways woven garments don't, so the grade weighs surface pilling, holes, and whether the ribbing and cuffs still recover — a stretched-out neckline or a moth hole caps an otherwise clean piece.",
    criteria: [
      "Pilling severity on high-friction zones — underarms, sides, cuffs",
      "Snags, pulls, and moth holes in the knit surface",
      "Shape retention: neckline, cuff, and hem ribbing recovery",
      "Felting or shrinkage from improper washing",
    ],
    steps: [
      {
        name: "Scan for pilling",
        text: "Check the underarms, sides, and cuffs where friction pills the yarn. Light, removable pilling is minor; dense matted pilling felted into the knit caps the grade.",
      },
      {
        name: "Hunt for holes",
        text: "Hold the sweater to the light and look for moth holes, snags, and pulls. A single small hole is a cosmetic hit; multiple holes signal moth damage.",
      },
      {
        name: "Test the ribbing",
        text: "Stretch and release the neckline, cuffs, and hem. Ribbing that stays stretched out lowers the grade even when the body is clean.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Unworn, no pilling, ribbing snaps back crisply." },
      { grade: "6 (Good)", note: "Light removable pilling at the cuffs, shape fully intact." },
      { grade: "3 (Poor)", note: "Matted pilling plus two moth holes and a stretched neckline." },
    ],
    relatedFlawSlugs: ["pilling", "moth-holes", "stretching"],
    faqs: [
      {
        q: "Does pilling always lower a sweater's grade?",
        a: "Only when it can't be removed. Light surface pilling that a fabric comb lifts off is a minor cosmetic note. Dense pilling that has felted into the knit is permanent wear and does lower the grade, because it changes the fabric's hand and look.",
      },
    ],
  },
  {
    slug: "cashmere-sweater",
    garment: "Cashmere sweater",
    alternateNames: ["cashmere jumper", "cashmere pullover"],
    title: "How to Grade a Used Cashmere Sweater",
    description:
      "How to grade a used cashmere sweater: pilling, moth holes, and felting from hot washes, plus graded examples on the 1–10 condition scale.",
    h1: "Grading a used cashmere sweater",
    intro:
      "Grading a used cashmere sweater is stricter than ordinary knitwear because the fibre is fine and the price is high. Buyers expect softness, so the grade turns on pilling, moth holes, and felting from a hot wash — cashmere pills fast, so honest pilling assessment separates a premium piece from a tired one.",
    criteria: [
      "Softness and loft vs. a felted, flattened hand from washing",
      "Pilling density — cashmere pills quickly, so grade the amount",
      "Moth holes, the most common and value-killing cashmere flaw",
      "Elbow and cuff thinning where the fine yarn wears through",
    ],
    steps: [
      {
        name: "Feel the hand",
        text: "Cashmere should feel soft and lofty. A stiff, flattened, or felted hand means it was washed hot and caps the grade regardless of how it looks.",
      },
      {
        name: "Grade the pilling",
        text: "All cashmere pills; judge how much. A quick de-pill returns light pilling to near-new, but permanent matted pilling lowers the grade.",
      },
      {
        name: "Search for moth holes",
        text: "Backlight the sweater and inspect the front, elbows, and underarms. Even one moth hole is a significant hit on a cashmere piece.",
      },
    ],
    gradedExamples: [
      { grade: "10 (NWT)", note: "Tags attached, soft loft, zero pills or holes." },
      { grade: "7 (Very Good)", note: "Soft hand, light de-pillable pilling, no holes." },
      { grade: "4 (Poor)", note: "Felted from a hot wash with two moth holes." },
    ],
    relatedFlawSlugs: ["pilling", "moth-holes", "felting"],
    faqs: [
      {
        q: "Why is a moth hole such a big deal on cashmere?",
        a: "Because cashmere is a premium fibre bought for its condition, a single moth hole is highly visible and hard to repair invisibly. Buyers discount holed cashmere sharply, so even one hole moves the grade down more than the same hole would on a cheaper acrylic knit.",
      },
    ],
  },
  {
    slug: "graphic-tee",
    garment: "Graphic tee",
    alternateNames: ["graphic t-shirt", "printed tee"],
    title: "How to Grade a Used Graphic Tee",
    description:
      "How to grade a used graphic tee: print cracking, collar stretch, and pit stains, with a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used graphic tee",
    intro:
      "Grading a used graphic tee is really about the print. The cotton body is cheap and replaceable, but the graphic is what buyers pay for, so cracking, peeling, and fading of the print lead the grade — alongside pit stains, collar stretch, and the pinholes that plague thin jersey.",
    criteria: [
      "Print integrity — cracking, peeling, or fading of the graphic",
      "Collar stretch and recovery on the ribbed neckline",
      "Pit stains and deodorant buildup under the arms",
      "Pinholes and thinning near the hem and front",
    ],
    steps: [
      {
        name: "Inspect the print",
        text: "Stretch the graphic gently. Fine cracking is expected on older prints; heavy peeling or flaking that lifts off the fabric is damage that leads the grade.",
      },
      {
        name: "Check the collar",
        text: "Pull and release the neckline. A stretched, wavy, or rippled collar is one of the most common tee flaws and lowers the grade.",
      },
      {
        name: "Look for stains and holes",
        text: "Backlight the shirt for pinholes and check the underarms for yellowing or deodorant crust. Both cap the grade.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Crisp print, tight collar, no stains or holes." },
      { grade: "6 (Good)", note: "Light print cracking typical of age, collar intact." },
      { grade: "3 (Poor)", note: "Peeling graphic, stretched collar, and underarm staining." },
    ],
    relatedFlawSlugs: ["cracked-graphics", "pit-stains", "stretching"],
    faqs: [
      {
        q: "Is a cracked graphic print always a defect?",
        a: "It depends on the shirt. On a vintage tee, fine even cracking is often desirable patina collectors want. On a newer tee, cracking and peeling read as wear and lower the grade. Context — the shirt's age and market — decides whether the cracking helps or hurts.",
      },
    ],
  },
  {
    slug: "dress-shirt",
    garment: "Dress shirt",
    alternateNames: ["button-up shirt", "oxford shirt"],
    title: "How to Grade a Used Dress Shirt",
    description:
      "How to grade a used dress shirt: collar and cuff fraying, ring stains, and buttons, plus a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used dress shirt",
    intro:
      "Grading a used dress shirt turns on the collar and cuffs. These are the first areas to fray and stain, so the grade leads with collar-edge wear, cuff fraying, and the ring stains that thin cotton picks up — then checks the buttons, placket, and any yellowing from long storage.",
    criteria: [
      "Collar-edge and cuff fraying — the first areas to wear",
      "Ring-around-the-collar staining and underarm yellowing",
      "Button count, cracks, and secure attachment",
      "Overall whiteness vs. storage yellowing",
    ],
    steps: [
      {
        name: "Inspect the collar and cuffs",
        text: "Run a finger along the collar fold and cuff edges for fraying and thin spots. Frayed edges are the most common dress-shirt flaw and lead the grade.",
      },
      {
        name: "Check for staining",
        text: "Look for ring stains at the collar, yellowing under the arms, and food or ink marks on the front. Set stains cap the grade.",
      },
      {
        name: "Count and test buttons",
        text: "Confirm every button is present, uncracked, and firmly sewn, and note any missing or mismatched replacements.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Crisp collar, bright white, all buttons intact." },
      { grade: "6 (Good)", note: "Light collar wear, all buttons present, no stains." },
      { grade: "3 (Poor)", note: "Frayed collar edge, underarm yellowing, one missing button." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "missing-buttons", "pit-stains"],
    faqs: [
      {
        q: "What's the first thing that lowers a dress shirt's grade?",
        a: "Collar and cuff wear. Because these edges fold and rub constantly, they fray and thin before the rest of the shirt shows any age. A frayed collar edge is usually the flaw that moves a dress shirt from very good down into the good-or-below range.",
      },
    ],
  },
  {
    slug: "hoodie-sweatshirt",
    garment: "Hoodie",
    alternateNames: ["hooded sweatshirt", "pullover sweatshirt"],
    title: "How to Grade a Used Hoodie",
    description:
      "How to grade a used hoodie: fleece matting, cuff pilling, zippers, and drawcords, with a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used hoodie",
    intro:
      "Grading a used hoodie centres on the fleece interior and the drawcord hardware. Pilling on the cuffs and hem, a matted or greyed fleece lining, and a broken zipper or missing drawcords lead the grade, while pocket stress and a stretched-out neck opening round out the inspection.",
    criteria: [
      "Cuff and hem ribbing pilling and stretch recovery",
      "Interior fleece — matting, greying, or pilling of the loops",
      "Zipper function (zip-ups) and drawcords present at the hood",
      "Kangaroo-pocket stress and sagging",
    ],
    steps: [
      {
        name: "Check the ribbing",
        text: "Stretch the cuffs and hem. Blown-out, stretched, or heavily pilled ribbing is the most common hoodie flaw and leads the grade.",
      },
      {
        name: "Inspect the fleece",
        text: "Turn it inside out. Fresh, lofty fleece grades high; matted, pilled, or greyed fleece shows heavy wash cycles and lowers the grade.",
      },
      {
        name: "Test hardware and cords",
        text: "Run the zipper full-travel on zip-ups and confirm both hood drawcords are present with their aglets intact.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Lofty fleece, tight cuffs, both drawcords present." },
      { grade: "6 (Good)", note: "Slightly matted fleece, cuffs intact, zipper smooth." },
      { grade: "3 (Poor)", note: "Greyed matted fleece, stretched cuffs, one drawcord missing." },
    ],
    relatedFlawSlugs: ["pilling", "stretching", "seam-stress"],
    faqs: [
      {
        q: "How much does a missing hood drawcord affect the grade?",
        a: "A missing or replaced drawcord is a minor functional flaw, not a dealbreaker. It lowers the grade a notch because it's visible and the aglets rarely match, but a hoodie with clean fleece and tight ribbing can still grade well overall despite one absent cord.",
      },
    ],
  },
  {
    slug: "activewear-leggings",
    garment: "Leggings",
    alternateNames: ["yoga pants", "gym leggings"],
    title: "How to Grade Used Leggings",
    description:
      "How to grade used leggings: the stretch test for sheerness, inner-thigh pilling, and waistband recovery, with graded examples on the 1–10 scale.",
    h1: "Grading used leggings",
    intro:
      "Grading used leggings is unusually strict because the flaws are subtle and use-related. Pilling on the inner thighs, thinning that turns the fabric sheer when stretched, faded waistbands, and lost compression lead the grade — a legging that's gone see-through at the seat fails no matter how clean it looks flat.",
    criteria: [
      "Sheerness — pilling or thinning that goes see-through when stretched",
      "Inner-thigh pilling and abrasion",
      "Waistband elasticity and compression retention",
      "Pilling and staining at the seat and gusset",
    ],
    steps: [
      {
        name: "Do the stretch test",
        text: "Stretch the fabric at the seat and thighs over your hand. Thinning that turns the weave sheer is the definitive legging flaw and caps the grade.",
      },
      {
        name: "Check the inner thighs",
        text: "Inspect where the legs rub for pilling and abrasion, the highest-wear zone on any legging.",
      },
      {
        name: "Test the waistband",
        text: "Stretch and release the waistband. Lost recovery or a rolled, relaxed band lowers the grade even when the legs are intact.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Full opacity when stretched, snappy waistband, no pilling." },
      { grade: "6 (Good)", note: "Minor inner-thigh pilling, still opaque and compressive." },
      { grade: "3 (Poor)", note: "Sheer at the seat when stretched and a relaxed waistband." },
    ],
    relatedFlawSlugs: ["pilling", "fabric-thinning", "stretching"],
    faqs: [
      {
        q: "Why do you stretch leggings to grade them?",
        a: "Because leggings can look opaque lying flat but go see-through under tension — exactly how they're worn. Stretching the fabric over your hand reveals thinning and pilling that has worn the weave sheer at the seat and thighs, the flaw buyers care about most and can't see in a flat photo.",
      },
    ],
  },
  {
    slug: "wool-coat",
    garment: "Wool coat",
    alternateNames: ["overcoat", "topcoat"],
    title: "How to Grade a Used Wool Coat",
    description:
      "How to grade a used wool coat: pilling, moth holes, bald patches, and lining, with a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used wool coat",
    intro:
      "Grading a used wool coat separates surface pilling from real fibre loss. Wool felts and pills at friction points, so the grade weighs pilling, moth holes, and bald patches, then checks the lining and structure — a coat lives or dies on its shoulders, buttons, and a clean, intact lining.",
    criteria: [
      "Pilling and felting at collar, cuffs, and sides",
      "Moth holes and bald patches in the wool face",
      "Lining tears, sweat staining, and hem separation",
      "Buttons present and structural shoulders holding shape",
    ],
    steps: [
      {
        name: "Read the wool surface",
        text: "Check the collar, cuffs, and underarms for pilling, felting, and thin bald spots. Fibre loss and bald patches cap the grade.",
      },
      {
        name: "Backlight for moth holes",
        text: "Hold panels to the light; wool coats are prime moth targets and even small holes lower the grade sharply.",
      },
      {
        name: "Inspect lining and structure",
        text: "Check the lining for tears and sweat stains, confirm all buttons, and make sure the shoulders and collar still hold their shape.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Clean wool face, crisp shoulders, flawless lining." },
      { grade: "6 (Good)", note: "Light cuff pilling, intact lining, all buttons present." },
      { grade: "3 (Poor)", note: "Bald patch at one cuff, two moth holes, torn lining." },
    ],
    relatedFlawSlugs: ["pilling", "moth-holes", "seam-stress"],
    faqs: [
      {
        q: "Do moth holes ruin a wool coat's grade?",
        a: "They lower it significantly. Wool is a favourite of clothes moths, and holes in the visible face fabric are hard to repair invisibly. A few small holes drop a coat into the lower grades; scattered holing usually makes it a repair-or-parts piece rather than a wearable one.",
      },
    ],
  },
  {
    slug: "puffer-jacket",
    garment: "Puffer jacket",
    alternateNames: ["down jacket", "puffa"],
    title: "How to Grade a Used Puffer Jacket",
    description:
      "How to grade a used puffer jacket: down leakage, lost loft, shell punctures, and zippers, plus graded examples on the 1–10 condition scale.",
    h1: "Grading a used puffer jacket",
    intro:
      "Grading a used puffer jacket is about the baffles and the loft. The grade leads with down leakage, flattened or clumped fill, and the pinholes and seam splits that let feathers escape, then checks the zipper — the shell can look perfect while a punctured baffle quietly bleeds down at every seam.",
    criteria: [
      "Down or feather leakage from seams, pinholes, or tears",
      "Loft — even fill vs. flattened or clumped baffles",
      "Shell punctures, snags, and delamination",
      "Main zipper function under the storm flap",
    ],
    steps: [
      {
        name: "Squeeze for leakage",
        text: "Gently squeeze and shake each baffle and look for escaping feathers. Active down leakage is the defining puffer flaw and caps the grade.",
      },
      {
        name: "Check the loft",
        text: "Confirm the fill is even and lofty. Flattened, clumped, or migrated down that leaves cold spots lowers the grade even without holes.",
      },
      {
        name: "Scan the shell and zip",
        text: "Inspect the shell for pinholes and snags and run the main zipper full-travel; a nylon shell hides tiny punctures that leak.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Full even loft, no leakage, zipper glides." },
      { grade: "6 (Good)", note: "Slight fill migration, no active leaks, shell intact." },
      { grade: "3 (Poor)", note: "Feathers escaping a seam split and a flattened baffle." },
    ],
    relatedFlawSlugs: ["seam-stress", "fabric-thinning"],
    faqs: [
      {
        q: "How do I tell if a puffer is leaking down?",
        a: "Squeeze and lightly shake each baffle in good light and watch the seams and surface. A few feathers working out at a seam means the baffle or stitching has failed, which is a major flaw — down loss is progressive and lowers the grade well below a clean-shell jacket.",
      },
    ],
  },
  {
    slug: "blazer-suit-jacket",
    garment: "Blazer",
    alternateNames: ["suit jacket", "sport coat"],
    title: "How to Grade a Used Blazer",
    description:
      "How to grade a used blazer: shoulder structure, bubbled fusing, elbow shine, and lining, with graded examples on the 1–10 condition scale.",
    h1: "Grading a used blazer",
    intro:
      "Grading a used blazer is a tailoring inspection. The grade leads with the structure buyers can't easily fix — shoulder shape, lapel roll, and the canvas — then weighs elbow shine, lining sweat stains, and button integrity. A blazer with a clean shell but bubbled fusing or a shiny seat grades down fast.",
    criteria: [
      "Structure: shoulder shape, lapel roll, and no bubbled fusing",
      "Elbow and seat shine from abrasion on worsted wool",
      "Lining condition — sweat stains, tears, vent separation",
      "Buttons present, matching, and functional (including cuff)",
    ],
    steps: [
      {
        name: "Assess the structure",
        text: "Check that the shoulders hold shape, the lapels roll cleanly, and the chest hasn't bubbled where fused interlining has delaminated — bubbling is a major, unfixable flaw.",
      },
      {
        name: "Look for shine",
        text: "Angle the elbows and seat to the light. A shiny, worn sheen on worsted wool signals heavy wear and lowers the grade.",
      },
      {
        name: "Check lining and buttons",
        text: "Inspect the lining for sweat stains and vent tears and confirm every front and cuff button is present and matching.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Crisp structure, no shine, flawless lining and buttons." },
      { grade: "6 (Good)", note: "Light elbow wear, clean lining, all buttons matching." },
      { grade: "3 (Poor)", note: "Bubbled chest fusing and shiny elbows — structurally tired." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "missing-buttons", "seam-stress"],
    faqs: [
      {
        q: "What is fabric bubbling on a blazer?",
        a: "Bubbling is when the fused interlining inside the chest or lapel delaminates from the outer wool, leaving rippled, blistered patches. It usually happens after dry-cleaning or moisture and can't be pressed out. Because it's a permanent structural flaw, bubbling drops a blazer's grade sharply even when the fabric is otherwise clean.",
      },
    ],
  },
  {
    slug: "silk-blouse",
    garment: "Silk blouse",
    alternateNames: ["silk top", "silk shirt"],
    title: "How to Grade a Used Silk Blouse",
    description:
      "How to grade a used silk blouse: water spots, deodorant stains, snags, and seam slippage, with graded examples on the 1–10 condition scale.",
    h1: "Grading a used silk blouse",
    intro:
      "Grading a used silk blouse is delicate work. Silk shows every insult — the grade leads with water spotting, deodorant and perfume stains, and the underarm degradation antiperspirant causes, then checks for snags, seam slippage, and the yellowing that ages white silk. One set stain can define the grade.",
    criteria: [
      "Water spots, perfume, and deodorant staining",
      "Underarm fibre degradation from antiperspirant",
      "Snags, pulls, and seam slippage in the woven silk",
      "Yellowing or dulling of the silk's sheen",
    ],
    steps: [
      {
        name: "Inspect for stains",
        text: "Silk records water spots, perfume, and deodorant as permanent marks. Check the front, cuffs, and neckline; set stains cap the grade.",
      },
      {
        name: "Check the underarms",
        text: "Antiperspirant degrades and stiffens silk under the arms. Look for yellowing, crustiness, or thinning there — a common hidden flaw.",
      },
      {
        name: "Look for snags and slippage",
        text: "Scan the weave for pulls and check the seams for slippage where stitches have pulled apart under tension.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Full sheen, no marks, seams tight." },
      { grade: "6 (Good)", note: "One faint water spot, otherwise clean and lustrous." },
      { grade: "3 (Poor)", note: "Underarm yellowing and a snag pull across the front." },
    ],
    relatedFlawSlugs: ["pit-stains", "fabric-thinning", "seam-stress"],
    faqs: [
      {
        q: "Can deodorant stains be removed from a silk blouse?",
        a: "Often not fully. Antiperspirant aluminium salts bond with silk protein and can permanently yellow, stiffen, or degrade the underarm fabric. Because the damage is usually set and weakens the fibre, underarm staining is a significant flaw that lowers a silk blouse's grade even when the rest of the garment is pristine.",
      },
    ],
  },
  {
    slug: "chino-trousers",
    garment: "Chino trousers",
    alternateNames: ["chinos", "khaki pants"],
    title: "How to Grade Used Chino Trousers",
    description:
      "How to grade used chino trousers: inner-thigh and seat wear, hem fraying, and pocket bags, with graded examples on the 1–10 condition scale.",
    h1: "Grading used chino trousers",
    intro:
      "Grading used chino trousers turns on the high-friction zones cotton twill wears fastest. The grade leads with inner-thigh and seat abrasion, hem fraying, and knee bagging, then checks the crotch seam, pocket bags, and any set stains — chinos rarely tear dramatically, so it's thinning and staining that move the grade.",
    criteria: [
      "Inner-thigh and seat abrasion (thinning, sheen, or blowout)",
      "Hem fraying and cuff wear",
      "Crotch-seam integrity and pocket-bag holes",
      "Knee bagging and set stains on the twill",
    ],
    steps: [
      {
        name: "Check the friction zones",
        text: "Inspect the inner thighs and seat for thinning, sheen, or a starting blowout — the first areas chinos fail and the ones that lead the grade.",
      },
      {
        name: "Inspect the hems",
        text: "Look at the hem edges for fraying and dragging wear, and confirm the original hem is intact rather than fraying open.",
      },
      {
        name: "Turn out the pockets",
        text: "Check the pocket bags and crotch seam for holes and stress, and scan the twill for set knee or ground-in stains.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Crisp twill, sharp hems, no thigh wear." },
      { grade: "6 (Good)", note: "Faint inner-thigh sheen, hems intact, no stains." },
      { grade: "3 (Poor)", note: "Thinning inner thighs starting to blow out and frayed hems." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "seam-stress"],
    faqs: [
      {
        q: "Where do chinos wear out first?",
        a: "At the inner thighs and seat, where the twill rubs constantly. That friction thins the fabric, adds a sheen, and eventually blows through — usually before the knees or hems fail. Grading a pair of chinos always starts there, because a thin inner thigh is the flaw closest to becoming a hole.",
      },
    ],
  },
  {
    slug: "jeans",
    garment: "Jeans",
    alternateNames: ["denim jeans", "denim pants"],
    title: "How to Grade a Used Pair of Jeans",
    description:
      "How to grade a used pair of jeans: crotch blowout, inner-thigh wear, and intended fades, plus a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used pair of jeans",
    intro:
      "Grading a used pair of jeans separates intended wash from real wear. Denim is bought partly for its fades, so the grade weighs whether whiskering and honeycombs are as-made, then leads with the crotch blowout, inner-thigh abrasion, and hem roping that end a jean's life regardless of how good the fades look.",
    criteria: [
      "Crotch blowout — the classic jean failure at the four-seam junction",
      "Inner-thigh abrasion and thinning toward a hole",
      "Intended fades and whiskering vs. incidental fabric loss",
      "Hem roping vs. cut hems; button-fly and rivet hardware",
    ],
    steps: [
      {
        name: "Check the crotch",
        text: "Inspect the four-seam crotch junction for thinning and blowout, the most common way jeans fail and the flaw that leads the grade.",
      },
      {
        name: "Read the fades",
        text: "Decide whether whiskering, honeycombs, and stacks are the jean's intended wash. As-made fading isn't penalized; incidental thinning is.",
      },
      {
        name: "Inspect hems and hardware",
        text: "Check the hems for damage beyond honest roping and confirm the shank button, rivets, and fly all function.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Deadstock, no wear at crotch or thighs, hardware crisp." },
      { grade: "7 (Very Good)", note: "Honest fading, thighs sound, hems roped but intact." },
      { grade: "3 (Poor)", note: "Crotch blowout and thinning inner thighs — repair only." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "seam-stress", "sun-fading"],
    faqs: [
      {
        q: "Is fading on jeans a defect?",
        a: "Usually not. Jeans are graded against their intended, worn-in state, so whiskering, honeycombs, and fade lines are part of the design and aren't penalized. What lowers the grade is structural failure on top of the fades — a crotch blowout, thinning inner thighs, or a hole heading through the fabric.",
      },
    ],
  },
  {
    slug: "pleated-skirt",
    garment: "Pleated skirt",
    alternateNames: ["accordion skirt"],
    title: "How to Grade a Used Pleated Skirt",
    description:
      "How to grade a used pleated skirt: pleat retention, fold-edge shine, closures, and hem, with graded examples on the 1–10 condition scale.",
    h1: "Grading a used pleated skirt",
    intro:
      "Grading a used pleated skirt is about whether the pleats survive. The grade leads with pleat crispness — pressed-in creases that have gone soft, splayed, or shiny lose the garment's whole point — then checks the waistband, zipper, and hem, plus any stains that settle into the folds where they're hard to clean.",
    criteria: [
      "Pleat retention — crisp, sharp folds vs. soft, splayed, or lost pleats",
      "Shine or scorch on the pleat edges from pressing",
      "Waistband, zipper, and hook-and-eye closure",
      "Hem integrity and stains trapped in the folds",
    ],
    steps: [
      {
        name: "Test the pleats",
        text: "Hang the skirt and check that the pleats fall sharp and even. Soft, opened, or splayed pleats are the defining flaw and lead the grade.",
      },
      {
        name: "Check the fold edges",
        text: "Look along the pleat edges for shine, scorching, or fraying from repeated pressing, which lowers the grade even when the pleats hold.",
      },
      {
        name: "Work the closure and hem",
        text: "Run the zipper, test the waistband hook, and inspect the hem and inner folds for trapped stains.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Razor-sharp pleats, clean closure, no fold stains." },
      { grade: "6 (Good)", note: "Pleats mostly crisp with slight softening, closure fine." },
      { grade: "3 (Poor)", note: "Splayed, flattened pleats and shine on the fold edges." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "stretching"],
    faqs: [
      {
        q: "Can flattened pleats be restored?",
        a: "Sometimes, with professional pressing, but permanently splayed pleats — especially in synthetic or aged fabric where the crease has relaxed out — often won't take a sharp fold again. Because the pleats are the garment's defining feature, lost pleat definition is a major flaw that lowers the grade regardless of the fabric's condition.",
      },
    ],
  },
  {
    slug: "maxi-dress",
    garment: "Maxi dress",
    alternateNames: ["long dress", "floor-length dress"],
    title: "How to Grade a Used Maxi Dress",
    description:
      "How to grade a used maxi dress: the dragging hem, underarm stains, zippers, and seam slippage, with graded examples on the 1–10 scale.",
    h1: "Grading a used maxi dress",
    intro:
      "Grading a used maxi dress spans a lot of fabric, so the grade leads with the hem that drags the ground — fraying, dirt, and snags at the floor-length edge — then checks the underarms, zipper, and any thin, flowy fabric for pulls, seam slippage, and the stains that show on light colours.",
    criteria: [
      "Floor-length hem — fraying, dirt line, and snags from dragging",
      "Underarm staining and odor on a full-coverage bodice",
      "Zipper and closure function on a long back seam",
      "Seam slippage and pulls in thin, flowy fabric",
    ],
    steps: [
      {
        name: "Inspect the hem",
        text: "Because a maxi hem drags the floor, check the full circumference for fraying, ground-in dirt, and snags — the first area to show wear.",
      },
      {
        name: "Check the bodice",
        text: "Look at the underarms for staining and the neckline and waist seams for slippage or pulls in lightweight fabric.",
      },
      {
        name: "Run the closure",
        text: "Zip the full length and test any hook or tie, then scan light-coloured fabric for stains that read strongly against the base.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Clean hem, no underarm marks, zipper smooth." },
      { grade: "6 (Good)", note: "Faint hem soiling, bodice clean, closure intact." },
      { grade: "3 (Poor)", note: "Frayed dirt-lined hem and underarm staining." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "pit-stains", "seam-stress"],
    faqs: [
      {
        q: "What wears out first on a maxi dress?",
        a: "The hem. A floor-length hem drags across the ground with every step, so it collects dirt, frays at the edge, and picks up snags long before the rest of the dress shows age. Grading a maxi dress starts at the hem, because that's where the wear concentrates.",
      },
    ],
  },
  {
    slug: "knit-dress",
    garment: "Knit dress",
    alternateNames: ["sweater dress", "jersey dress"],
    title: "How to Grade a Used Knit Dress",
    description:
      "How to grade a used knit dress: seat bagging, pilling, snags, and sheerness, with a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used knit dress",
    intro:
      "Grading a used knit dress combines sweater and dress checks. The grade leads with pilling and shape — the seat and hips bag out on a fitted knit — then weighs snags, holes, and whether the fabric has gone sheer or lost recovery at the stress points a body puts on a stretch dress.",
    criteria: [
      "Seat and knee bagging — lost recovery on a fitted knit",
      "Pilling at the sides, seat, and underarms",
      "Snags, pulls, and holes in the knit surface",
      "Sheerness or thinning where the knit stretches over the body",
    ],
    steps: [
      {
        name: "Check for bagging",
        text: "Look at the seat, hips, and any fitted zone for permanent bagging where the knit has stretched and won't recover — a leading knit-dress flaw.",
      },
      {
        name: "Grade the pilling",
        text: "Scan the sides, seat, and underarms for pilling and note whether it lifts off or has matted into the knit.",
      },
      {
        name: "Stretch-test thin areas",
        text: "Stretch the fabric over the seat to reveal thinning or sheerness, and scan the surface for snags and holes.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Full recovery, no pilling, opaque throughout." },
      { grade: "6 (Good)", note: "Light side pilling, shape holds, no bagging." },
      { grade: "3 (Poor)", note: "Bagged seat that won't recover and matted pilling." },
    ],
    relatedFlawSlugs: ["pilling", "stretching", "fabric-thinning"],
    faqs: [
      {
        q: "Why does a knit dress bag out at the seat?",
        a: "Because a fitted knit stretches to the body and, over time, loses its elastic recovery at the highest-tension zones — the seat and knees. Once the yarn no longer springs back, those areas stay stretched and baggy even off the body. That permanent loss of shape is a major flaw that lowers the grade.",
      },
    ],
  },
  {
    slug: "polo-shirt",
    garment: "Polo shirt",
    alternateNames: ["golf shirt", "pique polo"],
    title: "How to Grade a Used Polo Shirt",
    description:
      "How to grade a used polo shirt: collar curling, pique pilling, placket buttons, and pit stains, with graded examples on the 1–10 scale.",
    h1: "Grading a used polo shirt",
    intro:
      "Grading a used polo shirt leads with the collar and placket. A curled, wavy, or stretched collar is the most common polo flaw, so the grade starts there, then checks the pique fabric for pilling, the placket buttons, and the underarm and hem for staining and the pinholes fine knits pick up.",
    criteria: [
      "Collar shape — curling, waviness, or lost stiffness",
      "Placket buttons present, matching, and secure",
      "Pique-knit pilling and pinholes",
      "Underarm staining and hem wear",
    ],
    steps: [
      {
        name: "Judge the collar",
        text: "Lay the collar flat and check for curling, waviness, or a limp, stretched fold. A misshapen collar is the top polo flaw and leads the grade.",
      },
      {
        name: "Inspect the pique",
        text: "Scan the pique knit for pilling and backlight for pinholes, most common on the front and hem.",
      },
      {
        name: "Check buttons and pits",
        text: "Confirm the placket buttons are present and matching and inspect the underarms for staining.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Crisp flat collar, all buttons, no pilling." },
      { grade: "6 (Good)", note: "Slight collar softening, buttons intact, clean pique." },
      { grade: "3 (Poor)", note: "Curled wavy collar and underarm staining." },
    ],
    relatedFlawSlugs: ["stretching", "missing-buttons", "pit-stains"],
    faqs: [
      {
        q: "Why does the collar matter so much on a polo?",
        a: "Because it's the polo's signature feature and the first thing to look worn. Collars curl, ripple, and lose their stiffness from washing and wear, and a floppy or wavy collar reads as tired even when the body is spotless. It's usually the flaw that sets a polo's grade.",
      },
    ],
  },
  {
    slug: "flannel-shirt",
    garment: "Flannel shirt",
    alternateNames: ["flannel", "plaid shirt"],
    title: "How to Grade a Used Flannel Shirt",
    description:
      "How to grade a used flannel shirt: brushed-nap loss, pilling, elbow thinning, and buttons, with graded examples on the 1–10 condition scale.",
    h1: "Grading a used flannel shirt",
    intro:
      "Grading a used flannel shirt turns on the brushed nap. The soft fuzzy surface pills and wears flat at the collar, cuffs, and elbows, so the grade leads with nap loss and pilling, then checks the buttons, elbow thinning, and whether repeated washing has faded and thinned the cotton.",
    criteria: [
      "Brushed-nap loss — flattened, worn-smooth patches",
      "Pilling at collar, cuffs, and elbows",
      "Elbow and cuff thinning toward holes",
      "Button count and overall fade from washing",
    ],
    steps: [
      {
        name: "Check the nap",
        text: "Run a hand over the surface; the brushed nap flattens first at the collar, elbows, and cuffs. Worn-smooth patches lead the grade.",
      },
      {
        name: "Grade pilling and thinning",
        text: "Look for pilling and hold the elbows to the light for thinning that's heading toward a hole.",
      },
      {
        name: "Count buttons and fade",
        text: "Confirm all buttons are present and matching and note overall fade from repeated washing.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Full lofty nap, bright plaid, all buttons." },
      { grade: "6 (Good)", note: "Slight nap flattening at the cuffs, no holes." },
      { grade: "3 (Poor)", note: "Nap worn smooth at the elbows and a missing button." },
    ],
    relatedFlawSlugs: ["pilling", "fabric-thinning", "missing-buttons"],
    faqs: [
      {
        q: "What's the difference between pilling and nap loss on flannel?",
        a: "Pilling is loose fibre balled up on the surface; nap loss is the brushed fuzz being rubbed away entirely, leaving the flat weave exposed. Both lower a flannel's grade, but nap loss is more serious — it's permanent and changes the shirt's soft look and feel that buyers want.",
      },
    ],
  },
  {
    slug: "corduroy-pants",
    garment: "Corduroy pants",
    alternateNames: ["cords", "corduroy trousers"],
    title: "How to Grade Used Corduroy Pants",
    description:
      "How to grade used corduroy pants: crushed and bald wale, sheen, thinning, and hems, with graded examples on the 1–10 condition scale.",
    h1: "Grading used corduroy pants",
    intro:
      "Grading used corduroy pants is about the wales. The ribbed pile flattens and goes bald at the seat, knees, and inner thighs, so the grade leads with crushed or worn-away wale, then checks for the colour sheen where the pile is gone, plus hems, pocket bags, and set stains in the ridges.",
    criteria: [
      "Wale and pile condition — crushed, flattened, or bald patches",
      "Sheen at seat and knees where the pile has worn away",
      "Inner-thigh and knee thinning",
      "Hems, pocket bags, and stains trapped between the wales",
    ],
    steps: [
      {
        name: "Read the wale",
        text: "Check the seat, knees, and inner thighs where the corduroy pile crushes and goes bald. Worn-away wale is the defining flaw and leads the grade.",
      },
      {
        name: "Angle for sheen",
        text: "Tilt the high-wear zones to the light; a flat sheen where the pile is gone signals heavy wear even before it goes fully bald.",
      },
      {
        name: "Check hems and stains",
        text: "Inspect the hems and pocket bags and look for dirt and stains ground into the channels between the wales.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Full plush wale, no flattening, crisp hems." },
      { grade: "6 (Good)", note: "Slight knee flattening, no bald spots or sheen." },
      { grade: "3 (Poor)", note: "Bald crushed wale at the seat with a worn sheen." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "sun-fading"],
    faqs: [
      {
        q: "What does worn corduroy look like?",
        a: "The raised ribs, or wales, crush flat and eventually rub bald, leaving smooth, shiny patches where the plush pile used to be — usually at the seat, knees, and inner thighs. That flattening is corduroy's signature wear pattern and the main thing that lowers a pair's grade, because the pile can't be restored.",
      },
    ],
  },
  {
    slug: "cardigan",
    garment: "Cardigan",
    alternateNames: ["button-front sweater"],
    title: "How to Grade a Used Cardigan",
    description:
      "How to grade a used cardigan: placket buttons, buttonhole stretch, pilling, and ribbing, with graded examples on the 1–10 condition scale.",
    h1: "Grading a used cardigan",
    intro:
      "Grading a used cardigan blends knitwear checks with a button placket. The grade leads with pilling and shape recovery like any knit, then adds the front-specific flaws — placket buttons present and matching, buttonhole stretch, and a placket that hangs straight rather than gaping or drooping from wear.",
    criteria: [
      "Placket buttons present, matching, and secure",
      "Buttonhole stretch and a straight-hanging front",
      "Pilling at underarms, cuffs, and sides",
      "Ribbing recovery at cuffs, hem, and front band",
    ],
    steps: [
      {
        name: "Work the placket",
        text: "Button the cardigan and check that the front hangs straight, buttons match, and buttonholes aren't stretched open — the flaws unique to a cardigan.",
      },
      {
        name: "Grade the knit",
        text: "Scan for pilling at the underarms and cuffs and note whether it lifts off or has matted in.",
      },
      {
        name: "Test the ribbing",
        text: "Stretch and release the cuffs, hem, and front band; a stretched, drooping band lowers the grade.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Straight placket, all buttons matching, no pilling." },
      { grade: "6 (Good)", note: "Light cuff pilling, buttons intact, band holds." },
      { grade: "3 (Poor)", note: "Two missing buttons and stretched, gaping buttonholes." },
    ],
    relatedFlawSlugs: ["pilling", "missing-buttons", "stretching"],
    faqs: [
      {
        q: "Do mismatched replacement buttons lower a cardigan's grade?",
        a: "Yes, modestly. Replacement buttons that don't match the originals are visible and read as a repair, so they nudge the grade down even when they're secure. A full set of original, matching buttons is part of a high-grade cardigan; odd or plastic swaps on a wool piece are a clear flaw.",
      },
    ],
  },
  {
    slug: "tank-top",
    garment: "Tank top",
    alternateNames: ["camisole", "vest top"],
    title: "How to Grade a Used Tank Top",
    description:
      "How to grade a used tank top: strap stretch, underarm stains, pinholes, and shape, with a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used tank top",
    intro:
      "Grading a used tank top concentrates wear into a small garment. The grade leads with the straps and neckline — stretched, twisted, or thinning straps are the top flaw — then checks the underarms for staining, the thin jersey for pinholes, and whether the fabric still holds its shape at the bust.",
    criteria: [
      "Strap condition — stretch, twist, and thinning",
      "Underarm staining and deodorant buildup",
      "Pinholes and thinning in lightweight jersey",
      "Neckline and bust shape retention",
    ],
    steps: [
      {
        name: "Check the straps",
        text: "Stretch each strap and the neckline; stretched, twisted, or thinning straps are the most common tank flaw and lead the grade.",
      },
      {
        name: "Inspect the underarms",
        text: "Look for yellowing and deodorant buildup under the arms, prominent on a sleeveless cut.",
      },
      {
        name: "Backlight the body",
        text: "Hold the jersey to the light for pinholes and thin spots and confirm the bust still holds shape.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Snappy straps, clean pits, opaque jersey." },
      { grade: "6 (Good)", note: "Slight strap relaxation, no stains or holes." },
      { grade: "3 (Poor)", note: "Stretched straps and underarm yellowing." },
    ],
    relatedFlawSlugs: ["stretching", "pit-stains", "fabric-thinning"],
    faqs: [
      {
        q: "What's the most common flaw on a used tank top?",
        a: "Stretched straps. Because the straps are thin and carry the whole garment, they relax, twist, and thin out faster than the body — and a strap that no longer holds its length or has gone limp is the flaw that most often sets a tank top's grade below very good.",
      },
    ],
  },
  {
    slug: "raincoat",
    garment: "Raincoat",
    alternateNames: ["rain jacket", "mac"],
    title: "How to Grade a Used Raincoat",
    description:
      "How to grade a used raincoat: coating cracks, seam-tape failure, DWR, and zippers, with graded examples on the 1–10 condition scale.",
    h1: "Grading a used raincoat",
    intro:
      "Grading a used raincoat is a waterproofing inspection. The grade leads with the coating and seams that keep water out — cracked or peeling laminate, delaminated seam tape, and a failed DWR finish — then checks the zipper, storm flap, and any tears, because a raincoat that lets water in has lost its purpose.",
    criteria: [
      "Waterproof coating — cracking, peeling, or delamination",
      "Seam-tape integrity on the inside seams",
      "DWR finish — beading vs. wetting-out (sponginess)",
      "Zipper, storm flap, and tears in the shell",
    ],
    steps: [
      {
        name: "Inspect the coating",
        text: "Check the inner face for cracked, flaking, or peeling laminate and run seams for lifting tape — the failures that let water through and lead the grade.",
      },
      {
        name: "Check the seams",
        text: "Look at the taped inner seams; delaminated or curling tape is a waterproofing flaw even when the outer shell looks fine.",
      },
      {
        name: "Test hardware and shell",
        text: "Run the main zipper, check the storm flap, and scan the shell for tears and abrasion.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Intact coating, sealed seams, crisp zipper." },
      { grade: "6 (Good)", note: "DWR wetting out slightly, coating and tape intact." },
      { grade: "3 (Poor)", note: "Peeling inner laminate and lifting seam tape." },
    ],
    relatedFlawSlugs: ["seam-stress", "fabric-thinning"],
    faqs: [
      {
        q: "How can I tell if a raincoat is still waterproof?",
        a: "Check the inside. A failing raincoat shows cracked or peeling coating on the inner face and seam tape that's lifting or delaminating — both let water through even when the outside looks fine. A tired outer DWR that no longer beads water is a lesser issue; interior coating failure is what lowers the grade most.",
      },
    ],
  },
  {
    slug: "denim-shorts",
    garment: "Denim shorts",
    alternateNames: ["jean shorts", "cutoffs"],
    title: "How to Grade Used Denim Shorts",
    description:
      "How to grade used denim shorts: intended distressing vs. real wear, inner-thigh and crotch stress, with graded examples on the 1–10 scale.",
    h1: "Grading used denim shorts",
    intro:
      "Grading used denim shorts separates intended distressing from real wear. Frayed cut hems are usually by design, so the grade weighs whether fraying and fading are as-made, then leads with inner-thigh abrasion, the crotch seam, and pocket-corner stress — the structural points that fail beneath the fashionable distressing.",
    criteria: [
      "Intended raw or frayed hems and fading vs. incidental wear",
      "Inner-thigh abrasion and thinning",
      "Crotch-seam and pocket-corner stress",
      "Waistband, fly, and hardware function",
    ],
    steps: [
      {
        name: "Read the distressing",
        text: "Decide whether frayed hems, fading, and rips are the design. As-made distressing isn't penalized; incidental thinning and blowouts are.",
      },
      {
        name: "Check the structure",
        text: "Inspect the inner thighs and crotch seam for thinning heading toward a blowout — the flaw that leads the grade.",
      },
      {
        name: "Test the hardware",
        text: "Work the fly, button, and rivets and check the pocket corners for stress and holes.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Deadstock, crisp with intended fraying, hardware perfect." },
      { grade: "7 (Very Good)", note: "As-made distressing, thighs sound, fly works." },
      { grade: "3 (Poor)", note: "Blown-out inner thigh beyond the intended rips." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "seam-stress", "sun-fading"],
    faqs: [
      {
        q: "How do you grade intentionally distressed denim shorts?",
        a: "Against their intended, as-made state. Factory fraying, rips, and fading are the design and don't lower the grade. What counts is unintended damage on top — a crotch blowout, thinning that's about to become a hole where none was designed, or a broken fly — which does move the grade down.",
      },
    ],
  },
  {
    slug: "joggers",
    garment: "Joggers",
    alternateNames: ["sweatpants", "track pants"],
    title: "How to Grade Used Joggers",
    description:
      "How to grade used joggers: fleece matting, cuff and waistband recovery, thigh pilling, and drawcord, with graded examples on the 1–10 scale.",
    h1: "Grading used joggers",
    intro:
      "Grading used joggers leads with the fleece and the cuffs. The grade weighs interior fleece matting, pilling at the inner thighs and seat, and the elastic cuffs and waistband that lose their snap, then checks the drawcord and any thinning where a sweatpant rubs and bags at the knees.",
    criteria: [
      "Interior fleece — matting, greying, and pilling",
      "Inner-thigh and seat pilling and thinning",
      "Elastic cuff and waistband recovery",
      "Drawcord present; knee bagging",
    ],
    steps: [
      {
        name: "Inspect the fleece",
        text: "Turn the joggers inside out; matted, greyed, or pilled fleece signals heavy washing and lowers the grade.",
      },
      {
        name: "Test the elastic",
        text: "Stretch the ankle cuffs and waistband and release. Blown-out cuffs that no longer taper are a leading jogger flaw.",
      },
      {
        name: "Check thighs and cord",
        text: "Scan the inner thighs and seat for pilling and thinning and confirm the drawcord is present with intact aglets.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Lofty fleece, snappy cuffs, drawcord intact." },
      { grade: "6 (Good)", note: "Slight fleece matting, cuffs hold, no thinning." },
      { grade: "3 (Poor)", note: "Greyed matted fleece and blown-out ankle cuffs." },
    ],
    relatedFlawSlugs: ["pilling", "stretching", "fabric-thinning"],
    faqs: [
      {
        q: "What makes joggers look worn out?",
        a: "Two things: the interior fleece matting and greying from repeated washing, and the elastic cuffs losing their taper. Once the ankle cuffs blow out and no longer hug the leg, and the fleece feels flat and looks dingy, a pair of joggers reads as tired — and both flaws lower the grade.",
      },
    ],
  },
  {
    slug: "jumpsuit",
    garment: "Jumpsuit",
    alternateNames: ["romper", "playsuit"],
    title: "How to Grade a Used Jumpsuit",
    description:
      "How to grade a used jumpsuit: the closure, waist-seam integrity, underarm stains, and stress zones, with graded examples on the 1–10 scale.",
    h1: "Grading a used jumpsuit",
    intro:
      "Grading a used jumpsuit means inspecting a top and bottom as one piece. The grade leads with the closure system — a long back zipper or snap crotch that must work — then checks the waist seam that joins the halves, underarm staining, and the seat and knees for the stress a one-piece concentrates.",
    criteria: [
      "Closure — long zipper, snap crotch, or clasp all functioning",
      "Waist-seam integrity where top meets bottom",
      "Underarm staining on the enclosed bodice",
      "Seat and knee stress from a one-piece cut",
    ],
    steps: [
      {
        name: "Test the closure",
        text: "Run the full-length zipper or snap crotch and every clasp. A jumpsuit's closure is essential and a failed one leads the grade.",
      },
      {
        name: "Check the waist seam",
        text: "Inspect the seam joining top and bottom for slippage or stress, since it carries the load of a one-piece garment.",
      },
      {
        name: "Inspect stress zones",
        text: "Look at the seat, knees, and underarms for thinning, staining, and seam stress.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Smooth full-length zip, tight waist seam, clean pits." },
      { grade: "6 (Good)", note: "Closure works, faint underarm mark, seams sound." },
      { grade: "3 (Poor)", note: "Snap crotch failing and a stressed waist seam." },
    ],
    relatedFlawSlugs: ["seam-stress", "pit-stains"],
    faqs: [
      {
        q: "What should I check first on a used jumpsuit?",
        a: "The closure. A jumpsuit depends on a long back zipper or a snap crotch to get in and out, and if that fails the garment is unwearable regardless of fabric condition. Test the full closure first — a broken or separating zip is the flaw most likely to define the grade.",
      },
    ],
  },
  {
    slug: "vintage-tee",
    garment: "Vintage tee",
    alternateNames: ["vintage t-shirt", "band tee"],
    title: "How to Grade a Vintage T-Shirt",
    description:
      "How to grade a vintage tee: when fading and print cracking are patina, not damage, plus holes, stains, and graded examples on the 1–10 scale.",
    h1: "Grading a vintage tee",
    intro:
      "Grading a vintage tee flips the usual rules — here, wear is often value. Fine even print cracking and a soft, thin hand are desirable patina collectors pay for, so the grade rewards honest age while still penalizing what kills a vintage tee: holes, set stains, and cut or altered hems and collars.",
    criteria: [
      "Desirable patina (even fade, soft thinning, fine cracking) vs. damage",
      "Holes, especially at the front print and collar",
      "Set stains that read against aged cotton",
      "Originality — uncut hems, collar, and unaltered fit",
    ],
    steps: [
      {
        name: "Separate patina from damage",
        text: "On a vintage tee, even fading and fine print cracking are value, not flaws. Grade those as patina; reserve penalties for holes and stains.",
      },
      {
        name: "Hunt for holes",
        text: "Backlight the print and body for pinholes and moth holes, which — unlike fading — do lower a vintage tee's grade.",
      },
      {
        name: "Confirm originality",
        text: "Check that the hem, collar, and sleeves are uncut and unaltered, since a chopped vintage tee loses collector value.",
      },
    ],
    gradedExamples: [
      { grade: "9 (Excellent)", note: "Soft, evenly faded, crisp seams, no holes — prized patina." },
      { grade: "6 (Good)", note: "Honest wear with one tiny pinhole, all original." },
      { grade: "3 (Poor)", note: "Multiple holes through the print and a cut collar." },
    ],
    relatedFlawSlugs: ["cracked-graphics", "sun-fading", "moth-holes"],
    faqs: [
      {
        q: "Why can a faded, thin vintage tee grade higher than a newer one?",
        a: "Because vintage tees are collected for exactly that softly-worn look — even fading, a thin buttery hand, and fine print cracking are patina the market rewards. A vintage tee is graded against its collectible ideal, so honest age helps the grade, while holes, stains, and alterations still hurt it.",
      },
    ],
  },
  {
    slug: "wool-suit",
    garment: "Wool suit",
    alternateNames: ["two-piece suit", "suit set"],
    title: "How to Grade a Used Wool Suit",
    description:
      "How to grade a used wool suit: jacket structure, trouser seat wear, and matched-set condition, with graded examples on the 1–10 scale.",
    h1: "Grading a used wool suit",
    intro:
      "Grading a used wool suit means grading two pieces as a set, and the weakest piece leads. The grade weighs jacket structure and elbow shine plus trouser seat and inner-thigh wear, then checks that both halves match in colour and wear — a suit is only as good as its more-worn component.",
    criteria: [
      "Jacket structure — shoulders, lapel roll, no bubbled fusing",
      "Elbow shine and trouser seat and inner-thigh wear",
      "Colour and wear match between jacket and trousers",
      "Lining, buttons, and moth holes across both pieces",
    ],
    steps: [
      {
        name: "Grade the jacket",
        text: "Check shoulder shape, lapel roll, and the chest for bubbled fusing, plus elbow shine — the jacket flaws that lead the grade.",
      },
      {
        name: "Grade the trousers",
        text: "Inspect the seat and inner thighs for shine and thinning, the first zones a suit trouser wears through.",
      },
      {
        name: "Match the set",
        text: "Confirm jacket and trousers match in colour and wear level and check both for moth holes; the more-worn piece caps the grade.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Crisp jacket, clean seat, both pieces matching." },
      { grade: "6 (Good)", note: "Light elbow shine, trousers sound, colours match." },
      { grade: "3 (Poor)", note: "Bubbled jacket chest and shiny worn trouser seat." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "moth-holes", "seam-stress"],
    faqs: [
      {
        q: "Why does the more-worn piece decide a suit's grade?",
        a: "Because a suit is sold and worn as a matched set. If the trousers are worn shiny at the seat but the jacket is pristine, the pair still can't be worn as a suit at a high level — so the set grades to its weaker half. Mismatched wear between the pieces is itself a flaw.",
      },
    ],
  },
  {
    slug: "linen-shirt",
    garment: "Linen shirt",
    alternateNames: ["linen top"],
    title: "How to Grade a Used Linen Shirt",
    description:
      "How to grade a used linen shirt: why wrinkles aren't flaws, plus thinning, holes, and seam slippage, with graded examples on the 1–10 scale.",
    h1: "Grading a used linen shirt",
    intro:
      "Grading a used linen shirt accounts for the fibre's quirks. Linen wrinkles and softens by nature, so slubs and creasing aren't flaws, and the grade leads instead with the thinning, holes, and seam stress linen develops as it weakens with washing — plus collar wear, buttons, and stains that set in the open weave.",
    criteria: [
      "Thinning and holes as linen weakens (not wrinkles or slubs)",
      "Seam stress and slippage in the loose weave",
      "Collar and cuff wear",
      "Set stains lodged in the open weave; buttons",
    ],
    steps: [
      {
        name: "Look past the wrinkles",
        text: "Ignore creasing and slubs — they're inherent to linen. Grade the fibre's strength instead: hold panels to the light for thinning and holes.",
      },
      {
        name: "Check the seams",
        text: "Inspect seams for slippage and stress, common in linen's loose weave, especially at the shoulders and side seams.",
      },
      {
        name: "Inspect collar and stains",
        text: "Check the collar and cuffs for wear, confirm all buttons, and look for stains set into the open weave.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Strong crisp weave, no thinning, all buttons." },
      { grade: "6 (Good)", note: "Softened and slubby but sound, no holes or stains." },
      { grade: "3 (Poor)", note: "Thinning shoulders with a small hole and seam slippage." },
    ],
    relatedFlawSlugs: ["fabric-thinning", "seam-stress"],
    faqs: [
      {
        q: "Do wrinkles lower a linen shirt's grade?",
        a: "No. Linen wrinkles and shows slubs by nature — that relaxed, textured look is expected and isn't a flaw. What lowers a linen shirt's grade is genuine fibre weakening: thinning that lets light through, small holes, and seam slippage in the loose weave, which are the real signs of a garment near the end of its life.",
      },
    ],
  },
  {
    slug: "down-vest",
    garment: "Down vest",
    alternateNames: ["puffer vest", "gilet"],
    title: "How to Grade a Used Down Vest",
    description:
      "How to grade a used down vest: down leakage, lost loft, and armhole abrasion, with a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used down vest",
    intro:
      "Grading a used down vest is a compact puffer inspection. The grade leads with down leakage and loft — feathers escaping seams, flattened baffles — then checks the main zipper and the armholes and shoulders, the abrasion points where a layered vest rubs against jackets and packs and the shell wears through first.",
    criteria: [
      "Down leakage from seams, pinholes, or tears",
      "Loft — even fill vs. flattened or clumped baffles",
      "Armhole and shoulder abrasion (layering wear points)",
      "Main zipper function",
    ],
    steps: [
      {
        name: "Squeeze for leakage",
        text: "Squeeze and shake each baffle for escaping feathers; active down loss is the leading vest flaw and caps the grade.",
      },
      {
        name: "Check armholes and shoulders",
        text: "Inspect the bound armholes and shoulders, where a layered vest abrades against sleeves and pack straps and the shell thins first.",
      },
      {
        name: "Test loft and zip",
        text: "Confirm even, lofty fill with no cold clumps and run the main zipper full-travel.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Even loft, no leaks, crisp zipper and armholes." },
      { grade: "6 (Good)", note: "Slight fill migration, armholes sound, no leakage." },
      { grade: "3 (Poor)", note: "Feathers leaking a seam and abraded shoulder shell." },
    ],
    relatedFlawSlugs: ["seam-stress", "fabric-thinning"],
    faqs: [
      {
        q: "Where does a down vest wear out first?",
        a: "At the armholes and shoulders. Because a vest is almost always layered, those edges rub constantly against jacket sleeves and backpack straps, so the shell abrades and thins there before anywhere else — and a worn armhole that's starting to leak down is often the flaw that sets the grade.",
      },
    ],
  },
  {
    slug: "fleece-jacket",
    garment: "Fleece jacket",
    alternateNames: ["fleece pullover", "polar fleece"],
    title: "How to Grade a Used Fleece Jacket",
    description:
      "How to grade a used fleece jacket: pilling, matting, lost loft, and zippers, with a photo checklist and graded examples on the 1–10 scale.",
    h1: "Grading a used fleece jacket",
    intro:
      "Grading a used fleece jacket is about pill and loft. Fleece pills and mats at the cuffs, collar, and sides, flattening the pile buyers want, so the grade leads with pilling and matting, then checks the zipper, pockets, and whether the fabric has gone hard and shiny from heavy wash cycles.",
    criteria: [
      "Pilling and matting of the pile at cuffs, collar, and sides",
      "Loft — soft plush pile vs. flattened, hard, shiny fleece",
      "Zipper and pocket function",
      "Snags and pulls in the fleece",
    ],
    steps: [
      {
        name: "Check the pile",
        text: "Run a hand over the fleece at the cuffs, collar, and sides. Matted, pilled, flattened pile is the leading fleece flaw and caps the grade.",
      },
      {
        name: "Judge the loft",
        text: "Compare high-wear zones to protected areas; fleece that's gone hard, thin, and shiny from washing lowers the grade even without pills.",
      },
      {
        name: "Test the hardware",
        text: "Run the main and pocket zippers full-travel and scan for snags.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Plush lofty pile, no pilling, zipper glides." },
      { grade: "6 (Good)", note: "Slight cuff matting, body still soft, zipper fine." },
      { grade: "3 (Poor)", note: "Matted, hard, shiny pile and a catching zipper." },
    ],
    relatedFlawSlugs: ["pilling", "felting", "fabric-thinning"],
    faqs: [
      {
        q: "What ruins the look of a fleece jacket?",
        a: "Matting and pilling of the pile. The soft, lofty surface that makes fleece appealing flattens, pills, and mats at friction points — cuffs, collar, and sides — and eventually goes hard and shiny from heavy washing. That loss of loft is the main thing that lowers a fleece jacket's grade, and it can't be brushed back.",
      },
    ],
  },
  {
    slug: "workwear-pants",
    garment: "Workwear pants",
    alternateNames: ["work pants", "carpenter pants", "duck canvas pants"],
    title: "How to Grade Used Workwear Pants",
    description:
      "How to grade used workwear pants: knee and seat abrasion, tool-loop stress, seam blowouts, and hardware, with graded examples on the 1–10 scale.",
    h1: "Grading used workwear pants",
    intro:
      "Grading used workwear pants weighs heavy-duty construction against hard use. Built from thick canvas or duck, they take abuse, so the grade leads with knee and cuff abrasion, reinforced-pocket and tool-loop stress, and blown-out crotch or seat seams, then checks hardware and set stains that come with the territory.",
    criteria: [
      "Knee, cuff, and hem abrasion on the heavy fabric",
      "Reinforced pockets, tool loops, and rivets under stress",
      "Crotch and seat seam blowouts",
      "Set stains (paint, grease) and hardware function",
    ],
    steps: [
      {
        name: "Check abrasion zones",
        text: "Inspect the knees, cuffs, and hems for the abrasion and fraying that heavy canvas develops first — these lead the grade.",
      },
      {
        name: "Test reinforcements",
        text: "Pull on the tool loops, hammer loop, and reinforced pockets and check rivets; torn-off loops and stressed pockets lower the grade.",
      },
      {
        name: "Inspect seams and stains",
        text: "Check the crotch and seat seams for blowouts and note set paint, grease, or ground-in stains and hardware function.",
      },
    ],
    gradedExamples: [
      { grade: "9 (NWOT)", note: "Crisp canvas, intact loops, no abrasion." },
      { grade: "6 (Good)", note: "Light knee scuffing, all loops and rivets sound." },
      { grade: "3 (Poor)", note: "Blown seat seam and a torn-off tool loop." },
    ],
    relatedFlawSlugs: ["seam-stress", "fabric-thinning"],
    faqs: [
      {
        q: "Are paint or grease stains automatic dealbreakers on work pants?",
        a: "Not always. Workwear is expected to show some hard-use marks, and light, set stains lower the grade less than they would on a dress garment because they're in character. Structural failure matters more — a blown seat seam or torn-off tool loop hurts a work pant's grade more than a paint splatter does.",
      },
    ],
  },
];

const GUIDE_BY_SLUG = new Map(GARMENT_GUIDES.map((g) => [g.slug, g]));
const GUIDE_BY_PATH = new Map(GARMENT_GUIDES.map((g) => [guidePath(g.slug), g]));

export function getGuideBySlug(slug: string): GarmentGuide | undefined {
  return GUIDE_BY_SLUG.get(slug);
}
export function getGuideByPath(path: string): GarmentGuide | undefined {
  return GUIDE_BY_PATH.get(path);
}
export function isGuidePath(path: string): boolean {
  return GUIDE_BY_PATH.has(path);
}
export function isGuideHubPath(path: string): boolean {
  return path === GARMENT_GUIDES_HUB_PATH;
}

/** PublicRoute entries for the hub + every garment guide. */
export function garmentGuideRoutes(): PublicRoute[] {
  const hub: PublicRoute = {
    path: GARMENT_GUIDES_HUB_PATH,
    title: "How to Grade Used Clothing by Type",
    description:
      "Garment-by-garment grading guides — denim, leather, knitwear, activewear and more — each with the flaws to check, a photo checklist, and graded examples.",
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "HowTo",
  };
  const guides: PublicRoute[] = GARMENT_GUIDES.map((g) => ({
    path: guidePath(g.slug),
    title: g.title,
    description: g.description,
    changefreq: "monthly",
    priority: 0.5,
    jsonLdType: "HowTo",
  }));
  return [hub, ...guides];
}

/** Breadcrumb trail (relative) for a garment guide page. */
export function guideTrail(
  guide: GarmentGuide,
): Array<{ name: string; path: string }> {
  return [
    { name: "GradeThread", path: "/" },
    { name: "Grading guides", path: GARMENT_GUIDES_HUB_PATH },
    { name: guide.garment, path: guidePath(guide.slug) },
  ];
}
