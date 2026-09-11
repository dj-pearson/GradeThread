// One marketplace vocabulary across every root, including the roots that
// cannot import it (US-3388).
//
// WHAT WENT WRONG. src/lib/constants.ts is the map, and four other files hold a
// hand-typed copy of it because the edge service, Cloudflare Pages Functions
// and Android cannot import from src/. US-3380 corrected constants.ts and the
// copies did not move. The damage was not the wrong label, it was the MISSING
// key: a key a copy does not carry falls through to that copy's fallback, and
// the fallbacks are a capitalizer and the raw key. So the delist notification a
// seller reads said "still live on Offerup", and the public verified-seller
// storefront printed "View on etsy" to anyone with the link.
//
// functions/verified/[handle].ts carried the comment "Keep in sync with
// MARKETPLACE_LABELS in src/lib/constants.ts" the whole time it was out of
// sync. That comment is the argument for this file: a request to remember is
// not a mechanism.
//
// WHY IT PARSES SOURCE. The three remaining copies live in roots this test
// cannot import from: services/edge-functions/ is Deno with .ts import
// specifiers, functions/ is a Pages Function bundled by Cloudflare. Importing
// either from a vitest run under src/ does not build, and "fix the copies by
// deleting them" is not available for the same reason. So the guard reads the
// files and parses the object literal out, which is the shape
// platform-label-vocabulary.test.ts already uses against the extension.
//
// WHY IT NAMES NO PLATFORMS. The key set comes from MARKETPLACE_LABELS, which
// TypeScript already keys off LISTING_PLATFORMS. A guard carrying its own list
// of platforms is the same pair of eyes that missed offerup, only slower to
// admit it. Add a platform to LISTING_PLATFORMS and every copy below is checked
// for it with no edit to this file.
//
// WHAT THIS GUARD IS NOT ABOUT. SOCIAL_PLATFORM_LABELS (src/lib/constants.ts)
// and PLATFORM_LABEL (services/edge-functions/src/lib/social-platforms.ts) both
// say facebook: "Facebook", and both are RIGHT: that is Facebook the social
// network, a different key space that happens to share one word. The last
// describe() block below exists to prove this guard cannot redden on them.
//
// STILL OPEN, deliberately, and recorded here so nobody re-derives it:
//   - android/.../marketplaces/ListingCard.kt:62 says facebook -> "Facebook"
//     while three other Android files say "Facebook Marketplace". It is the
//     fifth copy and the only Android file that disagrees with its own
//     platform. Android was out of scope for the change that added this file;
//     a Kotlin copy needs its own parser, on the JVM side or here.
//   - src/components/analytics/listing-suggestions.tsx agrees on every key it
//     has and is missing four (etsy, shopify, whatnot, vinted), so it renders a
//     raw key for those. It is registered as a SUBSET copy below rather than
//     left unseen.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { MARKETPLACE_LABELS, SOCIAL_PLATFORM_LABELS } from "@/lib/constants";
import { sourceFiles, SCAN_TIMEOUT_MS } from "./_source-scan";

const ROOT = process.cwd();

/**
 * A label map that lives in source, addressed by file and by the name of the
 * const holding it.
 *
 * `mode` is the whole argument of this file:
 *  - "full"   the copy stands in for MARKETPLACE_LABELS on its own root, so a
 *             key it lacks is a user-visible fallback. It must carry all of
 *             them.
 *  - "subset" the copy serves a narrower key space on purpose (or has a gap
 *             nobody has closed yet). It must still agree on every key it does
 *             carry, and it must say why it is short.
 */
interface LabelCopy {
  readonly file: string;
  readonly constName: string;
  readonly mode: "full" | "subset";
  readonly why: string;
}

