import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// US-2527. The subprocessor list is the document a customer's DPA points at, and
// it named neither Google nor Apple while the product was writing a seller's
// inventory into their Google Drive, taking Play and App Store payments, and
// pushing notifications through FCM and APNs. It also stopped at eBay while four
// more marketplace integrations had shipped.
//
// A list kept by hand drifts the moment an integration lands. This checks it
// against the outbound hosts the edge service actually calls.

const PAGE = "src/pages/legal/subprocessors.tsx";
const EDGE_DIRS = [
  "services/edge-functions/src/lib",
  "services/edge-functions/src/routes",
];

function page(): string {
  return readFileSync(resolve(process.cwd(), PAGE), "utf8");
}

/** Every https host the edge service talks to. */
function outboundHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const dir of EDGE_DIRS) {
    const full = resolve(process.cwd(), dir);
    for (const file of readdirSync(full)) {
      if (!file.endsWith(".ts")) continue;
      const src = readFileSync(resolve(full, file), "utf8");
      for (const m of src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        hosts.add(m[1]!.toLowerCase());
      }
    }
  }
  return hosts;
}

/**
 * Hosts that are NOT subprocessors of personal data, each with the reason. A
 * host added here is a claim someone has to be able to defend.
 */
const NOT_A_PROCESSOR: Record<string, string> = {
  "gradethread.com": "our own domain",
  "functions.gradethread.com": "our own edge service",
  "api.gradethread.com": "our own Supabase",
  "api.indexnow.org": "submits public URLs only — no personal data",
  "www.facebook.com": "an outbound share link the user clicks",
  "www.instagram.com": "an outbound share link the user clicks",
  "www.tiktok.com": "an outbound share link the user clicks",
  "x.com": "an outbound share link the user clicks",
  "www.w3.org": "an XML namespace, not a request",
  // US-2790: the PROVENANCE url for the USPS rate table, recorded in
  // lib/shipping-rates.ts so a reader can check where the numbers came
  // from. Nothing calls it at runtime — the rates are constants read off
  // the page by hand and cross-checked, which is the whole point of
  // docs/shipping/. No data of any kind goes to USPS.
  "pe.usps.com": "a cited source URL for published rates, never called",
  "schema.org": "a JSON-LD vocabulary, not a request",
  "store.myshopify.com": "the Shopify host pattern — Shopify is listed",
  "example.com": "documentation and test fixtures",
  "www.example.com": "documentation and test fixtures",
  // Our own hosts, added when the connector work introduced them.
  "www.gradethread.com": "our own domain",
  "staging.gradethread.com": "our own staging domain",
  "flipdesk.com": "our own domain",
  "www.flipdesk.com": "our own domain",
  // The OAuth redirect_uri the MCP connector sends the SELLER'S BROWSER to
  // (lib/oauth-metadata.ts CLAUDE_CALLBACK). The edge never calls it, so no
  // data flows to it from us — the browser arrives carrying an authorization
  // code the seller just approved. Anthropic is separately listed as a
  // subprocessor for the grading calls, which DO send data.
  "claude.ai": "an OAuth redirect the seller's browser follows, not a call we make",
};

/** Which listed subprocessor a host belongs to. */
const HOST_OWNER: [RegExp, string][] = [
  [/(^|\.)ebay\.com$/, "eBay"],
  [/(^|\.)etsy\.com$/, "Etsy"],
  [/(^|\.)depop\.com$/, "Depop"],
  [/(^|\.)whatnot\.com$/, "Whatnot"],
  [/(^|\.)myshopify\.com$|(^|\.)shopify\.com$/, "Shopify"],
  [/(^|\.)googleapis\.com$|(^|\.)google\.com$|(^|\.)googleusercontent\.com$/, "Google"],
  [/(^|\.)apple\.com$/, "Apple"],
  [/(^|\.)stripe\.com$/, "Stripe"],
  [/(^|\.)anthropic\.com$/, "Anthropic"],
  [/(^|\.)openai\.com$/, "OpenAI"],
  [/(^|\.)posthog\.com$/, "PostHog"],
  [/(^|\.)sentry\.io$/, "Sentry"],
  [/(^|\.)cloudflare\.com$/, "Cloudflare"],
  [/(^|\.)supabase\.(co|com)$/, "Supabase"],
  [/(^|\.)amazonaws\.com$/, "Amazon"],
  [/(^|\.)remove\.bg$/, "remove.bg"],
];

describe("the subprocessor list matches what the code calls (US-2527)", () => {
  it("names Google and Apple", () => {
    const src = page();
    expect(src).toMatch(/name: "Google \(Alphabet\)"/);
    expect(src).toMatch(/name: "Apple"/);
    // With what they actually receive, not just a name in a table.
    expect(src).toContain("FCM");
    expect(src).toContain("APNs");
    expect(src).toContain("in-app purchases");
  });

  it("names every marketplace the product integrates with", () => {
    const src = page();
    for (const market of ["eBay", "Etsy", "Depop", "Whatnot", "Shopify"]) {
      expect(src, `${market} is missing`).toContain(`name: "${market}"`);
    }
  });

  it("every outbound host maps to a listed subprocessor or a stated exception", () => {
    const src = page();
    const unaccounted: string[] = [];
    for (const host of outboundHosts()) {
      if (host in NOT_A_PROCESSOR) continue;
      const owner = HOST_OWNER.find(([re]) => re.test(host))?.[1];
      if (!owner) {
        unaccounted.push(host);
        continue;
      }
      if (!src.includes(owner)) unaccounted.push(`${host} → ${owner} (not listed)`);
    }
    expect(
      unaccounted.sort(),
      "these hosts are called by the edge service but appear on neither the " +
        "subprocessor list nor the stated-exception list. Add the processor, or " +
        "add the host to NOT_A_PROCESSOR with the reason it is not one:\n  " +
        unaccounted.join("\n  "),
    ).toEqual([]);
  });

  it("the date moved when the list did", () => {
    const src = page();
    expect(src).not.toContain("April 1, 2026");
    // Stated twice on the page — the header and the table caption must agree.
    const dates = src.match(/August 14, 2026/g) ?? [];
    expect(dates.length).toBe(2);
  });

  it("the DPA still points at a page that exists", () => {
    const dpa = readFileSync(
      resolve(process.cwd(), "src/pages/legal/dpa.tsx"),
      "utf8",
    );
    expect(dpa).toMatch(/to="\/subprocessors"/);
    const routes = readFileSync(
      resolve(process.cwd(), "src/lib/seo/public-routes.ts"),
      "utf8",
    );
    expect(routes).toContain("/subprocessors");
  });
});
