import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLOSET_IMPORT_PLATFORMS,
  closetImportPlatformSentence,
  FREE_CLOSET_IMPORT_ROWS,
  isClosetImportPlatform,
} from "@/lib/marketplace-disclosure";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { closetImportFailureText } from "@/lib/lister-extension";

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

describe("the closet-import completion analytics (US-3154)", () => {
  // Found while checking what a FOURTH platform would need. The two lists above
  // are guarded; a third copy of the same list was not.
  //
  // src/pages/flipdesk/import.tsx gated both closet events on
  // `origin !== "poshmark" && origin !== "mercari"`, written when those were the
  // only two. US-3155 added Grailed to the edge and US-3261 added it to the web
  // card, and neither touched this line -- so every Grailed closet import since
  // has fired no `closet_import_completed` and no `closet_import_first_item`.
  // The funnel simply had no Grailed in it, which reads exactly like nobody
  // importing a Grailed closet.
  it("every platform the web offers is a member the gate recognises", () => {
    for (const platform of CLOSET_IMPORT_PLATFORMS) {
      expect(isClosetImportPlatform(platform), `${platform} not recognised`).toBe(true);
    }
    expect(isClosetImportPlatform("ebay")).toBe(false);
    expect(isClosetImportPlatform(undefined)).toBe(false);
  });

  it("the import page gates the events on the list, not on named platforms", () => {
    const page = read("src/pages/flipdesk/import.tsx");
    const fn = page.slice(
      page.indexOf("const recordClosetCompletion"),
      page.indexOf("// Poll the run until it terminalizes"),
    );
    expect(fn, "recordClosetCompletion not found in import.tsx").not.toBe("");
    expect(fn).toContain("isClosetImportPlatform(");
    for (const platform of CLOSET_IMPORT_PLATFORMS) {
      expect(
        fn,
        `recordClosetCompletion names "${platform}" literally; a fifth platform ` +
          "would be dropped from the funnel the same way Grailed was",
      ).not.toContain(`"${platform}"`);
    }
  });
});

describe("the supported-marketplace sentence (US-3154)", () => {
  // Four hand-written copies of one list: the edge route's 400, this bundle's
  // failure copy, the extension background's refusal and the card's prose. The
  // day a fourth marketplace lands, three of them are wrong and no build fails.
  // All four are built from a list now; these hold that they stay built.
  it("names every platform the web offers", () => {
    const sentence = closetImportPlatformSentence();
    for (const platform of CLOSET_IMPORT_PLATFORMS) {
      expect(sentence, `${sentence} omits ${platform}`).toContain(
        MARKETPLACE_LABELS[platform],
      );
    }
    expect(closetImportFailureText("unsupported", "poshmark")).toBe(
      `Closet import supports ${sentence}.`,
    );
  });

  it("the edge and the extension build theirs rather than typing it", () => {
    const route = read("services/edge-functions/src/routes/flipdesk-closet-import.ts");
    expect(route).toContain("closetImportPlatformSentence()");
    const bg = read("extension-unified/background.js");
    expect(bg).toContain("closetImportSupportedSentence()");
    // The extension's copy reads its own bundled adapters, so an adapter that
    // ships without the server accepting it cannot be named as supported.
    expect(bg).toMatch(/function closetImportSupportedSentence[\s\S]{0,200}GT_CLOSET_IMPORT_SELECTORS/);
    for (const platform of CLOSET_IMPORT_PLATFORMS) {
      const label = MARKETPLACE_LABELS[platform];
      expect(
        route,
        `the edge route still types "${label}" into the unsupported message`,
      ).not.toContain(`Mercari and ${label}`);
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
    expect(route).toContain("applyFreeTierCap(allRows, sellerEnabled, {");
    expect(route).toMatch(/const sellerEnabled = await sellerGate\(ownerId\)/);
    // And the old outright refusal is gone: a 402 here is what hid the feature
    // from the person deciding whether to buy it.
    expect(route).not.toContain('feature: "closet_import"');
  });

  it("the row bound composes with the plan's own live-listing cap", () => {
    // A bound that applies to one READ and to nothing else is not a bound:
    // Import is a button, and twenty presses would put five hundred live
    // listings on a plan that allows twenty-five. The route reads how much of
    // the account's OWN cap is left and takes the smaller of the two.
    const route = read(
      "services/edge-functions/src/routes/flipdesk-closet-import.ts",
    );
    // Scoped to the owner, never to a request field (US-268).
    expect(route).toMatch(/capacityHeadroom\(ownerId, "activeListings"\)/);
    expect(route).toContain("freeRowAllowance(");
    // The entitled path still runs the real gate, unchanged.
    expect(route).toMatch(/capacity: \{ kind: "activeListings", delta: newRows \}/);
  });
});
