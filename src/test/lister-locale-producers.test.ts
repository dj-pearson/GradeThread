// US-2777. `ListerPayload.locale` was built end to end and nothing ever set it.
//
// THE DEFECT SHAPE, because it is the reason this file exists rather than one
// more assertion in lister-guard.test.ts. The unwired-module gate catches a
// MODULE nobody imports. This was one level down: a FIELD nobody assigns, in a
// module everybody imports, where every layer that CONSUMES it is correct. Every
// existing test passed. The only visible symptom was a French seller watching a
// form fill on vinted.com.
//
// So the assertions here are about PRODUCERS, not about behaviour:
//   1. Every platform the extension gives a `locales` map has an entry in the
//      SPA's copy of that list, and the two lists are identical.
//   2. Each platform's default in the SPA is the `newListingUrl` the extension
//      would actually navigate to with no locale.
//   3. Somebody assigns `locale` on the direct path, and somebody assigns it on
//      the queued path. Both, named by file, because they diverged for months
//      precisely because the field was optional on both and set on neither.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LISTER_LOCALES,
  LISTER_LOCALE_DEFAULT,
  MULTI_DOMAIN_PLATFORMS,
} from "@/lib/lister-locales";

const ROOT = resolve(import.meta.dirname, "../..");

interface BundledFlow {
  newListingUrl?: string;
  locales?: Record<string, string>;
}

let bundled: Record<string, BundledFlow>;

beforeAll(() => {
  // selectors.js is a UMD file that assigns to `self`. The SPA cannot import
  // it, which is exactly why its locale list is duplicated in src/ — and why
  // this test loads it the same way src/test/lister-guard.test.ts does.
  const src = readFileSync(
    resolve(ROOT, "extension-unified/lister/selectors.js"),
    "utf8",
  );
  const scope: { GT_LISTER_SELECTORS?: Record<string, BundledFlow> } = {};
  new Function("self", "globalThis", src)(scope, scope);
  expect(scope.GT_LISTER_SELECTORS, "selectors.js did not assign").toBeTruthy();
  bundled = scope.GT_LISTER_SELECTORS!;
});

/** Every source file that could plausibly build a payload or a queue row. */
function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("the SPA's locale list matches the extension's (US-2777)", () => {
  it("names exactly the platforms that have a locales map", () => {
    const withLocales = Object.entries(bundled)
      .filter(([, flow]) => flow && flow.locales)
      .map(([platform]) => platform)
      .sort();
    expect(withLocales).toEqual([...MULTI_DOMAIN_PLATFORMS].sort());
  });

  it.each(MULTI_DOMAIN_PLATFORMS)("%s covers the same domains", (platform) => {
    const theirs = Object.keys(bundled[platform]!.locales!).sort();
    const ours = [...LISTER_LOCALES[platform]].sort();
    expect(ours).toEqual(theirs);
  });

  it.each(MULTI_DOMAIN_PLATFORMS)(
    "%s's default is the domain a locale-less job actually opens",
    (platform) => {
      const fallbackUrl = bundled[platform]!.newListingUrl;
      const defaultKey = LISTER_LOCALE_DEFAULT[platform];
      // The default KEY must resolve, through the bundled map, to the same URL
      // the extension uses when no locale is named. Otherwise "(default)" in the
      // picker labels a domain the seller does not actually get.
      expect(bundled[platform]!.locales![defaultKey]).toBe(fallbackUrl);
    },
  );
});

describe("ListerPayload.locale has a producer on BOTH paths (US-2777)", () => {
  it("the direct send reads the seller's setting", () => {
    const kit = read("src/components/flipdesk/listing-kit.tsx");
    expect(
      kit.includes("locale: localeForPlatform("),
      "listing-kit.tsx no longer sets `locale` on the payload it hands the " +
        "extension. Without it every send opens the platform's default domain " +
        "and a seller outside that market silently lands on the wrong site.",
    ).toBe(true);
  });

  it("the queued send is stamped by the edge, for every client", () => {
    // ⚠ THIS USED TO PIN THE FILE AND THE FUNCTION NAME, and it broke the day
    // US-3065 extracted the enqueue path into lib/extension-enqueue.ts so the
    // Claude connector could call it without a second copy. Nothing about the
    // PROPERTY changed: the stamping still happens on the server, still before
    // the insert, and is still the only place a queued job learns the seller's
    // country. Pinning WHERE it lives rather than WHAT must hold made a correct
    // refactor look like a regression.
    //
    // The property is: whatever function enqueues, it stamps the locale onto
    // the payload it writes. So the assertion follows the enqueue path to
    // wherever it is, and requires the stamp and the insert in that order.
    const enqueue = read(
      "services/edge-functions/src/lib/extension-enqueue.ts",
    );
    // ⚠ THE CALL SITE, NOT THE DEFINITION. The first version of this searched
    // for /stampSellerLocale\(/, which matches the `export async function`
    // line — so deleting the CALL left the guard green. Caught by sabotage;
    // a scan that matches its own definition proves the function exists and
    // nothing about whether anything runs it.
    const stampAt = enqueue.search(/await stampSellerLocale\(/);
    const insertAt = enqueue.search(/\.insert\(/);
    expect(
      stampAt,
      "nothing stamps the seller's locale onto a queued payload. Web, iOS and " +
        "Android all enqueue an empty payload, so the server is the ONLY place " +
        "a queued job can learn the seller's country.",
    ).toBeGreaterThan(-1);
    expect(insertAt, "the enqueue path no longer inserts a row").toBeGreaterThan(-1);
    expect(
      stampAt,
      "the locale is stamped AFTER the insert, so its answer is thrown away",
    ).toBeLessThan(insertAt);
    expect(
      /payload: payloadValue,/.test(enqueue),
      "the insert no longer writes the STAMPED payload, so stampSellerLocale " +
        "runs and its answer is discarded.",
    ).toBe(true);

    // And the HTTP route still reaches it rather than growing its own insert.
    const route = read(
      "services/edge-functions/src/routes/flipdesk-extension-queue.ts",
    );
    expect(
      /enqueueExtensionWork\(/.test(route),
      "the queue route no longer delegates to the extracted enqueue path",
    ).toBe(true);
  });

  it("the setting is actually written by a picker", () => {
    const picker = read("src/components/flipdesk/lister-locale-picker.tsx");
    expect(picker).toContain("lister_locales:");
    expect(picker).toContain("normalizeLocaleSelection(");
  });
});
