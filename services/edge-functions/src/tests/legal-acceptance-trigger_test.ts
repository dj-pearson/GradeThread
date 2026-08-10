// handle_new_user() is redefined by seven migrations, and CREATE OR REPLACE
// gives no warning when a new body drops what an earlier one added.
//
// That is not hypothetical. 00142 taught the trigger to record an email
// signup's clickwrap — users.tos_accepted_version and an append-only
// legal_acceptances row with method 'signup_clickwrap'. 00303 replaced the
// function to add use_case and simply did not carry the block forward; 00379 and
// 00401 rebased on the truncated body, 00401 stating in its own header that the
// body was "identical to 00379". Nothing failed. The columns are nullable, no
// test exercised the trigger's SQL, and POST /api/legal/confirm-signup went on
// refusing every caller — correctly, for a row that no longer existed — while
// its module and 00573's column comment both described it working.
//
// So these read the SQL. The `db` verify lane proves migrations APPLY to a fresh
// schema; it does not sign up a user, and a running GoTrue is what it would take
// to fire this trigger. Reading the last definition is the strongest check
// available from a checkout, and it is the one that would have caught 00303.

import { assert, assertEquals } from "@std/assert";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

// legal-versions.ts is read as SOURCE rather than imported: it pulls in
// lib/supabase.ts, which throws at module load without SUPABASE_URL. Parsing is
// also what the sort-order assertion below needs anyway — the ordering rule is
// code, not a value.
const LEGAL_VERSIONS_SRC = await Deno.readTextFile(
  new URL("../lib/legal-versions.ts", import.meta.url),
);

function fallbackConstant(name: string): string {
  const found = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(LEGAL_VERSIONS_SRC)?.[1];
  assert(found, `${name} not found in legal-versions.ts — renamed?`);
  return found;
}

const FALLBACK_TOS_VERSION = fallbackConstant("FALLBACK_TOS_VERSION");
const FALLBACK_PRIVACY_VERSION = fallbackConstant("FALLBACK_PRIVACY_VERSION");

const DEFINITION = /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.handle_new_user\s*\(/i;

/** Every migration that (re)defines the trigger, in apply order. */
async function definitions(): Promise<Array<{ file: string; sql: string }>> {
  const out: Array<{ file: string; sql: string }> = [];
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(entry.name, MIGRATIONS));
    if (DEFINITION.test(sql)) out.push({ file: entry.name, sql });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/**
 * The definition that actually runs: the last CREATE OR REPLACE wins.
 *
 * `body` starts at the CREATE and therefore EXCLUDES the file header. Every
 * assertion below reads `body`, never `sql` — a migration header that explains
 * what the function does mentions all the same identifiers, so matching the
 * whole file lets prose stand in for behaviour. Two sabotages passed that way
 * before this split: renaming the method string and re-drifting the ORDER BY
 * both left the explanation intact and the guard green.
 */
async function currentBody(): Promise<{ file: string; body: string }> {
  const all = await definitions();
  const last = all[all.length - 1];
  assert(last, "no migration defines handle_new_user");
  const at = last.sql.search(DEFINITION);
  assert(at > -1, `${last.file}: could not locate the CREATE`);
  return { file: last.file, body: last.sql.slice(at) };
}

Deno.test("the live handle_new_user records the signup clickwrap", async () => {
  const { file, body } = await currentBody();
  for (const required of [
    "tos_accepted_version",
    "privacy_accepted_version",
    "legal_acceptances",
    "signup_clickwrap",
  ]) {
    assert(
      body.includes(required),
      `${file} is the LAST definition of handle_new_user and does not mention ` +
        `${required}. A CREATE OR REPLACE that omits an earlier migration's ` +
        "block silently deletes that behaviour — which is exactly how 00303 " +
        "removed the clickwrap capture for months. Carry the block forward.",
    );
  }
});

Deno.test("the clickwrap row is what confirm-signup corroborates", async () => {
  // The two ends of US-2116 AC4. decideSignupConsentEvidence refuses when there
  // is no row with this method, so the string has to match on both sides or the
  // strengthened-evidence path records nothing and says so to nobody.
  const { body } = await currentBody();
  const evidence = await Deno.readTextFile(
    new URL("../lib/signup-consent-evidence.ts", import.meta.url),
  );
  const method = /SIGNUP_CLICKWRAP_METHOD\s*=\s*"([^"]+)"/.exec(evidence)?.[1];
  assertEquals(method, "signup_clickwrap");
  assert(
    body.includes(`'${method}'`),
    `the trigger must write method '${method}' — confirm-signup refuses when no ` +
      "row carries it, so a different string is an evidence path that can never fire",
  );
});

