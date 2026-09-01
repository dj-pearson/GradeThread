// US-2481: the extension work queue's one load-bearing rule.
//
// The queue exists so a seller can start cross-listing work from their phone.
// The reason it is safe to have a queue at all is that it stores WHAT to do and
// never a way IN — see vault/60-decisions/adr-no-server-side-marketplace-automation.md
// §3.1. These tests hold that line at the layer where a 400 can still name the
// offending key; the table's CHECK constraint holds it underneath, and the
// tenant-isolation suite holds it end-to-end.
//
// Pure functions, no network, no DB — this runs in the ordinary `deno test`.

import { assert, assertEquals } from "@std/assert";
import {
  CREDENTIAL_KEYS,
  EXTENSION_QUEUE_KINDS,
  MAX_QUEUE_DEPTH,
  QUEUE_TTL_MS,
  QUEUED_NOTICE,
  normalizeQueuePayload,
  planExpiry,
  withSellerLocale,
} from "../lib/extension-queue.ts";

Deno.test("a clean instruction passes through unchanged", () => {
  const payload = { locale: "vinted.fr", shareCount: 200, itemTitle: "Nike tee" };
  const out = normalizeQueuePayload(payload);
  assertEquals(out.rejectedKey, null);
  assertEquals(out.value, payload);
});

Deno.test("a credential key is refused, and named", () => {
  for (const key of ["password", "cookie", "sessionCookie", "accessToken", "csrf"]) {
    const out = normalizeQueuePayload({ [key]: "x" });
    assertEquals(
      out.rejectedKey,
      key,
      `${key} was allowed into a queue payload — the queue must never carry a way in`,
    );
    assertEquals(out.value, {}, "a refused payload must not be partially kept");
  }
});

Deno.test("separators and case do not smuggle a credential through", () => {
  // `session_cookie`, `SESSION-COOKIE` and `sessionCookie` are one key wearing
  // three spellings. A check that only matched the camelCase form would be
  // trivially routed around by whichever client wrote snake_case.
  for (const key of ["session_cookie", "SESSION-COOKIE", "Session Cookie", "PASSWORD"]) {
    const out = normalizeQueuePayload({ [key]: "x" });
    assert(out.rejectedKey !== null, `"${key}" slipped past the credential check`);
  }
});

Deno.test("a nested credential is found, not just a top-level one", () => {
  // The same leak, one brace deeper. A top-level-only check is the kind that
  // passes review and fails in production.
  assert(normalizeQueuePayload({ auth: { cookie: "sid=1" } }).rejectedKey !== null);
  assert(normalizeQueuePayload({ a: { b: { c: { password: "x" } } } }).rejectedKey !== null);
  assert(normalizeQueuePayload({ list: [{ sessionId: "x" }] }).rejectedKey !== null);
});

Deno.test("a suffix match catches the obvious rename", () => {
  // `poshmarkCookie` is a cookie. Matching on the suffix means renaming the key
  // is not a bypass.
  assert(normalizeQueuePayload({ poshmarkCookie: "x" }).rejectedKey !== null);
  assert(normalizeQueuePayload({ userPassword: "x" }).rejectedKey !== null);
});

Deno.test("an ordinary key that merely contains a bad word is still allowed", () => {
  // The check must not be so eager that it refuses real instructions. These are
  // the false positives that would make someone loosen it.
  assertEquals(normalizeQueuePayload({ sessionCount: 3 }).rejectedKey, null);
  assertEquals(normalizeQueuePayload({ cookieJarBrand: "Nike" }).rejectedKey, null);
});

Deno.test("an oversized payload is dropped whole, never truncated", () => {
  // Truncating JSON produces invalid JSON, and a half instruction is worse than
  // none: the extension would act on part of a job.
  const huge = { note: "x".repeat(20_000) };
  const out = normalizeQueuePayload(huge);
  assertEquals(out.rejectedKey, null);
  assertEquals(out.value, {}, "an oversized payload must be dropped, not clipped");
});

Deno.test("non-objects normalize to an empty payload rather than throwing", () => {
  for (const input of [null, undefined, "string", 42, [1, 2, 3], true]) {
    const out = normalizeQueuePayload(input);
    assertEquals(out.value, {});
    assertEquals(out.rejectedKey, null);
  }
});

Deno.test("the queue kinds are exactly the four the extension can run", () => {
  // A kind here with no branch in the extension would queue work that
  // silently never drains — which then expires and surfaces as a failure the
  // seller cannot act on. That is precisely what `share` did between US-2481 and
  // US-2497, so this list is what stops it coming back on a hunch. `revise`
  // (US-9202) has its branch: RUNNABLE_QUEUE_KINDS in
  // extension-unified/lister/job-store.js and runReviseFlow in lister/common.js,
  // pinned by extension-unified/test/revise-flow.test.cjs.
  // `relist` (US-9203) likewise: RUNNABLE_QUEUE_KINDS and runRelistFlow,
  // pinned by extension-unified/test/relist-flow.test.cjs.
  assertEquals([...EXTENSION_QUEUE_KINDS], ["list", "delist", "revise", "relist"]);
  assert(!(EXTENSION_QUEUE_KINDS as readonly string[]).includes("share"));
});

