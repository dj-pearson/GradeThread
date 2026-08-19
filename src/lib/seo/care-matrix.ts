// The flaw-crossed-with-fabric matrix (US-9014), under /care/{flaw}/{fabric}.
//
// SIX FIBRE CLASSES TIMES 32 FLAWS IS 192 PAGES. This file contains 18, and the
// 174 it does not contain are the point of it.
//
// A programmatic family earns its existence only where the generated page says
// something the parent page does not. Path 4's value pages failed that test:
// "what is a Nike Tech Fleece worth in Excellent condition" is the same
// sentence 400 times with the nouns swapped. This family passes it, because
// getting oil out of silk is genuinely not the procedure for cotton denim -
// enzyme detergent digests protein fibres, so the step that rescues the denim
// destroys the blouse.
//
// THE RULE, enforced by src/test/care-matrix.test.ts: a combination gets a page
// only when it carries `differs`, a one-line statement of what changes, and a
// procedure that is not the parent's. Combinations whose answer is the parent's
// answer are simply not generated; there is no thin page to canonicalise
// because there is no page.
//
// FIBRE CLASSES ARE MIRRORED, NOT INVENTED. They come from FiberClass in
// services/edge-functions/src/lib/fabric-criteria.ts, which is the grading
// engine's own taxonomy. src/test/care-matrix.test.ts reads that file and fails
// if the two lists drift, the same treatment ebay-fees.ts gets.

import type { PublicRoute } from "./public-routes";
import { FLAW_LIBRARY_HUB_PATH, getFlawBySlug } from "./flaw-library";

/** Mirrors FiberClass in services/edge-functions/src/lib/fabric-criteria.ts. */
export type FiberClass =
  | "wool_cashmere"
  | "cotton_denim"
  | "synthetic"
  | "silk"
  | "leather_suede"
  | "linen";

/** URL segment for a fibre class. Underscores are not URL-shaped. */
export const FIBER_SLUGS: Record<FiberClass, string> = {
  wool_cashmere: "wool",
  cotton_denim: "cotton",
  synthetic: "synthetic",
  silk: "silk",
  leather_suede: "leather",
  linen: "linen",
};

/** How each fibre is named in prose. */
export const FIBER_LABELS: Record<FiberClass, string> = {
  wool_cashmere: "wool and cashmere",
  cotton_denim: "cotton and denim",
  synthetic: "synthetics",
  silk: "silk",
  leather_suede: "leather and suede",
  linen: "linen",
};

export interface MatrixEntry {
  /** A slug from FLAW_ENTRIES. */
  flaw: string;
  fiber: FiberClass;
  /** <title> without the suffix. 46 chars. */
  title: string;
  /** 70-160. */
  description: string;
  h1: string;
  /**
   * ONE LINE on what actually changes versus the parent flaw page. If you
   * cannot write this line, the combination does not get a page.
   */
  differs: string;
  /** The procedure for this fibre. Must not restate the parent's steps. */
  steps: string[];
  /** What ruins the garment. The reason someone searched the fibre, not the flaw. */
  neverDo: string;
}

