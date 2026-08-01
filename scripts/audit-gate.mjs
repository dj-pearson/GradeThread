#!/usr/bin/env node
// The blocking npm-audit gate for PRODUCTION (shipped) dependencies.
//
// `npm audit --omit=dev --audit-level=high` was run bare, which gave the gate
// exactly two settings: block on everything, or lower the threshold. There is
// no third state in npm itself — no ignore file, no per-advisory suppression —
// so a single high advisory with no non-breaking fix used to leave "downgrade
// a major", "rewrite the app" or "weaken the gate for every dependency at
// once" as the only moves. The last one is the tempting one, and it is the one
// that quietly stops catching the next real advisory.
//
// This wrapper adds the missing state: the threshold stays at HIGH for every
// dependency, and named advisories can be accepted ONE AT A TIME, in writing,
// with an expiry date. The written record IS the allowlist — the accepted rows
// in .github/SECURITY_ADVISORY_ALLOWLIST.md are parsed straight out of the
// markdown table, so an entry cannot exist in CI without existing in the
// document a reviewer reads. Same shape as scripts/runbook-sync.mjs.
//
// Two properties are the point:
//
//   - An acceptance EXPIRES. Past its "Re-check by" date the advisory blocks
//     again, so nothing can be accepted permanently by forgetting about it.
//   - An acceptance is SPECIFIC. It names one advisory id; every other high or
//     critical finding, in that same package or any other, still fails.
//
// Anything this script reports that is NOT in the table is a real finding:
// upgrade the dependency. Do not add a row to make a build pass — a row is a
// claim that the advisory cannot affect this app, and it has to be true.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWLIST_FILE = ".github/SECURITY_ADVISORY_ALLOWLIST.md";

/** Severities this gate blocks on. Mirrors `--audit-level=high`. */
export const BLOCKING = new Set(["high", "critical"]);

/**
 * Pull the accepted advisories out of the allowlist markdown table.
 *
 * A row is `| GHSA-… | package | severity | why | YYYY-MM-DD |`. Only rows whose
 * first cell contains an advisory id and whose last cell is a date count — the
 * header, the separator and any prose row are ignored rather than guessed at,
 * so a malformed row fails closed (the advisory keeps blocking) instead of
 * silently accepting something.
 */
export function parseAllowlist(markdown) {
  const out = [];
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    const id = /\b(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d+)\b/i.exec(cells[0] ?? "")?.[1];
    const recheck = /^\d{4}-\d{2}-\d{2}$/.exec(cells[4] ?? "")?.[0];
    if (!id || !recheck) continue;
    out.push({ id: id.toUpperCase(), package: cells[1] ?? "", recheckBy: recheck });
  }
  return out;
}

/**
 * Flatten `npm audit --json` into one entry per distinct advisory.
 *
 * The `via` chain carries the advisory objects; a transitive vulnerability
 * repeats its parent's advisory by name (a plain string), which is why only
 * object entries are read. Dedupe by advisory id: one advisory reaching the
 * tree through two packages is one thing to fix, not two.
 */
export function collectAdvisories(auditJson) {
  const byId = new Map();
  for (const vuln of Object.values(auditJson?.vulnerabilities ?? {})) {
    for (const via of vuln?.via ?? []) {
      if (!via || typeof via !== "object") continue;
      const id = /\b(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d+)\b/i
        .exec(via.url ?? "")?.[1]?.toUpperCase() ?? `SOURCE-${via.source}`;
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        package: via.name ?? vuln.name ?? "",
        severity: String(via.severity ?? "").toLowerCase(),
        title: via.title ?? "",
        url: via.url ?? "",
      });
    }
  }
  return [...byId.values()];
}

/**
 * Decide the gate. Returns the blocking findings and the accepted ones, so the
 * caller can print BOTH — an accepted advisory that is never mentioned again is
 * how an acceptance turns into an assumption.
 */
export function evaluate(advisories, allowed, today) {
  const byId = new Map(allowed.map((a) => [a.id, a]));
  const blocking = [];
  const accepted = [];
  for (const adv of advisories) {
    if (!BLOCKING.has(adv.severity)) continue;
    const entry = byId.get(adv.id);
    if (!entry) {
      blocking.push({ ...adv, reason: "not in the allowlist" });
    } else if (entry.recheckBy < today) {
      blocking.push({ ...adv, reason: `acceptance expired ${entry.recheckBy} — re-review it` });
    } else {
      accepted.push({ ...adv, recheckBy: entry.recheckBy });
    }
  }
  return { blocking, accepted };
}

export function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // `npm audit` exits non-zero WHENEVER it finds anything at or above the
  // level, so its status is not the signal here — the parsed report is.
  const run = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    process.stdout.write("  ✗ audit-gate: could not parse `npm audit --json` output\n");
    process.stdout.write((run.stderr || run.stdout || "").slice(0, 2000) + "\n");
    return 1;
  }

  const allowed = parseAllowlist(readFileSync(resolve(root, ALLOWLIST_FILE), "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const { blocking, accepted } = evaluate(collectAdvisories(report), allowed, today);

  for (const a of accepted) {
    process.stdout.write(`  ! accepted: ${a.id} (${a.package}, ${a.severity}) — re-check by ${a.recheckBy}\n`);
  }
  for (const b of blocking) {
    process.stdout.write(`  ✗ ${b.id} (${b.package}, ${b.severity}): ${b.title}\n`);
    process.stdout.write(`      ${b.reason}. ${b.url}\n`);
  }
  process.stdout.write(
    blocking.length
      ? `  ✗ audit-gate: ${blocking.length} unaccepted high/critical advisory(ies) in production deps. ` +
        `Upgrade the dependency, or accept it in writing in ${ALLOWLIST_FILE}.\n`
      : `  ✓ audit-gate: no unaccepted high/critical advisories in production deps` +
        `${accepted.length ? ` (${accepted.length} accepted, all unexpired)` : ""}\n`,
  );
  return blocking.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
