import { assert, assertEquals } from "@std/assert";
import {
  isPlaceholderRelease,
  RELEASE_ENV_KEYS,
  resolveRelease,
} from "../lib/release-identity.ts";

// US-2001. The bug these tests pin was invisible for three weeks because every
// symptom pointed at the Docker build arg, and the code that consumed the result
// looked like it already handled the fallback case.

const env = (m: Record<string, string>) => (k: string) => m[k];

Deno.test("THE PRODUCTION BUG: a placeholder RELEASE_SHA no longer shadows a real SOURCE_COMMIT", () => {
  // This is the exact environment measured on functions.gradethread.com on
  // 2026-08-09: the image bakes RELEASE_SHA="dev" (ARG GIT_SHA default), and a
  // real commit is available under another name. The old `??` chain returned
  // "dev" here, because ?? falls through on undefined and never on a value — so
  // setting SOURCE_COMMIT by hand in Coolify would have changed nothing.
  const got = resolveRelease(env({
    RELEASE_SHA: "dev",
    SOURCE_COMMIT: "c9631342084bfd9e96883321a07a390d3be1e814",
  }));
  assertEquals(got, "c9631342084bfd9e96883321a07a390d3be1e814");
});

Deno.test("a real RELEASE_SHA still wins over the platform vars", () => {
  // Precedence must not invert: a deliberate build stamp beats an ambient one.
  assertEquals(
    resolveRelease(env({ RELEASE_SHA: "abc1234", SOURCE_COMMIT: "def5678" })),
    "abc1234",
  );
});

Deno.test("every key in the chain is reachable", () => {
  // The old chain's later keys were unreachable in production. Assert each one
  // can actually produce the answer, rather than trusting the list's order.
  let checked = 0;
  for (const key of RELEASE_ENV_KEYS) {
    // All keys before this one hold the placeholder that used to shadow them.
    const m: Record<string, string> = {};
    for (const other of RELEASE_ENV_KEYS) {
      if (other === key) break;
      m[other] = "dev";
    }
    m[key] = `sha-for-${key}`;
    assertEquals(resolveRelease(env(m)), `sha-for-${key}`, `${key} is unreachable`);
    checked++;
  }
  assertEquals(checked, RELEASE_ENV_KEYS.length);
  assert(checked >= 4, "the chain should still carry the four documented names");
});

Deno.test("all placeholders, or nothing set at all, resolves to unknown", () => {
  assertEquals(resolveRelease(env({})), "unknown");
  assertEquals(
    resolveRelease(env({
      RELEASE_SHA: "dev",
      COMMIT_SHA: "unknown",
      SOURCE_COMMIT: "latest",
      GIT_SHA: "none",
    })),
    "unknown",
  );
});

Deno.test("placeholders are matched case- and whitespace-insensitively", () => {
  // A build arg passed as "DEV" or with a trailing newline (a `$(git rev-parse)`
  // that failed, say) is the same blind spot wearing different whitespace.
  assertEquals(resolveRelease(env({ RELEASE_SHA: "  DEV \n" })), "unknown");
  assert(isPlaceholderRelease("Unknown"));
  assert(isPlaceholderRelease("   "));
  assert(isPlaceholderRelease(undefined));
  assert(!isPlaceholderRelease("abc1234"));
});

Deno.test("a resolved release is truncated to 40 chars", () => {
  const long = "a".repeat(64);
  assertEquals(resolveRelease(env({ RELEASE_SHA: long })).length, 40);
});

Deno.test("short SHAs and tags count as real — the form stays permissive", () => {
  // The measured failure was a placeholder surviving the build, not a malformed
  // SHA. Demanding 40 hex chars would break tag-based deploys for no benefit.
  for (const v of ["abc1234", "v2.3.1", "2026-08-09.1", "release-42"]) {
    assertEquals(resolveRelease(env({ RELEASE_SHA: v })), v);
  }
});
