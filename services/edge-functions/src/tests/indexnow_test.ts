// Unit tests for the IndexNow client (US-296). Mocks global fetch to assert the
// payload shape and that failures never throw into the caller.
//
// Run: deno test --allow-net --allow-env

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { submitUrls, certificateUrl, indexNowKey } from "../lib/indexnow.ts";

const realFetch = globalThis.fetch;

function restore() {
  globalThis.fetch = realFetch;
}

Deno.test("submitUrls no-ops (returns null, no fetch) when INDEXNOW_KEY unset", async () => {
  Deno.env.delete("INDEXNOW_KEY");
  let called = false;
  globalThis.fetch = () => {
    called = true;
    return Promise.resolve(new Response("", { status: 200 }));
  };
  try {
    const status = await submitUrls(["https://gradethread.com/cert/abc"]);
    assertEquals(status, null);
    assert(!called, "fetch must not be called when no key is configured");
  } finally {
    restore();
  }
});

Deno.test("submitUrls POSTs the correct IndexNow payload", async () => {
  Deno.env.set("INDEXNOW_KEY", "deadbeefdeadbeefdeadbeefdeadbeef");
  Deno.env.set("PUBLIC_SITE_URL", "https://gradethread.com");
  let captured: { url: string; body: unknown } | null = null;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    return Promise.resolve(new Response("", { status: 200 }));
  };
  try {
    const status = await submitUrls([
      "https://gradethread.com/cert/abc",
      "https://gradethread.com/cert/abc", // duplicate → deduped
      "not-a-url", // dropped
    ]);
    assertEquals(status, 200);
    assert(captured, "fetch should have been called");
    const { url, body } = captured as unknown as {
      url: string;
      body: Record<string, unknown>;
    };
    assertEquals(url, "https://api.indexnow.org/indexnow");
    assertEquals(body.host, "gradethread.com");
    assertEquals(body.key, "deadbeefdeadbeefdeadbeefdeadbeef");
    assertEquals(
      body.keyLocation,
      "https://gradethread.com/deadbeefdeadbeefdeadbeefdeadbeef.txt",
    );
    assertEquals(body.urlList, ["https://gradethread.com/cert/abc"]);
  } finally {
    Deno.env.delete("INDEXNOW_KEY");
    restore();
  }
});

Deno.test("submitUrls swallows fetch errors (never throws)", async () => {
  Deno.env.set("INDEXNOW_KEY", "deadbeefdeadbeefdeadbeefdeadbeef");
  globalThis.fetch = () => Promise.reject(new Error("network down"));
  try {
    const status = await submitUrls(["https://gradethread.com/cert/abc"]);
    assertEquals(status, null); // error swallowed → null, no throw
  } finally {
    Deno.env.delete("INDEXNOW_KEY");
    restore();
  }
});

Deno.test("certificateUrl + indexNowKey helpers", () => {
  Deno.env.set("PUBLIC_SITE_URL", "https://gradethread.com");
  assertEquals(
    certificateUrl("abc-123"),
    "https://gradethread.com/cert/abc-123",
  );
  Deno.env.delete("INDEXNOW_KEY");
  assertEquals(indexNowKey(), null);
  Deno.env.set("INDEXNOW_KEY", "  abc  ");
  assertEquals(indexNowKey(), "abc");
  Deno.env.delete("INDEXNOW_KEY");
});
