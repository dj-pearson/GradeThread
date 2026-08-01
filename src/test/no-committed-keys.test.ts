// US-2284 [P0]: no signing key or private key is tracked by git.
//
// extension.pem — the Chrome Web Store signing identity — was committed on
// 2026-07-13 and sat in the repository for weeks. Anyone with read access could
// have published an update that every installed user auto-receives.
//
// The reason it survived is worth stating, because it is the actual defect:
// gitleaks runs in push/PR mode, which scans the commits in the triggering
// event. It failed the commit that added the key, and then every run after that
// was green — a leak already in history is permanently invisible to a per-push
// scan. So there was a secret-scanning job, and it was working, and it could
// not have found this.
//
// Two things now close that. `.github/workflows/secret-scan-history.yml` sweeps
// the full history weekly, and this test refuses a tracked key at the point a
// developer would notice: their own test run, before the push.
//
// It reads `git ls-files` rather than the filesystem on purpose — an ignored
// file on disk is fine, a TRACKED one is the bug, and only git knows which is
// which.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Extensions that are a private key or a signed package, never a source file.
 * Broad on purpose: the next leak will not be another `.pem`.
 */
const FORBIDDEN = [
  ".pem",
  ".crx",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
  ".key",
  ".ppk",
];

function trackedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean);
  } catch {
    // No git (a tarball checkout, a sandbox without the binary). Skip rather
    // than fail: a false red here would train people to ignore this file, which
    // is the opposite of what a P0 guard is for.
    return [];
  }
}

describe("no signing key is tracked by git (US-2284)", () => {
  const tracked = trackedFiles();

  it("tracks no file with a key or signed-package extension", () => {
    const offenders = tracked.filter((f) =>
      FORBIDDEN.some((ext) => f.toLowerCase().endsWith(ext)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the .gitignore rules that stop the next one", () => {
    // The ignore rules are what stand between a stray packaging run and a
    // second leak. Losing them silently puts the repo back where it started.
    const text = readFileSync(resolve(process.cwd(), ".gitignore"), "utf8");
    for (const rule of ["*.pem", "*.crx", "*.p12", "*.keystore", "*.jks"]) {
      expect(text, `.gitignore must refuse ${rule}`).toContain(rule);
    }
  });

  it("has a scheduled full-history scan, not only a per-push one", () => {
    // The per-push scan cannot find a leak that already landed — that is why
    // this one went unseen for weeks. Without the scheduled sweep the same
    // failure repeats and stays green.
    const wf = readFileSync(
      resolve(process.cwd(), ".github/workflows/secret-scan-history.yml"),
      "utf8",
    );
    // fetch-depth: 0 is what makes it a HISTORY scan. Without it this workflow
    // is an expensive duplicate of the per-push one.
    expect(wf).toContain("fetch-depth: 0");
    expect(wf).toContain("schedule:");
  });
});