const COPIES: readonly LabelCopy[] = [
  {
    file: "services/edge-functions/src/lib/marketplace-event-notify.ts",
    constName: "PLATFORM_LABELS",
    mode: "full",
    why:
      "The sentence a seller reads when a sibling listing is still live. Its " +
      "fallback capitalizes the raw key, which is how it wrote 'Offerup'.",
  },
  {
    file: "functions/verified/[handle].ts",
    constName: "PLATFORM_LABELS",
    mode: "full",
    why:
      "The public verified-seller storefront. Its fallback is the raw key, so " +
      "a missing platform reads 'View on etsy' to anyone with the link.",
  },
  {
    file: "services/edge-functions/src/routes/admin-marketplace-connections.ts",
    constName: "MARKETPLACE_LABELS",
    mode: "full",
    why:
      "The operator console's connection rows and the reconnect notification " +
      "sent to the seller.",
  },
  {
    file: "services/edge-functions/src/lib/closet-import.ts",
    constName: "labels",
    mode: "subset",
    why:
      "Keyed by ClosetImportPlatform, which is the three marketplaces the " +
      "closet importer can read. TypeScript already forbids a fourth key, so " +
      "the narrowing is enforced, not remembered.",
  },
  {
    file: "src/lib/badge-arrival.ts",
    constName: "BADGE_PLATFORM_LABELS",
    mode: "subset",
    why:
      "Keyed by BadgeArrivalPlatform, the marketplaces that can carry a " +
      "verified badge back to us. Same type-enforced narrowing.",
  },
  {
    file: "src/components/analytics/listing-suggestions.tsx",
    constName: "labels",
    mode: "subset",
    why:
      "OPEN GAP, not a design. Keyed by plain string and missing etsy, " +
      "shopify, whatnot and vinted, so the suggestion panel prints a raw key " +
      "for those four. Every key it does carry is correct. Out of scope for " +
      "US-3388, which was fenced to the four files above; registered here so " +
      "it is a known number rather than a fresh discovery.",
  },
];

/**
 * Files that hold a marketplace-keyed map which is NOT a display-name map, and
 * so are allowed to be absent from COPIES.
 *
 * Each one is named, because "the scan found something it does not understand"
 * has to end in a decision rather than in a widened regex.
 */
const NOT_A_LABEL_MAP: ReadonlyMap<string, string> = new Map([
  [
    "src/lib/constants.ts",
    "The source of truth itself. MARKETPLACE_LABELS is imported here, not " +
      "parsed for comparison; the parser self-check below reads it anyway to " +
      "prove the parser agrees with the module system.",
  ],
]);

function readSource(file: string): string {
  // CRLF normalized first. This working tree mixes line endings by file --
  // marketplace-event-notify.ts is CRLF today and the two next to it are LF --
  // and every regex below anchors on \n.
  let raw: string;
  try {
    raw = readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    throw new Error(
      `${file} is registered in this guard and is not on disk. If the file ` +
        `moved, move the entry with it; if the copy is genuinely gone, delete ` +
        `the entry and say so. Do not leave a registered path dangling -- a ` +
        `guard that cannot open its subject is not guarding it.`,
    );
  }
  return raw.replace(/\r\n/g, "\n");
}

/** Strip // line comments so a commented-out entry cannot be parsed as real. */
function stripLineComments(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * The object literal assigned to `const <name>` in `file`, as a plain object.
 *
 * Throws rather than returning empty when the const is gone or unparseable. A
 * guard that silently finds nothing is the failure mode this whole file exists
 * to replace: the copies were wrong for a fortnight while a comment claimed
 * they were checked.
 */
function parseLabelMap(file: string, constName: string): Record<string, string> {
  const src = readSource(file);
  const decl = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?const\\s+${constName}\\b[^={]*=\\s*\\{\\n([\\s\\S]*?)\\n\\s*\\};`,
  );
  const block = decl.exec(src);
  if (!block?.[1]) {
    throw new Error(
      `could not find "const ${constName} = { ... }" in ${file}. That map is ` +
        `one of the hand-kept copies of MARKETPLACE_LABELS; if it moved or ` +
        `was renamed, update COPIES in this file. Do not delete the entry ` +
        `unless the copy itself is gone.`,
    );
  }
  const out: Record<string, string> = {};
  const entry = /^\s*"?([A-Za-z_][A-Za-z0-9_-]*)"?\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/gm;
  let m: RegExpExecArray | null;
  const body = stripLineComments(block[1]);
  while ((m = entry.exec(body)) !== null) {
    const key = m[1];
    const value = m[2];
    if (key === undefined || value === undefined) continue;
    out[key] = value;
  }
  if (Object.keys(out).length < 3) {
    throw new Error(
      `parsed only ${Object.keys(out).length} entries out of ${constName} in ` +
        `${file}. Fewer than 3 means the literal's shape changed and every ` +
        `comparison below would be vacuously true.`,
    );
  }
  return out;
}

const CANON = MARKETPLACE_LABELS as Record<string, string>;
const CANON_KEYS = Object.keys(CANON);

