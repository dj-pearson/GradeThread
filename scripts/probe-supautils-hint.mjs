#!/usr/bin/env node
// US-2403 — is the supautils hint path active for `anon` on a live stack?
//
// THE QUESTION THIS ANSWERS, AND WHY IT WAS STUCK. A denied FUNCTION call from
// a role listed in supautils.hint_roles segfaults the backend and restarts the
// whole database. US-2403 proved that on the local image and then could not
// establish whether PROD reproduces, because the direct test IS the denial of
// service: calling a revoked function as anon against prod is the attack, not a
// probe. `show supautils.hint_roles` over psql is safe but needs database
// access nobody has from here.
//
// THE SAFE PROXY. The crash lives in the hint path, and hint_roles gates the
// hint for TABLE denials as well as function denials — US-2403's own isolation
// found a denied table read on the crashing image returns a clean error PLUS
// the supautils hint "Grant the required privileges to the current role with:
// GRANT SELECT ON public.x TO anon;". Table denials never crash, on any image.
// So: ask for a table anon cannot read, and look at whether a supautils hint
// comes back. A hint means anon is in hint_roles and the function path is
// therefore live. No hint means it is not.
//
// THE CONTROL MATTERS MORE THAN THE SUBJECT. A null `hint` proves nothing on
// its own — PostgREST might simply not forward hints, and then every stack on
// earth would look mitigated. So this first asks for a near-miss column name,
// which makes POSTGRES emit "Perhaps you meant to reference the column ...".
// If that hint arrives, the channel demonstrably works and a null hint on the
// permission denial is a real absence. Without the control, do not read the
// result.
//
// WHAT THIS IS NOT. It is not a direct test of the function path, and it must
// never become one. It infers from a gate the two paths share. Say "evidence",
// not "proof", when quoting it.
//
//   node scripts/probe-supautils-hint.mjs [--url URL] [--key KEY] [--json]
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from the environment, then
// from .env.production. The anon key is public by design (it ships in the
// frontend bundle); it is still never printed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A table with no SELECT grant to anon, so the request is refused by GRANT
// rather than filtered to empty by RLS. RLS returns 200 and an empty array,
// which carries no error and therefore no hint — the wrong shape entirely.
const DENIED_TABLE = "applied_migrations";
// A readable table plus a deliberate near-miss column, for the control.
const CONTROL_TABLE = "grade_reports";
const CONTROL_NEAR_MISS = "certificate_i"; // certificate_id, one character short

function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function ask(url, key, query) {
  const res = await fetch(`${url}/rest/v1/${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export function verdict({ control, subject }) {
  if (!control.hintPresent) {
    return {
      conclusive: false,
      finding: "control_failed",
      say:
        "The control did not produce a hint, so this stack's hints are not reaching the client. " +
        "The permission-denied result is unreadable — do not quote it either way.",
    };
  }
  if (subject.hintPresent) {
    return {
      conclusive: true,
      finding: "hint_path_active",
      say:
        "A supautils hint came back for anon, so anon is in hint_roles and the FUNCTION denial " +
        "path is live. Treat this stack as reproducing the crash. Do not confirm by calling one.",
    };
  }
  return {
    conclusive: true,
    finding: "hint_path_quiet",
    say:
      "Hints reach the client and none came back for a permission denial as anon, so the " +
      "supautils hint path is not running for anon. Evidence this stack does NOT reproduce " +
      "the crash. Evidence, not proof: it shares a gate with the function path rather than testing it.",
  };
}

async function main() {
  const env = { ...readEnvFile(path.join(ROOT, ".env.production")), ...process.env };
  const url = (arg("url") ?? env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = arg("key") ?? env.VITE_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) {
    console.error("Need VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (env, .env.production, or --url/--key).");
    process.exit(2);
  }

  const c = await ask(url, key, `${CONTROL_TABLE}?select=${CONTROL_NEAR_MISS}&limit=1`);
  const s = await ask(url, key, `${DENIED_TABLE}?select=version&limit=1`);

  const control = {
    status: c.status,
    code: c.body?.code ?? null,
    hintPresent: typeof c.body?.hint === "string" && c.body.hint.length > 0,
    hint: c.body?.hint ?? null,
  };
  const subject = {
    status: s.status,
    code: s.body?.code ?? null,
    message: s.body?.message ?? null,
    hintPresent: typeof s.body?.hint === "string" && s.body.hint.length > 0,
    hint: s.body?.hint ?? null,
  };

  if (subject.code !== "42501") {
    console.error(
      `Subject did not return 42501 (got ${subject.code ?? subject.status}). ` +
        `public.${DENIED_TABLE} may now be readable by anon; pick another ungranted table.`,
    );
  }

  const v = verdict({ control, subject });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ url, control, subject, verdict: v }, null, 2));
    return;
  }

  console.log(`\nsupautils hint probe — ${url}\n`);
  console.log(`  control  ${CONTROL_TABLE}.${CONTROL_NEAR_MISS} -> ${control.code} ` +
    `hint=${control.hintPresent ? JSON.stringify(control.hint) : "none"}`);
  console.log(`  subject  ${DENIED_TABLE} as anon      -> ${subject.code} ` +
    `hint=${subject.hintPresent ? JSON.stringify(subject.hint) : "none"}`);
  console.log(`\n  ${v.finding}${v.conclusive ? "" : " (INCONCLUSIVE)"}\n  ${v.say}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
