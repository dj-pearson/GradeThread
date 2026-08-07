// US-1880 — tests for the adapter verification mechanism (scripts/adapter-verify.mjs).
//
// Two things are worth proving here and only one of them is obvious.
//
//  * The config EDITS are scoped: flipping one adapter's `verified` must not
//    touch its neighbours, and the version bump must never sort below the
//    current version (US-1879 makes every install ignore a hosted config that
//    does).
//  * The SNIPPET works. It is generated text a human pastes into a browser, so
//    nothing else in the build can tell whether it runs — and a verification
//    tool that silently reports PASS is worse than no tool. These tests execute
//    the generated source against a stub DOM and assert the verdict flips when
//    the page is wrong, using the REAL shipped Poshmark adapter (whose dead
//    URL-upgrade regex is the defect this whole story exists to fix).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildVerifyFunctionSource,
  buildVerifySnippet,
  nextVersion,
  parseBundledConfig,
  readAdapterVerified,
  readTopLevelString,
  setAdapterVerified,
  setTopLevelString,
} from "./lib/adapter-verification.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED = path.join(root, "extension-unified", "research", "selectors.js");
const HOSTED = path.join(root, "public", "extension", "marketplace-selectors.json");
const IMAGE_UTILS = path.join(root, "extension-unified", "research", "image-utils.js");

const bundledSrc = fs.readFileSync(BUNDLED, "utf8");
const hostedSrc = fs.readFileSync(HOSTED, "utf8");
const imageUtilsSrc = fs.readFileSync(IMAGE_UTILS, "utf8");
const config = parseBundledConfig(bundledSrc);

// The extension's own compareVersions, so the ordering invariant is checked
// against the rule the extension actually applies rather than a copy of it.
const IMG = (() => {
  const selfObj = {};
  new Function("self", "module", imageUtilsSrc)(selfObj, undefined);
  return selfObj.GT_CC_IMG;
})();

describe("config edits", () => {
  it("reads the same verified flags out of both config files", () => {
    for (const key of Object.keys(config.adapters)) {
      expect(readAdapterVerified(bundledSrc, key, { json: false })).toBe(config.adapters[key].verified);
      expect(readAdapterVerified(hostedSrc, key, { json: true })).toBe(config.adapters[key].verified);
    }
  });

  it("flips exactly one adapter and leaves the others alone", () => {
    const patched = setAdapterVerified(bundledSrc, "poshmark", true, { json: false });
    const after = parseBundledConfig(patched);
    expect(after.adapters.poshmark.verified).toBe(true);
    for (const key of Object.keys(config.adapters)) {
      if (key === "poshmark") continue;
      expect(after.adapters[key].verified).toBe(config.adapters[key].verified);
    }
    // Nothing but that one boolean moved.
    expect(patched.length).toBe(bundledSrc.length - "false".length + "true".length);
  });

  it("flips the JSON copy identically", () => {
    const patched = setAdapterVerified(hostedSrc, "poshmark", true, { json: true });
    const after = JSON.parse(patched);
    expect(after.adapters.poshmark.verified).toBe(true);
    expect(after.adapters.ebay.verified).toBe(true);
    expect(after.adapters.grailed.verified).toBe(false);
  });

  it("refuses a no-op flip rather than reporting success", () => {
    expect(() => setAdapterVerified(bundledSrc, "ebay", true, { json: false })).toThrow(/already verified:true/);
  });

  it("rejects an unknown adapter instead of editing something else", () => {
    expect(() => setAdapterVerified(bundledSrc, "etsy", true, { json: false })).toThrow(/not found/);
  });

  it("updates top-level version and lastVerified in both formats", () => {
    const js = setTopLevelString(
      setTopLevelString(bundledSrc, "version", "2026.09.3", { json: false }),
      "lastVerified",
      "2026-09-14",
      { json: false },
    );
    const parsed = parseBundledConfig(js);
    expect(parsed.version).toBe("2026.09.3");
    expect(parsed.lastVerified).toBe("2026-09-14");
    // configUrl (the adjacent top-level string) is untouched.
    expect(parsed.configUrl).toBe(config.configUrl);

    const json = setTopLevelString(
      setTopLevelString(hostedSrc, "version", "2026.09.3", { json: true }),
      "lastVerified",
      "2026-09-14",
      { json: true },
    );
    expect(JSON.parse(json).version).toBe("2026.09.3");
    expect(JSON.parse(json).lastVerified).toBe("2026-09-14");
  });

  it("reads the shipped version out of both files and they agree", () => {
    expect(readTopLevelString(bundledSrc, "version", { json: false })).toBe(
      readTopLevelString(hostedSrc, "version", { json: true }),
    );
  });
});

