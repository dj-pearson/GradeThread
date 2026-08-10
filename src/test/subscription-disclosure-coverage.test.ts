// US-2115 AC4: a component that sells a subscription must render the shared
// auto-renewal disclosure.
//
// This DERIVES the surface list by scanning src/ rather than reading a
// hand-maintained registry, and that is the whole point. A registry only
// protects the surfaces someone remembered to add; the surface that ships
// without a disclosure is by definition the one nobody remembered. Scanning
// means a NEW component that calls a subscribe hook fails this test the day it
// is written, without its author knowing the rule exists.
//
// It reads source as TEXT instead of rendering, because rendering each surface
// needs its own auth/billing/router mocks and a mock that drifts would quietly
// stop asserting anything. The copy itself IS render-tested, in
// src/components/billing/__tests__/auto-renewal-disclosure.test.tsx.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");
const SRC = resolve(REPO_ROOT, "src");

// The JSX opening tag, not the bare name: a file that keeps the import but
// deletes the element would otherwise still satisfy the guard, and "the import
// is still there" is precisely the shape a disclosure removal takes in review.
const DISCLOSURE_JSX = "<AutoRenewalDisclosure";

// The hooks that open a Stripe Checkout session in `mode: "subscription"`.
// Anything calling one of these is charging on a recurring basis.
const SUBSCRIBE_HOOKS = ["useFlipdeskSubscribe", "useBuyerSubscribe"];

// AC1 names four surfaces. Three of them call a subscribe hook and so are found
// by the scan; the marketing pricing page and the 402 paywall do NOT — pricing
// has no button at all and the paywall routes to the picker. They are pinned by
// name so removing the disclosure from them is still a failure.
const NAMED_SURFACES = [
  "src/pages/marketing/pricing.tsx",
  "src/components/billing/flipdesk-plan-picker-dialog.tsx",
  "src/components/billing/upgrade-required-dialog.tsx",
  "src/pages/buyer/billing.tsx",
];

// One-time purchases must NOT carry renewal language — a credit pack does not
// renew, and saying it does is its own misrepresentation.
// upgrade-required-dialog.tsx is deliberately absent: it is a MIXED surface,
// selling credit packs AND recommending a subscription, so it legitimately
// contains both.
const ONE_TIME_ONLY_SURFACES = [
  "src/components/billing/credit-pack-dialog.tsx",
  "src/components/api/api-overage-card.tsx",
];

// Renewal wording as a user would read it.
const RENEWAL_COPY = /until you cancel|renews? automatically|automatically until/i;

// Where renewal wording is SUPPOSED to live.
//  - the copy module is the single source AC3 asks for
//  - the legal pages are long-form terms; they must describe renewal, and they
//    are not a point of sale, which is exactly why the audit said having the
//    language ONLY there was the problem
const COPY_ALLOWED = [
  "src/lib/auto-renewal-copy.ts",
  "src/pages/legal/",
];

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "test") continue;
      walk(full, exts, out);
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

function relPath(full: string): string {
  return relative(REPO_ROOT, full).split("\\").join("/");
}

describe("US-2115: subscription purchase surfaces disclose auto-renewal", () => {
  // .tsx only. The hooks are DEFINED in use-billing-summary.ts, which is not a
  // purchase surface and must not be swept in by its own definitions.
  const subscribingFiles = walk(SRC, [".tsx"])
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      return SUBSCRIBE_HOOKS.some((h) => src.includes(h));
    })
    .map(relPath);

  it("finds the subscription surfaces at all (a scan that matches nothing proves nothing)", () => {
    expect(subscribingFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of subscribingFiles) {
    it(`${file} renders the shared disclosure`, () => {
      expect(
        read(file),
        `${file} calls a subscribe hook but never renders ${DISCLOSURE_JSX}>. ` +
          `A recurring charge has to state its terms on the same screen (US-2115 AC1).`,
      ).toContain(DISCLOSURE_JSX);
    });
  }

  for (const file of NAMED_SURFACES) {
    it(`${file} renders the shared disclosure (named in AC1)`, () => {
      expect(read(file)).toContain(DISCLOSURE_JSX);
    });
  }

  for (const file of ONE_TIME_ONLY_SURFACES) {
    it(`${file} does NOT claim a one-time purchase renews`, () => {
      const src = read(file);
      expect(src).not.toContain(DISCLOSURE_JSX);
      expect(src).not.toMatch(RENEWAL_COPY);
    });
  }

  it("renewal wording lives in the copy module, not hand-written into surfaces", () => {
    // AC3: one component so the surfaces cannot drift. If a surface re-authors
    // the sentence inline, this catches it — that is exactly how the surfaces
    // got out of step before (upgrade-preview-dialog had the only correct copy
    // in the repo and nothing tied it to the others).
    const offenders = walk(SRC, [".ts", ".tsx"])
      .map(relPath)
      .filter((f) => !COPY_ALLOWED.some((a) => f.startsWith(a)))
      .filter((f) => RENEWAL_COPY.test(read(f)));
    expect(
      offenders,
      "these files hand-write renewal copy instead of rendering <AutoRenewalDisclosure>",
    ).toEqual([]);
  });

  it("the allowlist is real (a stale path would silently exempt nothing)", () => {
    // If the copy module moves and this list is not updated, the check above
    // would still pass — it would just be exempting a file that no longer
    // exists while the real one gets flagged. Prove the source file is there.
    expect(read("src/lib/auto-renewal-copy.ts")).toMatch(RENEWAL_COPY);
  });
});
