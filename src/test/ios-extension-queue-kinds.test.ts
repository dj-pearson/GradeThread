import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-3105: the iOS queue kinds and revisable fields must match the server's.
//
// `EXTENSION_QUEUE_KINDS` (services/edge-functions/src/lib/extension-queue.ts)
// and `REVISABLE_FIELDS` (lib/pending-revises.ts) are the contract. iOS mirrors
// both in Swift, and Swift compiles only on the macOS CI job — so this guard is
// written where it runs everywhere.
//
// The failure it prevents is asymmetric and worth naming. A kind iOS cannot
// ENCODE is a feature the phone silently lacks: that is how revise and relist
// sat unavailable on the phone for two stories after the server and the
// extension both supported them. A kind iOS cannot DECODE is worse — the queue
// snapshot read fails and the seller sees no queue at all.

const SWIFT_QUEUE = resolve(
  __dirname,
  "../../ios/GradeThread/Marketplaces/ExtensionQueueService.swift",
);
const EDGE_QUEUE = resolve(
  __dirname,
  "../../services/edge-functions/src/lib/extension-queue.ts",
);
const EDGE_REVISES = resolve(
  __dirname,
  "../../services/edge-functions/src/lib/pending-revises.ts",
);

/** The `case foo` names inside a named Swift enum. */
function swiftEnumCases(source: string, enumName: string): string[] {
  const start = source.indexOf(`public enum ${enumName}`);
  expect(start, `${enumName} is not declared`).toBeGreaterThan(-1);
  const end = source.indexOf("\n    }", start);
  expect(end, `could not find the end of ${enumName}`).toBeGreaterThan(start);

  const out: string[] = [];
  for (const line of source.slice(start, end).split("\n")) {
    // `case list` and `case price, title, description, photos` both appear.
    const match = line.match(/^\s*case\s+([a-zA-Z,\s]+)$/);
    if (!match?.[1]) continue;
    for (const name of match[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/** A `["a", "b"] as const` string-array literal from a TypeScript const. */
function tsStringArray(source: string, constName: string): string[] {
  const start = source.indexOf(`export const ${constName}`);
  expect(start, `${constName} is not exported`).toBeGreaterThan(-1);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  expect(close).toBeGreaterThan(open);
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("US-3105: the iOS extension queue mirrors the server's contract", () => {
  const swift = readFileSync(SWIFT_QUEUE, "utf8");

  it("declares exactly the four kinds the edge accepts", () => {
    const server = tsStringArray(readFileSync(EDGE_QUEUE, "utf8"), "EXTENSION_QUEUE_KINDS");
    expect(server.length, "the parse found no kinds").toBeGreaterThan(1);
    expect(swiftEnumCases(swift, "Kind")).toEqual(server);
  });

  it("declares exactly the fields a revise may name", () => {
    const server = tsStringArray(readFileSync(EDGE_REVISES, "utf8"), "REVISABLE_FIELDS");
    expect(server.length, "the parse found no fields").toBeGreaterThan(1);
    expect(swiftEnumCases(swift, "ReviseField")).toEqual(server);
  });

  it("refuses an empty revise on the client rather than spending a round trip", () => {
    // The route validates `fields` and 400s on an empty array. The client
    // knowing that already is the difference between a disabled button and an
    // error the seller reads as a broken feature.
    expect(swift).toContain("case nothingToRevise");
    expect(swift).toContain("guard !fields.isEmpty else {");
  });
});
