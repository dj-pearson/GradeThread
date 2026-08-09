// US-2417 AC1 as a SOURCE guard: the browser never touches the two encrypted
// columns on `users` directly.
//
// The type system catches most of it — `ship_from_address` is branded
// EncryptedColumn, so reaching for `.line1` on it is a compile error. It does
// NOT catch two shapes that are exactly as damaging:
//
//   1. `select("… , business_phone, …")` — a string, invisible to tsc, which
//      pulls the envelope into a payload that then gets rendered or exported.
//   2. `.update({ business_phone })` from supabase-js — also a string to tsc,
//      and after 00567 it does not fail quietly: the users self-update guard
//      RAISES, so a seller sees an error they cannot act on.
//
// Both are one autocomplete away, and both look right in review. The plaintext
// only exists behind /api/account/shipping-profile.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/**
 * The only files allowed to trip the checks below, and why.
 *
 * Deliberately short. The checks are narrow enough (see COLUMNS) that merely
 * naming the field on a DTO from the edge is fine and does not need an entry —
 * an allowlist that has to grow with every consumer stops being read.
 */
const ALLOWED = new Set([
  // The type declarations that carry the warning.
  join("src", "types", "database.ts"),
  // This guard.
  join("src", "test", "encrypted-user-columns.test.ts"),
]);

const COLUMNS = ["business_phone", "ship_from_address"];

/**
 * The two shapes that are actually dangerous, and the reason the check is not
 * a plain substring scan: `shipping.business_phone` on the value that came back
 * from the edge is correct and common, so flagging the NAME would produce an
 * allowlist longer than the rule.
 *
 *   1. reading the column off the cached auth-store `profile` row, which holds
 *      the envelope, and
 *   2. naming it in a supabase-js select/update against `users`.
 */
function violations(text: string): string[] {
  const found: string[] = [];
  // Only a file that actually holds the auth-store profile can read the
  // envelope off it; `profile.business_phone` on a DTO from the edge is fine.
  const hasAuthProfile = /useAuthStore|useAuth\(/.test(text);
  // A supabase-js chain against `users`. The column has to appear INSIDE the
  // call, not merely somewhere in the same file — settings.tsx legitimately
  // queries users for other columns.
  const userQueries = [...text.matchAll(/\.from\(\s*["']users["']\s*\)/g)]
    .map((m) => {
      // Bound at the end of the statement, not at a fixed character count — a
      // window that runs past the `;` swallows whatever follows, and in
      // account-export.ts what follows is a comment explaining this very rule.
      const rest = text.slice(m.index!);
      const end = rest.indexOf(";");
      return end === -1 ? rest : rest.slice(0, end);
    });

  for (const col of COLUMNS) {
    if (hasAuthProfile && new RegExp(`\\bprofile\\s*[?]?\\.${col}\\b`).test(text)) {
      found.push(`${col} read off the cached profile row (it is ciphertext there)`);
    }
    if (userQueries.some((q) => q.includes(col))) {
      found.push(`${col} named in a supabase-js call against users`);
    }
  }
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("US-2417: the encrypted users columns are edge-only", () => {
  it("nothing reads them off the profile row or names them in a users query", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(process.cwd().length + 1);
      if (ALLOWED.has(rel)) continue;
      for (const v of violations(readFileSync(file, "utf8"))) {
        offenders.push(`${rel} → ${v}`);
      }
    }
    expect(
      offenders,
      "These reach a column that holds AES-GCM ciphertext. Read the plaintext " +
        "with fetchShippingProfile() from @/lib/shipping-profile, and write it " +
        "with saveShippingProfile().",
    ).toEqual([]);
  });

  it("the allowlist itself has not gone stale", () => {
    // An allowlist entry for a file that no longer exists is how one of these
    // quietly grows into a list nobody trusts.
    for (const rel of ALLOWED) {
      expect(() => statSync(join(process.cwd(), rel)), `${rel} is allowlisted but missing`)
        .not.toThrow();
    }
  });
});
