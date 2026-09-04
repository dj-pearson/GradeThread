import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  APP_STORE_URL,
  CHROME_WEB_STORE_URL,
  FIREFOX_ADDON_URL,
  appLinks,
  appLinksFor,
  appStoreUrl,
  chromeWebStoreUrl,
  firefoxAddonUrl,
  isFirefoxUa,
  isIosUa,
} from "@/lib/app-links";

// US-3110. GradeThread ships in three places and the site linked to none of
// them, so these tests are mostly about the links being REAL and being the same
// three everywhere — the defect was absence, not a wrong URL.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the published store URLs", () => {
  it("names the App Store listing, with the numeric app id", () => {
    expect(APP_STORE_URL).toMatch(/^https:\/\/apps\.apple\.com\/.+\/id\d+$/);
  });

  it("names a Chrome Web Store detail page, not the store's front door", () => {
    expect(CHROME_WEB_STORE_URL).toMatch(
      /^https:\/\/chromewebstore\.google\.com\/detail\/[^?]+$/,
    );
  });

  it("carries no session query string on the Chrome link", () => {
    // The URL as copied out of a signed-in browser arrives with
    // ?authuser=0&hl=en&pli=1 on it. Those are the copier's session, not the
    // listing, and they follow every visitor who clicks the footer.
    expect(CHROME_WEB_STORE_URL).not.toContain("authuser");
    expect(CHROME_WEB_STORE_URL).not.toContain("?");
  });

  it("names an AMO addon page, which is not derivable from the Chrome id", () => {
    expect(FIREFOX_ADDON_URL).toMatch(
      /^https:\/\/addons\.mozilla\.org\/.+\/firefox\/addon\/.+\/$/,
    );
    expect(FIREFOX_ADDON_URL).not.toContain("apinefjjagmigmobdlbiilhbjebmjkdh");
  });

  it("gives each of the three a distinct host", () => {
    const hosts = appLinks().map((l) => new URL(l.href).host);
    expect(new Set(hosts).size).toBe(3);
  });
});

describe("resolution order", () => {
  it("an explicit env override wins over the published listing", () => {
    vi.stubEnv("VITE_IOS_APP_STORE_URL", "https://testflight.apple.com/join/abc");
    vi.stubEnv("VITE_EXTENSION_WEBSTORE_URL", "https://example.test/chrome");
    vi.stubEnv("VITE_EXTENSION_AMO_URL", "https://example.test/firefox");
    expect(appStoreUrl()).toBe("https://testflight.apple.com/join/abc");
    expect(chromeWebStoreUrl()).toBe("https://example.test/chrome");
    expect(firefoxAddonUrl()).toBe("https://example.test/firefox");
  });

  it("a whitespace-only override does not win", () => {
    // An env var set to " " in a hosting dashboard is set as far as the shell
    // is concerned, and without the trim it would return a blank href.
    vi.stubEnv("VITE_IOS_APP_STORE_URL", "   ");
    vi.stubEnv("VITE_EXTENSION_AMO_URL", "   ");
    expect(appStoreUrl()).toBe(APP_STORE_URL);
    expect(firefoxAddonUrl()).toBe(FIREFOX_ADDON_URL);
  });

  it("builds the Chrome link from the bridge's extension id when one is set", () => {
    vi.stubEnv("VITE_EXTENSION_WEBSTORE_URL", "");
    vi.stubEnv("VITE_LISTER_EXTENSION_ID", "abcdefghijklmnopqrstuvwxyzabcdef");
    expect(chromeWebStoreUrl()).toBe(
      "https://chromewebstore.google.com/detail/abcdefghijklmnopqrstuvwxyzabcdef",
    );
  });

  it("never builds a detail URL with an empty id segment", () => {
    vi.stubEnv("VITE_EXTENSION_WEBSTORE_URL", "");
    vi.stubEnv("VITE_LISTER_EXTENSION_ID", "");
    expect(chromeWebStoreUrl()).toBe(CHROME_WEB_STORE_URL);
    expect(chromeWebStoreUrl()).not.toMatch(/detail\/$/);
  });
});

