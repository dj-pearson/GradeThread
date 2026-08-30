#!/usr/bin/env node
// US-2444 AC4 + AC5 — the migrations lint. Four structural checks on
// supabase/migrations/ that need nothing but the filesystem and git: no Docker,
// no Postgres, no network. Everything expensive about migrations already has a
// gate (db-migrations.yml applies them, the boot manifest checks they recorded
// themselves); what had NO gate was the shape of the directory itself.
//
// WHY THIS EXISTS. supabase/migrations/00122_verified_storefront_listings.sql was
// named on a .gitignore line and never committed. It is not missing by accident:
// 00121 and 00123 are both present, and the ignore line landed in the same commit
// that shipped the storefront feature. So the DDL for a live feature was applied
// to prod by hand and deliberately kept out of the repo — and every guard we own
// stayed green, because each was asking a different question:
//   • db-migrations.yml proves the files present apply cleanly. A file that is
//     not there applies cleanly by not existing.
//   • the boot manifest (US-2009) starts at 00254, so it cannot see 00122.
//   • check-tracked-ignored.mjs (US-2437) catches TRACKED + ignored. This file
//     was UNTRACKED + ignored, which is the opposite state and invisible to it.
// Nothing was looking at the sequence, and nothing was looking at whether an
// ignore rule could reach this directory. Both are one function each.
//
// The consequence is quiet and bad: verify:db and the db-migrations lane exist to
// prove migrations apply to a FRESH schema, and they were proving it against a
// schema production does not have. Nobody finds out until a restore, a new
// environment, or a migration that assumes 00122's objects exist.
//
// Run: node scripts/migrations-lint.mjs

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(root, "supabase", "migrations");

export const MIG_PREFIX = "supabase/migrations";

/**
 * The three 6-digit filenames are CORRECT and must stay. Commit e4a44545: three
 * pairs of migrations shared a numeric prefix (00035, 00037, 00038), and the
 * Supabase CLI keys schema_migrations on that prefix — so a fresh `db start`
 * died on "duplicate key ... schema_migrations_pkey". One file per pair was
 * renamed to a 6-digit version that STILL SORTS INTO THE SAME SLOT ("000355"
 * lands between "00035" and "00036" lexically), so apply order is unchanged.
 *
 * That is why the shape rule allows 5 OR 6 digits but pins the 6-digit set: the
 * form is a collision fix, not a numbering style, and a new one would mean the
 * collision happened again. All three are below the 00254 footer era, so their
 * absence from the boot manifest (which filters to 5 digits) costs nothing.
 */
export const SIX_DIGIT_BY_DESIGN = new Set([
  "000355_photo_types_v2.sql",
  "000375_push_device_tokens.sql",
  "000385_feedback_messages.sql",
]);

/**
 * Numbers with no .sql file, each with the reason it is empty. A gap is NOT
 * automatically a bug — authors skip numbers — so this list is what turns the
 * check from noise into signal: a NEW gap is unexplained by definition, and an
 * entry that gets filled must leave the list. It may only shrink.
 */
export const KNOWN_GAPS = new Map([
  ["00011", "never authored — no file in any commit (`git log --all` empty)."],
  ["00014", "never authored — no file in any commit."],
  ["00479", "never authored — no file in any commit."],
  [
    "00689",
    "never authored — two agents working the same tree on 2026-08-29 both "
      + "claimed it within a few minutes (US-3007 inventory write-offs and "
      + "US-2987 facilitator sales tax). Both renamed away rather than one "
      + "overwriting the other, to 00690 and 00691, so the number was used by "
      + "nobody. Renumbering either one back would only move the hole.",
  ],
  [
    "00636",
    "authored, APPLIED to production, then withdrawn. 00636/00637 created a " +
      "lulufanatics.com crawler; the owner had it removed because that site's " +
      "terms prohibit scrapers. 00638 drops what they built AND deletes their " +
      "applied_migrations rows, so the applied set matches the shipped set and " +
      "neither is a phantom. The numbers are technically free again — nothing " +
      "would read 'applied' off a stale row — but they stay skipped because " +
      "reusing them would confuse anyone reading this history.",
  ],
  [
    "00637",
    "the second half of the withdrawn lulufanatics crawler — see 00636.",
  ],
  [
    "00527",
    "held on purpose: 00527_revoke_public_function_execute.sql.BLOCKED. The " +
      "suffix is the safety mechanism (US-2403 — a denied function call " +
      "segfaults the Supabase Postgres image), not an oversight.",
  ],
]);

