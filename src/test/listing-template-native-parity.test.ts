import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2818 built a Swift mirror of DESCRIPTION_TEMPLATES and nothing pinned the
// two together.
//
// THE DRIFT THIS FOUND ON ITS FIRST RUN was one character: the suit template's
// "Sold as a two-piece set" line used an em dash on the web and a hyphen on
// iOS. Nothing would ever have failed. The same suit, listed from a phone and
// from a laptop, simply read differently to the buyer — and a listing this
// product generates is the one piece of writing a seller does not proofread,
// because they did not write it.
//
// Read out of the SOURCES rather than compared between two hand-written lists:
// a copy of the templates in this file would be a third thing to keep in step.
// Swift is not compiled on Windows, so this is also the only check on the
// mirror that runs before iOS CI.

const WEB = "src/lib/listing-templates.ts";
const SWIFT = "ios/GradeThread/Marketplaces/Publish/ListingDescriptionTemplate.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8").split("\r\n").join("\n");
}

/** `DESCRIPTION_TEMPLATES` as { group: text }. */
function webTemplates(): Record<string, string> {
  const src = read(WEB);
  const start = src.indexOf("export const DESCRIPTION_TEMPLATES");
  expect(start, "DESCRIPTION_TEMPLATES is gone from the web").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n};", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^ {2}(\w+): `([\s\S]*?)`,?$/gm)) out[m[1]!] = m[2]!;
  return out;
}

/** The Swift `template(for:)` switch as { group: text }. */
function swiftTemplates(): Record<string, string> {
  const src = read(SWIFT);
  const at = src.indexOf("static func template(for group");
  expect(at, "template(for:) is gone from the Swift mirror").toBeGreaterThan(-1);
  const body = src.slice(at);
  const out: Record<string, string> = {};
  // Comment lines may sit between a case and its return — the suit case has
  // three, explaining why its extra line exists at all.
  const re =
    /^ {8}case ([^:\n]+):\n(?:\s*\/\/[^\n]*\n)*\s*return """\n([\s\S]*?)\n( *)"""/gm;
  for (const m of body.matchAll(re)) {
    // Swift strips the closing delimiter's indentation from every line.
    const indent = m[3]!.length;
    const text = m[2]!.split("\n").map((l) => l.slice(indent)).join("\n");
    // One `case .a, .b, .c:` covers three groups whose web templates are
    // byte-identical. Collapsing them is faithful, not drift.
    for (const g of m[1]!.split(",")) out[g.trim().replace(/^\./, "")] = text;
  }
  return out;
}

describe("the iOS description templates mirror the web's", () => {
  const web = webTemplates();
  const swift = swiftTemplates();

  it("both sides parsed, which is what makes the rest meaningful", () => {
    // An extraction that silently found nothing would make every comparison
    // below vacuously true. The first version of this parser matched zero Swift
    // cases and reported eleven groups "missing from iOS", which is the same
    // failure wearing a different hat.
    expect(Object.keys(web).length, "no web templates parsed").toBeGreaterThan(8);
    expect(Object.keys(swift).length, "no Swift templates parsed").toBeGreaterThan(8);
  });

  it("covers exactly the same groups", () => {
    expect(Object.keys(swift).sort()).toEqual(Object.keys(web).sort());
  });

  it.each(Object.keys(webTemplates()))("%s reads identically on both", (group) => {
    expect(swift[group], `${group} is missing from the Swift mirror`).toBeDefined();
    expect(swift[group]).toBe(web[group]);
  });
});
