// US-2356: bulk email, arbitrary recipients, and the GDPR export branch.
//
// The finding was an INCONSISTENCY rather than a blanket omission, which is what
// makes it worth a guard: admin-growth.ts already required both super_admin and
// a step-up for exactly this class of action, so the bar a send had to clear
// depended on which router it happened to live in. Five routes that reach real
// inboxes had no second factor at all:
//
//   • 500 waitlist invitations in one call;
//   • two "test sends" to an OPERATOR-SUPPLIED address — a preview feature and a
//     content-exfiltration channel are the same endpoint;
//   • two that send an arbitrary subject and body to a real user FROM THE
//     PLATFORM ADDRESS, which is the most convincing phishing channel the
//     product has.
//
// And the GDPR handler gated its DELETE branch with super_admin, a step-up and a
// typed confirm string while its EXPORT branch — which signs a URL to a user's
// complete archive — had none of the three. That it destroys nothing is not the
// distinction: one branch erases a person's data and the other hands all of it
// to whoever holds the link.
//
// TWO CLAIMS IN THE STORY WERE ALREADY FIXED and are asserted here rather than
// re-implemented, so nobody re-opens them: the newsletter approval transition
// carries super_admin + step-up, and the safety / passport-integrity queues gate
// dismiss and reopen exactly as they gate resolve.

import { assert } from "@std/assert";

const R = new URL("../routes/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, R));

/** The handler body for one route registration, up to the next registration. */
function handler(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  assert(at > -1, `route not found: ${anchor}`);
  const rest = src.slice(at + anchor.length);
  const next = rest.search(/\n\w+Routes\.(get|post|put|patch|delete)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

const EMAIL_ROUTES: Array<[string, string, string]> = [
  [
    "admin-waitlist.ts",
    'adminWaitlistRoutes.post("/invite"',
    "500 invitations to real inboxes from the platform address, in one call",
  ],
  [
    "admin-drip.ts",
    'adminDripRoutes.post("/campaigns/:campaign/test-send"',
    "the recipient is operator-supplied, so campaign copy can go to any address",
  ],
  [
    "admin-newsletter.ts",
    'adminNewsletterRoutes.post("/issues/:id/test-send"',
    "unreleased issue content, to any address, one at a time",
  ],
  [
    "admin-messages.ts",
    'adminMessagesRoutes.post("/:userId"',
    "arbitrary subject and body to a real user, from the platform address",
  ],
  [
    "admin-moderation.ts",
    'adminModerationRoutes.post("/notify-owner"',
    "same channel as admin-messages, same reasoning",
  ],
];

Deno.test("US-2356 AC2: every bulk / arbitrary-recipient send needs a step-up", () => {
  const missing: string[] = [];
  for (const [file, anchor, why] of EMAIL_ROUTES) {
    const body = handler(read(file), anchor);
    if (!/requireStepUp\(c\)/.test(body)) missing.push(`${file} ${anchor} — ${why}`);
  }
  assert(missing.length === 0, `these sends lost their step-up:\n  ${missing.join("\n  ")}`);
});

Deno.test("US-2356 AC2: the step-up is RETURNED, not merely called", () => {
  // requireStepUp hands back a Response to return. Calling it and dropping the
  // result reads as a guard and is not one — the same shape US-2364 found on the
  // agent demotion.
  for (const [file, anchor] of EMAIL_ROUTES) {
    const body = handler(read(file), anchor);
    assert(
      /if \(stepUp\) return stepUp;/.test(body),
      `${file} ${anchor}: the step-up result is discarded`,
    );
  }
});

Deno.test("US-2356 AC3: the GDPR export branch is gated like the delete branch", () => {
  const src = read("admin-compliance.ts");
  const at = src.indexOf('if (req.type === "export")');
  assert(at > -1, "the export branch was restructured");
  const branch = src.slice(at, src.indexOf("return await processDelete", at));
  assert(
    branch.includes('c.get("adminRole") !== "super_admin"'),
    "export no longer requires super_admin",
  );
  assert(branch.includes("requireStepUp(c)"), "export no longer requires a step-up");
  assert(
    branch.includes('body.confirm !== "EXPORT USER DATA"'),
    "export no longer requires a typed confirmation",
  );
});

Deno.test("US-2356 AC3: the two confirm phrases are different", () => {
  // One shared phrase becomes muscle memory, and the point of typing it is to
  // notice WHICH of the two irreversible things you are doing.
  const src = read("admin-compliance.ts");
  assert(src.includes('"ERASE USER DATA"'), "the delete confirm phrase is gone");
  assert(src.includes('"EXPORT USER DATA"'), "the export confirm phrase is gone");
});

Deno.test("US-2356 AC5: the allow-list allows only what it lists", () => {
  // `in` walks the prototype chain: "toString", "constructor" and "valueOf" all
  // satisfied it. Nothing catastrophic followed — the lookup then yields
  // undefined and the request dies later — but an allow-list that admits names
  // it does not list is not an allow-list.
  const src = read("admin-brand-knowledge.ts");
  assert(
    !/\btable in KB_TABLES\b/.test(src),
    "the membership check walks the prototype chain again",
  );
  assert(
    src.includes("Object.hasOwn(KB_TABLES, table)"),
    "the own-property check is gone",
  );
  // Both call sites, not just the one someone happened to look at.
  assert(
    src.split("Object.hasOwn(KB_TABLES, table)").length - 1 >= 2,
    "only one of the two membership checks was fixed",
  );
});

Deno.test("US-2356: the prototype keys really would have passed the old check", () => {
  // Pins the reason rather than the fix. If a future reader doubts that `in` was
  // the problem, this answers it without them having to try it.
  const sample: Record<string, readonly string[]> = { brand_knowledge: [] };
  assert("toString" in sample, "`in` no longer sees inherited keys — re-read this");
  assert(!Object.hasOwn(sample, "toString"), "Object.hasOwn is not own-only");
  assert(Object.hasOwn(sample, "brand_knowledge"), "Object.hasOwn misses real keys");
});

Deno.test("US-2356 AC1: the approval that unlocks a send already carries the send's bar", () => {
  // Already true when this story was picked up. Asserted so it cannot quietly
  // regress and so nobody re-implements it: the send requires super_admin plus a
  // step-up, and so must the transition that sets the approved state it needs.
  const src = read("admin-newsletter.ts");
  const t = handler(src, 'adminNewsletterRoutes.post("/issues/:id/transition"');
  assert(
    /to === "approved"[\s\S]{0,200}requireSensitive\(c\)/.test(t),
    "approving an issue no longer carries super_admin + step-up, so a plain " +
      "content admin can stage the blast again",
  );
  assert(
    /function requireSensitive[\s\S]{0,300}super_admin[\s\S]{0,200}requireStepUp/.test(src),
    "requireSensitive stopped meaning super_admin AND step-up",
  );
});

Deno.test("US-2356 AC4: dismiss and reopen are gated like resolve", () => {
  // Also already true. The story reports these as skipping the step-up; both
  // files fold dismissed and open into the same `resolving` flag that gates it.
  for (const file of ["admin-safety.ts", "admin-passport-integrity.ts"]) {
    const src = read(file);
    assert(
      /const resolving = status === "actioned" \|\| status === "dismissed" \|\| status === "open";/
        .test(src),
      `${file}: dismiss/reopen no longer share the resolve gate`,
    );
    assert(
      /if \(resolving\) \{\s*\n\s*const stepUp = requireStepUp\(c\);/.test(src),
      `${file}: the resolving flag no longer gates anything`,
    );
  }
});
