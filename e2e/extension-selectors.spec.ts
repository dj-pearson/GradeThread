import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// US-3063: resolve every shipped selector against a saved copy of the page.
//
// THE REGRESSION CLASS. Selector health has only ever been observable live —
// a human with a logged-in account pressing "Check selectors" in the popup — so
// a marketplace redesign is discovered by a seller whose cross-post silently
// did nothing. US-1875's delist bug shipped that way. A checked-in fixture
// makes the DOM testable with no account and no network.
//
// WHAT A FIXTURE CAN AND CANNOT TELL YOU. It is a photograph. This catches "our
// selectors no longer match the page we last saw", which is the whole of the
// regression class above, and it does NOT catch "the page changed this
// morning". The sidecar's capturedAt is there so a reader can see how old the
// answer is rather than assuming it is current.
//
// eBay HAS NO FIXTURE, ON PURPOSE. US-3042 removed DOM reading from the eBay
// path entirely: the extension sends an item id or a URL and the server
// resolves it through the Browse API. A fixture would imply there are eBay
// selectors to protect, and adding one is how that gets quietly reintroduced.
// There is an explicit assertion below rather than only this comment.
//
// NO DEV SERVER. page.setContent, so this project needs no webServer and no
// built SPA — see the `extension-selectors` project in playwright.config.ts.

// fileURLToPath, not new URL(...).pathname: the latter is absolute on Windows
// and RELATIVE on Linux, so the fixtures resolve on one platform and vanish on
// the other — and vanishing fixtures read as "nothing to check", not as an error.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension-unified");
const FIXTURES = join(EXT, "test", "fixtures", "dom");

/** Load a classic script that assigns onto `self` and hand back that scope. */
function loadGlobals(relPath: string): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  const src = readFileSync(join(EXT, relPath), "utf8");
  new Function("self", src)(scope);
  return scope;
}

interface ListerBlock {
  enabled?: boolean;
  version?: string;
  fields?: Record<string, string>;
  delist?: Record<string, unknown>;
  [k: string]: unknown;
}

interface ResearchAdapter {
  enabled?: boolean;
  gallery?: string[];
  title?: string[];
  price?: string[];
  [k: string]: unknown;
}

const LISTER = loadGlobals("lister/selectors.js").GT_LISTER_SELECTORS as
  Record<string, ListerBlock>;
const RESEARCH = (loadGlobals("research/selectors.js").GT_CC_CONFIG as {
  adapters: Record<string, ResearchAdapter>;
}).adapters;

/** Every captured fixture on disk, as {platform, flow}. */
function fixtures(): { platform: string; flow: string; html: string; meta: string }[] {
  if (!existsSync(FIXTURES)) return [];
  const out: { platform: string; flow: string; html: string; meta: string }[] = [];
  for (const platform of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!platform.isDirectory()) continue;
    const dir = join(FIXTURES, platform.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".html")) continue;
      out.push({
        platform: platform.name,
        flow: f.replace(/\.html$/, ""),
        html: join(dir, f),
        meta: join(dir, f.replace(/\.html$/, ".json")),
      });
    }
  }
  return out;
}

const FOUND = fixtures();

/**
 * A selector string in this repo is a comma-separated fallback list, and it
 * resolves when ANY branch matches. Counting branches individually would fail a
 * perfectly healthy config, since the later branches exist precisely because
 * the earlier ones stop matching.
 */
async function resolves(page: import("@playwright/test").Page, sel: string) {
  return await page.evaluate(
    (s) => document.querySelectorAll(s).length,
    sel,
  );
}

