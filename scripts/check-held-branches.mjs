#!/usr/bin/env node
// US-3421: a registry that names a branch nobody can fetch.
//
// PENDING_MIGRATIONS.md's "WHAT IS STILL WAITING FOR YOU" table and
// scripts/migrations-lint.mjs's KNOWN_GAPS both name `held-*` branches as the
// home of finished, unapplied migrations. Measured 2026-09-18 from a fresh
// clone: `git ls-remote --heads origin` returns 212 heads and NOT ONE matches
// `held-*`. Six finished migrations live on one machine.
//
// It stayed invisible because the two registries AGREE WITH EACH OTHER. Cross
// -checking them proves only that somebody copied the name twice; the remote is
// the only thing that knows whether the branch exists. So this asks the remote.
//
// THE HOLD RULE DOES NOT REQUIRE THE BRANCH TO BE LOCAL. What it protects is
// origin/MAIN: a migration reaching main auto-deploys the frontend, and the next
// edge deploy boot-guards a schema version prod does not have. Nothing deploys
// from a side branch. So pushing a held branch costs nothing the rule defends
// and buys durability, review, and the ability for any clone to land the
// migration once the owner has applied it.
//
// Usage:  node scripts/check-held-branches.mjs [--remote origin]
// Exit 0 = every named branch exists (or the remote could not be asked)
// Exit 1 = a registry names a branch the remote does not have

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Files that name a held branch, and what each one is for. A new registry goes
 * here; `src/test/held-branches.test.ts` fails if one of these stops containing
 * any reference at all, so the list cannot rot into a scan of nothing.
 */
export const REGISTRIES = [
  {
    file: "PENDING_MIGRATIONS.md",
    why: "the owner's merge-order table",
    // TABLE ROWS ONLY, and the scoping is what keeps this guard worth running.
    // This file also NARRATES branches: ones that were superseded, renamed or
    // deleted on purpose. Those are supposed to be absent from the remote, and
    // reporting them turns a 6-line finding into a 14-line one where most
    // entries are correct. A noisy guard is a guard somebody switches off.
    // A row in the merge-order table is a live claim that the branch is there.
    scope: "table-rows",
  },
  {
    file: "scripts/migrations-lint.mjs",
    why: "KNOWN_GAPS, which explains each hole in the numbering",
    // Every entry is a live claim by construction: the `filled` check makes the
    // branch delete its own entry when it lands, so an entry that still exists
    // is asserting that its branch still exists.
    scope: "whole-file",
  },
];

/**
 * The branches that are named and absent TODAY, each with what it holds.
 *
 * A BASELINE, NOT AN EXEMPTION, and shrink-only. Gating outright would redden
 * every push against a backlog only the owner can clear, which is how a guard
 * gets switched off (`check-ui-browser.mjs` carries the same reasoning in
 * src/test/guard-lane-parity.test.ts). Gating on GROWTH is what stops a sixth
 * from arriving quietly, which is the actual regression.
 *
 * Both directions are checked, so the list cannot rot: a name here that is no
 * longer missing -- because the branch was pushed, or because the registry
 * stopped naming it -- FAILS and must be deleted in the same commit.
 *
 * Measured 2026-09-18 (US-3421): `git ls-remote --heads origin` returned 212
 * heads and none matched `held-*`.
 */
export const KNOWN_ABSENT = new Map([
  ["held-v2/us-3387-00793", "00793, retire 23 size charts a rename orphaned"],
  ["held-v2/us-3397-00794", "00794, stop anon enumerating the storage buckets"],
  ["held-v2/us-3398-00795", "00795, the deletion log stops claiming a purge it never checked"],
  ["held-v2/us-3410-00798", "00798, COMMENTs recording five objects prod has and no migration builds"],
  ["held-v2/us-3312-00799", "00799, two brand_knowledge notes that are false in prod"],
]);

// `held/x`, `held-v2/x`, `held-v3/x`. Deliberately loose about the suffix: the
// convention has already gone from `held/` to `held-v2/` to `held-v3/` in a
// week, and a guard whose real trigger is a naming convention is a guard that
// fails the day someone bumps it.
const BRANCH_RE = /\bheld(?:-v\d+)?\/[A-Za-z0-9._-]+/g;

