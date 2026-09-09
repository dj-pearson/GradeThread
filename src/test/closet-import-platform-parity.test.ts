import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLOSET_IMPORT_PLATFORMS,
  FREE_CLOSET_IMPORT_ROWS,
} from "@/lib/marketplace-disclosure";

// US-3261 / US-3263. Two lists and one number, stated in two places each,
// because the web bundle cannot import from the Deno edge service.
//
// This is the same arrangement MARKETPLACE_EXTENSION_FLOW uses against the
// extension's selectors, and it exists for the same reason: the last time these
// drifted, Grailed closet import was added to the edge (US-3155) and to nothing
// else, so the web card never offered it and the run row it would have written
// violated a CHECK constraint anyway. Neither failure was visible from either
// side alone.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const EDGE_MODULE = "services/edge-functions/src/lib/closet-import.ts";

function edgePlatforms(): string[] {
  const src = read(EDGE_MODULE);
  const m = src.match(/CLOSET_IMPORT_PLATFORMS\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error(`No CLOSET_IMPORT_PLATFORMS in ${EDGE_MODULE}`);
  return [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? "");
}

describe("the closet-import platform list (US-3261)", () => {
  it("the web offers exactly what the edge accepts", () => {
    expect([...CLOSET_IMPORT_PLATFORMS].sort()).toEqual(edgePlatforms().sort());
  });

  it("every platform the web offers has a photo-host allowlist on the edge", () => {
    // A platform with no allowlist imports zero photos and says nothing about
    // why, which is a worse failure than not offering it at all.
    const src = read(EDGE_MODULE);
    const block = src.match(
      /CLOSET_IMPORT_PHOTO_HOSTS[\s\S]*?=\s*\{([\s\S]*?)\n\};/,
    );
    const body = block?.[1] ?? "";
    expect(body, "CLOSET_IMPORT_PHOTO_HOSTS not found").not.toBe("");
    for (const platform of CLOSET_IMPORT_PLATFORMS) {
      expect(body, `${platform} has no photo hosts`).toContain(`${platform}:`);
    }
  });
});

describe("the free-plan import bound (US-3263)", () => {
  it("the web states the same number the edge enforces", () => {
    const src = read(EDGE_MODULE);
    const m = src.match(/FREE_CLOSET_IMPORT_ROWS\s*=\s*(\d+)/);
    expect(m, `No FREE_CLOSET_IMPORT_ROWS in ${EDGE_MODULE}`).not.toBeNull();
    expect(Number(m?.[1] ?? 0)).toBe(FREE_CLOSET_IMPORT_ROWS);
  });

  it("the edge trims from the account's entitlement, not from the request", () => {
    // The browser and the extension both send a batch; neither is trusted to
    // have applied the bound. applyFreeTierCap takes the entitlement as its
    // argument and the route resolves that from the users row.
    const route = read(
      "services/edge-functions/src/routes/flipdesk-closet-import.ts",
    );
    expect(route).toContain("applyFreeTierCap(allRows, sellerEnabled)");
    expect(route).toMatch(/const sellerEnabled = await sellerGate\(ownerId\)/);
    // And the old outright refusal is gone: a 402 here is what hid the feature
    // from the person deciding whether to buy it.
    expect(route).not.toContain('feature: "closet_import"');
  });
});