test.describe("US-3063: shipped selectors resolve against captured pages", () => {
  test("eBay has no DOM fixture, and that is deliberate", () => {
    // US-3042: the eBay path reads nothing off the page. An eBay fixture would
    // imply there are eBay selectors worth protecting, which is how DOM reading
    // gets reintroduced on that path.
    expect(
      FOUND.filter((f) => f.platform === "ebay"),
      "eBay reads nothing off the page (US-3042). A fixture here means someone " +
        "is scraping it again — delete the fixture, not this assertion.",
    ).toEqual([]);
  });

  test("the fixture set is reported, and an empty one is not a pass", () => {
    // A spec with no fixtures passes every other case vacuously and reads
    // exactly like a spec that verified something. Say which happened.
    const names = FOUND.map((f) => `${f.platform}/${f.flow}`).sort();
    console.log(
      names.length
        ? `[selector-fixtures] ${names.length}: ${names.join(", ")}`
        : "[selector-fixtures] NONE CAPTURED — every case below is skipped, " +
          "not passed. Run scripts/capture-selector-fixture.mjs (US-3063 AC8).",
    );
    test.skip(
      names.length === 0,
      "no fixtures captured yet — see scripts/capture-selector-fixture.mjs",
    );
    expect(names.length).toBeGreaterThan(0);
  });

  for (const fx of FOUND) {
    test.describe(`${fx.platform}/${fx.flow}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setContent(readFileSync(fx.html, "utf8"));
      });

      test("the sidecar names the selector version it was captured against", () => {
        expect(
          existsSync(fx.meta),
          `${fx.platform}/${fx.flow}.json is missing. Without it nobody can ` +
            `tell whether this fixture predates the selectors it is proving.`,
        ).toBe(true);
        const meta = JSON.parse(readFileSync(fx.meta, "utf8")) as {
          selectorsVersion?: string;
          capturedAt?: string;
          path?: string;
        };
        expect(meta.capturedAt, "the sidecar must record when it was taken")
          .toBeTruthy();
        // The URL must be a PATH. A full URL carries a query string that
        // identifies the account that captured it.
        expect(meta.path ?? "", `${fx.platform}: the sidecar stores a path only`)
          .not.toMatch(/^https?:/);

        const shipped = LISTER[fx.platform]?.version;
        if (shipped) {
          expect(
            meta.selectorsVersion,
            `recapture ${fx.platform} ${fx.flow} — selectors.js is at ` +
              `${shipped} and this fixture was taken against ` +
              `${meta.selectorsVersion}. A selector bump without a recapture ` +
              `means this spec is proving the OLD selectors against an OLD page.`,
          ).toBe(shipped);
        }
      });

      test("every enabled lister selector resolves", async ({ page }) => {
        const block = LISTER[fx.platform];
        test.skip(!block, `${fx.platform} has no lister block`);
        // A disabled platform is REPORTED, never failed: its selectors are
        // known-unverified and failing on them would make the suite red for a
        // flow nobody can run anyway.
        test.skip(
          block!.enabled !== true,
          `${fx.platform} lister is enabled:false — skipped, not failed`,
        );

        const fields = block!.fields ?? {};
        const missing: string[] = [];
        for (const [name, sel] of Object.entries(fields)) {
          if (typeof sel !== "string" || !sel) continue;
          if ((await resolves(page, sel)) === 0) missing.push(`${name}`);
        }
        expect(
          missing,
          `these ${fx.platform} field selectors match nothing in the ` +
            `${fx.flow} fixture. Either the page changed, or the fixture is ` +
            `the wrong flow for them.`,
        ).toEqual([]);
      });

      test("the research adapter finds a gallery and a title", async ({ page }) => {
        const adapter = RESEARCH[fx.platform];
        test.skip(!adapter, `${fx.platform} has no research adapter`);
        test.skip(
          adapter!.enabled !== true,
          `${fx.platform} research adapter is enabled:false`,
        );
        // Only the detail/research flows carry a gallery; a list FORM has none
        // and asserting one there would fail correct config.
        test.skip(
          fx.flow === "list",
          "a list form has no gallery — that is the detail fixture's job",
        );

        for (const key of ["gallery", "title"] as const) {
          const list = adapter![key];
          if (!Array.isArray(list) || list.length === 0) continue;
          const joined = list.join(", ");
          expect(
            await resolves(page, joined),
            `${fx.platform} ${key}: none of ${list.length} selector(s) matched`,
          ).toBeGreaterThan(0);
        }
      });

      test("the HOSTED config resolves too, not just the bundled one", async ({ page }) => {
        // background.js fetches public/extension/marketplace-selectors.json at
        // runtime and it overrides the bundled adapters. Proving only the
        // bundled ones leaves the config sellers actually run unverified.
        const hostedPath = join(
          ROOT,
          "public",
          "extension",
          "marketplace-selectors.json",
        );
        test.skip(!existsSync(hostedPath), "no hosted config in this checkout");
        const hosted = JSON.parse(readFileSync(hostedPath, "utf8")) as {
          adapters?: Record<string, ResearchAdapter>;
        };
        const adapter = hosted.adapters?.[fx.platform];
        test.skip(!adapter, `${fx.platform} is not in the hosted config`);
        test.skip(adapter!.enabled !== true, `${fx.platform} hosted: disabled`);
        test.skip(fx.flow === "list", "a list form has no gallery");

        const gallery = adapter!.gallery;
        if (!Array.isArray(gallery) || gallery.length === 0) return;
        expect(
          await resolves(page, gallery.join(", ")),
          `${fx.platform}: the HOSTED gallery selectors match nothing. The ` +
            `bundled ones may still work, which is exactly how a stale hosted ` +
            `config goes unnoticed.`,
        ).toBeGreaterThan(0);
      });
    });
  }
});
