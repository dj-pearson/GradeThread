// US-913: signed open/click engagement tokens. Pure crypto/string transforms,
// so this runs with no DB/env (the secret is always passed in explicitly).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyMarketingEmailTracking,
  EMAIL_TRACK_BASE_PATH,
  isBotOpenUserAgent,
  signEngagementToken,
  verifyEngagementToken,
} from "../lib/email-engagement-token.ts";

const SECRET = "test-engagement-secret";
const BASE = "https://functions.gradethread.com";
const CAMPAIGN = "11111111-1111-1111-1111-111111111111";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

Deno.test("open token round-trips through sign + verify", async () => {
  const tok = await signEngagementToken({ c: CAMPAIGN, u: USER_A, k: "o" }, SECRET);
  const payload = await verifyEngagementToken(tok, SECRET);
  assertEquals(payload, { c: CAMPAIGN, u: USER_A, k: "o" });
});

Deno.test("click token carries the signed destination URL", async () => {
  const url = "https://gradethread.com/dashboard?x=1";
  const tok = await signEngagementToken({ c: CAMPAIGN, u: USER_A, k: "c", l: url }, SECRET);
  const payload = await verifyEngagementToken(tok, SECRET);
  assertEquals(payload?.l, url);
  assertEquals(payload?.k, "c");
});

Deno.test("a token minted with the wrong secret fails verification", async () => {
  const tok = await signEngagementToken({ c: CAMPAIGN, u: USER_A, k: "o" }, "attacker-key");
  assertEquals(await verifyEngagementToken(tok, SECRET), null);
});

Deno.test("a tampered signature fails verification", async () => {
  const tok = await signEngagementToken({ c: CAMPAIGN, u: USER_A, k: "o" }, SECRET);
  const tampered = tok.slice(0, -1) + (tok.endsWith("A") ? "B" : "A");
  assertEquals(await verifyEngagementToken(tampered, SECRET), null);
});

Deno.test("garbage / missing tokens verify to null", async () => {
  assertEquals(await verifyEngagementToken("", SECRET), null);
  assertEquals(await verifyEngagementToken("nodot", SECRET), null);
  assertEquals(await verifyEngagementToken(null, SECRET), null);
  assertEquals(await verifyEngagementToken(".", SECRET), null);
});

// AC6: tokens never leak / affect another recipient's identity. Splicing user
// A's valid signature onto a body that names user B (or swapping the body of A's
// token for B's) must NOT verify — so a recipient can never forge a token that
// writes to another recipient's row.
Deno.test("a token cannot be re-pointed at another recipient", async () => {
  const tokenA = await signEngagementToken({ c: CAMPAIGN, u: USER_A, k: "o" }, SECRET);
  const tokenB = await signEngagementToken({ c: CAMPAIGN, u: USER_B, k: "o" }, SECRET);

  // Splice A's signature onto B's body (the enumeration / impersonation attempt).
  const forgedBody = tokenB.slice(0, tokenB.indexOf("."));
  const stolenSig = tokenA.slice(tokenA.indexOf(".") + 1);
  const forged = `${forgedBody}.${stolenSig}`;
  assertEquals(await verifyEngagementToken(forged, SECRET), null);

  // And each legitimate token resolves ONLY to its own recipient.
  assertEquals((await verifyEngagementToken(tokenA, SECRET))?.u, USER_A);
  assertEquals((await verifyEngagementToken(tokenB, SECRET))?.u, USER_B);
});

Deno.test("flags prefetch/proxy opens, passes a real client UA", () => {
  assert(isBotOpenUserAgent("Mozilla/5.0 (via ggpht.com GoogleImageProxy)"));
  assert(isBotOpenUserAgent("YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-for-desktop"));
  assert(isBotOpenUserAgent(""), "missing UA is bot-likely");
  assert(isBotOpenUserAgent(null));
  assert(
    !isBotOpenUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
    ),
    "a real Safari client must not be flagged",
  );
});

Deno.test("rewriter wraps links with a signed click token + injects the open pixel", async () => {
  const target = "https://gradethread.com/dashboard?x=1";
  const html = `<body><a href="${target}">Go</a></body>`;
  const out = await applyMarketingEmailTracking(html, BASE, { campaignId: CAMPAIGN, userId: USER_A }, SECRET);

  // Link rewritten to a /c/<token> redirect; pixel injected inside the body.
  assertStringIncludes(out, `${BASE}${EMAIL_TRACK_BASE_PATH}/c/`);
  assertStringIncludes(out, `${BASE}${EMAIL_TRACK_BASE_PATH}/o/`);
  assert(out.indexOf(`${EMAIL_TRACK_BASE_PATH}/o/`) < out.indexOf("</body>"), "pixel inside body");
  assertStringIncludes(out, "display:none");

  // The wrapped click token verifies back to the ORIGINAL destination.
  const clickTok = out.match(new RegExp(`${EMAIL_TRACK_BASE_PATH}/c/([^"]+)"`))?.[1];
  assert(clickTok, "click token present");
  const payload = await verifyEngagementToken(clickTok!, SECRET);
  assertEquals(payload?.l, target);
  assertEquals(payload?.c, CAMPAIGN);
  assertEquals(payload?.u, USER_A);
});

Deno.test("rewriter leaves the one-click unsubscribe link direct", async () => {
  const unsub = `${BASE}/api/notifications/unsubscribe?u=1&t=abc`;
  const out = await applyMarketingEmailTracking(
    `<body><a href="${unsub}">Unsub</a></body>`,
    BASE,
    { campaignId: CAMPAIGN, userId: USER_A },
    SECRET,
  );
  assert(out.includes(`href="${unsub}"`), "unsubscribe must reach its real endpoint directly");
  assert(!out.includes(`${EMAIL_TRACK_BASE_PATH}/c/`), "unsubscribe must not be click-wrapped");
});
