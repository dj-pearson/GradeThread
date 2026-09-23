// The shots a grade cannot go ahead without (front, back, label) are declared
// once, in services/edge-functions/src/lib/image-quality.ts, where the quality
// gate blocks on them. grade.ts and api-v1.ts used to keep their own copies of
// the list, pinned by nothing, so a change to the gate would have left the
// upload checks asking for the old set. This fails if a copy comes back.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EDGE = "services/edge-functions/src";
const SOURCE = `${EDGE}/lib/image-quality.ts`;
const CONSUMERS = [
  `${EDGE}/routes/grade.ts`,
  `${EDGE}/routes/api-v1.ts`,
  `${EDGE}/lib/api-grade-ingest.ts`,
  `${EDGE}/lib/grading-submit.ts`,
];

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function edgeSources(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "tests" ? [] : edgeSources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") ? [p] : [];
  });
}

describe("REQUIRED_IMAGE_TYPES has one source", () => {
  it("is declared in image-quality.ts", () => {
    expect(read(SOURCE)).toMatch(/export const REQUIRED_IMAGE_TYPES = \[/);
  });

  it("no other edge file declares its own REQUIRED_IMAGE_TYPES", () => {
    const copies = edgeSources(EDGE).filter(
      (p) => p !== SOURCE && /const\s+\w*REQUIRED_IMAGE_TYPES\s*=\s*\[/.test(read(p)),
    );
    expect(copies, "a local copy of the required-photo list").toEqual([]);
  });

  it.each(CONSUMERS)("%s imports it from image-quality.ts", (p) => {
    expect(read(p)).toMatch(
      /import \{[^}]*\bREQUIRED_IMAGE_TYPES\b[^}]*\} from "(\.\.\/lib|\.)\/image-quality\.ts"/,
    );
  });
});