describe("user-agent ordering", () => {
  const FIREFOX =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  it("reads Firefox and iOS out of the user agent, and Chrome as neither", () => {
    expect(isFirefoxUa(FIREFOX)).toBe(true);
    expect(isFirefoxUa(CHROME)).toBe(false);
    expect(isIosUa(IPHONE)).toBe(true);
    expect(isIosUa(CHROME)).toBe(false);
    expect(isFirefoxUa(null)).toBe(false);
    expect(isIosUa(undefined)).toBe(false);
  });

  it("puts the installable one first", () => {
    expect(appLinksFor(IPHONE)[0]?.id).toBe("ios");
    expect(appLinksFor(FIREFOX)[0]?.id).toBe("firefox");
    expect(appLinksFor(CHROME)[0]?.id).toBe("chrome");
  });

  it("drops nothing, whatever the browser", () => {
    // The reason this matters: a reseller reads the site on a laptop and
    // installs the phone app on their phone. Hiding the App Store link on
    // desktop hides it from the person it is for.
    for (const ua of [FIREFOX, IPHONE, CHROME, null]) {
      expect(appLinksFor(ua).map((l) => l.id).sort()).toEqual([
        "chrome",
        "firefox",
        "ios",
      ]);
    }
  });
});

describe("the surfaces that offer a download", () => {
  // Source scans, because what US-3110 fixes is a link being ABSENT from a
  // page, and absence is what a scan can actually see.
  const SURFACES: Array<[string, string]> = [
    ["the marketing footer", "src/components/marketing/marketing-layout.tsx"],
    ["the landing footer", "src/pages/landing.tsx"],
    ["the onboarding welcome", "src/components/onboarding/onboarding-flow.tsx"],
    [
      "the dashboard widget",
      "src/components/dashboard/widgets/grading-get-apps.tsx",
    ],
  ];

  // US-3111's page is not in SURFACES: it renders its own buttons rather than
  // the shared component, because it is the one place with room to say what
  // each install is FOR. It still reads its hrefs from app-links().
  const DOWNLOAD_PAGE = "src/pages/marketing/download.tsx";

  it("the download page builds its links from app-links, not from literals", () => {
    const src = read(DOWNLOAD_PAGE);
    expect(src).toContain('from "@/lib/app-links"');
    expect(src).toContain("appLinks()");
    expect(src).not.toContain("apps.apple.com");
    expect(src).not.toContain("chromewebstore.google.com");
    expect(src).not.toContain("addons.mozilla.org");
  });

  it("the download page is registered everywhere a public route has to be", () => {
    // The four places a marketing page has to appear or it 404s, prerenders
    // blank, or ships its structured data to the SPA only.
    expect(read("src/lib/seo/public-routes.ts")).toContain("downloadRoute()");
    expect(read("src/routes/index.tsx")).toContain('path: "/download"');
    const entry = read("src/prerender/entry-server.tsx");
    expect(entry).toContain("[DOWNLOAD_PATH]: <DownloadPage />");
    expect(entry).toContain("[DOWNLOAD_PATH]: `${M}marketing/download`");
    expect(read("src/prerender/head-builder.ts")).toContain(
      '"/download": downloadsJsonLd',
    );
  });

  it("the marketing footer links the page as well as the three stores", () => {
    expect(read("src/components/marketing/marketing-layout.tsx")).toContain(
      '<FooterLink to="/download">',
    );
  });

  for (const [name, path] of SURFACES) {
    it(`${name} renders the shared component`, () => {
      const src = read(path);
      expect(src).toMatch(/<AppDownload(Links|Row|List)\b/);
      expect(src).toContain('from "@/components/get-the-apps"');
    });
  }

  it("hard-codes no store URL outside app-links.ts", () => {
    for (const [name, path] of SURFACES) {
      const src = read(path);
      expect(src, name).not.toContain("apps.apple.com/us/app");
      expect(src, name).not.toContain("chromewebstore.google.com");
      expect(src, name).not.toContain("addons.mozilla.org");
    }
  });

  it("registers the dashboard widget as promotional, so it stays below the data", () => {
    const src = read("src/lib/dashboard-widgets.ts");
    expect(src).toContain('id: "grading.get-apps"');
    const promoBlock = src.slice(src.indexOf("PROMOTIONAL_WIDGET_IDS"));
    expect(promoBlock.slice(0, 400)).toContain('"grading.get-apps"');
  });

  it("opens every external link safely", () => {
    const src = read("src/components/get-the-apps.tsx");
    const anchors = src.match(/target="_blank"/g) ?? [];
    const rels = src.match(/rel="noopener noreferrer"/g) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    expect(rels.length).toBe(anchors.length);
  });
});
