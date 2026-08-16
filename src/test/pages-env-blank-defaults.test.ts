// A blank Pages environment variable must fall back to the default, not to "".
//
// FOUND 2026-08-16, sweeping outward from the same defect in the edge service
// (lib/env.ts, lib/release-identity.ts, routes/health.ts — three copies there).
// `??` falls through on undefined and NEVER on an empty string, so a blank
// field on the Cloudflare Pages project resolves to "" rather than to the
// default sitting right beside it. A blank is what a Pages env var looks like
// when someone clears a field, or adds the key before pasting the value.
//
// Each of these fails QUIETLY and differently, which is why they are worth
// pinning individually rather than trusting one rule:
//
//   EDGE_API_URL=""        every SSR fetch goes to a relative path; blog and
//                          certificate pages render their error state
//   PUBLIC_SITE_URL=""     empty canonical and og:url tags — invisible on the
//                          page, read by search engines
//   IOS_BUNDLE_ID=""       appIDs becomes "<TEAMID>." and is served with 200;
//                          Apple reads a malformed appID and Universal Links
//                          stop opening the app
//   ANDROID_PACKAGE_NAME=""  the same for App Links
//
// The team-id and fingerprint checks in those two files ALREADY fail closed on
// a blank. The asymmetry was the bug: the concept was understood in the same
// function, one line up.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDGE_API_URL,
  DEFAULT_PUBLIC_SITE_URL,
  edgeApi,
  siteUrl,
} from "../../functions/_shared/blog-render";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("blank Pages env vars fall back to the default", () => {
  it("edgeApi survives a blank EDGE_API_URL", () => {
    expect(edgeApi({ EDGE_API_URL: "" } as never)).toBe(DEFAULT_EDGE_API_URL);
    expect(edgeApi({ EDGE_API_URL: "   " } as never)).toBe(DEFAULT_EDGE_API_URL);
    expect(edgeApi({} as never)).toBe(DEFAULT_EDGE_API_URL);
  });

  it("siteUrl survives a blank PUBLIC_SITE_URL", () => {
    expect(siteUrl({ PUBLIC_SITE_URL: "" } as never)).toBe(DEFAULT_PUBLIC_SITE_URL);
    expect(siteUrl({} as never)).toBe(DEFAULT_PUBLIC_SITE_URL);
  });

  it("a real value still wins", () => {
    // The fallback must not swallow a deliberate override — a preview
    // deployment pointing at a staging edge is the whole reason these exist.
    expect(edgeApi({ EDGE_API_URL: "https://staging.example" } as never))
      .toBe("https://staging.example");
    expect(siteUrl({ PUBLIC_SITE_URL: "https://preview.example" } as never))
      .toBe("https://preview.example");
  });

  it("the app-association files treat a blank identifier as unset", () => {
    // Source-scanned: these are PagesFunction handlers whose signature is
    // awkward to invoke here, and the property is one expression each.
    const aasa = readFileSync(
      join(process.cwd(), "functions/.well-known/apple-app-site-association.ts"),
      "utf8",
    );
    const links = readFileSync(
      join(process.cwd(), "functions/.well-known/assetlinks.json.ts"),
      "utf8",
    );
    expect(aasa).toMatch(/env\.IOS_BUNDLE_ID \?\? ""\)\.trim\(\) \|\| DEFAULT_BUNDLE_ID/);
    expect(links).toMatch(/env\.ANDROID_PACKAGE_NAME \?\? ""\)\.trim\(\) \|\| DEFAULT_PACKAGE_NAME/);
    // …and the shape that caused it must not come back.
    expect(aasa).not.toMatch(/\?\? DEFAULT_BUNDLE_ID\)\.trim\(\)/);
    expect(links).not.toMatch(/\?\? DEFAULT_PACKAGE_NAME\)\.trim\(\)/);
  });
});
