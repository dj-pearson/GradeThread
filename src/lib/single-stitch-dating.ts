// Dating a vintage tee from the tells on the garment (US-9020).
//
// WHAT THIS REFUSES TO DO. Every other page on this subject says "single stitch
// means pre-1994" and stops, which is the half of the answer that costs people
// money. Single stitch is a SUGGESTION with a wide date range, it is trivially
// reproduced, and it is routinely contradicted by another tell on the same
// garment. So this combines signals, reports the range they agree on, and says
// out loud when they disagree — because a garment whose tells conflict is
// usually a reproduction or a rework, and that is the finding worth having.
//
// TWO KINDS OF SIGNAL, and mixing them up is the common error:
//
//   FLOORS are hard. A printed copyright year cannot predate itself, and a
//   tagless heat-transferred neck label did not exist before the technique did.
//   A floor moves the earliest possible year and nothing overturns it except
//   the tell being fake.
//
//   HINTS are soft. Single stitching, a 50/50 blend and a boxy cut are all
//   common in one era and possible in any. They narrow a range; they never
//   establish one.
//
// The dates below are deliberately given as RANGES with the transition spread
// across several years, because the changes they describe were manufacturer by
// manufacturer rather than industry-wide on a date. A page that prints a single
// year is more confident than the evidence.
//
// PURE. No I/O, no dates read from the clock, so the estimate a visitor sees is
// reproducible and the whole module is unit tested without a browser.

export type Answer = "yes" | "no" | "unsure";

/** The latest year a garment could plausibly be and still show single stitch. */
export const SINGLE_STITCH_TYPICAL_LATEST = 1996;
/** The earliest year the tagless heat-transfer neck label was in wide use. */
export const TAGLESS_EARLIEST = 2002;

export interface DatingInput {
  /** Single-needle stitching at the hem and sleeve openings. */
  singleStitch: Answer;
  /** A copyright or event year printed on the graphic, if there is one. */
  printedYear: number | null;
  /** A sewn-in tag naming the USA as the country of manufacture. */
  madeInUsa: Answer;
  /** A 50/50 or other poly-cotton blend stated on the tag. */
  blendedFabric: Answer;
  /** A tagless neck label, heat-transferred rather than sewn in. */
  taglessLabel: Answer;
}

export interface DatingSignal {
  kind: "floor" | "hint" | "conflict";
  label: string;
  detail: string;
}

export interface DatingResult {
  /** Earliest year the garment can be, or null when nothing sets a floor. */
  earliest: number | null;
  /** Latest year the soft signals suggest, or null when nothing narrows it. */
  latest: number | null;
  /** How the range should be read, in one phrase. */
  confidence: "conflicting" | "narrow" | "indicative" | "insufficient";
  /** One sentence a person can act on. */
  headline: string;
  signals: DatingSignal[];
}

/** A printed year that could not be on a t-shirt. Rejects typos, not old tees. */
export function isPlausiblePrintedYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1940 && year <= 2100;
}