describe("nextVersion", () => {
  it("restarts at .1 in a new month and increments within one", () => {
    expect(nextVersion("2026.07.8", "2026-08-07")).toBe("2026.08.1");
    expect(nextVersion("2026.08.1", "2026-08-09")).toBe("2026.08.2");
  });

  it("never sorts below the current version, even for an earlier date", () => {
    // A backdated clock would otherwise publish a config every install ignores.
    const bumped = nextVersion("2026.07.8", "2026-06-01");
    expect(IMG.compareVersions(bumped, "2026.07.8")).toBe(1);
    expect(bumped).toBe("2026.07.9");
  });

  it("is always strictly greater than the input, for every shipped-shape case", () => {
    for (const [current, date] of [
      ["2026.07.8", "2026-08-07"],
      ["2026.07.8", "2026-07-31"],
      ["2026.12.4", "2027-01-02"],
      ["2026.12.4", "2026-01-02"],
      ["2026.08.1", "2026-08-01"],
    ]) {
      expect(IMG.compareVersions(nextVersion(current, date), current)).toBe(1);
    }
  });

  it("rejects a malformed date rather than inventing a version", () => {
    expect(() => nextVersion("2026.07.8", "August 7")).toThrow(/YYYY-MM-DD/);
  });
});

// ── the snippet actually runs ───────────────────────────────────────────────

// A selector engine is not needed: the snippet only ever queries the adapter's
// own configured selectors, so the stub maps selector string -> elements. What
// is under test is the extraction/upgrade/verdict logic, not CSS matching.
function makeDom({ selectors = {}, host, pathname }) {
  const document = {
    querySelectorAll(sel) {
      return selectors[sel] || [];
    },
    querySelector(sel) {
      return (selectors[sel] || [])[0] || null;
    },
  };
  return { document, location: { host, pathname } };
}

function img(attrs) {
  return {
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    textContent: "",
  };
}

function text(value) {
  return { getAttribute: () => null, textContent: value };
}

// Resolves any URL to a size, so "did the upgrade deliver more pixels" is
// measurable without network access. Unknown URLs fail to load.
function makeImageClass(sizes) {
  return class FakeImage {
    set src(url) {
      const size = sizes[url];
      queueMicrotask(() => {
        if (size) {
          this.naturalWidth = size[0];
          this.naturalHeight = size[1];
          this.onload?.();
        } else {
          this.onerror?.();
        }
      });
    }
  };
}

function runSnippet(adapterKey, dom, ImageClass) {
  const source = buildVerifyFunctionSource({
    adapterKey,
    adapter: config.adapters[adapterKey],
    version: config.version,
    imageUtilsSrc,
  });
  const quietConsole = { log() {}, table() {} };
  const factory = new Function(
    "document",
    "location",
    "Image",
    "console",
    "setTimeout",
    `return (${source});`,
  );
  return factory(dom.document, dom.location, ImageClass, quietConsole, setTimeout)();
}

