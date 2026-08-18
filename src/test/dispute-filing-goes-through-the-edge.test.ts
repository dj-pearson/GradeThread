import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// US-2670: a grade dispute must be FILED through the edge route, never by
// inserting into `disputes` from a client.
//
// WHY, and every one of these is a rule the direct insert silently skips:
//
//   • THE FILING WINDOW. routes/grade.ts enforces DISPUTE_WINDOW_DAYS
//     server-side, and US-2153 added it for exactly this reason — its own
//     comment says "the 7-day rule was only in client UI, so a slow/older report
//     could still be disputed via a direct API call". A client that inserts into
//     the table IS that direct API call. Its local window constant only decides
//     whether a button is enabled.
//   • OWNERSHIP OF THE REPORT. The RLS insert policies on `disputes` check
//     `auth.uid() = user_id` (00001) and workspace membership on the same column
//     (00042). NEITHER checks that the caller owns `grade_report_id`. The edge
//     route loads the submission `.eq("user_id", ownerId)` first; a direct insert
//     has nothing equivalent, so any valid report id is accepted.
//   • THE DUPLICATE CHECK, the evidence-image pipeline (validate → strip EXIF →
//     store, US-276), and the submission status flip. All edge-side.
//
// Android already does it correctly and its DisputeService says why in a comment
// a line long: the edge does both halves. Web posts to the same route. iOS was
// the only client inserting directly, which is what this test was written for.
//
// SCOPED TO WRITES. Reading `disputes` from a client is fine and every client
// does it — RLS scopes a SELECT to the caller's own rows.

const root = process.cwd();

/** Every source file under a root, for the extensions given. */
function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "build" || name === ".git") continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...sourceFiles(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Comments stripped, so a header describing a call that is not made cannot pass. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*(\/\/|\*).*$/gm, "");
}

const CLIENT_ROOTS: Array<{ label: string; dir: string; exts: string[] }> = [
  { label: "web", dir: join(root, "src"), exts: [".ts", ".tsx"] },
  { label: "ios", dir: join(root, "ios"), exts: [".swift"] },
  { label: "android", dir: join(root, "android", "app", "src", "main"), exts: [".kt"] },
];

// A write on the disputes table, in any of the three client dialects. supabase-js
// and supabase-kt both read `.from("disputes")` then `.insert(`; supabase-swift
// is the same shape. The window between them is generous but bounded, so a
// `.from("disputes").select()` two hundred lines above an unrelated `.insert(`
// cannot be mistaken for one call.
const DISPUTE_WRITE = /from\(\s*"disputes"\s*\)[\s\S]{0,400}?\.(insert|upsert)\s*[({]/;

describe("US-2670: no client writes to `disputes` directly", () => {
  for (const { label, dir, exts } of CLIENT_ROOTS) {
    it(`${label} files disputes through the edge, not the table`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(dir, exts)) {
        // The admin console is a different actor with a different posture: it
        // RESOLVES disputes rather than filing them, and it is behind admin auth.
        if (file.includes(join("pages", "admin"))) continue;
        if (DISPUTE_WRITE.test(code(file))) {
          offenders.push(file.slice(root.length + 1).replace(/\\/g, "/"));
        }
      }
      expect(
        offenders,
        `these write to \`disputes\` from a client, which skips the server filing ` +
          `window, the report-ownership check, the duplicate check, the evidence ` +
          `pipeline and the submission status flip. File through POST ` +
          `/api/grade/dispute instead — see android DisputeService.kt for the shape.`,
      ).toEqual([]);
    });
  }

  it("the scan actually reads the clients, rather than passing vacuously", () => {
    // The failure mode this guard has to avoid is its own: a wrong path, an
    // empty file list, and a green tick forever.
    for (const { label, dir, exts } of CLIENT_ROOTS) {
      const files = sourceFiles(dir, exts);
      expect(files.length, `${label}: found no source files under ${dir}`).toBeGreaterThan(20);
      expect(
        files.some((f) => /dispute/i.test(f)),
        `${label}: no file with "dispute" in its name — the scan is looking in the wrong place`,
      ).toBe(true);
    }
  });

  it("the edge route the clients must use still exists", () => {
    // If /dispute is ever renamed, this guard would be telling clients to call
    // something that is not there.
    const grade = readFileSync(join(root, "services/edge-functions/src/routes/grade.ts"), "utf8");
    expect(grade).toMatch(/gradeRoutes\.post\(\s*"\/dispute"/);
    expect(grade, "the server-side filing window is what the direct insert skips").toMatch(
      /DISPUTE_WINDOW_DAYS\s*=\s*\d+/,
    );
  });
});
