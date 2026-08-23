import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// US-2016 AC4: stop scoring "grading submission" as ONE row.
//
// THE DEFECT THAT CRITERION NAMES. There are TWO grading pipelines in the edge
// and they are different journeys, not two spellings of one:
//
//   consumer / certified   POST /api/grade/submit, /pay/:id, GET /status/:id
//   FlipDesk / reseller    POST /api/flipdesk/grading/{validate,submit},
//                          GET  /api/flipdesk/grading/submissions/:id
//
// Scored as a single "grading submission" capability, a client that implements
// only the reseller half reads as COMPLETE. That is exactly how iOS shipped
// without the entire paid consumer journey - the audit had a green row.
//
// So this guard scores per PIPELINE, per CLIENT, and prints the matrix on
// failure. It is a floor: a client that has a pipeline may not silently lose
// it. It does NOT demand that every client have every pipeline - Android's gap
// is a product decision that belongs to a story, not a test failure - but it
// does refuse to let that gap be invisible.

const ROOT = resolve(import.meta.dirname, "../..");

/** One pipeline's endpoints, as the string a client would have to contain. */
const PIPELINES = {
  consumer: {
    label: "consumer / certified",
    endpoints: ["api/grade/submit", "api/grade/pay", "api/grade/dispute"],
  },
  reseller: {
    label: "FlipDesk / reseller",
    endpoints: ["flipdesk/grading/validate", "flipdesk/grading/submit"],
  },
} as const;

const CLIENTS = {
  web: "src",
  ios: "ios/GradeThread",
  android: "android/app/src/main",
} as const;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".swift", ".kt"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === "build" || entry === "__tests__") continue;
      sourceFiles(p, out);
    } else if (SOURCE_EXTENSIONS.some((e) => entry.endsWith(e))) {
      if (entry.includes(".test.") || entry.endsWith("Tests.swift")) continue;
      out.push(p);
    }
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * ⚠ WITHOUT THIS THE WHOLE GUARD IS DECORATIVE, and it was: three sabotages -
 * deleting the consumer submit path, renaming the pay endpoint, renaming the
 * dispute endpoint - ALL stayed green, because every one of those endpoints is
 * also named in a doc comment. `/// US-2688 - the body POST /api/grade/dispute
 * actually reads` satisfied a check about whether the client can file disputes.
 *
 * The same trap this repo has hit three times before, walked into by a guard
 * written to catch a related one. Every other guard I wrote today strips
 * comments; this one did not, and only sabotage said so.
 */
function code(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Which endpoints of a pipeline a client's production sources CALL. */
function reached(clientDir: string, endpoints: readonly string[]): string[] {
  const files = sourceFiles(join(ROOT, clientDir));
  const corpus = files.map((f) => code(readFileSync(f, "utf8"))).join("\n");
  return endpoints.filter((e) => corpus.includes(e));
}

/** The full matrix, computed once. */
function matrix(): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [client, dir] of Object.entries(CLIENTS)) {
    out[client] = {};
    for (const [key, pipeline] of Object.entries(PIPELINES)) {
      out[client]![key] = reached(dir, pipeline.endpoints);
    }
  }
  return out;
}

function render(m: Record<string, Record<string, string[]>>): string {
  const lines: string[] = [];
  for (const [client, pipelines] of Object.entries(m)) {
    for (const [key, hit] of Object.entries(pipelines)) {
      const total = PIPELINES[key as keyof typeof PIPELINES].endpoints.length;
      lines.push(`  ${client.padEnd(8)} ${key.padEnd(9)} ${hit.length}/${total}`);
    }
  }
  return lines.join("\n");
}

describe("the two grading pipelines are scored separately (US-2016 AC4)", () => {
  const m = matrix();

  /** Which endpoints of a pipeline a client is MISSING. */
  function missing(
    client: keyof typeof CLIENTS,
    pipeline: keyof typeof PIPELINES,
  ): string[] {
    const have = new Set(m[client]![pipeline]!);
    return PIPELINES[pipeline].endpoints.filter((e) => !have.has(e));
  }

  it("they really are two different journeys, not two spellings", () => {
    // If these ever collapse into one route set, this whole guard is obsolete
    // rather than wrong - and someone should delete it deliberately.
    const route = readFileSync(join(ROOT, "services/edge-functions/src/routes/grade.ts"), "utf8");
    expect(route).toContain('gradeRoutes.post("/submit"');
    expect(route).toContain('gradeRoutes.post("/pay/:id"');
    const flipdesk = readFileSync(
      join(ROOT, "services/edge-functions/src/lib/grading-submit.ts"),
      "utf8",
    );
    expect(flipdesk.length).toBeGreaterThan(0);
  });

  it("web has EVERY endpoint of both", () => {
    expect(missing("web", "consumer"), render(m)).toEqual([]);
    expect(missing("web", "reseller"), render(m)).toEqual([]);
  });

  it("iOS has EVERY endpoint of both, which it did not before US-2016", () => {
    // ⚠ ASSERTED PER ENDPOINT, NOT AS A COUNT ABOVE ZERO. The first version of
    // this case used `length > 0`, and deleting the whole consumer submit and
    // pay path left it GREEN - `api/grade/dispute` lives in DisputeSheet.swift
    // and that single hit satisfied the entire pipeline.
    //
    // Which is the defect AC4 names, reproduced inside the guard written to
    // prevent it: one number standing in for a journey reads complete while
    // half of it is missing. Found by sabotage, not by review.
    expect(missing("ios", "reseller"), render(m)).toEqual([]);
    expect(
      missing("ios", "consumer"),
      "iOS lost part of the consumer grading path. It was added by US-2016 " +
        "after the owner decided the paid consumer journey belongs on the " +
        "phone.\n" + render(m),
    ).toEqual([]);
  });

  it("Android has EVERY endpoint of both, which it did not before US-2716", () => {
    // THIS CASE USED TO ASSERT THE OPPOSITE, and the flip is the point.
    //
    // Until 2026-08-23 it REQUIRED Android to be missing consumer endpoints,
    // because whether the paid consumer path belonged on Android was an
    // unanswered product question (US-2716 AC1) and a guard must not settle a
    // product question by passing. The owner answered it on US-2815 by
    // choosing to build; Android got the whole chain; and US-2716 AC4 said
    // this line gets rewritten in the same commit either way.
    //
    // Asserted per ENDPOINT, never as a count, for the reason spelled out in
    // the iOS case above: one number standing in for a journey reads complete
    // while half of it is missing.
    expect(missing("android", "reseller"), render(m)).toEqual([]);
    expect(
      missing("android", "consumer"),
      "Android lost part of the consumer grading path. It was added by " +
        "US-2716 after the owner decided the paid consumer journey belongs " +
        "on the phone." + "\n" + render(m),
    ).toEqual([]);
  });

  it("the dispute half is scored with the pipeline it belongs to", () => {
    // US-2016's own note: "grade dispute" is not one row either - it is
    // file-a-dispute (three clients) and attach-evidence (three, as of US-2688).
    // Both are part of the CONSUMER pipeline, so a client with disputes and no
    // submit path has half a journey.
    for (const client of ["web", "ios", "android"] as const) {
      const dir = CLIENTS[client];
      const hasDispute = reached(dir, ["api/grade/dispute"]).length > 0;
      expect(hasDispute, `${client} cannot file a grade dispute`).toBe(true);
    }
  });
});