// A real CloudFront listing-photo shape: the size lives in the FILENAME prefix,
// which is what the fixed urlUpgrade rule keys on.
const POSH_THUMB = "https://di2ponv0v5otw.cloudfront.net/posts/2026/05/12/6459ab/s_6459abcdef0123456789.jpg";
const POSH_LARGE = "https://di2ponv0v5otw.cloudfront.net/posts/2026/05/12/6459ab/l_6459abcdef0123456789.jpg";
const POSH_THUMB_2 = "https://di2ponv0v5otw.cloudfront.net/posts/2026/05/12/6459ab/s_aaaabbbbccccdddd1111.jpg";
const POSH_LARGE_2 = "https://di2ponv0v5otw.cloudfront.net/posts/2026/05/12/6459ab/l_aaaabbbbccccdddd1111.jpg";

function poshmarkPage(overrides = {}) {
  return makeDom({
    host: "poshmark.com",
    pathname: "/listing/Vintage-Denim-Jacket-6459abcdef",
    selectors: {
      ".slideshow img": [img({ src: POSH_THUMB }), img({ src: POSH_THUMB_2 })],
      "h1.listing__title": [text("Vintage Levis Denim Jacket")],
      "a[data-et-name='brand']": [text("Levi's")],
      "[data-et-name='seller_username']": [text("thriftco")],
      ...overrides,
    },
  });
}

const POSH_SIZES = {
  [POSH_THUMB]: [200, 250],
  [POSH_LARGE]: [1200, 1500],
  [POSH_THUMB_2]: [200, 250],
  [POSH_LARGE_2]: [1200, 1500],
};

