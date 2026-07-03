// US-1570: the WEB mirror of the MeasureCard constants must stay byte-level
// in sync with the canonical artwork JSON (and therefore with the edge copy,
// which runs the same assertion in deno). Shared-constants convention: the
// two measure-card.ts modules are generated together — this test catches a
// one-sided edit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cardVersionForIds, MEASURE_CARD_V1 } from "@/lib/measure-card";

const canonical = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../assets/measure-card/geometry-v1.json"),
    "utf8",
  ),
);

describe("measure-card constants (web mirror)", () => {
  it("matches the committed artwork JSON exactly", () => {
    expect(JSON.parse(JSON.stringify(MEASURE_CARD_V1))).toEqual(canonical);
  });

  it("matches the edge copy byte-for-byte (shared-constants convention)", () => {
    const web = readFileSync(resolve(__dirname, "../measure-card.ts"), "utf8");
    const edge = readFileSync(
      resolve(
        __dirname,
        "../../../services/edge-functions/src/lib/measure-card.ts",
      ),
      "utf8",
    );
    expect(web).toBe(edge);
  });

  it("identifies card v1 from detected ids in any order", () => {
    expect(cardVersionForIds([12, 10, 13, 11])?.version).toBe(1);
    expect(cardVersionForIds([10, 11])).toBeNull();
  });
});