describe("the parser reads source the way the module system does", () => {
  // The anti-vacuity test, and the one that makes the three unimportable
  // copies trustworthy. If parseLabelMap can reproduce a map this file also
  // imports, its answer about a map this file cannot import means something.
  it("parsing MARKETPLACE_LABELS out of constants.ts matches the import", () => {
    const parsed = parseLabelMap("src/lib/constants.ts", "MARKETPLACE_LABELS");
    expect(parsed).toEqual(CANON);
  });

  it("the canonical map is a real map", () => {
    expect(CANON_KEYS.length).toBeGreaterThanOrEqual(10);
    for (const key of CANON_KEYS) {
      expect(typeof CANON[key], `MARKETPLACE_LABELS.${key}`).toBe("string");
      expect(CANON[key]?.trim(), `MARKETPLACE_LABELS.${key} is blank`).toBeTruthy();
    }
  });
});

/**
 * Every registered copy, parsed once.
 *
 * Lazy on purpose. Parsing at describe() time means one unreadable file takes
 * the whole FILE down at collection, and a suite that never collected reports
 * "no tests" rather than a failure anyone can read. Inside the its, a broken
 * entry fails the tests that depend on it and leaves the discovery scan
 * running, which is the test most likely to explain what happened.
 */
let parsedCache: Array<{ copy: LabelCopy; map: Record<string, string> }> | null = null;
function parsedCopies(): Array<{ copy: LabelCopy; map: Record<string, string> }> {
  parsedCache ??= COPIES.map((copy) => ({
    copy,
    map: parseLabelMap(copy.file, copy.constName),
  }));
  return parsedCache;
}

describe("every hand-kept copy of MARKETPLACE_LABELS agrees with it", () => {
  it("every copy parses to a real map of strings", () => {
    for (const { copy, map } of parsedCopies()) {
      const keys = Object.keys(map);
      expect(keys.length, `${copy.file} ${copy.constName}`).toBeGreaterThanOrEqual(3);
      for (const key of keys) {
        expect(map[key]?.trim(), `${copy.file} ${copy.constName}.${key} is blank`).toBeTruthy();
      }
    }
  });

  // AC1. The one that catches a misspelling, a stale name, or a copy that was
  // corrected on one root and not the others.
  it("no copy disagrees with constants.ts about a key they share", () => {
    const disagreements: string[] = [];
    for (const { copy, map } of parsedCopies()) {
      for (const key of Object.keys(map)) {
        if (!Object.prototype.hasOwnProperty.call(CANON, key)) continue;
        if (map[key] !== CANON[key]) {
          disagreements.push(
            `${copy.file} ${copy.constName}.${key} says "${map[key]}", ` +
              `src/lib/constants.ts says "${CANON[key]}"`,
          );
        }
      }
    }
    expect(
      disagreements,
      "one vocabulary across every root. src/lib/constants.ts wins; it is the " +
        "map already held to the browser extension by " +
        "platform-label-vocabulary.test.ts.",
    ).toEqual([]);
  });

  // AC2, and the half that actually shipped the bugs. A key that is absent
  // does not render nothing, it renders whatever that file's fallback makes
  // up: "Offerup" from a capitalizer, "etsy" from the raw key.
  it("no full copy is missing a platform constants.ts names", () => {
    const gaps: string[] = [];
    for (const { copy, map } of parsedCopies()) {
      if (copy.mode !== "full") continue;
      const missing = CANON_KEYS.filter(
        (k) => !Object.prototype.hasOwnProperty.call(map, k),
      );
      if (missing.length > 0) {
        gaps.push(`${copy.file} ${copy.constName} is missing: ${missing.join(", ")}`);
      }
    }
    expect(
      gaps,
      "a missing key falls through to that file's fallback, which is a " +
        "capitalizer or the raw key. That is what put 'Offerup' in a seller " +
        "notification and 'etsy' on a public storefront.",
    ).toEqual([]);
  });

  // A key nobody else has is the same drift pointing the other way: either
  // constants.ts is missing a platform, or a copy invented one.
  it("no copy names a platform constants.ts does not", () => {
    const strays: string[] = [];
    for (const { copy, map } of parsedCopies()) {
      for (const key of Object.keys(map)) {
        if (!Object.prototype.hasOwnProperty.call(CANON, key)) {
          strays.push(`${copy.file} ${copy.constName}.${key}`);
        }
      }
    }
    expect(
      strays,
      "either LISTING_PLATFORMS is missing this platform or the copy made it " +
        "up. Both are worth stopping for.",
    ).toEqual([]);
  });

  // A subset copy is allowed to be short only if someone wrote down why. This
  // is the pressure valve, and it has to cost something or every copy becomes
  // a subset copy the first time the guard is inconvenient.
  it("every subset copy says why it is short", () => {
    for (const copy of COPIES) {
      if (copy.mode !== "subset") continue;
      expect(copy.why.length, `${copy.file} needs a real reason`).toBeGreaterThan(40);
    }
  });
});