export const CARE_MATRIX: readonly MatrixEntry[] = [
  // ── Stains: the fibre changes the chemistry, not just the caution ───────
  {
    flaw: "stains-general",
    fiber: "silk",
    title: "How to Get a Stain Out of Silk",
    description:
      "Enzyme detergent digests silk, because silk is a protein and so is the stain. What to use instead, and why water alone leaves a ring on silk.",
    h1: "Getting a stain out of silk",
    differs:
      "Silk is a protein fibre, so the enzyme detergent that lifts a protein stain digests the garment along with it.",
    steps: [
      "Blot with a dry white cloth. Coloured cloth transfers dye into silk far more readily than into cotton.",
      "Work with cool water and a drop of pH-neutral detergent, never an enzyme or biological one.",
      "Treat the WHOLE panel rather than the spot. Silk shows a tide line where a treated area meets an untreated one, which is a second, larger problem than the stain.",
      "Roll in a towel to blot, then dry flat away from heat and sun.",
      "If it survives that, stop and take it to a cleaner. A second home attempt on silk usually costs more than the first one saved.",
    ],
    neverDo:
      "No enzyme detergent, no oxygen bleach, no hot water, no rubbing. Any of the four dulls the sheen permanently even if the stain goes.",
  },
  {
    flaw: "stains-general",
    fiber: "wool_cashmere",
    title: "How to Get a Stain Out of Wool",
    description:
      "Wool is a protein, so a biological detergent attacks the fibre and not just the stain. The cool-water, no-agitation method that does not felt it.",
    h1: "Getting a stain out of wool",
    differs:
      "Wool is a protein fibre and it felts. Enzymes eat it, and the agitation that shifts a stain from cotton mats it permanently.",
    steps: [
      "Lift any solids off with a blunt edge before adding water. Pressing them in is most of the damage.",
      "Use cool water and a wool-safe, non-biological detergent.",
      "Press the cloth against the stain. Do not rub, and do not work the fabric between your hands, which is the motion that felts it.",
      "Rinse by pressing clean water through the same way, then roll in a towel.",
      "Dry flat and away from a radiator. Heat plus moisture is the second half of felting.",
    ],
    neverDo:
      "No biological detergent, no hot water, no wringing, no tumble drying. Felting is not reversible, so a felted jumper is a worse outcome than the stain.",
  },
  {
    flaw: "stains-general",
    fiber: "leather_suede",
    title: "How to Get a Stain Out of Leather",
    description:
      "On leather the water is itself the stain. Why the first instinct ruins the panel, and how to lift grease with a dry absorbent instead.",
    h1: "Getting a stain out of leather and suede",
    differs:
      "Water is itself a stain on leather and suede, so every step of the usual method makes a second mark around the first.",
    steps: [
      "Do nothing wet. On grease, cover the mark with cornflour or talc and leave it overnight to draw the oil out.",
      "Brush the powder away with a soft brush, following the nap on suede.",
      "For a mark on suede, a suede eraser and a brass-bristle brush do more than any liquid will.",
      "For smooth leather, a dedicated leather cleaner on a cloth, worked over the WHOLE panel so there is no clean patch next to a dirty one.",
      "Recondition afterwards. Cleaning removes oils the hide needs, and a dry panel cracks at the flex points within a season.",
    ],
    neverDo:
      "No water, no washing machine, no household detergent, no heat to dry it. Each leaves a permanent tide line or cracks the finish.",
  },
  // ── Ink: the solvent that works is the solvent that destroys ────────────
  {
    flaw: "ink-stains",
    fiber: "silk",
    title: "How to Get Ink Out of Silk",
    description:
      "Isopropyl alcohol lifts ink and strips silk dye at the same time. Why the standard method trades an ink mark for a pale bleached one.",
    h1: "Getting ink out of silk",
    differs:
      "The alcohol that dissolves ink also dissolves silk dye, so the standard method trades an ink mark for a bleached one.",
    steps: [
      "Test on an inside seam first, and wait for it to dry. Silk dye lifts slowly enough to look fine while wet.",
      "If the test lifts colour, stop. This is a professional job and nothing at home improves it.",
      "If it does not, back the fabric with a white cloth and apply the smallest possible amount with a cotton bud.",
      "Blot from the outside of the mark inward, moving to clean cloth constantly.",
      "Rinse the area with cool water immediately rather than letting the alcohol sit.",
    ],
    neverDo:
      "No hairspray, no hand sanitiser, no soaking. All three are standard ink advice and all three are written for cotton.",
  },
  {
    flaw: "ink-stains",
    fiber: "leather_suede",
    title: "How to Get Ink Out of Leather",
    description:
      "Alcohol removes the leather's finish along with the ink and leaves a dull patch. What actually lifts a fresh mark, and why a set one is a repair.",
    h1: "Getting ink out of leather",
    differs:
      "Alcohol strips the leather's finish, so it removes the ink and the colour underneath it in the same pass.",
    steps: [
      "Act immediately. Ink that has been on leather for a day has soaked past the finish and is no longer a cleaning problem.",
      "Blot, never wipe. Wiping spreads ink along the grain and into a much larger area.",
      "Use a leather-specific ink lifter, worked from the outside in with a cotton bud.",
      "Recondition the panel afterwards.",
      "For a set mark, the honest options are a professional colour touch-up or living with it.",
    ],
    neverDo:
      "No alcohol, no acetone, no magic eraser. The magic eraser is an abrasive and it takes the top layer of finish off.",
  },
  // ── Pilling: comes out of one fibre and never out of another ───────────
  {
    flaw: "pilling",
    fiber: "synthetic",
    title: "Pilling on Synthetics: Why It Stays",
    description:
      "Pills on fleece and technical knits do not comb out the way wool pills do, because the fibre is stronger than the yarn holding it.",
    h1: "Pilling on synthetics",
    differs:
      "A synthetic pill is anchored by a fibre stronger than the yarn around it, so shaving removes the pill and leaves the anchor to make another.",
    steps: [
      "Shave it if you are photographing or wearing it soon, and expect it back after two or three washes.",
      "Use the lowest setting. Synthetic knits are thinner than they look and a shaver goes through fleece easily.",
      "Do not comb. A sweater comb needs a fibre that breaks, and polyester does not break.",
      "Wash inside out, cold, on a gentle cycle, and never with anything abrasive like denim or towels.",
      "Accept the ceiling: on a fleece, pilling is the wear indicator. It is what a heavily worn fleece looks like and there is no version where it goes away for good.",
    ],
    neverDo:
      "Do not treat this the way you would treat wool pilling. Wool pills are dead fibre coming off; synthetic pills are the garment telling you how much life it has left.",
  },
  {
    flaw: "pilling",
    fiber: "wool_cashmere",
    title: "How to De-pill Wool and Cashmere",
    description:
      "Wool pills genuinely come off, which is why a comb beats a shaver here. Where a cashmere knit is too fine for a blade to be safe.",
    h1: "De-pilling wool and cashmere",
    differs:
      "Wool pills are dead fibre that has already left the yarn, so unlike synthetics they come away for good.",
    steps: [
      "Use a sweater comb rather than an electric shaver on anything fine, cashmere especially. A blade cuts a hole in a loose knit faster than you can react.",
      "Lay the garment flat and hold the fabric taut beside the area you are working, never underneath it.",
      "Short strokes in one direction, following the knit.",
      "Stop when it reads smooth from a low angle rather than chasing every pill.",
      "Steam afterwards to lift the surface back up.",
    ],
    neverDo:
      "Do not shave a cashmere knit on a high setting, and do not de-pill while wearing it. Both are how a jumper acquires a hole instead of a smooth surface.",
  },
  // ── Shrinkage: recoverable on one fibre, permanent on another ──────────
  {
    flaw: "shrinkage",
    fiber: "wool_cashmere",
    title: "Shrunken Wool: Felted or Just Small?",
    description:
      "A shrunken wool jumper is one of two things and only one comes back. How to tell before you spend an hour on it, and the method for the one that does.",
    h1: "Shrunken wool: felted, or just small?",
    differs:
      "Wool shrinkage is usually FELTING, which is a permanent physical change, not the reversible tightening cotton does.",
    steps: [
      "Look at the surface first. If the stitches have disappeared into a dense mat, it is felted and nothing below will help.",
      "If you can still see the knit structure, it is recoverable and worth the 30-minute conditioner soak.",
      "Soak in lukewarm water with hair conditioner. Wool needs the full 30 minutes; the conditioner is what lets the scales slide past each other again.",
      "Stretch back to shape on a towel, easing rather than pulling, and pin it.",
      "Dry flat and completely before moving it.",
    ],
    neverDo:
      "Do not agitate, do not use hot water, and do not tumble dry to speed it up. All three are the mechanism that felts wool, which is what you are trying to undo.",
  },
  {
    flaw: "shrinkage",
    fiber: "cotton_denim",
    title: "How to Unshrink Cotton and Denim",
    description:
      "Cotton shrinkage is fibres pulled tight rather than locked together, so it genuinely comes back. The soak-and-stretch method, and denim's version of it.",
    h1: "Unshrinking cotton and denim",
    differs:
      "Cotton shrinkage is tension rather than felting, so the fibres are undamaged and the size is genuinely recoverable.",
    steps: [
      "Soak in lukewarm water with conditioner for 30 minutes, the same as any fibre.",
      "For denim, put it on damp and move in it. Body heat and movement stretch denim back better than hands do.",
      "For a t-shirt, stretch it flat on a towel, working from the middle outward.",
      "Do not rinse the conditioner out. It is what is keeping the fibres slippery while you work.",
      "Air dry. A dryer undoes all of it in twenty minutes.",
    ],
    neverDo:
      "Do not put it back in a hot wash to try again. Every hot cycle shrinks cotton a little further and the effect accumulates.",
  },
  // ── Rust: the standard method attacks protein fibres ───────────────────
  {
    flaw: "rust-spots",
    fiber: "silk",
    title: "Rust on Silk: What Not to Try",
    description:
      "Lemon juice and sun is the standard rust method and it destroys silk. Why oxalic acid is no better on a protein fibre, and what is left to try.",
    h1: "Rust marks on silk",
    differs:
      "Every effective home rust treatment is an acid, and acids weaken protein fibres. On silk the fibre fails before the rust does.",
    steps: [
      "Do not use lemon juice, and above all do not put silk in direct sun to dry it out.",
      "Rinse the area with cool water in case the deposit is loose surface rust rather than a bonded stain.",
      "If that does nothing, this is a professional job. Say so to the cleaner, because a rust stain treated as a general stain gets bleached and set.",
      "Meanwhile, remove whatever caused it. Rust on stored silk is almost always the hanger or a fastening plus damp.",
    ],
    neverDo:
      "No chlorine bleach, ever, on rust of any kind: it reacts with iron and sets the mark darker and permanently. On silk it also destroys the fibre.",
  },
  // ── Odour: one fibre holds it and one cannot be washed at all ──────────
  {
    flaw: "smoke-odor",
    fiber: "synthetic",
    title: "Smoke Smell in Synthetics",
    description:
      "Polyester and fleece bind the oils that carry smoke, so odour survives a wash that clears cotton. What works on a technical fabric, and what seals it in.",
    h1: "Smoke smell in synthetic fabrics",
    differs:
      "Synthetics are oleophilic: they bind the oils that carry smoke, so odour survives a wash that would clear it from cotton.",
    steps: [
      "Air outdoors first, as with any fibre. It still does more than any product.",
      "Wash with a detergent made for technical fabrics, or add an odour-eliminating additive. Ordinary detergent does not release oil from polyester.",
      "Skip the fabric softener. It coats the fibre and seals the odour in, which is the single most common mistake here.",
      "Never tumble dry between attempts. Heat sets it into a synthetic much harder than into cotton.",
      "If two rounds fail, it is in the fibre for good. That is a real outcome on synthetics and it is why a smoke-exposed fleece is worth very little.",
    ],
    neverDo:
      "No fabric softener and no dryer sheets. Both are the opposite of what the fabric needs and they make the next attempt harder.",
  },
  {
    flaw: "mildew-odor",
    fiber: "leather_suede",
    title: "Mildew on Leather and Suede",
    description:
      "You cannot hot-wash leather, which is the step that clears mildew from everything else. The dry-brush-and-sun method that replaces it.",
    h1: "Mildew on leather and suede",
    differs:
      "The hot wash and vinegar soak that clears mildew from fabric would ruin the hide, so the whole procedure is dry.",
    steps: [
      "Take it outside before you touch it. Brushing mildew indoors distributes spores across everything else you own.",
      "Brush the growth off dry, with a soft brush, following the nap on suede.",
      "Wipe smooth leather with a cloth barely damp with a 1:1 water and rubbing alcohol mix, then dry naturally away from heat.",
      "Leave it in indirect sun for a few hours. UV kills what is producing the smell, and this is the step that does the work.",
      "Recondition smooth leather afterwards; the alcohol takes oils with it.",
    ],
    neverDo:
      "No washing machine, no soaking, no direct heat to dry it. Wet leather dried fast goes hard and cracks, and that is worse than mildew.",
  },
  // ── Snags: one fibre forgives, one records it permanently ──────────────
  {
    flaw: "snags-pulls",
    fiber: "silk",
    title: "Snags in Silk: Pulls and Slippage",
    description:
      "A silk pull leaves a permanent shine line even after the loop goes back, and a pull beside a seam may be seam slippage, which is structural.",
    h1: "Snags and pulls in silk",
    differs:
      "Silk is a filament rather than a spun yarn, so a pull leaves a permanent shine line, and a pull near a seam is often seam slippage, which is structural damage.",
    steps: [
      "Look at where it is. Parallel thread gaps beside a seam are seam slippage, not a snag, and no amount of loop-pulling fixes that.",
      "For a genuine snag, work the loop through to the inside with a fine needle as you would on a knit.",
      "Expect a residual line. The filament has been stretched and silk records that as a change in sheen.",
      "Steam gently from the wrong side. It reduces the line and will not remove it.",
      "Do not spread the slack aggressively along the row; woven silk has no row to spread it into and you will distort the weave.",
    ],
    neverDo:
      "Do not use a snag needle with a coarse latch on fine silk, and never pull the loop out straight. Both convert a mark into a hole.",
  },
  {
    flaw: "snags-pulls",
    fiber: "wool_cashmere",
    title: "Snags in Wool and Cashmere Knits",
    description:
      "A knit has rows to spread the pulled yarn back into, which is why a wool snag can genuinely disappear and a woven one cannot.",
    h1: "Snags in wool and cashmere",
    differs:
      "A knit is one continuous yarn in rows, so the excess from a pull can be spread back along the row until it disappears. A woven fabric has nowhere to put it.",
    steps: [
      "Never cut it: on a knit a cut loop unravels along the whole row, which is a far worse failure than on a woven.",
      "Draw the loop through to the inside with a snag needle.",
      "Spread the slack a stitch at a time in BOTH directions along the row. This is the step that only works on a knit and it is why wool snags vanish and silk ones do not.",
      "Steam and dry flat.",
      "If the yarn has broken rather than pulled, stop and darn it instead. A broken yarn in a knit will run.",
    ],
    neverDo:
      "Do not stretch the garment across the snag before releasing the loop. On a knit that tightens the neighbouring stitches around the pull and locks it in.",
  },
  // ── Holes: repaired differently enough to be a different job ───────────
  {
    flaw: "holes-tears",
    fiber: "leather_suede",
    title: "Repairing a Tear in Leather",
    description:
      "Leather does not fray, so a tear is backed and bonded rather than patched or darned. Why stitching one first often makes it longer.",
    h1: "Repairing a tear in leather or suede",
    differs:
      "Leather has no weave to fray, so the fabric repairs do not apply: a tear is bonded to a backing rather than stitched or darned.",
    steps: [
      "Do not stitch it first. Needle holes are a perforated line and leather tears along perforated lines.",
      "Cut a subpatch of thin leather or a repair fabric about 15mm larger than the tear on every side.",
      "Feed it through the tear so it sits behind the hide, smooth side to the underside.",
      "Bond with a flexible leather adhesive, pressing the tear edges closed and butted rather than overlapped.",
      "Weight it flat while it cures, then recondition the panel.",
    ],
    neverDo:
      "No superglue and no iron-on patch. Superglue goes hard and cracks at the next flex; heat shrinks and glazes leather.",
  },
  {
    flaw: "holes-tears",
    fiber: "silk",
    title: "Repairing a Hole in Silk",
    description:
      "A backing patch shows through silk and a darn kills the drape. Why most silk holes are a professional job, and the one case you can fix at home.",
    h1: "Repairing a hole in silk",
    differs:
      "Silk is thin and often semi-transparent, so a backing patch shows through and a darn puckers the drape that makes the garment worth repairing.",
    steps: [
      "Check whether it is a hole or seam slippage. Slippage is restitched at the seam and is the easier of the two by a wide margin.",
      "For a small clean tear along the grain, a ladder stitch in silk thread closes it almost invisibly.",
      "Fusible interfacing is a last resort here: it stiffens a patch of fabric whose whole value is that it moves.",
      "For anything with fabric missing, this is French reweaving, which is specialist and expensive.",
      "Price the repair against the garment before starting. On silk that calculation goes the wrong way more often than not.",
    ],
    neverDo:
      "No iron-on patch, no machine darning. Both leave a stiff, shiny rectangle that is more visible from across a room than the hole was.",
  },
  // ── Wrinkling: a defect on one fibre and a feature on another ──────────
  {
    flaw: "collar-wear",
    fiber: "linen",
    title: "Collar Wear on Linen Shirts",
    description:
      "Linen is stiff and inelastic, so a collar fold abrades through rather than just going grey. How to tell soiling from fibre loss before you scrub.",
    h1: "Collar wear on linen",
    differs:
      "Linen fibres are stiff and inelastic, so a repeated fold abrades them through rather than just soiling them. The grey line may be thinning, not dirt.",
    steps: [
      "Hold the collar to the light. If light comes through the fold line, that is fibre loss and no amount of washing changes it.",
      "If it is soiling, work a little shampoo into the fold and leave it 30 minutes, then wash warm.",
      "Do not scrub a linen fold. The stiffness that makes linen crease also makes it break under abrasion.",
      "Press with steam and plenty of moisture; a dry hot iron on a worn linen fold cuts it.",
      "For a worn edge on a shirt worth keeping, turning the collar works on linen as it does on cotton.",
    ],
    neverDo:
      "Do not treat linen creasing as a defect to be removed. Wrinkling is inherent to the fibre and pressing it out repeatedly is what wears the folds through.",
  },
  {
    flaw: "sun-fading",
    fiber: "linen",
    title: "Yellowed Linen: Storage, Not Sun",
    description:
      "Yellowing in stored linen is oxidation rather than destroyed dye, so unlike sun fading some of it genuinely comes out. How to tell which you have.",
    h1: "Yellowed and faded linen",
    differs:
      "Yellowing in stored linen is oxidation of the fibre and residues in it, not destroyed dye, so unlike sun fading some of it genuinely comes out.",
    steps: [
      "Work out which you have. Even yellowing across a folded garment is storage oxidation; lighter patches where light fell are sun fading and permanent.",
      "For yellowing, soak in oxygen bleach and warm water for several hours, not chlorine.",
      "Dry white linen in the sun. On white linen UV bleaches, which is the one place sunlight helps rather than harms.",
      "Repeat once if it lifted at all. If the first soak did nothing, further soaks will not.",
      "Store it unstarched afterwards. Starch is food for the reaction that yellowed it.",
    ],
    neverDo:
      "No chlorine bleach on linen. It weakens the fibre and often turns the yellow browner rather than removing it.",
  },
];

