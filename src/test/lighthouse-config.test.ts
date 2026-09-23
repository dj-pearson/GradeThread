// Guards for the Lighthouse lanes (.github/workflows/lighthouse.yml).
//
// The static configs pointed at /pricing/index.html under staticDistDir while
// scripts/prerender.mjs writes flat dist/pricing.html, so every page but the
// home page 404'd, and the collect steps' continue-on-error hid it. Serving
// dist/ as files would not have been enough either: the SPA mounts over
// /pricing.html, finds no route called that, and renders its noindex
// not-found page, which is what Lighthouse would then have scored. These
// tests hold the configs to clean, routed paths and hold the workflow to
// failing when a gating budget or a collection step fails.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import {
  lhUrlKey,
  locs,
  matchManifest,
  pickProdUrls,
} from "../../scripts/lighthouse-prod-urls.mjs";

type Assertion = string | [string, Record<string, number>];
interface LhConfig {
  ci: {
    collect: {
      url?: string[];
      staticDistDir?: string;
      startServerCommand?: string;
      settings?: { skipAudits?: string[] };
    };
    assert: { assertions: Record<string, Assertion> };
  };
}

const ROOT = resolve(__dirname, "../..");
const readConfig = (name: string): LhConfig =>
  JSON.parse(readFileSync(resolve(ROOT, name), "utf8")) as LhConfig;
const level = (a: Assertion | undefined) => (Array.isArray(a) ? a[0] : a);

const STATIC = ["lighthouserc.json", "lighthouserc.mobile.json"] as const;
const PUBLIC_PATHS = new Set(PUBLIC_ROUTES.map((r) => r.path));

describe("static Lighthouse configs", () => {
  for (const name of STATIC) {
    const config = readConfig(name);

    it(`${name}: every URL is a clean, prerendered public route`, () => {
      const urls = config.ci.collect.url ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) {
        const path = new URL(u).pathname;
        expect(path, `${u} is not a PUBLIC_ROUTES path`).toSatisfy((p: string) => PUBLIC_PATHS.has(p));
        expect(path).not.toMatch(/\.html$/);
      }
    });

    it(`${name}: served by vite preview, not as bare files`, () => {
      expect(config.ci.collect.staticDistDir).toBeUndefined();
      expect(config.ci.collect.startServerCommand).toMatch(/vite preview/);
      // Every URL must be on the port the server command binds.
      const port = config.ci.collect.startServerCommand?.match(/--port (\d+)/)?.[1];
      for (const u of config.ci.collect.url ?? []) expect(new URL(u).port).toBe(port);
    });

    it(`${name}: SEO and accessibility are gating`, () => {
      const a = config.ci.assert.assertions;
      expect(level(a["categories:seo"])).toBe("error");
      expect(level(a["categories:accessibility"])).toBe("error");
      // robots.txt is a Pages Function, absent from dist/: vite preview
      // answers with index.html and the audit fails on every page, which
      // would hold the SEO category at 0.92 for a reason that is not real.
      expect(config.ci.collect.settings?.skipAudits).toContain("robots-txt");
    });
  }

  it("desktop CLS is gating; mobile CLS stays a warning", () => {
    expect(level(readConfig("lighthouserc.json").ci.assert.assertions["cumulative-layout-shift"])).toBe("error");
    expect(level(readConfig("lighthouserc.mobile.json").ci.assert.assertions["cumulative-layout-shift"])).toBe("warn");
  });
});

describe("prod SSR Lighthouse config", () => {
  const config = readConfig("lighthouserc.prod.json");

  it("is report-only: no assertion can fail the job", () => {
    const levels = Object.values(config.ci.assert.assertions).map(level);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((l) => l === "warn")).toBe(true);
  });

  it("measures accessibility", () => {
    expect(config.ci.assert.assertions["categories:accessibility"]).toBeDefined();
  });
});

describe("lighthouse.yml", () => {
  const wf = readFileSync(resolve(ROOT, ".github/workflows/lighthouse.yml"), "utf8");

  it("fails the static job when either Lighthouse step fails", () => {
    expect(wf).toMatch(
      /if: always\(\) && \(steps\.lhci_mobile\.outcome == 'failure' \|\| steps\.lhci_desktop\.outcome == 'failure'\)\n\s+run: \|[\s\S]*?exit 1/,
    );
  });

  it("runs the prod lane off pull requests and reports it to an issue", () => {
    const prod = wf.slice(wf.indexOf("\n  prod-ssr:"));
    expect(prod).toContain("if: github.event_name != 'pull_request'");
    expect(prod).toContain("issues: write");
    expect(prod).toContain("configPath: ./lighthouserc.prod.json");
    expect(prod).toContain("node scripts/lighthouse-prod-urls.mjs");
    expect(prod).toContain("github.rest.issues.createComment");
  });

  it("matches the prod manifest through matchManifest, not by exact URL", () => {
    const prod = wf.slice(wf.indexOf("\n  prod-ssr:"));
    expect(prod).toContain("scripts/lighthouse-prod-urls.mjs`)");
    expect(prod).toMatch(/matchManifest\(wanted, manifest, links\)/);
    // The old exact-key lookups; either one coming back reintroduces the bug.
    expect(prod).not.toMatch(/measured\.get\(u\)|links\[u\]/);
  });

  it("does not say the weekly results only land in the Job Summary", () => {
    const schedule = wf.slice(wf.indexOf("workflow_dispatch"), wf.indexOf("schedule:"));
    expect(schedule).toContain("Lighthouse weekly: live SSR pages");
  });
});

