// US-266: fail-closed debug gating unit tests.
//
// Verifies edgeEnv()/isProduction()/isDebugAllowed() default to a SAFE
// (production, debug-off) posture and that no security-weakening flag can be
// honored while EDGE_ENV=production.
import { assert, assertEquals } from "@std/assert";
import {
  assertNoProdDebugFlags,
  edgeEnv,
  isDebugAllowed,
  isProduction,
} from "../lib/env.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = Deno.env.get(k);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("defaults to production (fail-closed) when EDGE_ENV unset", () => {
  withEnv({ EDGE_ENV: undefined, DENO_ENV: undefined }, () => {
    assertEquals(edgeEnv(), "production");
    assert(isProduction());
  });
});

Deno.test("EDGE_ENV is case/whitespace insensitive", () => {
  withEnv({ EDGE_ENV: "  Production  " }, () => assert(isProduction()));
  withEnv({ EDGE_ENV: "development" }, () => assert(!isProduction()));
});

Deno.test("isDebugAllowed is ALWAYS false in production, even with flag=true", () => {
  withEnv({ EDGE_ENV: "production", WEBHOOK_PAYOUT_DEBUG: "true" }, () => {
    assertEquals(isDebugAllowed("WEBHOOK_PAYOUT_DEBUG"), false);
  });
});

Deno.test("isDebugAllowed honors flag only outside production", () => {
  withEnv({ EDGE_ENV: "development", WEBHOOK_PAYOUT_DEBUG: "true" }, () => {
    assertEquals(isDebugAllowed("WEBHOOK_PAYOUT_DEBUG"), true);
  });
  withEnv({ EDGE_ENV: "development", WEBHOOK_PAYOUT_DEBUG: undefined }, () => {
    assertEquals(isDebugAllowed("WEBHOOK_PAYOUT_DEBUG"), false);
  });
  withEnv({ EDGE_ENV: "development", WEBHOOK_PAYOUT_DEBUG: "1" }, () => {
    // only the literal string "true" enables it
    assertEquals(isDebugAllowed("WEBHOOK_PAYOUT_DEBUG"), false);
  });
});

Deno.test("assertNoProdDebugFlags warns (non-fatal) when a flag is set in prod", () => {
  const orig = console.error;
  let warned = "";
  console.error = (...args: unknown[]) => {
    warned += args.join(" ");
  };
  try {
    withEnv({ EDGE_ENV: "production", WEBHOOK_PAYOUT_DEBUG: "true" }, () => {
      assertNoProdDebugFlags();
    });
  } finally {
    console.error = orig;
  }
  assert(warned.includes("WEBHOOK_PAYOUT_DEBUG"));
  assert(warned.includes("IGNORED"));
});

Deno.test("assertNoProdDebugFlags is silent outside production", () => {
  const orig = console.error;
  let warned = "";
  console.error = (...args: unknown[]) => {
    warned += args.join(" ");
  };
  try {
    withEnv({ EDGE_ENV: "development", WEBHOOK_PAYOUT_DEBUG: "true" }, () => {
      assertNoProdDebugFlags();
    });
  } finally {
    console.error = orig;
  }
  assertEquals(warned, "");
});