export const SHAPE = /^(\d{5,6})_[a-z0-9_]+\.sql(\.BLOCKED)?$/;

/** Version = the digits the Supabase CLI keys schema_migrations on. */
export const versionOf = (file) => file.slice(0, file.indexOf("_"));

// ── 1. No ignore rule may reach this directory ───────────────────────────────
// Two halves, because they catch different mistakes. `git check-ignore` answers
// for paths; the 00122 line named a file that does not exist, so no probe over
// the directory could ever have found it. Reading the ignore FILES for the
// literal path is the only thing that sees a rule written against a future name.

/** Paths git would ignore. Pure w.r.t. its inputs; needs a repo. */
export function ignoredPaths(paths, cwd = root) {
  if (paths.length === 0) return [];
  try {
    // --no-index is load-bearing. By default `git check-ignore` reports nothing
    // for a TRACKED path, on the reasoning that tracking wins — so a rule added
    // over the existing migrations would read as clean here and the guard would
    // pass while the rule sat there waiting for the next fresh clone.
    const out = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd,
      input: paths.join("\n"),
      encoding: "utf8",
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    // git check-ignore exits 1 when NOTHING matches. That is the good case.
    if (err.status === 1) return [];
    throw err;
  }
}

/**
 * Rules in an ignore file that can reach a migration.
 * `nested` = the file lives inside supabase/migrations/, where a rule needs no
 * path prefix to reach one, so ANY rule is a hit. Repo-level files are matched
 * on the literal path instead, to keep the check off unrelated lines.
 */
export function ignoreRulesNamingMigrations(text, { nested = false } = {}) {
  return text
    .split("\n")
    .map((t, i) => ({ line: i + 1, text: t.trim() }))
    .filter((l) =>
      l.text && !l.text.startsWith("#") &&
      (nested || l.text.includes(MIG_PREFIX))
    );
}

// ── 2. Filename shape ────────────────────────────────────────────────────────
export function shapeFailures(entries) {
  const out = [];
  for (const f of entries) {
    if (f.startsWith(".")) continue;
    const m = SHAPE.exec(f);
    if (!m) {
      out.push({ file: f, kind: "malformed" });
      continue;
    }
    if (m[1].length === 6 && !SIX_DIGIT_BY_DESIGN.has(f)) {
      out.push({ file: f, kind: "unpinned-six-digit" });
    }
  }
  for (const f of SIX_DIGIT_BY_DESIGN) {
    if (!entries.includes(f)) out.push({ file: f, kind: "pinned-but-absent" });
  }
  return out;
}

// ── 3. No two migrations claim the same version ──────────────────────────────
// This is the failure e4a44545 fixed by hand: schema_migrations is keyed on the
// prefix, so a duplicate takes out `supabase db start` and `db reset` for
// everyone, with an error that names a Postgres constraint rather than a file.
export function duplicateVersions(sqlFiles) {
  const byVersion = new Map();
  for (const f of sqlFiles) {
    const v = versionOf(f);
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(f);
  }
  return [...byVersion.entries()].filter(([, files]) => files.length > 1);
}

// ── 4. Sequence gaps ─────────────────────────────────────────────────────────
export function gapReport(sqlFiles) {
  const nums = [...new Set(sqlFiles.map(versionOf))]
    .filter((v) => /^\d{5}$/.test(v))
    .map(Number)
    .sort((a, b) => a - b);
  const present = new Set(nums);
  const gaps = [];
  for (let n = nums[0]; n <= nums[nums.length - 1]; n++) {
    if (!present.has(n)) gaps.push(String(n).padStart(5, "0"));
  }
  return {
    gaps,
    unexplained: gaps.filter((g) => !KNOWN_GAPS.has(g)),
    filled: [...KNOWN_GAPS.keys()].filter((g) => !gaps.includes(g)),
  };
}