export function dateVintageTee(input: DatingInput): DatingResult {
  const signals: DatingSignal[] = [];
  let earliest: number | null = null;
  let latest: number | null = null;

  const printed =
    input.printedYear != null && isPlausiblePrintedYear(input.printedYear)
      ? input.printedYear
      : null;

  // ── Floors ────────────────────────────────────────────────────────────
  if (printed != null) {
    earliest = printed;
    signals.push({
      kind: "floor",
      label: `Printed year ${printed}`,
      detail:
        "The strongest single tell on the shirt, and the one most guides skip. The garment cannot be older than the artwork on it, so this sets a hard floor. It does not set a ceiling: a 1991 copyright line was still being printed on new blanks years later, and reprints carry the original year.",
    });
  }

  if (input.taglessLabel === "yes") {
    earliest = Math.max(earliest ?? TAGLESS_EARLIEST, TAGLESS_EARLIEST);
    signals.push({
      kind: "floor",
      label: "Tagless neck label",
      detail:
        "A heat-transferred neck print instead of a sewn-in tag puts the blank in the 2000s at the earliest. This is a floor, not a hint.",
    });
  }

  // ── Hints ─────────────────────────────────────────────────────────────
  if (input.singleStitch === "yes") {
    latest = SINGLE_STITCH_TYPICAL_LATEST;
    signals.push({
      kind: "hint",
      label: "Single stitch hem",
      detail:
        "One line of stitching at the hem and sleeve openings rather than two. Standard on US-made blanks through the 1980s and phased out through the mid-1990s, manufacturer by manufacturer rather than on a date. It suggests an older shirt. On its own it proves nothing, because the stitch is easy to reproduce and small runs still use it.",
    });
  } else if (input.singleStitch === "no") {
    signals.push({
      kind: "hint",
      label: "Double stitch hem",
      detail:
        "Two parallel lines at the hem. Usual from the mid-1990s onward, so it argues against the shirt being 1980s, but plenty of double-stitched blanks are still twenty years old. It rules less out than sellers assume.",
    });
  }

  if (input.madeInUsa === "yes") {
    signals.push({
      kind: "hint",
      label: "Made in USA",
      detail:
        "Domestic blank manufacture was the norm before production moved offshore through the 1990s, so this leans older. It is a weak signal by itself and a useful one alongside the stitch.",
    });
  }

  if (input.blendedFabric === "yes") {
    signals.push({
      kind: "hint",
      label: "Poly-cotton blend",
      detail:
        "50/50 and similar blends were everywhere on 1980s blanks. They never went away, so this supports an older read without narrowing it much on its own.",
    });
  }

  // ── Conflicts ─────────────────────────────────────────────────────────
  // The finding worth having: two tells that cannot both be honest.
  if (input.singleStitch === "yes" && input.taglessLabel === "yes") {
    signals.push({
      kind: "conflict",
      label: "Single stitch on a tagless blank",
      detail:
        "These two do not belong on the same garment. A tagless neck label is 2000s, single stitching is not. The likely explanations are a reproduction blank made to look vintage, or a reworked shirt. Price it as modern until something else settles it.",
    });
  }

  if (printed != null && latest != null && printed > latest) {
    signals.push({
      kind: "conflict",
      label: `Printed ${printed} on a single-stitch blank`,
      detail:
        "The artwork is newer than the stitching suggests the blank is. That is either a reprint on old stock, which happens, or a reproduction. The printed year wins, because it is the harder of the two tells to fake convincingly.",
    });
  }

  const conflicts = signals.filter((s) => s.kind === "conflict");
  const floors = signals.filter((s) => s.kind === "floor");
  const hints = signals.filter((s) => s.kind === "hint");

  // A conflict outranks the range, and the range is deliberately not printed
  // alongside it: a number next to "these tells disagree" is the half people
  // remember.
  if (conflicts.length > 0) {
    return {
      earliest,
      latest: null,
      confidence: "conflicting",
      headline:
        "The tells on this shirt disagree with each other. That is the finding: treat it as modern or reworked until an independent tell says otherwise, and do not pay a vintage price on the strength of the stitch.",
      signals,
    };
  }

  if (floors.length === 0 && hints.length === 0) {
    return {
      earliest: null,
      latest: null,
      confidence: "insufficient",
      headline:
        "Nothing here dates the shirt yet. The printed year on the graphic is the tell worth finding first, because it is the only one that sets a hard floor.",
      signals,
    };
  }

  if (floors.length > 0 && hints.length > 0) {
    return {
      earliest,
      latest,
      confidence: "narrow",
      headline:
        latest != null && earliest != null
          ? `Most likely between ${earliest} and ${latest}, with the printed year setting the floor and the construction setting the rest.`
          : `Not earlier than ${earliest}, with the construction supporting an older read.`,
      signals,
    };
  }

  if (floors.length > 0) {
    return {
      earliest,
      latest: null,
      confidence: "indicative",
      headline: `Not earlier than ${earliest}. Nothing entered so far puts a ceiling on it, so check the hem stitching next.`,
      signals,
    };
  }

  return {
    earliest: null,
    latest,
    confidence: "indicative",
    headline:
      latest != null
        ? `The construction suggests roughly ${latest} or earlier, which is a lean rather than a date. Find the printed year on the graphic to turn it into a range.`
        : "The construction argues against an early shirt without dating it. Find the printed year on the graphic.",
    signals,
  };
}
