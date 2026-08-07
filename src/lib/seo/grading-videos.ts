// YouTube grading shorts (US-1689) — the registry behind the on-page embeds.
//
// Plan §6.8 + §7.3: 5–10 short "how to grade a used {garment}" videos, each
// embedded on its matching /grading/guides/{garment} page. AI answer engines
// increasingly cite video transcripts, and reseller YouTube is a large
// sub-community, so a transcript-bearing embed is both a multimedia signal and
// a citable surface.
//
// PURE DATA + derivation. Imports the guide registry (for the garment names the
// titles/tags are derived from) and nothing else.
//
// ── The publish gate (why nothing renders yet) ──────────────────────────
//
// Every short below carries a finished SCRIPT. None carries a `youtubeId`,
// because filming and uploading is a human job. `publishedShort()` returns a
// short ONLY once `youtubeId` + `uploadDate` are set, and BOTH the page embed
// and the VideoObject markup go through it. So there is never markup for a
// video that does not exist — the no-fake-markup rule that governs this repo's
// structured data (no placeholder SearchAction, no invented aggregateRating).
//
// To publish one: film it, then fill in `youtubeId` + `uploadDate` here. The
// embed and its VideoObject appear on the guide page in the same deploy. See
// vault/40-growth/youtube-grading-shorts.md for the production runbook.

import { GARMENT_GUIDES, getGuideBySlug, guidePath } from "./garment-guides";
import { SITE_URL } from "./site";

/** One spoken beat of the short: when it lands, and the line read over it. */
export interface ShortBeat {
  /** Offset into the video, `m:ss`. */
  at: string;
  /** What is on screen at this beat. */
  shot: string;
  /** The line read, verbatim. Read as written, this IS the transcript. */
  say: string;
}

export interface GradingShort {
  /** The garment guide this short belongs on. Must exist in GARMENT_GUIDES. */
  guideSlug: string;
  /** Target runtime in seconds — YouTube Shorts caps at 60. */
  durationSeconds: number;
  /** The ordered script. Read verbatim, this doubles as the transcript. */
  beats: ShortBeat[];
  /**
   * YouTube video id, filled in by content ops AFTER the short is published.
   * Until it is set the guide page renders no embed and emits no VideoObject.
   */
  youtubeId?: string;
  /** ISO date (YYYY-MM-DD) the short went live. Required alongside youtubeId. */
  uploadDate?: string;
  /**
   * The real transcript, when the finished audio differs from the script
   * (an ad-lib, a re-take, a trimmed beat). Leave unset for a verbatim read —
   * `shortTranscript()` then derives it from the beats, so the two cannot drift.
   */
  transcript?: string;
}

/** Every short's title ends with this, so the channel reads as one series. */
export const SHORTS_SERIES_SUFFIX = "GradeThread 1–10 Scale";

/** Tags carried by every short, so the series clusters on YouTube. */
export const SHORTS_BASE_TAGS = [
  "gradethread",
  "condition grading",
  "grading scale",
  "reselling",
  "thrifting",
  "poshmark",
  "ebay reseller",
] as const;

// ── The scripts ────────────────────────────────────────────────────────
//
// Ten garments, chosen for distinct failure modes rather than volume — a
// cashmere short that repeats the knit-sweater short is a wasted upload. Each
// script follows the same five-beat shape (hook → three checks → grade call),
// which is what makes the series recognisable and keeps every short under 60s.
//
// The checks are lifted from each guide's own `steps`, so a viewer who lands on
// the page from the video reads the same rubric they just watched.

