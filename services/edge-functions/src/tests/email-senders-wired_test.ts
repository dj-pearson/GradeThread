// Every exported send*Email in lib/email.ts has a production caller.
//
// WHY THIS ONE RULE AND NOT THE WHOLE AUDIT. scripts/audit-unwired-exports.mjs
// reports dead exports across the edge lib and nothing gates on it, because most
// of its ~75 hits are legitimate: test-only resets (_clearBreakers,
// __resetLifecycleForTests), port probes, helpers a mirror suite pins. Gating
// that needs a baseline, and a baseline nobody has to justify becomes a budget.
//
// An email sender is the one family where the rule holds with NO exemptions. A
// send*Email with no caller is never "fine": either the notification silently
// does not go out, or it is dead code wearing the costume of a shipped feature.
// So this asserts ZERO, not a baseline, and it does so today because both of the
// two that existed were removed on 2026-08-23:
//
//   sendGradeCompleteEmail  SUPERSEDED. GradeCompleteData was a strict subset of
//                           GradeFinalizedData, and the live pipeline already
//                           sends preliminary + finalized. The preliminary path
//                           even reads notification_preferences.grade_complete.
//   sendBroadcastEmail      SUPERSEDED by US-925's durable per-recipient send in
//                           routes/admin-growth.ts. Its render helper
//                           buildBroadcastEmailHtml is still live and untouched.
//
// ⚠ AN IMPORT IS NOT A CALL. `import { sendWelcomeEmail } from "./email.ts"`
// contains the name, so a substring search says "called" for a function nobody
// invokes. That is the single most common way a check like this passes against
// broken code, so the match requires the opening paren.
//
// ⚠ A COMMENT IS NOT A CALL EITHER. A doc comment saying "like sendFooEmail()"
// satisfies a paren match just as well as real code. Comment lines are dropped
// first. The stripper is deliberately conservative - only whole lines that BEGIN
// with // or *, plus block comments - rather than every //, because stripping
// mid-line // would eat the tail of any line holding an https:// literal and
// could hide a real call. Doc comments are the realistic case and are covered.

import { assert, assertEquals } from "@std/assert";

// Only @std/assert is in the import map and the lockfile is frozen, so the
// directory walk is hand-rolled the same way growth-table-bounded-reads_test.ts
// does it.
const SRC = new URL("../", import.meta.url);
const EMAIL_TS = new URL("../lib/email.ts", import.meta.url).href;

async function walk(dir: URL, out: string[] = []): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const child = new URL(`${e.name}${e.isDirectory ? "/" : ""}`, dir);
    if (e.isDirectory) await walk(child, out);
    else if (e.name.endsWith(".ts")) out.push(child.href);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

async function productionSources(): Promise<string[]> {
  const out: string[] = [];
  for (const href of await walk(SRC)) {
    if (href.includes("/tests/") || href === EMAIL_TS) continue;
    out.push(await Deno.readTextFile(new URL(href)));
  }
  return out;
}

function exportedSenders(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(send[A-Za-z0-9_]*Email)\s*\(/gm)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

Deno.test("an import does not count as a call, and neither does a comment", () => {
  const called = (hay: string, name: string) =>
    new RegExp(`\\b${name}\\s*\\(`).test(stripComments(hay));

  assertEquals(called('import { sendWelcomeEmail } from "./email.ts";', "sendWelcomeEmail"), false);
  assertEquals(called("export { sendWelcomeEmail };", "sendWelcomeEmail"), false);
  assertEquals(called("// falls back to sendWelcomeEmail(user)", "sendWelcomeEmail"), false);
  assertEquals(called(" * see sendWelcomeEmail(to, data)", "sendWelcomeEmail"), false);
  assertEquals(called("/** sendWelcomeEmail(x) */", "sendWelcomeEmail"), false);
  assertEquals(called("await sendWelcomeEmail(user.email, data);", "sendWelcomeEmail"), true);
  // A URL in live code must survive the stripper, or a real call beside it hides.
  assertEquals(
    called('const u = "https://a.b"; await sendWelcomeEmail(u, d);', "sendWelcomeEmail"),
    true,
  );
});

Deno.test("every exported send*Email has a production caller", async () => {
  const email = await Deno.readTextFile(new URL(EMAIL_TS));
  const senders = exportedSenders(email);

  // Not vacuous: email.ts really does export dozens of these. If the regex
  // stops matching, this fails instead of reporting a clean sweep of nothing.
  assert(
    senders.length > 40,
    `only ${senders.length} exported send*Email found - the declaration regex broke`,
  );

  const sources = (await productionSources()).map(stripComments);
  assert(sources.length > 100, `only ${sources.length} production sources walked`);

  const uncalled = senders.filter(
    (n) => !sources.some((s) => new RegExp(`\\b${n}\\s*\\(`).test(s)),
  );

  assertEquals(
    uncalled,
    [],
    `exported email sender(s) that no production file calls: ${uncalled.join(", ")}. ` +
      `Either the notification never goes out, or it is dead code - decide which, ` +
      `then wire it or delete it. There is no allowlist here on purpose.`,
  );
});