/** Every held branch named in a registry, with where each was found. */
export function namedBranches(root = ROOT) {
  /** @type {Map<string, string[]>} */
  const found = new Map();
  for (const { file } of REGISTRIES) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    let text = readFileSync(p, "utf8");
    if (REGISTRIES.find((r) => r.file === file)?.scope === "table-rows") {
      text = text
        .split("\n")
        .filter((l) => l.trimStart().startsWith("|"))
        .join("\n");
    }
    // A struck-through name is a record of what the row USED to say. Keeping it
    // readable is the point of the strikethrough; asking the remote for it is
    // not.
    text = text.replace(/~~[^~]*~~/g, "");
    for (const m of text.matchAll(BRANCH_RE)) {
      if (!found.has(m[0])) found.set(m[0], []);
      if (!found.get(m[0]).includes(file)) found.get(m[0]).push(file);
    }
  }
  return found;
}

/**
 * Branch names the remote actually has.
 * Returns null when the remote could not be asked at all, which is NOT the same
 * as "it has none" — the caller must not read a null as a clean result.
 */
export function remoteBranches(remote = "origin", root = ROOT) {
  const readRefs = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    return new Set(
      readRefs(["ls-remote", "--heads", remote])
        .split("\n")
        .map((l) => l.split("refs/heads/")[1])
        .filter(Boolean),
    );
  } catch {
    // No network, or no credential. Local remote-tracking refs are a weaker
    // answer (they are only as fresh as the last fetch, and a shallow clone may
    // hold few), so they are the fallback rather than the first choice.
    try {
      const local = readRefs([
        "for-each-ref",
        "--format=%(refname:lstrip=3)",
        `refs/remotes/${remote}`,
      ])
        .split("\n")
        .filter(Boolean);
      return local.length ? new Set(local) : null;
    } catch {
      return null;
    }
  }
}

export function missingBranches(named, onRemote) {
  return [...named.entries()]
    .filter(([b]) => !onRemote.has(b))
    .map(([branch, files]) => ({ branch, files }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const remoteIdx = process.argv.indexOf("--remote");
  const remote = remoteIdx === -1 ? "origin" : (process.argv[remoteIdx + 1] ?? "origin");

  const named = namedBranches();
  if (named.size === 0) {
    console.log("[held-branches] no held branch is named in any registry — ok");
    process.exit(0);
  }

  const onRemote = remoteBranches(remote);
  if (onRemote === null) {
    // SKIPPED, said out loud, the same way the Docker lanes skip. A guard that
    // prints a green line it did not earn is the failure this repo keeps
    // finding; so is one that fails every offline run until it is switched off.
    console.log(
      `[held-branches] SKIPPED: could not ask ${remote} and there are no ` +
        `remote-tracking refs. ${named.size} named branch(es) were NOT checked.`,
    );
    process.exit(0);
  }

  const missing = missingBranches(named, onRemote);
  const missingNames = new Set(missing.map((m) => m.branch));

  const fresh = missing.filter((m) => !KNOWN_ABSENT.has(m.branch));
  const cleared = [...KNOWN_ABSENT.keys()].filter((b) => !missingNames.has(b));

  if (fresh.length === 0 && cleared.length === 0) {
    const held = KNOWN_ABSENT.size;
    console.log(
      `[held-branches] ${named.size} named branch(es) on ${remote}; ` +
        `${held} still absent and baselined, no new ones — ok`,
    );
    process.exit(0);
  }

  if (fresh.length) {
    console.error(
      `[held-branches] ${fresh.length} branch(es) are named and do NOT exist on ${remote}:`,
    );
    for (const { branch, files } of fresh) {
      console.error(`  • ${branch}   (named in ${files.join(", ")})`);
    }
    console.error("");
    console.error(
      "  Work parked on a branch only one machine has is work one disk failure\n" +
        "  from being rewritten. Push the branch, or stop naming it: the hold\n" +
        "  rule protects origin/MAIN, which is what deploys, and a side branch\n" +
        "  is not a violation of it.",
    );
  }

  if (cleared.length) {
    console.error(
      `[held-branches] ${cleared.length} KNOWN_ABSENT entr(y/ies) are no longer missing:`,
    );
    for (const b of cleared) console.error(`  • ${b}`);
    console.error("");
    console.error(
      "  Either the branch was pushed or the registry stopped naming it. Good\n" +
        "  either way — delete the entry from KNOWN_ABSENT in the same commit.\n" +
        "  The list may only shrink, so a stale entry fails as loudly as a new gap.",
    );
  }
  process.exit(1);
}