// ── 5. A revoke that revokes nothing (US-2666) ───────────────────────────────
//
// `CREATE FUNCTION` grants EXECUTE to PUBLIC, and every role is implicitly a
// member of PUBLIC. So `REVOKE ALL ON FUNCTION f() FROM anon` removes a grant
// anon never held on its own and leaves the one it actually executes through.
// The function stays callable by anyone holding the public anon key.
//
// PROVEN, not reasoned: three probe functions in a rolled-back transaction —
// untouched, revoked-from-anon, and revoked-from-anon-and-public — answered
// has_function_privilege('anon', …) TRUE, TRUE, FALSE. And production returns
// HTTP 200 to an anon POST on flipdesk_overview_metrics, whose migration has
// revoked it from anon since the day it was written.
//
// It has to be caught at authoring time because there is no other moment it can
// be caught: the REVOKE is valid SQL, it succeeds, psql prints REVOKE, and the
// migration applies green. 13 files reached for this pattern and 6 of them
// secured nothing for up to three years.
//
// The working form is in 00216_credit_ledger_admin.sql:143 — `FROM PUBLIC,
// anon, authenticated`.
export const REVOKE_ON_FUNCTION =
  /revoke\s+[a-z\s]*\bon\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\([^)]*\)\s*from\s+([a-z_,\s]+)/gi;

/**
 * The no-ops that already shipped. Applied migrations are IMMUTABLE, so these
 * cannot be edited — they are fixed forward by a new migration under US-2666.
 * Grandfathered by exact file+function so a NEW one in the same file still
 * fails, and listed with what each leaves reachable.
 */
export const INEFFECTIVE_REVOKE_GRANDFATHERED = new Map([
  ["00097_integrity_constraints.sql:data_integrity_scan", "admin integrity scan"],
  ["00099_snap_quota.sql:reserve_snap", "MUTATES a user's Snap quota"],
  ["00099_snap_quota.sql:refund_snap", "MUTATES a user's Snap quota"],
  ["00170_north_star_gamification.sql:north_star_weekly_counts", "aggregate counters"],
  ["00170_north_star_gamification.sql:north_star_lifetime_counts", "aggregate counters"],
  ["00594_flipdesk_overview_metrics.sql:flipdesk_overview_metrics", "a seller's whole P&L"],
]);

/**
 * Functions whose revokes, taken TOGETHER within one file, never name PUBLIC.
 *
 * Grouped rather than per-statement, and that is not a detail: several files
 * write the roles as separate statements — `from public;` then `from anon;` —
 * which is correct and which a per-statement check flags twice. The first
 * version of this rule did exactly that and reported 14 where there are 6.
 *
 * The unit is the FILE because a migration should be self-contained; a genuine
 * fix-forward lands in a later file and names PUBLIC, so it clears itself.
 *
 * Returns `{ key, file, fn, roles }`, key being the grandfather key.
 */
export function ineffectiveRevokes(sqlFiles, read) {
  const hits = [];
  for (const file of sqlFiles) {
    const sql = read(file);
    const byFn = new Map();
    for (const m of sql.matchAll(REVOKE_ON_FUNCTION)) {
      const [, fn, rolesRaw] = m;
      const roles = rolesRaw.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
      const seen = byFn.get(fn) ?? new Set();
      for (const r of roles) seen.add(r);
      byFn.set(fn, seen);
    }
    for (const [fn, roles] of byFn) {
      if (roles.has("public")) continue;
      hits.push({ key: `${file}:${fn}`, file, fn, roles: [...roles] });
    }
  }
  return hits;
}