export const GRADING_SHORTS: GradingShort[] = [
  {
    guideSlug: "denim-jacket",
    durationSeconds: 45,
    beats: [
      {
        at: "0:00",
        shot: "Jacket flat on a table, hands pulling the cuff placket taut.",
        say: "Most people grade a denim jacket by how faded it looks. That is the wrong end of it.",
      },
      {
        at: "0:07",
        shot: "Close-up on the button placket and pocket corners.",
        say: "Check one: the stress points. Cuff plackets, pocket corners, the button placket. Denim barely pills, so structure leads the grade.",
      },
      {
        at: "0:17",
        shot: "Shoulders held to a window, comparing shoulder tone to body tone.",
        say: "Check two: read the fading honestly. Factory whiskering is the design and costs nothing. Sun fading on the shoulders is wear, and it does.",
      },
      {
        at: "0:27",
        shot: "Thumb working each rivet and the shank button.",
        say: "Check three: work every button and rivet. One seized shank button is a functional hit that caps the grade no matter how clean the denim is.",
      },
      {
        at: "0:36",
        shot: "Grade card overlay: 9 NWOT, 7 Very Good, 4 Poor.",
        say: "Crisp indigo, no stress wear, that is a nine. Honest wear with one frayed cuff, seven. Blown underarm seam and a missing button, four. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "leather-jacket",
    durationSeconds: 48,
    beats: [
      {
        at: "0:00",
        shot: "Hands flexing the elbow of a moto jacket.",
        say: "Patina is not damage. That one distinction decides most leather jacket grades.",
      },
      {
        at: "0:07",
        shot: "Close-up of the leather flexing at the elbow and cuff.",
        say: "Check one: feel the hide. Supple and evenly coloured grades high. Dry, stiff or cracking caps the grade however good it looks in photos.",
      },
      {
        at: "0:18",
        shot: "Side-by-side of even darkening versus a cracked, peeling panel.",
        say: "Check two: separate patina from damage. Even darkening and softening is desirable and is not penalised. Surface cracking, peeling finish and abraded colour loss are.",
      },
      {
        at: "0:29",
        shot: "Main zip run full travel, then each pocket zip.",
        say: "Check three: run every zipper end to end. Zips fail long before the leather does, and a catching main zip usually is the grade.",
      },
      {
        at: "0:39",
        shot: "Grade card overlay: 8 Excellent, 6 Good, 3 Poor.",
        say: "Supple hide, even patina, clean lining, that is an eight. Cuff abrasion but fully functional, six. Peeling finish and a broken zip, three. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "knit-sweater",
    durationSeconds: 44,
    beats: [
      {
        at: "0:00",
        shot: "Sweater laid flat, hand brushing the underarm.",
        say: "A sweater can be spotless on the front and still grade low. Here is where to actually look.",
      },
      {
        at: "0:06",
        shot: "Close-up of pilling at the underarm and side seam.",
        say: "Check one: scan the friction zones. Underarms, sides, cuffs. Light pilling a comb lifts off is minor. Dense pilling felted into the knit caps the grade.",
      },
      {
        at: "0:17",
        shot: "Sweater held up to a window, backlit.",
        say: "Check two: backlight it and hunt for holes. One small moth hole is a cosmetic hit. Several means moth damage, and buyers price that hard.",
      },
      {
        at: "0:27",
        shot: "Neckline and cuff stretched, then released.",
        say: "Check three: test the ribbing. Stretch the neckline and cuffs and let go. Ribbing that stays stretched lowers the grade even when the body is clean.",
      },
      {
        at: "0:36",
        shot: "Grade card overlay: 9 NWOT, 6 Good, 3 Poor.",
        say: "No pilling and snappy ribbing is a nine. Light removable pilling, six. Matted pilling, two moth holes and a stretched neck, three. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "cashmere-sweater",
    durationSeconds: 46,
    beats: [
      {
        at: "0:00",
        shot: "Hands sinking into a cashmere sweater, then a felted one for contrast.",
        say: "Cashmere is graded stricter than any other knit, and the reason is in your hands.",
      },
      {
        at: "0:07",
        shot: "Close-up of a lofty hand versus a flat, felted hand.",
        say: "Check one: feel the hand. Cashmere should be soft and lofty. Stiff and flattened means it was washed hot, and felting caps the grade regardless of looks.",
      },
      {
        at: "0:18",
        shot: "Comb lifting pills off a sleeve.",
        say: "Check two: grade the pilling by amount, not presence. All cashmere pills. A quick de-pill returns light pilling to near new. Matted pilling does not come back.",
      },
      {
        at: "0:29",
        shot: "Front and elbows backlit against a window.",
        say: "Check three: backlight for moth holes. On cashmere even one visible hole moves the grade further down than the same hole on an acrylic knit.",
      },
      {
        at: "0:38",
        shot: "Grade card overlay: 10 NWT, 7 Very Good, 4 Poor.",
        say: "Tags on, full loft, zero pills, that is a ten. Soft with light de-pillable pilling, seven. Felted with two moth holes, four. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "graphic-tee",
    durationSeconds: 42,
    beats: [
      {
        at: "0:00",
        shot: "Hands gently stretching a printed graphic.",
        say: "On a graphic tee the cotton is cheap. The print is what the buyer is paying for.",
      },
      {
        at: "0:06",
        shot: "Close-up of fine cracking, then heavy flaking.",
        say: "Check one: stretch the graphic gently. Fine cracking on an older print is expected. Heavy peeling that lifts off the fabric is damage and leads the grade.",
      },
      {
        at: "0:17",
        shot: "Collar pulled and released, showing waviness.",
        say: "Check two: pull the collar and let go. A wavy, rippled neckline is the most common tee flaw and it is instantly visible in a listing photo.",
      },
      {
        at: "0:26",
        shot: "Shirt backlit; then underarm inspected.",
        say: "Check three: backlight for pinholes and check the underarms for yellowing and deodorant crust. Both cap the grade.",
      },
      {
        at: "0:34",
        shot: "Grade card overlay: 9 NWOT, 6 Good, 3 Poor.",
        say: "Crisp print, tight collar, clean pits, that is a nine. Light age cracking with the collar intact, six. Peeling graphic and stained underarms, three. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "hoodie-sweatshirt",
    durationSeconds: 43,
    beats: [
      {
        at: "0:00",
        shot: "Hoodie turned inside out, revealing the fleece.",
        say: "The outside of a hoodie lies. Turn it inside out first.",
      },
      {
        at: "0:06",
        shot: "Cuffs and hem stretched and released.",
        say: "Check one: the ribbing. Stretch the cuffs and hem. Blown out, stretched or heavily pilled ribbing is the most common hoodie flaw and it leads the grade.",
      },
      {
        at: "0:17",
        shot: "Close-up of lofty fleece next to matted, greyed fleece.",
        say: "Check two: read the fleece. Fresh and lofty grades high. Matted, pilled or greyed loops mean a lot of wash cycles, and that lowers the grade.",
      },
      {
        at: "0:27",
        shot: "Zip run full travel; both drawcords pulled out.",
        say: "Check three: run the zip end to end and confirm both hood drawcords are there with their aglets. A missing cord is a small but visible hit.",
      },
      {
        at: "0:35",
        shot: "Grade card overlay: 9 NWOT, 6 Good, 3 Poor.",
        say: "Lofty fleece, tight cuffs, both cords, that is a nine. Slightly matted with a smooth zip, six. Greyed fleece, stretched cuffs, one cord gone, three. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "activewear-leggings",
    durationSeconds: 40,
    beats: [
      {
        at: "0:00",
        shot: "Leggings flat on a table, then stretched over a hand.",
        say: "Leggings look fine lying flat. That is exactly why people grade them wrong.",
      },
      {
        at: "0:06",
        shot: "Fabric stretched over a hand at the seat, going sheer.",
        say: "Check one: the stretch test. Pull the fabric over your hand at the seat and thighs. If the weave goes see-through, that is the flaw buyers care about and it caps the grade.",
      },
      {
        at: "0:18",
        shot: "Close-up of inner-thigh pilling.",
        say: "Check two: the inner thighs. Where the legs rub is the highest wear zone on any legging. Pilling and abrasion start there.",
      },
      {
        at: "0:26",
        shot: "Waistband stretched and released.",
        say: "Check three: the waistband. Stretch and release. A band that has lost its snap or rolls at the top lowers the grade even when the legs are perfect.",
      },
      {
        at: "0:33",
        shot: "Grade card overlay: 9 NWOT, 6 Good, 3 Poor.",
        say: "Fully opaque under stretch with a snappy band, that is a nine. Minor thigh pilling, still opaque, six. Sheer at the seat, three. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "jeans",
    durationSeconds: 44,
    beats: [
      {
        at: "0:00",
        shot: "Jeans held up by the waistband, crotch toward camera.",
        say: "Jeans are bought for their fades. They are graded on something else entirely.",
      },
      {
        at: "0:06",
        shot: "Close-up on the four-seam crotch junction, backlit.",
        say: "Check one: the crotch. Backlight the four-seam junction and look for thinning. Crotch blowout is how jeans actually die, and it leads the grade.",
      },
      {
        at: "0:17",
        shot: "Whiskering and honeycombs shown, then incidental thinning.",
        say: "Check two: read the fades. Whiskering, honeycombs and stacks are the intended wash and cost nothing. Incidental thinning on top of them does.",
      },
      {
        at: "0:27",
        shot: "Hems inspected; shank button and rivets worked.",
        say: "Check three: hems and hardware. Honest roping is fine. Damage past it is not. Then work the shank button, the rivets and the fly.",
      },
      {
        at: "0:36",
        shot: "Grade card overlay: 9 NWOT, 7 Very Good, 3 Poor.",
        say: "Deadstock with no crotch or thigh wear is a nine. Honest fading with sound thighs, seven. Crotch blowout and thin inner thighs, three. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "wool-coat",
    durationSeconds: 45,
    beats: [
      {
        at: "0:00",
        shot: "Wool coat on a hanger, hand brushing the collar.",
        say: "On a wool coat, pilling and fibre loss are not the same thing, and only one of them is fixable.",
      },
      {
        at: "0:07",
        shot: "Close-up of collar, cuff and underarm pilling and felting.",
        say: "Check one: read the wool surface. Collar, cuffs, underarms. Pilling and felting are one thing. A thin, bald patch is fibre that is gone, and that caps the grade.",
      },
      {
        at: "0:18",
        shot: "Coat panels held to a window, backlit.",
        say: "Check two: backlight the panels. Wool is a moth favourite, and holes in the visible face are hard to repair invisibly, so even small ones drop the grade sharply.",
      },
      {
        at: "0:28",
        shot: "Lining inspected, buttons counted, shoulders squared up.",
        say: "Check three: lining, buttons and shoulders. A torn or sweat-stained lining, a missing button, or shoulders that no longer hold shape all pull the grade down.",
      },
      {
        at: "0:37",
        shot: "Grade card overlay: 9 NWOT, 6 Good, 3 Poor.",
        say: "Clean face, crisp shoulders, flawless lining, that is a nine. Light cuff pilling with all buttons, six. Bald cuff, two moth holes, torn lining, three. Full checklist on GradeThread.",
      },
    ],
  },
  {
    guideSlug: "puffer-jacket",
    durationSeconds: 42,
    beats: [
      {
        at: "0:00",
        shot: "Puffer squeezed near a seam; a feather works out.",
        say: "A puffer's shell can look perfect while the jacket quietly bleeds down at every seam.",
      },
      {
        at: "0:07",
        shot: "Each baffle squeezed and shaken in raking light.",
        say: "Check one: squeeze and shake each baffle in good light and watch the seams. Active down leakage is the defining puffer flaw and it caps the grade.",
      },
      {
        at: "0:17",
        shot: "Hand pressing across baffles, showing even loft then a flat one.",
        say: "Check two: the loft. Run a hand across the baffles. Even fill grades high. Flattened, clumped or migrated down leaves cold spots and lowers the grade with no hole at all.",
      },
      {
        at: "0:28",
        shot: "Shell scanned at an angle; main zip run under the storm flap.",
        say: "Check three: angle the shell to the light for pinholes and snags, then run the main zip full travel under the storm flap.",
      },
      {
        at: "0:35",
        shot: "Grade card overlay: 9 NWOT, 6 Good, 3 Poor.",
        say: "Full even loft, no leakage, smooth zip, that is a nine. Slight fill migration with no leaks, six. Feathers escaping a split seam, three. Full checklist on GradeThread.",
      },
    ],
  },
];

// ── Derivation: naming and tagging, so the series cannot drift ─────────
//
// AC3 ("named/tagged consistently with the GradeThread Scale") is enforced by
// DERIVING the title, description and tags rather than storing them. There is
// no field anyone can hand-type inconsistently.

/**
 * The YouTube title: the guide's own <title> plus the series suffix. Reusing
 * the guide title means the video and the page it lives on carry the same
 * name, and the titles are already tuned to be unique and ≤ 46 characters —
 * so adding the suffix cannot breach YouTube's 100-character cap.
 */
export function shortTitle(short: GradingShort): string {
  const guide = getGuideBySlug(short.guideSlug);
  const base = guide ? guide.title : short.guideSlug;
  return `${base} | ${SHORTS_SERIES_SUFFIX}`;
}

/** The YouTube description — the scale, the checks, and the guide link. */
export function shortDescription(short: GradingShort): string {
  const guide = getGuideBySlug(short.guideSlug);
  if (!guide) return "";
  const url = `${SITE_URL}${guidePath(guide.slug)}`;
  return [
    `${guide.intro}`,
    "",
    "What this short checks:",
    ...guide.steps.map((s, i) => `${i + 1}. ${s.name}`),
    "",
    `Every grade sits on the GradeThread 1.0–10.0 condition scale. Full checklist, graded examples and the photo list: ${url}`,
  ].join("\n");
}

/** Tags: the shared series tags plus this garment's names. */
export function shortTags(short: GradingShort): string[] {
  const guide = getGuideBySlug(short.guideSlug);
  const garment = guide?.garment.toLowerCase();
  const alternates = guide?.alternateNames ?? [];
  const specific = [
    ...(garment ? [garment, `how to grade a ${garment}`] : []),
    ...alternates,
  ];
  // De-duped, order preserved: series tags first so the channel clusters.
  return [...new Set([...SHORTS_BASE_TAGS, ...specific])];
}

/**
 * The transcript. A verbatim read means the script IS the transcript, so it is
 * derived from the beats unless content ops recorded a real one that differs.
 */
export function shortTranscript(short: GradingShort): string {
  if (short.transcript?.trim()) return short.transcript.trim();
  return short.beats.map((b) => b.say).join(" ");
}

/** ISO 8601 duration, the form schema.org VideoObject wants. */
export function shortDurationIso(short: GradingShort): string {
  return `PT${short.durationSeconds}S`;
}

/** Privacy-preserving embed URL (no cookie until the viewer hits play). */
export function shortEmbedUrl(youtubeId: string): string {
  return `https://www.youtube-nocookie.com/embed/${youtubeId}`;
}

/** The canonical watch URL, for the "watch on YouTube" link and contentUrl. */
export function shortWatchUrl(youtubeId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

/** YouTube's own thumbnail for the video — no asset for us to host. */
export function shortThumbnailUrl(youtubeId: string): string {
  return `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
}

/**
 * A short that is ACTUALLY on YouTube: both the id and the upload date are set.
 * This is the single gate — the embed and the VideoObject both go through it,
 * so an unproduced short can never become markup for a video that isn't there.
 */
export interface PublishedShort extends GradingShort {
  youtubeId: string;
  uploadDate: string;
}

export function isPublished(short: GradingShort): short is PublishedShort {
  return Boolean(short.youtubeId?.trim() && short.uploadDate?.trim());
}

const SHORT_BY_GUIDE = new Map(GRADING_SHORTS.map((s) => [s.guideSlug, s]));

/** The scripted short for a guide, published or not (production tooling). */
export function getShortByGuideSlug(slug: string): GradingShort | undefined {
  return SHORT_BY_GUIDE.get(slug);
}

/** The LIVE short for a guide — undefined until it has been filmed and set. */
export function publishedShort(slug: string): PublishedShort | undefined {
  const short = SHORT_BY_GUIDE.get(slug);
  return short && isPublished(short) ? short : undefined;
}

/** Every short that is live. Empty until content ops fills in the ids. */
export function publishedShorts(): PublishedShort[] {
  return GRADING_SHORTS.filter(isPublished);
}

/** Guide slugs that have a scripted short. Used by the production runbook. */
export function scriptedGuideSlugs(): string[] {
  return GRADING_SHORTS.map((s) => s.guideSlug);
}

/** Guides with no short scripted yet — the candidate pool for the next batch. */
export function guidesWithoutShorts(): string[] {
  return GARMENT_GUIDES.filter((g) => !SHORT_BY_GUIDE.has(g.slug)).map(
    (g) => g.slug,
  );
}