Deno.test("expiry is a week out, and in the future", () => {
  const now = Date.parse("2026-08-10T00:00:00Z");
  const expires = Date.parse(planExpiry(now));
  assertEquals(expires - now, QUEUE_TTL_MS);
  assert(QUEUE_TTL_MS > 0);
});

Deno.test("the depth cap is a real number, not unlimited", () => {
  // Without one, a week of phone queuing turns into a laptop that opens
  // marketplace tabs it will not stop opening.
  assert(MAX_QUEUE_DEPTH > 0 && MAX_QUEUE_DEPTH <= 500);
});

Deno.test("the queued notice never claims the work is done", () => {
  // US-2481 AC7. A mobile screen that renders "Listed!" for a queued job has
  // told the seller their listing is live when it is not — and for a delist,
  // that belief is what becomes a double sale.
  assert(/desktop browser/i.test(QUEUED_NOTICE));
  assert(/until then/i.test(QUEUED_NOTICE));
  assert(
    !/\b(done|complete|completed|listed|published)\b/i.test(QUEUED_NOTICE),
    "the queued notice must not read as a completion",
  );
});

Deno.test("the credential list covers the obvious shapes", () => {
  for (const expected of ["password", "cookie", "session", "accesstoken", "secret"]) {
    assert(
      (CREDENTIAL_KEYS as readonly string[]).includes(expected),
      `"${expected}" fell out of CREDENTIAL_KEYS`,
    );
  }
});

// ── US-2777: the seller's country domain on a queued job ──────────────────
//
// Vinted is one app on 22 country domains and `newListingUrlForLocale` silently
// returns the platform default when a job names no locale — so a French seller
// queued a cross-post that opened vinted.com and watched a form fill on a site
// they have no account on. Web, iOS and Android all enqueue an empty payload,
// so the edge is the only place that can know.

Deno.test("the seller's stored locale is stamped onto an empty payload", () => {
  const out = withSellerLocale({}, { vinted: "vinted.fr" }, "vinted");
  assertEquals(out, { locale: "vinted.fr" });
});

Deno.test("a locale the caller supplied is NOT overwritten by the default", () => {
  // The web's direct send reads the same setting itself, and a caller naming a
  // locale is making a statement about this job. Overwriting it would make the
  // field carry the account default and nothing else, forever.
  const out = withSellerLocale({ locale: "vinted.it" }, { vinted: "vinted.fr" }, "vinted");
  assertEquals(out.locale, "vinted.it");
});

Deno.test("no setting means no locale, which is exactly today's behaviour", () => {
  // Every account has no setting on the day this ships. If the no-setting case
  // started naming a domain, this change would move sellers who never asked.
  for (const settings of [null, undefined, {}, [], "vinted.fr", 7]) {
    assertEquals(withSellerLocale({}, settings, "vinted"), {});
  }
});

Deno.test("a setting for another platform does not leak onto this one", () => {
  assertEquals(withSellerLocale({}, { vinted: "vinted.fr" }, "poshmark"), {});
});

Deno.test("a non-string stored value is ignored rather than coerced", () => {
  // A hand-written row or an older shape. None of these is a locale key, and
  // asking the extension to resolve one would refuse a job for no reason.
  for (const bad of [null, 7, true, { nested: "vinted.fr" }, [], ""]) {
    assertEquals(withSellerLocale({}, { vinted: bad }, "vinted"), {});
  }
});

Deno.test("an UNCOVERED key is passed through, not silently defaulted", () => {
  // Deliberate. The extension's bundled map is the authority and it refuses a
  // domain it does not cover BY NAME (US-2479 AC2). Filtering here would turn
  // that loud refusal back into the silent wrong-country page this fixes.
  assertEquals(
    withSellerLocale({}, { vinted: "vinted.xx" }, "vinted"),
    { locale: "vinted.xx" },
  );
});

Deno.test("stamping keeps the rest of the payload", () => {
  const out = withSellerLocale({ shareCount: 200 }, { vinted: "vinted.de" }, "vinted");
  assertEquals(out, { shareCount: 200, locale: "vinted.de" });
});

Deno.test("a stamped payload still passes the credential check", () => {
  // The stamp runs AFTER normalizeQueuePayload, so this pins that it cannot
  // introduce something the bright-line check would have refused.
  const stamped = withSellerLocale({}, { vinted: "vinted.fr" }, "vinted");
  assertEquals(normalizeQueuePayload(stamped).rejectedKey, null);
});
