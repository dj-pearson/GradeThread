// US-938 / US-913 + US-924: open/click tracking rewriter + pre-send QA gate.
// Pure string transforms, so this runs with no DB/env.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyEmailTracking,
  injectOpenPixel,
  qaCheckEmail,
  rewriteLinksForClickTracking,
} from "../lib/email-tracking.ts";

const BASE = "https://functions.gradethread.com";

Deno.test("rewrites CTA links through click tracking", () => {
  const html = `<a href="https://gradethread.com/dashboard?x=1">Go</a>`;
  const out = rewriteLinksForClickTracking(html, BASE, "tok-1");
  assertStringIncludes(out, `${BASE}/api/drip-track/c/tok-1?u=`);
  // The original target is preserved (URL-encoded) for the redirect.
  assertStringIncludes(out, encodeURIComponent("https://gradethread.com/dashboard?x=1"));
});

Deno.test("leaves the one-click unsubscribe link direct (never wrapped)", () => {
  const unsub = `${BASE}/api/notifications/unsubscribe?u=1&t=abc`;
  const out = rewriteLinksForClickTracking(`<a href="${unsub}">Unsub</a>`, BASE, "tok");
  assert(out.includes(unsub), "unsubscribe link must reach its real endpoint directly");
  assert(!out.includes("/api/drip-track/c/"), "unsubscribe must not be click-wrapped");
});

Deno.test("does not double-wrap an already-tracked link", () => {
  const tracked = `${BASE}/api/drip-track/c/tok?u=https%3A%2F%2Fx.com`;
  const out = rewriteLinksForClickTracking(`<a href="${tracked}">x</a>`, BASE, "tok");
  // Exactly one click-tracking prefix — not wrapped again.
  assertEquals(out.match(/\/api\/drip-track\/c\//g)?.length, 1);
});

Deno.test("injects a hidden open pixel before </body>", () => {
  const out = injectOpenPixel("<html><body>hi</body></html>", BASE, "tok");
  assertStringIncludes(out, `${BASE}/api/drip-track/o/tok`);
  assert(out.indexOf("/o/tok") < out.indexOf("</body>"), "pixel must sit inside the body");
  assertStringIncludes(out, "display:none");
});

Deno.test("applyEmailTracking adds both the pixel and a rewritten link", () => {
  const out = applyEmailTracking(`<body><a href="https://x.com/y">z</a></body>`, BASE, "t");
  assertStringIncludes(out, `${BASE}/api/drip-track/o/t`);
  assertStringIncludes(out, `${BASE}/api/drip-track/c/t?u=`);
});

Deno.test("QA gate passes a clean rendered email", () => {
  assertEquals(qaCheckEmail({ subject: "Your trial", html: "<p>Hi there,</p>" }).ok, true);
});

Deno.test("QA gate flags an un-substituted token, empty subject, and empty body", () => {
  assert(!qaCheckEmail({ subject: "Hi {{firstName}}", html: "<p>ok</p>" }).ok);
  assert(qaCheckEmail({ subject: "Hi {{firstName}}", html: "<p>ok</p>" }).issues.includes("unrendered_token"));
  assert(qaCheckEmail({ subject: "", html: "<p>ok</p>" }).issues.includes("empty_subject"));
  assert(qaCheckEmail({ subject: "Hi", html: "<p>{{gradesCount}}</p>" }).issues.includes("unrendered_token"));
  assert(qaCheckEmail({ subject: "Hi", html: "<div></div>" }).issues.includes("empty_body"));
});
