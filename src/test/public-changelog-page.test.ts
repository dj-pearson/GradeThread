import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { CHANGELOG_PATH } from "@/lib/seo/changelog";

// US-2809: the public changelog page, and the two ways it could quietly stop
// being what it is.
//
// The API (changelogPublicRoutes, US-916) was built with a public page and an
// in-app panel in mind, and for months had neither. The admin authoring screen
// claimed a public feed in two places, so an admin publishing an entry was told
// it appeared somewhere it did not. An earlier pass deleted that claim; this
// page makes it true instead, and the claim is back.
//
// What this holds is the ADMIN-FACING HONESTY, which is the part with no other
// test: the page must read the PUBLIC feed, and the admin copy must only
// promise surfaces that exist. The SEO registration is already guarded
// elsewhere (public-routes.test.ts fails the build on a public router path
// missing from the registry, and the prerender sync-guard on entry-server).

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

/**
 * The source with line comments removed.
 *
 * ⚠ THE FIRST DRAFT OF THE PANEL CASE BELOW FAILED ON ITS OWN DOCUMENTATION.
 * The admin file's header comment says "The in-app 'What's New' panel is still
 * unbuilt, and no copy here claims it" — a sentence written to record that the
 * claim is absent, which the scan then read AS the claim. A guard that fires on
 * the prose written about it is not checking the code, and it is the failure
 * mode this repo keeps rediscovering.
 *
 * Only what a user can READ counts as a claim, so comments come out first.
 */
const withoutComments = (src: string) =>
  src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const PAGE = "src/pages/marketing/changelog.tsx";
const ADMIN = "src/pages/admin/changelog.tsx";

describe("US-2809: the public changelog reads the public feed", () => {
  it("is registered as an indexable public route", () => {
    const entry = PUBLIC_ROUTES.find((r) => r.path === CHANGELOG_PATH);
    expect(entry, `${CHANGELOG_PATH} is not in PUBLIC_ROUTES`).toBeDefined();
    expect(entry!.title.length).toBeGreaterThan(5);
    expect(entry!.description.length).toBeGreaterThan(50);
  });

  it("calls /api/changelog and not the admin endpoint", () => {
    const src = read(PAGE);
    expect(src).toContain("/api/changelog?");
    expect(
      src.includes("/api/admin/changelog"),
      "the public page is reading the ADMIN endpoint, which requires an admin JWT " +
        "and AAL2. Every anonymous visitor would get a 403 and an empty page.",
    ).toBe(false);
    expect(
      src.includes("edgeFetch"),
      "the public page is using edgeFetch, which attaches a session token and " +
        "gates on auth. A logged-out visitor is the normal case here.",
    ).toBe(false);
  });

  it("passes the audience explicitly rather than by omission", () => {
    // AC2's rule is that a surface passes ?audience=. A public page has no
    // viewer, so the honest value is `all` — and passing it beats leaving the
    // parameter off, which reads as forgetting rather than deciding. The API
    // treats both the same; the SOURCE does not say the same thing.
    //
    // ⚠ COMMENTS STRIPPED, and this case is why the helper exists at all. The
    // page's own comment heading reads "WHY THIS PASSES audience=all", written
    // to explain the decision — and it satisfied this check on its own. Deleting
    // the parameter from the actual fetch left the suite green, because the
    // explanation outlived the thing it explained. Third instance of that shape
    // in this one file.
    const src = withoutComments(read(PAGE));
    expect(
      /audience=all/.test(src),
      "the page no longer states its audience. Either restore audience=all with " +
        "the reasoning, or if this page has become viewer-aware, pass the " +
        "viewer's audience so a grading-only reader is not shown FlipDesk news.",
    ).toBe(true);
  });
});

describe("US-2809: the admin page only promises surfaces that exist", () => {
  it("claims the public page, which now exists", () => {
    // Comments stripped for the same reason as above: the header comment
    // discusses /changelog at length, and would satisfy this on its own while
    // the subtitle an admin actually reads said nothing.
    const src = withoutComments(read(ADMIN));
    expect(
      src.includes("/changelog"),
      "the admin copy no longer mentions the public page. It exists, and an " +
        "admin deciding whether to publish should know where the entry goes.",
    ).toBe(true);
  });

  it("does not still say the public page is missing", () => {
    // The exact sentence the earlier pass added while it was true. Leaving it
    // after building the page is the same failure in the opposite direction.
    const src = read(ADMIN);
    for (const stale of [
      "There is no public changelog page yet",
      "reaches subscribers and nobody else",
    ]) {
      expect(src.includes(stale), `stale admin copy: "${stale}"`).toBe(false);
    }
  });

  it("does not claim an in-app What's New panel, which is still unbuilt", () => {
    // The other half of US-916, and the one the ?audience= filter was designed
    // for. If someone builds it, this case is the reminder to update the copy
    // in the same commit rather than a month later.
    const src = withoutComments(read(ADMIN));
    const claimsPanel = /in-app[^.]{0,40}panel|What's New panel/i.test(src);
    const panelExists = (() => {
      try {
        return read("src/components/changelog/whats-new-panel.tsx").length > 0;
      } catch {
        return false;
      }
    })();
    expect(
      claimsPanel && !panelExists,
      "the admin copy promises an in-app What's New panel that does not exist. " +
        "That is the exact shape US-2809 was filed for.",
    ).toBe(false);
  });
});
