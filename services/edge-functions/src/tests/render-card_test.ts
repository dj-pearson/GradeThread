// US-2619: the markup rasteriser, and the one way it could be worse than the bug.
//
// This route takes markup from the caller and rasterises it. Open, that is
// compute amplification. The gate is therefore the whole security surface, and
// the trap is that the RIGHT-LOOKING function is the wrong one:
// `pagesOriginBypass` returns false when the secret is unset, which is correct
// for skipping a rate limiter and catastrophic for guarding a route — the
// handler would read identically and be reachable by anyone in exactly the
// configuration production sat in until 2026-08-16.
//
// So these cases pin the FAIL DIRECTION, not just the happy path.

import { assert, assertEquals } from "@std/assert";
import type { Context } from "hono";
import { requirePagesOrigin } from "../middleware/rate-limit.ts";
import {
  MAX_DIMENSION,
  MAX_MARKUP_BYTES,
  MIN_DIMENSION,
  validateRenderCardBody,
} from "../routes/render-card.ts";

/** Minimal Context stand-in: the gate reads exactly one header. */
function ctx(header?: string): Context {
  return {
    req: { header: (name: string) => (name === "x-pages-origin" ? header : undefined) },
  } as unknown as Context;
}

function withSecret<T>(value: string | null, fn: () => T): T {
  const prev = Deno.env.get("CF_PAGES_ORIGIN_SECRET");
  if (value === null) Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
  else Deno.env.set("CF_PAGES_ORIGIN_SECRET", value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
    else Deno.env.set("CF_PAGES_ORIGIN_SECRET", prev);
  }
}

Deno.test("US-2619: an UNSET secret closes the route, it does not open it", () => {
  // The assertion this whole file exists for. `pagesOriginBypass` returns false
  // here too — the difference is what the caller does with false, and a gate
  // must refuse. If this ever reads `true`, the route rasterises for strangers.
  withSecret(null, () => {
    assertEquals(requirePagesOrigin(ctx("anything")), false);
    assertEquals(requirePagesOrigin(ctx(undefined)), false);
    assertEquals(requirePagesOrigin(ctx("")), false);
  });
});

Deno.test("US-2619: the gate accepts only the exact secret", () => {
  withSecret("s3cret", () => {
    assertEquals(requirePagesOrigin(ctx("s3cret")), true);
    assertEquals(requirePagesOrigin(ctx("s3cre")), false);
    assertEquals(requirePagesOrigin(ctx("s3crets")), false);
    assertEquals(requirePagesOrigin(ctx("S3CRET")), false);
    assertEquals(requirePagesOrigin(ctx(undefined)), false);
    assertEquals(requirePagesOrigin(ctx("")), false);
  });
});

Deno.test("US-2619: a surrounding-whitespace header still matches", () => {
  // Both sides .trim(). An operator pasting a value into a Cloudflare field
  // picks up a trailing newline more often than anyone would like, and the
  // failure would look exactly like a wrong secret.
  withSecret("s3cret", () => {
    assertEquals(requirePagesOrigin(ctx("  s3cret\n")), true);
  });
});

Deno.test("US-2619: the body validator refuses what it should", () => {
  assertEquals(validateRenderCardBody({}).ok, false);
  assertEquals(validateRenderCardBody({ markup: "", width: 1200, height: 630 }).ok, false);
  assertEquals(validateRenderCardBody({ markup: "   ", width: 1200, height: 630 }).ok, false);
  assertEquals(validateRenderCardBody({ markup: "<div/>", width: 1200 }).ok, false);
  // Non-integers and non-numbers, because a float dimension reaches the
  // rasteriser as a surprise rather than an error.
  assertEquals(validateRenderCardBody({ markup: "<div/>", width: 1200.5, height: 630 }).ok, false);
  assertEquals(
    validateRenderCardBody({ markup: "<div/>", width: "1200", height: 630 }).ok,
    false,
  );
  assertEquals(validateRenderCardBody({ markup: "<div/>", width: NaN, height: 630 }).ok, false);
});

Deno.test("US-2619: the caps are enforced at both ends", () => {
  const big = "x".repeat(MAX_MARKUP_BYTES + 1);
  assertEquals(validateRenderCardBody({ markup: big, width: 1200, height: 630 }).ok, false);

  const ok = validateRenderCardBody({ markup: "<div/>", width: 1200, height: 630 });
  assert(ok.ok);

  for (const bad of [MIN_DIMENSION - 1, 0, -1200, MAX_DIMENSION + 1]) {
    assertEquals(
      validateRenderCardBody({ markup: "<div/>", width: bad, height: 630 }).ok,
      false,
      `width ${bad} should be refused`,
    );
    assertEquals(
      validateRenderCardBody({ markup: "<div/>", width: 1200, height: bad }).ok,
      false,
      `height ${bad} should be refused`,
    );
  }
});

Deno.test("US-2619: the markup cap counts BYTES, not characters", () => {
  // A card of multi-byte glyphs is bigger than it looks, and the cap is about
  // work rather than characters. Just under the limit in characters, over it in
  // bytes: this must be refused.
  const emoji = "🧥"; // 4 bytes
  const markup = emoji.repeat(Math.ceil(MAX_MARKUP_BYTES / 4) + 1);
  assert(markup.length < MAX_MARKUP_BYTES, "fixture must be under the cap in CHARACTERS");
  assertEquals(validateRenderCardBody({ markup, width: 1200, height: 630 }).ok, false);
});

Deno.test("US-2619: the route gates BEFORE it parses a body", () => {
  // Source-structural, because the ordering is the point: an unauthenticated
  // caller must not be able to make this service parse 64 KB of JSON.
  const src = Deno.readTextFileSync(new URL("../routes/render-card.ts", import.meta.url));
  const gate = src.indexOf("requirePagesOrigin(c)");
  const parse = src.indexOf("c.req.json()");
  assert(gate > 0, "the gate is gone");
  assert(parse > 0, "the body parse is gone");
  assert(gate < parse, "the auth gate must come before the body is read");
  // And the bypass must never be CALLED here: same header, opposite fail
  // direction. Anchored to the call shape rather than the bare name, because
  // the file's own comment explains why not to use it — a bare-substring
  // assertion matched that comment and failed against correct code. Second time
  // this exact shape has bitten on this story (the first was an assertion that
  // matched a comment naming `/og/verified/nobody`), so: a negative assertion
  // has to name something only the WRONG code would contain.
  assertEquals(/pagesOriginBypass\s*\(/.test(src), false);
});
