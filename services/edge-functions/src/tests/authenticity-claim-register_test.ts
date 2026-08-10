// US-2133 AC1: every authenticity verdict a user can read must be on the list
// the substantiation review is given.
//
// Same instrument as subscription-copy-register_test.ts, for the same reason: a
// review is only as good as the inventory handed to it, and that register found
// a false claim within an hour of existing. This one is stricter in one place —
// the RENDERED labels are deliberately weaker than the enum names ("Looks
// consistent with genuine" is an observation about photographs; "likely
// authentic" would be a judgement about the item), and that distinction is the
// product's entire legal posture. It is one string wide, so it is pinned.
//
// This file asserts nothing about whether a claim is DEFENSIBLE. That is
// US-2133 AC1/AC2 and it needs counsel.

import { assert, assertEquals } from "@std/assert";
import { code } from "./_source-scan.ts";

const AI_AUTH = await Deno.readTextFile(
  new URL("../lib/ai-authenticity.ts", import.meta.url),
);
const TOOL_PAGE = await Deno.readTextFile(
  new URL("../../../../src/pages/tools/authenticity-check.tsx", import.meta.url),
);
const REGISTER = await Deno.readTextFile(
  new URL("../../../../vault/20-domain/authenticity-claim-register.md", import.meta.url),
);

/** The verdict union, read from the type rather than restated here. */
function verdicts(): string[] {
  const m = /export type AuthenticityVerdict = ([^;]+);/.exec(code(AI_AUTH));
  assert(m, "AuthenticityVerdict not found — renamed?");
  return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!).sort();
}

/** The user-visible label for each verdict, from the page's label map. */
function labels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of code(TOOL_PAGE).matchAll(/(\w+):\s*\{\s*label:\s*"([^"]+)"/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

Deno.test("US-2133: the scan still finds the verdicts and their labels", () => {
  // Guards the guard. Either half returning nothing would leave every
  // assertion below passing over an empty set.
  assertEquals(verdicts(), ["inconclusive", "likely_authentic", "red_flags"]);
  const l = labels();
  assertEquals(Object.keys(l).sort(), ["inconclusive", "likely_authentic", "red_flags"]);
});

Deno.test("US-2133 AC1: every verdict and every rendered label is registered", () => {
  const missing: string[] = [];
  for (const v of verdicts()) if (!REGISTER.includes(v)) missing.push(v);
  for (const [v, label] of Object.entries(labels())) {
    if (!REGISTER.includes(label)) missing.push(`${v} → "${label}"`);
  }
  assertEquals(
    missing,
    [],
    "these are read by a user and are not in " +
      "vault/20-domain/authenticity-claim-register.md. The substantiation review " +
      "cannot cover a claim it was never shown.",
  );
});

Deno.test("US-2133 AC2: the rendered label does not assert the item is genuine", () => {
  // The posture is undecided (AC2), so the copy must not decide it by drift.
  // "Authentic", "verified", "genuine item" and the like are verification
  // claims; the pipeline is built for an assessment — confidence-ceilinged,
  // hard-capped on contradiction, with a limitations string the model cannot
  // author. A label that outruns that is the one change nobody would file a bug
  // about.
  const forbidden = [
    "Authentic",
    "Verified",
    "Confirmed genuine",
    "Genuine item",
    "Guaranteed",
  ];
  for (const [verdict, label] of Object.entries(labels())) {
    for (const word of forbidden) {
      assert(
        !label.includes(word),
        `${verdict} renders as "${label}", which asserts verification. The ` +
          "pipeline supports an assessment with stated limitations; changing " +
          "that is US-2133 AC2 and needs counsel, not a copy edit.",
      );
    }
  }
  assert(
    labels().likely_authentic?.includes("consistent"),
    "the positive verdict must stay an observation about the photographs",
  );
});

Deno.test("US-2133: the mandatory limitations disclosure is still mandatory", () => {
  // The register cites this as what backs every claim. If the constant stops
  // saying it, the register is describing a protection that is gone.
  const src = code(AI_AUTH);
  for (const phrase of [
    "not a definitive authentication",
    "one trust signal, not proof",
  ]) {
    assert(
      src.includes(phrase),
      `AUTHENTICITY_LIMITATIONS no longer says "${phrase}" — the register cites ` +
        "it as the disclosure that accompanies every verdict",
    );
  }
  assert(
    /export const AUTHENTICITY_LIMITATIONS/.test(src),
    "the disclosure must stay a fixed constant the model cannot author",
  );
});

Deno.test("US-2133: the register does not claim a review that has not happened", () => {
  // Same rule as the subscription register. An unverifiable substantiation
  // claim is worse than an honest gap, because the gap is what makes anyone act.
  for (const line of REGISTER.split(/\r?\n/)) {
    if (!/substantiated|counsel[- ]reviewed/i.test(line)) continue;
    const denies = /\b(nothing|none|not|never|no)\b/i.test(line);
    assert(
      denies || /\d{4}-\d{2}-\d{2}/.test(line) || /pending|awaiting|owes|needs/i.test(line),
      `"${line.trim()}" claims substantiation with no dated record.`,
    );
  }
});