export function matrixPath(entry: MatrixEntry): string {
  return `${FLAW_LIBRARY_HUB_PATH}/${entry.flaw}/${FIBER_SLUGS[entry.fiber]}`;
}

export function getMatrixEntryByPath(path: string): MatrixEntry | undefined {
  const norm = path.replace(/\/+$/, "");
  return CARE_MATRIX.find((e) => matrixPath(e) === norm);
}

/** Every fibre page that exists for a flaw, for the parent page to link down to. */
export function matrixEntriesForFlaw(flawSlug: string): MatrixEntry[] {
  return CARE_MATRIX.filter((e) => e.flaw === flawSlug);
}

/**
 * The hard cap from US-9014 AC4. If the matrix ever reaches this, the story
 * stops and the number is re-argued rather than raised in passing.
 *
 * Note how far under it we are: 18 of a possible 192, and the cap is 400. The
 * cap was never the binding constraint. The binding constraint is having
 * something different to say, which is why this file is 18 entries long and not
 * 192.
 */
export const MATRIX_PAGE_CAP = 400;

/**
 * Routes for the matrix. Spread into PUBLIC_ROUTES the same way
 * calculatorRoutes() is.
 *
 * A combination with no entry generates NO route. There is deliberately no
 * thin page canonicalising back to the parent, because a page that exists only
 * to point at another page is still a page Google has to crawl and judge.
 */
export function careMatrixRoutes(): PublicRoute[] {
  return CARE_MATRIX.map((e) => ({
    path: matrixPath(e),
    title: e.title,
    description: e.description,
    changefreq: "monthly" as const,
    priority: 0.5,
    jsonLdType: "Article",
  }));
}

/** Entries whose parent flaw is missing from the library. Should always be empty. */
export function orphanedMatrixEntries(): MatrixEntry[] {
  return CARE_MATRIX.filter((e) => !getFlawBySlug(e.flaw));
}
