// US-3184: an operator script that can spend AI against prod must announce its
// model and refuse a drifted one.
//
// Today exactly one script can: backfill-tag-reads.ts. Pinning that one file
// would pass forever while a second is written, and the second is the one that
// hurts - because by then the 2026-09-02 incident is a note somebody read once.
// So this scans scripts/ and requires the guard on anything that can reach the
// Anthropic client, transitively.

import { assert, assertEquals } from "@std/assert";

const SCRIPTS = "scripts";
const LIB = "src/lib";

/** Modules that construct or use the Anthropic client. */
const AI_MARKERS = [
  "getAnthropicClient",
  "messages.create",
  "messages.stream",
];

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Local imports of a source file, as repo-relative paths under src/lib. */
function localLibImports(src: string, fromDir: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+"(\.[^"]+\.ts)"/g)) {
    const rel = m[1]!;
    // scripts/ imports lib as "../src/lib/x.ts"; lib imports as "./x.ts".
    const name = rel.split("/").pop()!;
    if (rel.includes("/lib/") || fromDir === LIB) out.push(`${LIB}/${name}`);
  }
  return out;
}

/** Does this module reach an Anthropic call, directly or through one hop? */
async function reachesAi(path: string, dir: string): Promise<boolean> {
  const src = await readIfExists(path);
  if (!src) return false;
  if (AI_MARKERS.some((m) => src.includes(m))) return true;
  // One hop is enough: every AI helper in this service calls the client
  // directly, so a script importing one is the shape we are looking for.
  for (const dep of localLibImports(src, dir)) {
    const depSrc = await readIfExists(dep);
    if (depSrc && AI_MARKERS.some((m) => depSrc.includes(m))) return true;
  }
  return false;
}

Deno.test("US-3184: every AI-spending operator script checks for model drift", async () => {
  const offenders: string[] = [];
  const guarded: string[] = [];
  let scanned = 0;

  for await (const e of Deno.readDir(SCRIPTS)) {
    if (!e.isFile || !e.name.endsWith(".ts")) continue;
    scanned++;
    const path = `${SCRIPTS}/${e.name}`;
    if (!(await reachesAi(path, SCRIPTS))) continue;
    const src = (await readIfExists(path))!;
    if (src.includes("checkModelDrift(")) guarded.push(path);
    else {
      offenders.push(
        `${path}: can reach an Anthropic call but never calls checkModelDrift(). ` +
          `Add the banner + refusal from src/lib/operator-model-guard.ts, or, if ` +
          `it genuinely cannot spend, stop importing the module that can.`,
      );
    }
  }

  assert(scanned > 10, `scanned only ${scanned} scripts - the walk broke`);
  assertEquals(offenders, [], offenders.join("\n"));
  // Guard-the-guard: if the scan stops FINDING the one script we know spends,
  // it has silently started passing on everything.
  assert(
    guarded.includes("scripts/backfill-tag-reads.ts"),
    `the scan no longer sees backfill-tag-reads.ts as AI-spending, so a clean ` +
      `result here means nothing. Guarded: ${guarded.join(", ") || "(none)"}`,
  );
});
