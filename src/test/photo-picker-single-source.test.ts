// US-2461 AC2/AC4: there is exactly ONE photo-tag picker on the web.
//
// This guard exists because the epic already failed once on this axis. US-2466
// shipped `PhotoTagSelect` and claimed it "replaced three hand-rolled flat
// lists". It replaced one. `reconcile.tsx` and `autolister.tsx` kept mapping the
// raw type vocabulary into a `<select>`, which meant both still offered `tag_2`,
// `detail_2..4` and the five fixed `measurement_*` types — the RETIRED
// vocabulary — as brand-new choices, and neither had the Suggested / All types
// split. Nothing caught it, because the only thing standing between the retired
// list and a picker was somebody remembering.
//
// The rule enforced here: a file that renders picker markup must not also build
// its option list out of the photo-type vocabulary. Route it through
// PhotoTagSelect, which filters retired types and reads the item's profile.

import { describe, expect, it } from "vitest";
import { sourceTexts, SCAN_TIMEOUT_MS } from "@/lib/__tests__/_source-scan";
import { RETIRED_PHOTO_TYPES } from "@/lib/photo-roles";

// The scanned trees: everything a seller can click.
const UI_DIRS = ["src/pages", "src/components"] as const;

// Merely IMPORTING the vocabulary is fine — autolister derives a gallery sort
// rank from FLIPDESK_PHOTO_TYPES and that is not a picker. What is banned is
// turning it into options, which shows up two ways, both of which the two real
// offenders used:
//
//   1. mapping the array straight into markup      (reconcile.tsx)
//   2. labelling an <option> from PHOTO_TYPE_LABELS (autolister.tsx, which
//      mapped a locally-derived subset, so pattern 1 alone would miss it)
const BUILDS_OPTIONS: readonly RegExp[] = [
  /(FLIPDESK_PHOTO_TYPES|MEASUREMENT_PHOTO_TYPES)[\s\S]{0,200}?\.map\([\s\S]{0,300}?<(option|SelectItem)\b/,
  /<(option|SelectItem)\b[\s\S]{0,300}?PHOTO_TYPE_LABELS\s*[[.]/,
];

// The one component allowed to do both — it is the picker.
const ALLOWED = ["photo-tag-select.tsx"];

/** Strip // and /* comments so a file that only NAMES a symbol in prose passes. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function uiFiles() {
  return sourceTexts(UI_DIRS)
    .filter(({ file }) => /\.tsx$/.test(file))
    .filter(({ file }) => !/[\\/]__tests__[\\/]|\.test\.tsx$/.test(file))
    .map(({ file, text }) => ({ file, code: stripComments(text) }));
}

describe("photo tag picker has one source (US-2461)", () => {
  it(
    "no UI file builds picker options out of the photo-type vocabulary",
    () => {
      const offenders = uiFiles()
        .filter(({ file }) => !ALLOWED.some((a) => file.endsWith(a)))
        .filter(({ code }) => BUILDS_OPTIONS.some((re) => re.test(code)))
        .map(({ file }) => file.replace(/^.*[\\/]src[\\/]/, "src/"));

      expect(
        offenders,
        "These files render options AND reference the photo-type vocabulary. " +
          "Use <PhotoTagSelect> instead — it hides retired types and shows the " +
          "item's suggested slots first.",
      ).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "no UI file names a retired photo type as a literal value",
    () => {
      // Retired types stay valid in the enum forever (Postgres cannot drop one)
      // and historical rows still point at them, so LABELLING one is fine —
      // PhotoTagSelect does exactly that for an un-backfilled photo. Writing one
      // as a literal in a component is what creates a new one.
      const retired = Object.keys(RETIRED_PHOTO_TYPES);
      const hits: string[] = [];
      for (const { file, code } of uiFiles()) {
        // The grading submission flow has its OWN taxonomy (`image_type`, an
        // enum that still carries numbered slots) which US-2471 owns. This
        // guard is the FlipDesk vocabulary only.
        if (file.includes("submission")) continue;
        for (const t of retired) {
          if (new RegExp(`["'\`]${t}["'\`]`).test(code)) {
            hits.push(`${file.replace(/^.*[\\/]src[\\/]/, "src/")}: ${t}`);
          }
        }
      }
      expect(hits).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );
});
