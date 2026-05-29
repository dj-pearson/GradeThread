import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Plain .mjs helper with no type declarations — import via the untyped
// specifier so tsc doesn't demand a .d.ts for a build/CI script.
// @ts-expect-error: no declaration file for the .mjs helper
import * as submitMod from "../../scripts/submit-indexnow.mjs";

const parseArgs = submitMod.parseArgs as (argv: string[]) => {
  dryRun: boolean;
  manifestPath: string;
};
const buildPayload = submitMod.buildPayload as (
  manifest: unknown,
  key: string,
) => { host: string; key: string; keyLocation: string; urlList: string[] } | null;
const submitIndexNow = submitMod.submitIndexNow as (
  opts: Record<string, unknown>,
) => Promise<Record<string, unknown> & { payload?: { urlList: string[] } }>;
const INDEXNOW_ENDPOINT = submitMod.INDEXNOW_ENDPOINT as string;

// US-297: deploy-time IndexNow submitter for static routes. The CLI shells out,
// but the core is pure + injectable so we can unit-test it without a network.

const MANIFEST = {
  siteUrl: "https://gradethread.com",
  generatedAt: "2026-05-29T00:00:00.000Z",
  routes: [
    { path: "/", priority: 1.0 },
    { path: "/privacy", priority: 0.3 },
    { path: "/privacy", priority: 0.3 }, // dup → deduped
    { path: "relative-bad" }, // dropped (not absolute)
  ],
};

function writeManifest(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "indexnow-"));
  const p = join(dir, "seo-manifest.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("parseArgs", () => {
  it("defaults to no dry-run + dist manifest", () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      manifestPath: "dist/seo-manifest.json",
    });
  });
  it("parses --dry-run and --manifest", () => {
    expect(parseArgs(["--dry-run", "--manifest", "x.json"])).toEqual({
      dryRun: true,
      manifestPath: "x.json",
    });
    expect(parseArgs(["-n"]).dryRun).toBe(true);
  });
});

describe("buildPayload", () => {
  it("maps registry paths to absolute URLs, dedupes, drops non-absolute", () => {
    const payload = buildPayload(MANIFEST, "KEY123");
    expect(payload).not.toBeNull();
    if (!payload) throw new Error("payload null");
    expect(payload.host).toBe("gradethread.com");
    expect(payload.key).toBe("KEY123");
    expect(payload.keyLocation).toBe("https://gradethread.com/KEY123.txt");
    expect(payload.urlList).toEqual([
      "https://gradethread.com/",
      "https://gradethread.com/privacy",
    ]);
  });
  it("returns null when there are no usable routes", () => {
    expect(buildPayload({ siteUrl: "https://x", routes: [] }, "K")).toBeNull();
    expect(buildPayload({}, "K")).toBeNull();
  });
});

describe("submitIndexNow", () => {
  it("skips (no fetch) when key is missing and not dry-run", async () => {
    const fetchImpl = vi.fn();
    const res = await submitIndexNow({
      manifestPath: writeManifest(MANIFEST),
      key: "",
      fetchImpl,
      log: () => {},
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("no-key");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips when the manifest is unreadable", async () => {
    const res = await submitIndexNow({
      manifestPath: "/nonexistent/seo-manifest.json",
      key: "KEY",
      fetchImpl: vi.fn(),
      log: () => {},
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("no-manifest");
  });

  it("dry-run prints the payload and does not call fetch", async () => {
    const fetchImpl = vi.fn();
    const res = await submitIndexNow({
      manifestPath: writeManifest(MANIFEST),
      dryRun: true,
      fetchImpl,
      log: () => {},
    });
    expect(res.dryRun).toBe(true);
    expect(res.payload?.urlList).toHaveLength(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the payload to the IndexNow endpoint with a key", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const res = await submitIndexNow({
      manifestPath: writeManifest(MANIFEST),
      key: "KEY123",
      fetchImpl,
      log: () => {},
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(url).toBe(INDEXNOW_ENDPOINT);
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.urlList).toEqual([
      "https://gradethread.com/",
      "https://gradethread.com/privacy",
    ]);
    expect(res.status).toBe(200);
    expect(res.count).toBe(2);
  });

  it("never throws on fetch failure (non-blocking)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const res = await submitIndexNow({
      manifestPath: writeManifest(MANIFEST),
      key: "KEY123",
      fetchImpl,
      log: () => {},
    });
    expect(res.error).toContain("network down");
  });
});
