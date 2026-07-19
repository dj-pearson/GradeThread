// US-2129: shared, memoized source scanner for the repo-wide guard tests.
//
// no-or-on-mutations.test.ts (US-1552) and lockstep-registry.test.ts (US-2019)
// both walk src/ + functions/ + services/edge-functions/src and read every file
// — 2,235 files, 21.6 MB. Measured: ~27ms to walk, ~490ms to read, when nothing
// else is running.
//
// Under vitest's parallel workers that inflates past the default 5000ms
// testTimeout, and the suite failed with "Test timed out in 5000ms" on a
// DIFFERENT test each run. Two guards that scan the whole repo were the ones
// going red at random — the worst possible tests to have flaking, since random
// red teaches everyone to re-run rather than investigate, and a genuine US-1552
// or US-2019 regression would be indistinguishable from the noise.
//
// The avoidable half was real duplication: no-or-on-mutations read all 2,235
// files TWICE (once per heavy test) because only the file LIST was hoisted, not
// the contents. This module reads each file once per worker and memoizes, so
// every guard in a file shares one pass.
//
// NOTE the deliberate limit: vitest runs each test FILE in its own worker, so
// this cache is per-worker. It removes duplicate reads within a file, not
// across files. That is why the guards also carry an explicit timeout — see
// SCAN_TIMEOUT_MS.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Timeout for a test that performs a full source scan.
 *
 * NOT a blind raise (US-2129 AC2 explicitly forbids that). 5000ms is vitest's
 * default, tuned for unit tests; a 21.6 MB scan is not a unit test. The
 * measured cost is ~0.5s idle and ~8.6s under full parallel load, so 30s leaves
 * real headroom on a loaded CI runner while still failing an actual hang.
 */
export const SCAN_TIMEOUT_MS = 30_000;

const SKIP = new Set(["node_modules", "dist", "coverage", "build"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory absent in this checkout — not this guard's problem
  }
  for (const entry of entries) {
    if (SKIP.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else out.push(full);
  }
  return out;
}

const fileCache = new Map<string, string[]>();
const textCache = new Map<string, Array<{ file: string; text: string }>>();

/** Every file under `dirs` (repo-relative), memoized per worker. */
export function sourceFiles(dirs: readonly string[], root = process.cwd()): string[] {
  const key = `${root}::${dirs.join(",")}`;
  const hit = fileCache.get(key);
  if (hit) return hit;
  const files = dirs.flatMap((d) => walk(resolve(root, d)));
  fileCache.set(key, files);
  return files;
}

/**
 * Every file under `dirs` WITH its contents, read once and memoized.
 *
 * Unreadable/binary files are skipped rather than throwing — a guard should not
 * fail because someone committed a PNG.
 */
export function sourceTexts(
  dirs: readonly string[],
  root = process.cwd(),
): Array<{ file: string; text: string }> {
  const key = `${root}::${dirs.join(",")}`;
  const hit = textCache.get(key);
  if (hit) return hit;
  const out: Array<{ file: string; text: string }> = [];
  for (const file of sourceFiles(dirs, root)) {
    try {
      out.push({ file, text: readFileSync(file, "utf8") });
    } catch {
      continue;
    }
  }
  textCache.set(key, out);
  return out;
}
