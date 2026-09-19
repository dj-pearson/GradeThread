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
 *
 * Down one the same day: 00793's entry came out when US-3387 REBUILT that
 * migration into the tree from the list its own guard already carried, so no
 * registry names that branch any more. This case fired on its first real use
 * and named the entry to delete, which is the shrink-only half working rather
 * than a nuisance. Rebuilding is not the same as pushing the branch: four are
 * still reachable from one machine only.
 */
export const KNOWN_ABSENT = new Map([
  ["held-v2/us-3397-00794", "00794, stop anon enumerating the storage buckets"],
  ["held-v2/us-3398-00795", "00795, the deletion log stops claiming a purge it never checked"],
  ["held-v2/us-3410-00798", "00798, COMMENTs recording five objects prod has and no migration builds"],
  ["held-v2/us-3312-00799", "00799, two brand_knowledge notes that are false in prod"],
]);

/**
 * Held branches that carry NO migration, which no registry can hold.
 *
 * THE BLIND SPOT, found 2026-09-18 while investigating US-3399. Both registries
 * above are keyed on a migration: the merge-order table has a version column,
 * and `KNOWN_GAPS` exists to explain a hole in the numbering. A branch holding
 * finished work and no SQL has nowhere to be named, so it can only appear in
 * PENDING_MIGRATIONS.md PROSE -- and prose is deliberately out of scope, for the
 * good reason in the `table-rows` comment above.
 *
 * So this guard was green while `held/us-3399-chart-order` (d3ec2de55, the
 * chart-ordering fix plus a `brand-knowledge-chart-order_test.ts` that exists
 * nowhere else) was exactly as lost as the four it tracks. `git cat-file -t
 * d3ec2de55` returns "Not a valid object name" in a fresh clone.
 *
 * MEASURED, because the noise question is the whole reason prose is out of
 * scope: PENDING_MIGRATIONS.md names 14 held branches, 4 in table rows and 10 in
 * prose only. NINE of the ten carry a five-digit migration number in the name --
 * `held/us-3387-00793` beside `held-v2/us-3387-00793`, `held/us-3256-00790`
 * beside `held-v2/us-3256-00797` -- i.e. the same story at successive
 * conventions and numbers, which is the narration the scoping exists to skip.
 * Exactly ONE has no number. So "no migration number in the name" is a precise
 * discriminator, not a heuristic: it finds the one branch that has no other
 * home and stays silent on the nine that do.
 *
 * Shrink-only in both directions, like KNOWN_ABSENT.
 */
export const KNOWN_ABSENT_UNNUMBERED = new Map([
  [
    "held/us-3399-chart-order",
    "US-3399's chart-ordering fix (d3ec2de55): the ORDER BY plus " +
      "brand-knowledge-chart-order_test.ts, which exists in no clone. " +
      "Unrecoverable -- the SHA is not an object here, so it must be rebuilt.",
  ],
]);

/** A five-digit migration number anywhere in the branch name. */
const NUMBERED_RE = /\b\d{5}\b/;

/**
 * Held branch names found ANYWHERE in the registries, prose included, that
 * carry no migration number.
 *
 * Reads the files unscoped on purpose. That is the opposite of `namedBranches`
 * and it is safe for exactly the reason measured above: dropping the numbered
 * names drops all the narration.
 */
export function unnumberedBranches(root = ROOT) {
  /** @type {Map<string, string[]>} */
  const found = new Map();
  for (const { file } of REGISTRIES) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8").replace(/~~[^~]*~~/g, "");
    for (const m of text.matchAll(BRANCH_RE)) {
      if (NUMBERED_RE.test(m[0])) continue;
      if (!found.has(m[0])) found.set(m[0], []);
      if (!found.get(m[0]).includes(file)) found.get(m[0]).push(file);
    }
  }
  return found;
}

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

  // The migration-less half, checked separately because it is found by a
  // different rule and its baseline is its own.
  const unnumbered = unnumberedBranches();
  const unnumberedMissing = missingBranches(unnumbered, onRemote);
  const unnumberedNames = new Set(unnumberedMissing.map((m) => m.branch));
  const freshUnnumbered = unnumberedMissing.filter(
    (m) => !KNOWN_ABSENT_UNNUMBERED.has(m.branch),
  );
  const clearedUnnumbered = [...KNOWN_ABSENT_UNNUMBERED.keys()].filter(
    (b) => !unnumberedNames.has(b),
  );

  if (
    fresh.length === 0 &&
    cleared.length === 0 &&
    freshUnnumbered.length === 0 &&
    clearedUnnumbered.length === 0
  ) {
    console.log(
      `[held-branches] ${named.size} named branch(es) on ${remote}; ` +
        `${KNOWN_ABSENT.size} still absent and baselined, no new ones — ok`,
    );
    console.log(
      `[held-branches] ${unnumbered.size} branch(es) carry no migration and so ` +
        `no registry can hold them; ${KNOWN_ABSENT_UNNUMBERED.size} absent and ` +
        `baselined — ok`,
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

  if (freshUnnumbered.length) {
    console.error(
      `[held-branches] ${freshUnnumbered.length} branch(es) carry NO migration, ` +
        `are named only in prose, and do NOT exist on ${remote}:`,
    );
    for (const { branch, files } of freshUnnumbered) {
      console.error(`  • ${branch}   (named in ${files.join(", ")})`);
    }
    console.error("");
    console.error(
      "  A held branch with no SQL has no registry: the merge-order table has a\n" +
        "  version column and KNOWN_GAPS explains a hole in the numbering, and\n" +
        "  this has neither. Nothing else will ever notice it is gone. Push it,\n" +
        "  or land the work, or stop naming it.",
    );
  }

  if (clearedUnnumbered.length) {
    console.error(
      `[held-branches] ${clearedUnnumbered.length} KNOWN_ABSENT_UNNUMBERED ` +
        `entr(y/ies) are no longer missing:`,
    );
    for (const b of clearedUnnumbered) console.error(`  • ${b}`);
    console.error("");
    console.error(
      "  Delete the entry in the same commit. Shrink-only, same as the list above.",
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
