// US-2114: every place we tell a customer about a recurring charge must be on
// the list counsel is given.
//
// US-2114 is a REVIEW GATE — the disclosure copy, the consent wording and the
// retention period are legal determinations, and its notes say plainly: do not
// let an agent invent legal language. But copy shipped anyway, deliberately and
// with the reason recorded (US-2115: showing nothing was the exposure the audit
// actually found), and it has kept growing — six billing emails gained buyer
// variants on 2026-08-10 alone, every sentence of them agent-drafted.
//
// The risk this file addresses is not the wording. It is that the LIST goes
// stale: a review gate is only as good as the inventory handed to it, and an
// inventory maintained by memory is how the seventh email gets written after
// counsel signs off on six.
//
// So the register lives in the vault (vault/50-business/
// subscription-copy-review-register.md, which is US-2114 AC4's home) and this
// test derives the same set from source and fails when they disagree. A new
// email that speaks about renewals or cancellation cannot ship unregistered.

import { assert, assertEquals } from "@std/assert";
import { code, fnBody } from "./_source-scan.ts";

const EMAIL = await Deno.readTextFile(new URL("../lib/email.ts", import.meta.url));
const REGISTER = await Deno.readTextFile(
  new URL("../../../../vault/50-business/subscription-copy-review-register.md", import.meta.url),
);

/**
 * Language that makes a message a statement about a recurring charge or the
 * ending of one — the two things state ARLs regulate the wording of.
 *
 * Deliberately broad. A false positive costs one line in the register; a false
 * negative is a sentence about someone's money that counsel never saw.
 */
const BILLING_SPEECH =
  /renews? automatically|until you cancel|cancel any ?time|your card will be charged|the payment is just|renewal|cancellation stops|plan will drop|subscription renewed|update your card/i;

/** Every exported send*Email name, in declaration order. */
function senderNames(src: string): string[] {
  return [...src.matchAll(/export async function (send\w+Email)\s*\(/g)].map((m) => m[1]!);
}

const EMAIL_CODE = code(EMAIL);
const BILLING_SENDERS = senderNames(EMAIL_CODE)
  .filter((name) =>
    BILLING_SPEECH.test(fnBody(EMAIL_CODE, `export async function ${name}`))
  )
  .sort();

Deno.test("US-2114: the register is not empty and the scan still works", () => {
  // Guards the guard. A regex that stops matching, or a rename of the send*Email
  // convention, would leave every assertion below passing over nothing — which
  // reads as "the register is complete" while it covers no one.
  assert(
    BILLING_SENDERS.length >= 6,
    `only ${BILLING_SENDERS.length} billing emails found — the scan has probably ` +
      "stopped working rather than the emails having been deleted",
  );
});

Deno.test("US-2114 AC1: every billing email is on the list counsel is given", () => {
  const missing = BILLING_SENDERS.filter((name) => !REGISTER.includes(name));
  assertEquals(
    missing,
    [],
    "these send copy about a recurring charge and are not in " +
      "vault/50-business/subscription-copy-review-register.md. A review gate is " +
      "only as good as the inventory handed to it — add them, with who drafted " +
      "them and their status, before they ship.",
  );
});

Deno.test("US-2114: the register does not list emails that no longer exist", () => {
  // The other direction. A register naming a deleted template tells counsel to
  // review something that cannot be shown to anyone, and quietly inflates how
  // much of the surface looks covered.
  const listed = [...REGISTER.matchAll(/`(send\w+Email)`/g)].map((m) => m[1]!);
  assert(listed.length > 0, "the register lists no email by name — format changed?");
  const stale = [...new Set(listed)].filter((name) => !EMAIL.includes(`function ${name}(`));
  assertEquals(stale, [], "the register names templates that no longer exist");
});

Deno.test("US-2114: nothing claims counsel review without naming the record", () => {
  // The one failure this register could cause that is worse than not existing:
  // an entry marked reviewed when it was not. Any line asserting review must
  // cite a dated record, so the claim is checkable rather than atmospheric.
  for (const line of REGISTER.split(/\r?\n/)) {
    if (!/counsel[- ]reviewed/i.test(line)) continue;
    // A line DENYING review is exactly what this register should be full of
    // today, so negations pass. Only an assertion that review HAPPENED needs a
    // date behind it.
    const denies = /\b(nothing|none|not|never|no)\b/i.test(line);
    assert(
      denies || /\d{4}-\d{2}-\d{2}/.test(line) ||
        /pending|awaiting|will then accept/i.test(line),
      `"${line.trim()}" claims counsel review with no date. An unverifiable ` +
        "review claim is worse than an honest gap.",
    );
  }
});