// ── US-2837: "safe to run twice" is a rule nothing was checking ──────────────
//
// US-1108 rule 1 requires every migration to be idempotent. Nothing enforced it,
// and the enforcement gap is the same one behind US-2832: a migration that
// cannot be re-applied is a migration that can only ever be fixed by hand, and a
// hand fix leaves no applied_migrations row for an audit to find.
//
// scripts/apply-prod-migrations.sh does NOT protect you from this. It skips
// every file at or below the highest recorded version, so it is a poor test of
// re-runnability and, more importantly, it will never re-apply a hole BELOW the
// maximum. That skip is by MAXIMUM, not by membership, and it is exactly how
// 00134 stayed missing in production for months while every version above it
// was recorded (US-2726, US-2832).
//
// THREE FORMS ARE CHECKED, and only the first is a hard zero:
//
//   CREATE FUNCTION      -> must be CREATE OR REPLACE FUNCTION. Zero tolerance,
//                           no grandfather list, because after 00609 was fixed
//                           there are none left in 658 files. A dropped-then-
//                           created function is still fine, and often required
//                           when the argument list changes: the DROP removes the
//                           OLD signature, the OR REPLACE handles the new one on
//                           a second run. 00609 is the worked example.
//   CREATE TRIGGER       -> needs DROP TRIGGER IF EXISTS on the same name
//                           earlier in the same file. CREATE OR REPLACE TRIGGER
//                           (PG14+) is accepted and does not match this rule.
//   CREATE POLICY        -> needs DROP POLICY IF EXISTS on the same name.
//                           Postgres has no CREATE OR REPLACE POLICY, so a
//                           pg_policies existence guard is accepted instead.
//
// ⚠ THE THRESHOLD IS NOT A KNOB. Raising it silences the finding instead of
// fixing it, exactly as US-2059's 00478 threshold warns for the same reason. It
// is set to the HIGHEST FILE THAT ALREADY VIOLATED when the rule landed, which
// makes it a description of history rather than a budget: every one of the 367
// migrations from 00292 to 00661 already complies, with no exceptions. The
// practice self-corrected long ago; this only stops it drifting back.
//
// The 48 triggers and 251 policies below the threshold are NOT to be fixed.
// Retro-editing 299 statements across 61 applied migrations is a far larger risk
// than the one it removes, and applied migrations are immutable for good reason
// (US-2059). Their counts are asserted so the historical set can only shrink.
//
// ⚠ THE COMPARISON IS LEXICAL, NOT NUMERIC, and that is not a style choice. The
// three SIX_DIGIT_BY_DESIGN files exist to sort INTO an existing slot: 000375
// belongs between 00037 and 00038, which is where lexical order puts it and
// where the Supabase CLI and the boot guard both read it. Parsed as an integer
// it reads 375, which is past this threshold, so a numeric compare declares two
// of the oldest migrations in the repo to be new violations and drops them out
// of the grandfathered counts at the same time. The first cut did exactly that
// and reported 12 failures for one mistake.
export const IDEMPOTENT_GRANDFATHERED_THROUGH = "00291";
export const GRANDFATHERED_UNGUARDED_TRIGGERS = 48;
export const GRANDFATHERED_UNGUARDED_POLICIES = 251;

/** Comments must go before matching, or a rule's own documentation satisfies it. */
export function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every create in `sqlFiles` that cannot survive a second run.
 *
 * Returns `{ file, version, kind, name }`. `kind` is "function" | "trigger" |
 * "policy"; `version` is the filename prefix AS A STRING, because the
 * grandfather comparison is lexical (see the block above).
 */
