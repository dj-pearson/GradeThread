import { assert, assertEquals } from "@std/assert";
import {
  isPlaceholderRelease,
  RELEASE_ENV_KEYS,
  resolveRelease,
  unreadReleaseCandidates,
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

// ── US-2001: naming the variable that might already hold the commit ─────────
//
// resolveRelease says "unknown" and nothing about why, and that gap is why this
// story has been re-diagnosed three times: the operator cannot tell an unset
// variable from one set under a name nothing reads. unreadReleaseCandidates
// closes it from the other end.

Deno.test("US-2001: a commit-shaped variable nothing reads is named", () => {
  assertEquals(
    unreadReleaseCandidates([
      ["COOLIFY_GIT_COMMIT", "9f3c1ab"],
      ["SUPABASE_URL", "https://api.gradethread.com"],
    ]),
    ["COOLIFY_GIT_COMMIT"],
  );
});

Deno.test("US-2001: the keys already read are never suggested", () => {
  // They are resolved by resolveRelease. Reporting one would tell the operator
  // to add a key that is already there, which reads as a bug in the diagnostic.
  assertEquals(
    unreadReleaseCandidates([["SOURCE_COMMIT", "abc1234"], ["GIT_SHA", "def5678"]]),
    [],
  );
});

Deno.test("US-2001: a placeholder value is not a candidate", () => {
  // Pointing at a key holding "dev" sends the operator to the same placeholder
  // they already have.
  for (const v of ["dev", "unknown", "", "  ", "latest", "none", "local"]) {
    assertEquals(
      unreadReleaseCandidates([["BUILD_COMMIT", v]]),
      [],
      `"${v}" was offered as a build identity`,
    );
  }
});

Deno.test("US-2001: a SECRET is never named, even when it looks like a commit", () => {
  // This lands in a deploy log. A key called COMMIT_SIGNING_KEY matches the
  // candidate pattern and is a secret; the deny list wins on purpose, because a
  // missed diagnostic costs one more question and a leaked secret name costs a
  // rotation.
  const secrets = [
    ["COMMIT_SIGNING_KEY", "abc1234"],
    ["GIT_COMMIT_TOKEN", "abc1234"],
    ["SHA_SECRET", "abc1234"],
    ["REVISION_PASSWORD", "abc1234"],
    ["COMMIT_API_KEY", "abc1234"],
    ["GIT_PRIVATE_REF", "abc1234"],
  ] as Array<[string, string]>;
  assertEquals(unreadReleaseCandidates(secrets), []);
});

Deno.test("US-2001: unrelated variables are not swept in", () => {
  // The point is a short, actionable list. A diagnostic naming forty variables
  // is one nobody reads, which is the same as not having it.
  assertEquals(
    unreadReleaseCandidates([
      ["PORT", "8787"],
      ["EDGE_ENV", "production"],
      ["STRIPE_SECRET_KEY", "sk_live_x"],
      ["ANTHROPIC_API_KEY", "sk-ant-x"],
      ["SHASTA_REGION", "us-east"],
    ]),
    [],
  );
});

Deno.test("US-2001: the list is capped", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    [`BUILD_COMMIT_${i}`, "abc1234"] as [string, string]);
  assertEquals(unreadReleaseCandidates(many).length, 8);
});

Deno.test("US-2001: the real production shape resolves without a candidate line", () => {
  // What the fix looks like once applied: SOURCE_COMMIT set as an ordinary
  // Coolify variable while RELEASE_SHA is still the empty ARG default.
  const env = (k: string) =>
    ({ RELEASE_SHA: "", SOURCE_COMMIT: "abc1234deadbeef" } as Record<string, string>)[k];
  assertEquals(resolveRelease(env), "abc1234deadbeef");
  assertEquals(isPlaceholderRelease(resolveRelease(env)), false);
});

Deno.test("US-2001: the boot diagnostic logs NAMES, never values", () => {
  // A SOURCE SCAN, deliberately, and this is the case where one is the right
  // instrument: what has to hold is a property of the CALL SITE, not of a
  // function. unreadReleaseCandidates already returns names only and is tested
  // above; nothing stopped main.ts from mapping those names back through
  // Deno.env.get() before logging them, and the sabotage run proved it —
  // rewriting the log line to emit [key, value] pairs left every behavioural
  // case green.
  //
  // This lands in a deploy log. A value there is whatever the key holds, in a
  // place it was never meant to be.
  const src = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  const start = code.indexOf("edge.boot.release_unknown");
  assert(start > -1, "the boot release diagnostic was removed");
  const block = code.slice(start, code.indexOf("});", start));

  assert(
    block.includes("unreadCandidates: candidates,"),
    "the diagnostic no longer logs the bare name list — check it is not " +
      "resolving those names back to their values before logging",
  );
  assert(
    !/Deno\.env\.get/.test(block),
    "the boot diagnostic reads env values inside the log payload; it must log " +
      "KEY NAMES only, because this line goes to a deploy log",
  );
  assert(
    !/toObject\(\)/.test(block),
    "the boot diagnostic dumps the environment into the log payload",
  );
});
