// US-2118 AC4, the client half: a user who ALREADY pays must never buy a plan
// change with one click.
//
// A new subscriber passes through Stripe Checkout, which discloses the price on
// its own hosted page. Someone who already has a subscription does not — the
// change happens in place, Stripe charges the proration immediately, and the
// only disclosure that can exist is one we render ourselves. The server refuses
// without `confirmUpgrade` (services/edge-functions/src/tests/
// upgrade-confirmation-gate_test.ts), so a surface that skips the dialog does
// not overcharge anyone; it just breaks with a 409. This guards the surface.
//
// DERIVED BY SCANNING, not from a list, for the reason the sibling coverage
// test gives: a registry only protects the surfaces someone remembered to add.
// That is not hypothetical here. The FlipDesk gate shipped in July 2026 and the
// buyer path — an identical in-place branch on the other product — went
// unguarded for months, because every assertion named one route.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");
const SRC = resolve(REPO_ROOT, "src");

/** Each subscribe hook, and the product string its surface must pass. */
const PRODUCTS = [
  { hook: "useFlipdeskSubscribe", product: "flipdesk" },
  { hook: "useBuyerSubscribe", product: "buyer" },
] as const;

/** The dialog that discloses the proration and captures consent. */
const DIALOG_JSX = "<UpgradePreviewDialog";

/**
 * The state setter that opens it. A naming convention, pinned deliberately: a
 * rename fails here loudly, which is the correct outcome for the one hop
 * between "the user clicked buy" and "the user was told the price".
 */
const DIALOG_OPENER = "setUpgradeTarget(";

/**
 * The bodies of every arrow-function handler that can fire a subscribe
 * mutation, brace-matched so an if/else arm later in the same handler is
 * included — the FlipDesk picker puts the mutation in one arm and the dialog in
 * the other, and slicing only up to the mutation would miss it.
 */
function subscribeHandlers(src: string): string[] {
  const out: string[] = [];
  const re = /\.mutate\(\s*\{\s*plan:/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const arrow = src.lastIndexOf("() => {", m.index);
    if (arrow === -1) continue;
    const open = src.indexOf("{", arrow);
    let depth = 0;
    let end = src.length;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    out.push(src.slice(open, end));
  }
  return out;
}

// The hook definitions and the dialog itself: the dialog calls every subscribe
// hook by design, and the hooks module defines them.
const NOT_A_SURFACE = [
  "src/hooks/use-billing-summary.ts",
  "src/components/billing/upgrade-preview-dialog.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).map((f) => ({
  path: relative(REPO_ROOT, f).replace(/\\/g, "/"),
  src: readFileSync(f, "utf8"),
}));

describe("US-2118: in-place plan changes go through the confirmation dialog", () => {
  for (const { hook, product } of PRODUCTS) {
    // A caller is a surface that USES the hook, not one that merely imports it
    // — the import survives a deletion of the call and would keep this green.
    const callers = FILES.filter(
      (f) => f.src.includes(`${hook}()`) && !NOT_A_SURFACE.includes(f.path),
    );

    it(`${hook} has at least one point-of-sale surface`, () => {
      // Guards the guard: if a rename empties this list, every assertion below
      // passes over nothing and the file reads as covering a product it no
      // longer finds.
      expect(callers.map((c) => c.path)).not.toHaveLength(0);
    });

    for (const caller of callers) {
      it(`${caller.path} renders the upgrade confirmation dialog`, () => {
        expect(caller.src).toContain(DIALOG_JSX);
      });

      it(`${caller.path} mounts it as product="${product}"`, () => {
        // The dialog is shared between the two products and each branch reads a
        // different Stripe subscription and a different price table. The wrong
        // product string would preview one charge and make another.
        expect(caller.src).toContain(`product="${product}"`);
      });

      it(`${caller.path} can open the dialog from the handler that subscribes`, () => {
        // RENDERING THE DIALOG IS NOT THE SAME AS ROUTING TO IT, and the
        // difference is the entire defect. A surface can mount the dialog and
        // still call subscribe.mutate() straight off the click for a user who
        // already pays — which is what the buyer page did.
        //
        // So: find every click handler that can fire the subscribe mutation and
        // require the SAME handler to be able to open the dialog instead. The
        // two surfaces branch differently (an early return vs an if/else), so
        // this asks whether the escape hatch exists in the handler at all
        // rather than pinning one shape.
        const handlers = subscribeHandlers(caller.src);
        expect(handlers.length).toBeGreaterThan(0);
        for (const body of handlers) {
          expect(
            body.includes(DIALOG_OPENER),
            `a handler in ${caller.path} calls the subscribe mutation but can ` +
              `never call ${DIALOG_OPENER} — an already-paying user's click ` +
              "would go straight to an in-place charge (the server would 409, " +
              "so this breaks rather than overcharges, but the surface is wrong)",
          ).toBe(true);
        }
      });
    }
  }

  it("the dialog is the only place confirmUpgrade is set", () => {
    // confirmUpgrade IS the consent artifact. A surface that passes it without
    // having rendered the disclosure has forged the consent rather than
    // captured it, and the server would accept it — the 409 cannot tell the
    // difference between a real confirmation and a hardcoded true.
    const setters = FILES.filter((f) => /confirmUpgrade:\s*true/.test(f.src));
    expect(setters.map((f) => f.path)).toEqual([
      "src/components/billing/upgrade-preview-dialog.tsx",
    ]);
  });

  it("the dialog discloses the amount, the new rate and the renewal date", () => {
    const dialog = FILES.find(
      (f) => f.path === "src/components/billing/upgrade-preview-dialog.tsx",
    );
    expect(dialog).toBeDefined();
    // The three figures AC1 names, each BOUND to the preview response rather
    // than merely mentioned. The static plan price is not the prorated amount,
    // and a dialog stating a wrong charge is worse than today's silence —
    // it turns an omission into an affirmative misstatement about money.
    for (const binding of [
      /value=\{money\(data\.amount_due_today_cents, currency\)\}/,
      /value=\{`\$\{money\(data\.new_recurring_cents, currency\)\}/,
      /value=\{dateLabel\(data\.next_renewal_at\)\}/,
      // The confirm button states the figure too — it is the last thing read
      // before the charge, and the one a screenshot of a dispute would show.
      /Confirm &amp; pay \{money\(data\?\.amount_due_today_cents, currency\)\}/,
    ]) {
      expect(dialog!.src).toMatch(binding);
    }
  });
});