export function unguardedCreates(sqlFiles, read) {
  const hits = [];
  for (const file of sqlFiles) {
    const sql = stripSqlComments(read(file));
    const version = versionOf(file);
    const add = (kind, name) => hits.push({ file, version, kind, name });

    // `create or replace function` does not match: "or replace" sits between.
    for (const m of sql.matchAll(/create\s+function\s+(?:public\.)?"?([a-z0-9_]+)"?/gi)) {
      add("function", m[1]);
    }

    for (const m of sql.matchAll(/create\s+(?:constraint\s+)?trigger\s+"?([a-z0-9_]+)"?/gi)) {
      const name = escapeRe(m[1].toLowerCase());
      if (!new RegExp(`drop\\s+trigger\\s+if\\s+exists\\s+"?${name}"?`, "i").test(sql)) {
        add("trigger", m[1]);
      }
    }

    for (const m of sql.matchAll(/create\s+policy\s+(?:"([^"]+)"|([a-z0-9_]+))/gi)) {
      const raw = m[1] ?? m[2];
      const name = escapeRe(raw);
      const dropped = new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+"?${name}"?`, "i").test(sql);
      // The other legitimate form: an existence guard against pg_policies. There
      // is no CREATE OR REPLACE POLICY, so this is a real alternative rather
      // than an escape hatch, and it must name THIS policy to count.
      const guarded =
        /pg_policies/i.test(sql) && new RegExp(`pg_policies[\\s\\S]{0,400}?${name}`, "i").test(sql);
      if (!dropped && !guarded) add("policy", raw);
    }
  }
  return hits;
}

// ── Runner ───────────────────────────────────────────────────────────────────
export function lint() {
  const failures = [];
  const fail = (m) => failures.push(m);

  const entries = readdirSync(MIG_DIR).sort();
  const sqlFiles = entries.filter((f) => f.endsWith(".sql"));

  const ignored = ignoredPaths([
    ...entries.map((f) => `${MIG_PREFIX}/${f}`),
    `${MIG_PREFIX}/00999_probe_future_migration.sql`,
    `${MIG_PREFIX}/00999_probe_future_migration.sql.BLOCKED`,
  ]);
  if (ignored.length > 0) {
    fail(
      `${ignored.length} path(s) under ${MIG_PREFIX}/ are gitignored. A migration ` +
        `that git refuses to see is a migration that only exists on one machine:\n` +
        ignored.map((p) => `    ${p}`).join("\n") +
        `\n  Delete the ignore rule. If the file genuinely must not be committed ` +
        `(a secret, an environment-specific value, a destructive one-off), the ` +
        `answer is a sanitised replacement that IS committed, with the reason in ` +
        `the file — not an invisible hole in the sequence.`,
    );
  }

  for (const [ignoreFile, nested] of [
    [".gitignore", false],
    [".git/info/exclude", false],
    [`${MIG_PREFIX}/.gitignore`, true],
  ]) {
    let text;
    try {
      text = readFileSync(join(root, ignoreFile), "utf8");
    } catch {
      continue;
    }
    for (const h of ignoreRulesNamingMigrations(text, { nested })) {
      fail(
        `${ignoreFile}:${h.line} names a migrations path: "${h.text}"\n` +
          `  Reading the ignore FILES is a separate check from testing the paths, ` +
          `and it is the half that found 00122: a rule written against a filename ` +
          `that does not exist yet matches nothing on disk, so no scan of the ` +
          `directory can ever see it. Remove the rule.`,
      );
    }
  }

  for (const { file, kind } of shapeFailures(entries)) {
    if (kind === "malformed") {
      fail(
        `${MIG_PREFIX}/${file} does not match NNNNN_snake_case_name.sql — the ` +
          `Supabase CLI derives the schema_migrations version from the digits ` +
          `before the first underscore, and lexical filename order IS apply order.`,
      );
    } else if (kind === "unpinned-six-digit") {
      fail(
        `${MIG_PREFIX}/${file} uses a 6-digit prefix. That form exists solely to ` +
          `resolve a duplicate-number collision (commit e4a44545) and the three ` +
          `files using it are pinned in SIX_DIGIT_BY_DESIGN. A new one means two ` +
          `migrations claimed the same number again — fix the collision, then add ` +
          `the file here with the pair it split.`,
      );
    } else {
      fail(
        `SIX_DIGIT_BY_DESIGN lists ${file}, which no longer exists. If it was ` +
          `renamed back to 5 digits, confirm the collision it was splitting is ` +
          `gone first — the collision broke \`supabase db start\` outright.`,
      );
    }
  }

  for (const [v, files] of duplicateVersions(sqlFiles)) {
    fail(
      `${files.length} migrations share version ${v}: ${files.join(", ")}\n` +
        `  supabase db start/reset will fail on "duplicate key value violates ` +
        `unique constraint schema_migrations_pkey". Rename the LESS depended-on ` +
        `file to a 6-digit version that sorts into the same slot (e.g. ${v} -> ` +
        `${v}5) so apply order is preserved, and record it in ` +
        `SIX_DIGIT_BY_DESIGN.`,
    );
  }

  const { unexplained, filled } = gapReport(sqlFiles);
  if (unexplained.length > 0) {
    fail(
      `${unexplained.length} unexplained gap(s) in the migration sequence: ` +
        `${unexplained.join(", ")}\n` +
        `  A skipped number is usually harmless and sometimes means a migration ` +
        `was lost (US-2444). Establish which, then add it to KNOWN_GAPS with the ` +
        `reason — an unannotated gap is indistinguishable from a hole.`,
    );
  }
  if (filled.length > 0) {
    fail(
      `${filled.length} entr(y/ies) in KNOWN_GAPS now have a migration: ` +
        `${filled.join(", ")}\n` +
        `  Good — remove them from scripts/migrations-lint.mjs. The list may only ` +
        `shrink, so a stale entry fails as loudly as a new gap.`,
    );
  }

  const revokes = ineffectiveRevokes(sqlFiles, (f) => readFileSync(join(MIG_DIR, f), "utf8"));
  const newNoOps = revokes.filter((r) => !INEFFECTIVE_REVOKE_GRANDFATHERED.has(r.key));
  for (const r of newNoOps) {
    fail(
      `${MIG_PREFIX}/${r.file}: \`revoke … on function ${r.fn}(…) from ` +
        `${r.roles.join(", ")}\` does not deny ${r.roles.join(" or ")}.\n` +
        `  CREATE FUNCTION grants EXECUTE to PUBLIC and every role belongs to ` +
        `PUBLIC, so revoking a role by name leaves the grant it actually uses. ` +
        `The function stays callable by anyone holding the public anon key, the ` +
        `SQL succeeds, and the migration applies green — which is why this has ` +
        `to fail here rather than anywhere later.\n` +
        `  \`FROM PUBLIC, ${r.roles.join(", ")}\` is the form that works ` +
        `(00216_credit_ledger_admin.sql:143). But before writing it, read the ` +
        `two things that make a revoke here more expensive than it looks:\n` +
        `    • A DENIED call from anon or authenticated SEGFAULTS this Postgres ` +
        `image (US-2403), so a revoke on anything reachable with the public anon ` +
        `key hands out a restart button. That is why 00527 is a DO NOT APPLY.\n` +
        `    • Revoking from PUBLIC also strips service_role unless you grant it ` +
        `back explicitly — most functions here hold EXECUTE only through the ` +
        `PUBLIC default, so the revoke takes out the edge along with the attacker ` +
        `(proven on reserve_snap: service_role goes t → f → t across ` +
        `revoke-then-grant).\n` +
        `  The remedy this repo has settled on is an authorization check in the ` +
        `function BODY, the way admin_revenue_metrics does it — it revokes ` +
        `nothing, so it never arms either problem.`,
    );
  }
  const fixedNoOps = [...INEFFECTIVE_REVOKE_GRANDFATHERED.keys()].filter(
    (k) => !revokes.some((r) => r.key === k),
  );
  if (fixedNoOps.length > 0) {
    fail(
      `${fixedNoOps.length} INEFFECTIVE_REVOKE_GRANDFATHERED entr(y/ies) no longer ` +
        `match: ${fixedNoOps.join(", ")}\n` +
        `  The list may only shrink, so remove them. But check WHY they stopped ` +
        `matching first: an applied migration is immutable, so the honest reason ` +
        `is that a later migration fixed the grant — not that this file changed.`,
    );
  }

  // US-2837: idempotency. See the block above unguardedCreates for why the
  // threshold is a description of history and not a budget.
  const unguarded = unguardedCreates(sqlFiles, (f) => readFileSync(join(MIG_DIR, f), "utf8"));

  for (const h of unguarded.filter((x) => x.kind === "function")) {
    fail(
      `${MIG_PREFIX}/${h.file}: \`CREATE FUNCTION ${h.name}\` is not ` +
        `\`CREATE OR REPLACE FUNCTION\`.\n` +
        `  US-1108 rule 1 requires every migration to be safe to run twice, and ` +
        `this one is not: the second run raises "function ${h.name} already ` +
        `exists with same argument types" and aborts everything after it.\n` +
        `  If you dropped the function first because the ARGUMENT LIST changed, ` +
        `keep the drop and still write OR REPLACE. The two answer different ` +
        `questions: the DROP removes the old signature so an existing call is ` +
        `never ambiguous, and the OR REPLACE handles the second run, where the ` +
        `drop matches nothing because the old signature is already gone. ` +
        `00609_appstore_transaction_environment.sql is the worked example.\n` +
        `  There is no grandfather list for this one. 00609 was the only ` +
        `instance in 658 files and it is fixed, so the correct count is zero.`,
    );
  }

  for (const h of unguarded.filter((x) => x.kind !== "function")) {
    if (h.version <= IDEMPOTENT_GRANDFATHERED_THROUGH) continue;
    const drop =
      h.kind === "trigger"
        ? `DROP TRIGGER IF EXISTS ${h.name} ON <table>;`
        : `DROP POLICY IF EXISTS "${h.name}" ON <table>;`;
    fail(
      `${MIG_PREFIX}/${h.file}: \`CREATE ${h.kind.toUpperCase()} ${h.name}\` has ` +
        `no matching DROP ... IF EXISTS earlier in the same file.\n` +
        `  A second run raises 42710 and aborts. Add \`${drop}\` immediately ` +
        `before the create.\n` +
        (h.kind === "trigger"
          ? `  CREATE OR REPLACE TRIGGER (PG14+) is also accepted.\n`
          : `  An IF NOT EXISTS guard against pg_policies naming this policy is ` +
            `also accepted, since Postgres has no CREATE OR REPLACE POLICY.\n`) +
        `  Do NOT raise IDEMPOTENT_GRANDFATHERED_THROUGH to make this pass. It ` +
        `is set to ${IDEMPOTENT_GRANDFATHERED_THROUGH}, the highest file that ` +
        `already violated when the rule landed, and every migration since then ` +
        `complies. Raising it silences the finding instead of fixing it.`,
    );
  }

  const oldTriggers = unguarded.filter(
    (h) => h.kind === "trigger" && h.version <= IDEMPOTENT_GRANDFATHERED_THROUGH,
  ).length;
  const oldPolicies = unguarded.filter(
    (h) => h.kind === "policy" && h.version <= IDEMPOTENT_GRANDFATHERED_THROUGH,
  ).length;
  for (const [what, constant, got, want] of [
    ["trigger", "GRANDFATHERED_UNGUARDED_TRIGGERS", oldTriggers, GRANDFATHERED_UNGUARDED_TRIGGERS],
    ["policy", "GRANDFATHERED_UNGUARDED_POLICIES", oldPolicies, GRANDFATHERED_UNGUARDED_POLICIES],
  ]) {
    if (got === want) continue;
    fail(
      `the grandfathered unguarded-${what} count is ${got}, not ${want}.\n` +
        (got < want
          ? `  Fewer is good, and the number may only fall: lower ` +
            `${constant} to ${got}. Check WHY ` +
            `it fell first, though. An applied migration is immutable, so the ` +
            `honest reason is a later migration replacing the object, not an ` +
            `edit to a shipped file.`
          : `  It went UP, which the threshold cannot explain: these are all at ` +
            `or below ${IDEMPOTENT_GRANDFATHERED_THROUGH}, and files that old do ` +
            `not gain statements. Something edited a migration that has already ` +
            `been applied to production.`),
    );
  }

  return { failures, count: sqlFiles.length };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrations-lint.mjs")) {
  const { failures, count } = lint();
  if (failures.length > 0) {
    console.error("");
    for (const f of failures) console.error(`✗ ${f}\n`);
    console.error(`${failures.length} migrations-lint failure(s).`);
    process.exit(1);
  }
  console.log(
    `✓ migrations lint: ${count} migrations, no ignored paths, no duplicate ` +
      `versions, ${KNOWN_GAPS.size} annotated gap(s)`,
  );
}