describe("the generated snippet", () => {
  it("passes on a healthy Poshmark listing and reports the upgraded pixels", async () => {
    const result = await runSnippet("poshmark", poshmarkPage(), makeImageClass(POSH_SIZES));
    expect(result.verdict).toBe("PASS");
    expect(result.fails).toBe(0);
    expect(result.probes.map((p) => p.upgraded)).toEqual([POSH_LARGE, POSH_LARGE_2]);
    expect(result.probes[0].after).toEqual({ w: 1200, h: 1500 });
    expect(result.probes[0].before).toEqual({ w: 200, h: 250 });
  });

  // The point of the whole exercise: a urlUpgrade rule that matches nothing is
  // invisible in the config and fatal in production. Verified by MUTATION —
  // re-running with the old, dead pattern must fail.
  it("fails when the urlUpgrade rule matches nothing (the pre-US-1880 regex)", async () => {
    const deadRule = JSON.parse(JSON.stringify(config.adapters.poshmark));
    deadRule.urlUpgrade = { pattern: "/s_[a-z0-9]+/", replacement: "/l_", flags: "i" };
    const source = buildVerifyFunctionSource({
      adapterKey: "poshmark",
      adapter: deadRule,
      version: config.version,
      imageUtilsSrc,
    });
    const dom = poshmarkPage();
    const factory = new Function(
      "document",
      "location",
      "Image",
      "console",
      "setTimeout",
      `return (${source});`,
    );
    const result = await factory(
      dom.document,
      dom.location,
      makeImageClass(POSH_SIZES),
      { log() {}, table() {} },
      setTimeout,
    )();

    expect(result.verdict).toBe("FAIL");
    const row = result.rows.find((r) => r.check === "urlUpgrade rewrote URLs");
    expect(row.status).toBe("FAIL");
    expect(row.detail).toMatch(/matched NOTHING/);
    // …and it is caught for the right reason: the graded images stayed thumbnails.
    const fullRes = result.rows.find((r) => r.check.startsWith("images are full-res"));
    expect(fullRes.detail).toBe("0 of 2");
  });

  it("distinguishes 'no gallery selector matched' from 'matched but no URL'", async () => {
    const noGallery = await runSnippet(
      "poshmark",
      makeDom({ host: "poshmark.com", pathname: "/listing/x", selectors: {} }),
      makeImageClass({}),
    );
    expect(noGallery.rows.find((r) => r.check === "gallery selector matched").status).toBe("FAIL");

    // Elements present, but carrying only a lazy-load placeholder in an attribute
    // the adapter does not read — the imageAttrs/urlUpgrade failure mode.
    const noUrls = await runSnippet(
      "poshmark",
      poshmarkPage({ ".slideshow img": [img({ "data-lazy": POSH_THUMB })] }),
      makeImageClass(POSH_SIZES),
    );
    expect(noUrls.rows.find((r) => r.check === "gallery selector matched").status).toBe("PASS");
    const urlRow = noUrls.rows.find((r) => r.check === "gallery elements yielded URLs");
    expect(urlRow.status).toBe("FAIL");
    expect(urlRow.detail).toMatch(/imageAttrs \/ urlUpgrade/);
  });

  it("fails on the wrong host or a non-listing page", async () => {
    const wrong = await runSnippet(
      "poshmark",
      makeDom({ host: "example.com", pathname: "/about", selectors: {} }),
      makeImageClass({}),
    );
    expect(wrong.rows.find((r) => r.check === "host matches adapter").status).toBe("FAIL");
    expect(wrong.rows.find((r) => r.check === "detected as a listing page").status).toBe("FAIL");
  });

  it("treats a missing title as a failure and a missing optional field as a warning", async () => {
    const bare = makeDom({
      host: "poshmark.com",
      pathname: "/listing/x",
      selectors: { ".slideshow img": [img({ src: POSH_THUMB })] },
    });
    const result = await runSnippet("poshmark", bare, makeImageClass(POSH_SIZES));
    expect(result.rows.find((r) => r.check === "title").status).toBe("FAIL");
    expect(result.rows.find((r) => r.check === "brandSelectors").status).toBe("WARN");
  });

  it("reports a load failure rather than silently scoring it as full-res", async () => {
    // The upgraded URL 404s — a plausible outcome of a wrong upgrade rule.
    const sizes = { [POSH_THUMB]: [200, 250], [POSH_THUMB_2]: [200, 250] };
    const result = await runSnippet("poshmark", poshmarkPage(), makeImageClass(sizes));
    const loadRow = result.rows.find((r) => r.check === "upgraded URLs load");
    expect(loadRow.status).toBe("FAIL");
    expect(loadRow.detail).toBe("0 of 2 loaded");
    expect(result.verdict).toBe("FAIL");
  });

  it("runs against every shipped adapter, not just the one under test", async () => {
    for (const key of Object.keys(config.adapters)) {
      const result = await runSnippet(
        key,
        makeDom({ host: "example.invalid", pathname: "/", selectors: {} }),
        makeImageClass({}),
      );
      expect(result.adapter).toBe(key);
      expect(result.verdict).toBe("FAIL"); // nothing matches on a blank page
    }
  });
});

describe("the pasted artifact", () => {
  it("is a self-contained script carrying the shipped helpers verbatim", () => {
    const snippet = buildVerifySnippet({
      adapterKey: "grailed",
      adapter: config.adapters.grailed,
      version: config.version,
      imageUtilsSrc,
    });
    expect(snippet).toContain("(async function () {");
    expect(snippet.trimEnd().endsWith("})();")).toBe(true);
    // The real helper source, not a paraphrase of it.
    expect(snippet).toContain("function srcsetLargest(srcset)");
    expect(snippet).toContain("function applyUrlUpgrade(url, upgrade)");
    expect(snippet).toContain(`const KEY = "grailed";`);
    expect(snippet).toContain(config.version);
    // No import/require — it has to run in a bare DevTools console.
    expect(snippet).not.toMatch(/^\s*(import|require)\s/m);
  });

  it("refuses to build from anything but the real image-utils source", () => {
    expect(() =>
      buildVerifySnippet({
        adapterKey: "grailed",
        adapter: config.adapters.grailed,
        version: config.version,
        imageUtilsSrc: "// not the helpers",
      }),
    ).toThrow(/real extension-unified/);
  });
});
