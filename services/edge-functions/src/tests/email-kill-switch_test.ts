// US-2379: FIRST import. email-kill-switch.ts reaches lib/supabase.ts through
// system-settings.ts, which reads env at import time — without this the file
// only loads because some other test ran before it.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  AUTH_CATEGORY_PREFIX,
  EMAIL_CATEGORY_CATALOG,
  isProtectedCategory,
  PROTECTED_CATEGORIES,
  sanitizeDisabledList,
} from "../lib/email-kill-switch.ts";

Deno.test("protected categories can never be disabled", () => {
  for (const c of PROTECTED_CATEGORIES) {
    assert(isProtectedCategory(c), `${c} should be protected`);
    assertEquals(
      sanitizeDisabledList([c]),
      [],
      `${c} survived sanitize — an operator could switch off a receipt`,
    );
  }
});

Deno.test("every auth email is protected, whichever action produced it", () => {
  for (
    const action of [
      "signup",
      "magiclink",
      "recovery",
      "invite",
      "email_change",
      "reauthentication",
    ]
  ) {
    const category = `${AUTH_CATEGORY_PREFIX}${action}`;
    assert(isProtectedCategory(category), `${category} should be protected`);
    assertEquals(sanitizeDisabledList([category]), []);
  }
});

Deno.test("sanitize drops unknown categories rather than storing them", () => {
  // A typo stored as-is would sit in the list looking like it did something.
  assertEquals(sanitizeDisabledList(["ops_allert", "not_a_category"]), []);
});

Deno.test("sanitize keeps, de-duplicates and sorts real categories", () => {
  assertEquals(
    sanitizeDisabledList(["trial_expiring", "ops_alert", "trial_expiring"]),
    ["ops_alert", "trial_expiring"],
  );
});

Deno.test("sanitize survives junk input", () => {
  for (const bad of [null, undefined, "trial_expiring", 42, {}]) {
    assertEquals(sanitizeDisabledList(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
  assertEquals(sanitizeDisabledList([null, 7, "", "   ", "ops_alert"]), ["ops_alert"]);
});

Deno.test("the catalog agrees with itself about what is protected", () => {
  for (const meta of EMAIL_CATEGORY_CATALOG) {
    assertEquals(
      meta.protected,
      isProtectedCategory(meta.category),
      `${meta.category}: catalog says protected=${meta.protected}, the gate disagrees`,
    );
  }
});

Deno.test("the catalog has no duplicate categories", () => {
  const seen = new Set<string>();
  for (const meta of EMAIL_CATEGORY_CATALOG) {
    assert(!seen.has(meta.category), `duplicate catalog entry: ${meta.category}`);
    seen.add(meta.category);
  }
});

Deno.test("US-2854: every email category in email.ts has a switch", async () => {
  // The drift guard. A new send function ships a new `category:` literal; if the
  // catalog is not updated, that email has no operator switch and does not
  // appear in the admin table — and nothing else would ever say so.
  const src = await Deno.readTextFile(
    new URL("../lib/email.ts", import.meta.url),
  );
  const known = new Set(EMAIL_CATEGORY_CATALOG.map((c) => c.category));
  const missing: string[] = [];
  for (const m of src.matchAll(/category:\s*"([a-zA-Z0-9_.-]+)"/g)) {
    const category = m[1];
    if (!category) continue;
    // Template-built auth categories are matched by prefix, not by name.
    if (isProtectedCategory(category)) continue;
    if (!known.has(category)) missing.push(category);
  }
  assertEquals(
    [...new Set(missing)].sort(),
    [],
    "these categories are sent by lib/email.ts but have no entry in EMAIL_CATEGORY_CATALOG",
  );
});
