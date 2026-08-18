import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUYER_FEATURES } from "@/lib/buyer-features";

// US-2503 AC3/AC5: the iOS capability table must say the same thing as the web
// registry, and "must" here means tested rather than intended.
//
// The story exists because a claim on /pricing ("Every FlipDesk plan includes
// buyer tools") outran what one client could deliver, and nothing was red. A
// hand-copied Swift list would reproduce that failure one level down: somebody
// flips `conditionAlerts` to shipped in TypeScript, the phone still says
// "coming soon", and the only signal is a support ticket.
//
// So this parses the Swift table and compares it, field by field, to the real
// registry import. Any drift in ids, labels, delivery or notes fails HERE — on
// the machine the edit is made on, in seconds — rather than on a macOS runner
// or not at all.

const SWIFT = resolve(
  process.cwd(),
  "ios/GradeThread/Buyer/BuyerEntitlements.swift",
);

interface ParsedCapability {
  id: string;
  label: string;
  delivery: string;
  note: string | null;
}

/**
 * Reads the entries between the GENERATED TABLE markers.
 *
 * Scoped to the markers on purpose: the file also holds `BuyerEntitlements.free`
 * and the delivery enum, and a whole-file scan would match strings that are not
 * table entries. Same trap the Android capture guard hit — a whole-file grep for
 * `PhotoProcessor` passed against code where the capture path had none, because
 * the import path in the same file did.
 */
function parseSwiftTable(): ParsedCapability[] {
  const src = readFileSync(SWIFT, "utf8");
  const start = src.indexOf("// BEGIN GENERATED TABLE");
  const end = src.indexOf("// END GENERATED TABLE");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "BuyerEntitlements.swift is missing its GENERATED TABLE markers",
    );
  }
  const body = src.slice(start, end);

  const entryRe =
    /BuyerCapability\(\s*id:\s*"([^"]+)",\s*label:\s*"((?:[^"\\]|\\.)*)",\s*delivery:\s*\.(\w+),\s*note:\s*(nil|"(?:[^"\\]|\\.)*")\)/g;

  const out: ParsedCapability[] = [];
  for (const m of body.matchAll(entryRe)) {
    const rawNote = m[4]!;
    out.push({
      id: m[1]!,
      label: m[2]!.replace(/\\"/g, '"'),
      delivery: m[3]!,
      note:
        rawNote === "nil"
          ? null
          : rawNote.slice(1, -1).replace(/\\"/g, '"'),
    });
  }
  return out;
}

/** `desktop-only` in TypeScript is `desktopOnly` in Swift; the rest match. */
function swiftDelivery(ios: string): string {
  return ios === "desktop-only" ? "desktopOnly" : ios;
}

describe("iOS buyer capability table mirrors the web registry", () => {
  const parsed = parseSwiftTable();

  it("parses every entry (the regex still matches the file it guards)", () => {
    // Without this, a formatting change that stops the regex matching would make
    // every comparison below pass against an EMPTY list. That failure mode has
    // shipped in this repo more than once, and it always looks like a green run.
    expect(parsed.length).toBe(Object.keys(BUYER_FEATURES).length);
  });

  it("lists exactly the registry's capability ids, in the same order", () => {
    expect(parsed.map((c) => c.id)).toEqual(Object.keys(BUYER_FEATURES));
  });

  it("agrees on every label, delivery and note", () => {
    const expected = Object.entries(BUYER_FEATURES).map(([id, meta]) => ({
      id,
      label: meta.label,
      delivery: swiftDelivery(meta.ios),
      note: meta.iosNote ?? null,
    }));
    expect(parsed).toEqual(expected);
  });

  it("names a real Swift file for anything it claims iOS has shipped", () => {
    // AC5 read literally. The first version of the web-side guard only COUNTED
    // shipped entries, so flipping one from planned to shipped sailed through:
    // the count stayed under the threshold. A threshold is not a property.
    const shipped = parsed.filter((c) => c.delivery === "shipped");
    expect(shipped.length).toBeGreaterThan(0);
    for (const cap of shipped) {
      const meta = BUYER_FEATURES[cap.id as keyof typeof BUYER_FEATURES];
      expect(meta.iosScreen, `${cap.id} claims shipped with no iosScreen`).
        toBeTruthy();
    }
  });

  it("gives every desktop-only capability the sentence the plan screen shows", () => {
    // A bundled capability that just vanishes on one client reads as a bug. The
    // subscriber paid for the bundle; they are owed the location.
    for (const cap of parsed.filter((c) => c.delivery === "desktopOnly")) {
      expect(cap.note, `${cap.id} is desktop-only with no note`).toBeTruthy();
    }
  });

  it("gives planned capabilities no note (the screen renders its own)", () => {
    for (const cap of parsed.filter((c) => c.delivery === "planned")) {
      expect(cap.note).toBeNull();
    }
  });
});