Deno.test("the trigger resolves the version the way the gate does", async () => {
  // If the trigger and deriveKind() disagree about which legal_documents row is
  // "current", a fresh signup is stamped with a version the gate does not
  // consider current — so the user is re-prompted immediately — or with one it
  // considers newer than it should, and they are never prompted again.
  const { body } = await currentBody();
  // COUNTED, not merely present. There are two lookups — tos and privacy — and
  // a sabotage that drifted only the first left the second matching and the
  // assertion green. Half a mirror is not a mirror.
  const ordered = body.match(/ORDER BY\s+d\.effective_date DESC,\s*d\.version DESC/gi) ?? [];
  assertEquals(
    ordered.length,
    2,
    "both legal_documents lookups (tos and privacy) must order by effective_date " +
      "desc then version desc, mirroring deriveKind() in lib/legal-versions.ts",
  );
  assert(
    /effective_date !== b\.effective_date/.test(LEGAL_VERSIONS_SRC) &&
      /a\.version !== b\.version/.test(LEGAL_VERSIONS_SRC),
    "deriveKind no longer sorts by effective_date then version — the trigger's " +
      "ORDER BY above was mirrored from it and must move with it",
  );
  // The empty-table baseline has to be the same on both sides, or a fresh
  // database stamps one version and gates on another.
  assertEquals(FALLBACK_TOS_VERSION, FALLBACK_PRIVACY_VERSION);
  const fallbacks = body.match(
    new RegExp(`'${FALLBACK_TOS_VERSION}'`, "g"),
  ) ?? [];
  assertEquals(
    fallbacks.length,
    2,
    `both fallbacks must equal FALLBACK_TOS_VERSION (${FALLBACK_TOS_VERSION}) — ` +
      "drifting one leaves a fresh database stamping one version and gating on another",
  );
});

Deno.test("the recorded version is server-resolved, not the browser's constant", async () => {
  // US-2017: the clients hardcode LEGAL_VERSIONS, so after an operator publishes
  // a new document the browser keeps sending the old string while /terms serves
  // the new one. Stamping what the browser sent records a version the user was
  // never shown. The metadata's PRESENCE still signals "this was an email
  // signup with a checkbox" — an OAuth signup sends none and must stay NULL for
  // the gate — but the VALUE comes from legal_documents.
  const { body } = await currentBody();
  assert(
    /FROM public\.legal_documents/i.test(body),
    "the trigger must read the current version from legal_documents",
  );
  for (const clientValue of [
    "left(NEW.raw_user_meta_data ->> 'tos_version'",
    "left(NEW.raw_user_meta_data ->> 'privacy_version'",
  ]) {
    assert(
      !body.includes(clientValue),
      `the trigger stamps ${clientValue}… — that is the browser's hardcoded ` +
        "constant, which does not move when a document is published",
    );
  }
  // accepted_at is server time for the same reason a client IP would be refused
  // (lib/signup-consent-evidence.ts): a forgeable value on a consent record is
  // worse than an absent one.
  assert(
    !/legal_accepted_at/.test(body),
    "accepted_at must be now() (server-observed), not the client's legal_accepted_at",
  );
});

Deno.test("an OAuth signup still records no acceptance", async () => {
  // The gate depends on it. If the trigger stamped a version for a signup with
  // no clickwrap, an OAuth user would be marked as having accepted terms they
  // were never shown, and legal-gate.tsx would never prompt them.
  const { body } = await currentBody();
  assert(
    /v_clickwrap\s+boolean\s*:=/.test(body),
    "the clickwrap signal must be derived, not assumed",
  );
  assert(
    /IF v_clickwrap THEN[\s\S]*legal_acceptances/.test(body),
    "the audit row must be written only when a clickwrap actually happened",
  );
  assert(
    /CASE WHEN v_clickwrap THEN left\(v_tos, 64\) END/.test(body),
    "the users.* acceptance columns must stay NULL for a signup with no clickwrap",
  );
});