describe("the registry cannot quietly miss a copy", () => {
  // Discovery. A sixth copy landing in a new file is exactly how the fifth one
  // happened, so the registry is checked against the tree rather than trusted.
  //
  // The heuristic: at least three distinct LISTING_PLATFORMS keys mapped to a
  // short quoted string that reads like a display name. URL maps, the AI tone
  // map and the disclosure prose all carry the same keys and are excluded by
  // the value shape, which is the point -- the scan looks for LABELS.
  it(
    "every file holding a marketplace label map is registered",
    () => {
      const files = sourceFiles(["src", "functions", "services/edge-functions/src"]);
      const entry = new RegExp(
        `^[ \\t]*"?(${CANON_KEYS.join("|")})"?[ \\t]*:[ \\t]*"([^"]{1,24})"[ \\t]*,?[ \\t]*$`,
        "gm",
      );
      const looksLikeAName = /^[A-Za-z][A-Za-z0-9 .&'-]*$/;
      const registered = new Set(COPIES.map((c) => c.file));
      const unregistered: string[] = [];

      for (const abs of files) {
        if (!/\.tsx?$/.test(abs)) continue;
        const rel = abs.slice(ROOT.length + 1).split(sep).join("/");
        if (/(^|\/)(__tests__|tests)\//.test(rel)) continue;
        if (registered.has(rel) || NOT_A_LABEL_MAP.has(rel)) continue;
        let text: string;
        try {
          text = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
        } catch {
          continue;
        }
        entry.lastIndex = 0;
        const keys = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = entry.exec(text)) !== null) {
          if (m[1] && m[2] && looksLikeAName.test(m[2])) keys.add(m[1]);
        }
        if (keys.size >= 3) unregistered.push(`${rel} (${[...keys].sort().join(", ")})`);
      }

      expect(
        unregistered,
        "a marketplace display-name map that no guard compares to " +
          "src/lib/constants.ts. Add it to COPIES (full or subset with a " +
          "reason), or to NOT_A_LABEL_MAP if it is a different key space.",
      ).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it("every registered file still exists and still holds its const", () => {
    // An entry that stops matching is as bad as a file that stops being
    // checked: it is how a rename disarms a guard without anyone noticing.
    for (const copy of COPIES) {
      expect(() => parseLabelMap(copy.file, copy.constName)).not.toThrow();
    }
    for (const [file] of NOT_A_LABEL_MAP) {
      expect(() => readSource(file), `${file} is gone`).not.toThrow();
    }
  });
});

describe("the social key space is a different key space", () => {
  // "Prove your guard does not redden on these." SOCIAL_PLATFORM_LABELS and
  // the edge's PLATFORM_LABEL both say facebook: "Facebook" and both are
  // correct: that is the social network, where the product posts, not the
  // Marketplace surface, where it lists. The two maps are allowed to disagree
  // about the word "facebook" forever.
  const EDGE_SOCIAL = "services/edge-functions/src/lib/social-platforms.ts";

  it("this guard reads no social-platform map", () => {
    const watched = [...COPIES.map((c) => c.file), ...NOT_A_LABEL_MAP.keys()];
    expect(watched).not.toContain(EDGE_SOCIAL);
    for (const copy of COPIES) {
      expect(copy.constName).not.toBe("SOCIAL_PLATFORM_LABELS");
      expect(copy.constName).not.toBe("PLATFORM_LABEL");
    }
  });

  it("both sides of the social vocabulary still say Facebook, and are right", () => {
    expect(SOCIAL_PLATFORM_LABELS.facebook).toBe("Facebook");
    expect(parseLabelMap(EDGE_SOCIAL, "PLATFORM_LABEL").facebook).toBe("Facebook");
    // And the marketplace vocabulary still says the long one, which is the
    // disagreement that must NOT be reconciled.
    expect(CANON.facebook).toBe("Facebook Marketplace");
  });

  it("the social maps agree with each other", () => {
    // Free, since the parser is already here, and it is the same failure shape
    // one key space over.
    const edge = parseLabelMap(EDGE_SOCIAL, "PLATFORM_LABEL");
    const web = SOCIAL_PLATFORM_LABELS as Record<string, string>;
    const disagreements = Object.keys(edge)
      .filter((k) => Object.prototype.hasOwnProperty.call(web, k))
      .filter((k) => edge[k] !== web[k])
      .map((k) => `${k}: edge "${edge[k]}", web "${web[k]}"`);
    expect(disagreements).toEqual([]);
  });
});