describe("matchManifest (prod-ssr report)", () => {
  const B = "https://gradethread.com";
  const run = (url: string, performance: number) => ({
    url,
    isRepresentativeRun: true,
    summary: { performance, seo: 1, accessibility: 0.9, "best-practices": 1 },
  });

  it("finds a page Lighthouse measured after a trailing-slash redirect", () => {
    const [row] = matchManifest(
      [`${B}/help`],
      [run(`${B}/help/`, 0.8)],
      { [`${B}/help/`]: "https://storage.example/r1" },
    );
    expect(row?.summary?.performance).toBe(0.8);
    expect(row?.measuredUrl).toBe(`${B}/help/`);
    expect(row?.report).toBe("https://storage.example/r1");
  });

  it("finds a page measured after an apex-to-www redirect", () => {
    const [row] = matchManifest(
      [`${B}/blog/how-to-grade`],
      [run("https://www.gradethread.com/blog/how-to-grade", 0.7)],
    );
    expect(row?.summary?.performance).toBe(0.7);
  });

  it("still reports a page that was not measured as not measured", () => {
    const rows = matchManifest(
      [`${B}/help`, `${B}/cert/abc`],
      [run(`${B}/help`, 0.9)],
    );
    expect(rows.map((r) => r.summary === null)).toEqual([false, true]);
  });

  it("uses the representative run and ignores the others", () => {
    const [row] = matchManifest(
      [`${B}/help`],
      [{ ...run(`${B}/help`, 0.1), isRepresentativeRun: false }, run(`${B}/help`, 0.95)],
    );
    expect(row?.summary?.performance).toBe(0.95);
  });

  it("keeps the query string and the root path distinct", () => {
    expect(lhUrlKey(`${B}/x?a=1`)).not.toBe(lhUrlKey(`${B}/x?a=2`));
    expect(lhUrlKey(`${B}/`)).toBe(lhUrlKey(B));
    expect(lhUrlKey(`${B}/`)).not.toBe(lhUrlKey(`${B}/help`));
  });
});

describe("pickProdUrls", () => {
  const B = "https://gradethread.com";
  const sitemap = (...urls: string[]) =>
    `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;

  it("takes two curves, one post, one cert, then /help", () => {
    const urls = pickProdUrls({
      condition: sitemap(`${B}/condition-index`, `${B}/condition-index/levis-501`, `${B}/condition-index/patagonia-synchilla`, `${B}/condition-index/third`),
      blog: sitemap(`${B}/blog`, `${B}/blog/how-to-grade`, `${B}/blog/other`),
      certs: sitemap(`${B}/cert/abc123`, `${B}/cert/def456`),
    });
    expect(urls).toEqual([
      `${B}/condition-index/levis-501`,
      `${B}/condition-index/patagonia-synchilla`,
      `${B}/blog/how-to-grade`,
      `${B}/cert/abc123`,
      `${B}/help`,
    ]);
  });

  it("never takes a blog pagination or tag hub for a post", () => {
    const urls = pickProdUrls({
      condition: null,
      blog: sitemap(`${B}/blog/page/2`, `${B}/blog/tag/denim`, `${B}/blog/real-post`),
      certs: null,
    });
    expect(urls).toContain(`${B}/blog/real-post`);
    expect(urls.some((u) => u.includes("/page/") || u.includes("/tag/"))).toBe(false);
  });

  it("falls back to the hubs when a sitemap is unreachable, and skips the cert", () => {
    expect(pickProdUrls({ condition: null, blog: null, certs: null })).toEqual([
      `${B}/condition-index`,
      `${B}/blog`,
      `${B}/help`,
    ]);
  });

  it("ignores URLs on another origin", () => {
    const urls = pickProdUrls({
      condition: sitemap("https://evil.example/condition-index/x"),
      blog: null,
      certs: sitemap("https://staging.gradethread.com/cert/abc"),
    });
    expect(urls).toEqual([`${B}/condition-index`, `${B}/blog`, `${B}/help`]);
  });

  it("decodes &amp; in <loc>", () => {
    expect(locs("<loc>https://a.test/x?a=1&amp;b=2</loc>")).toEqual(["https://a.test/x?a=1&b=2"]);
  });
});
