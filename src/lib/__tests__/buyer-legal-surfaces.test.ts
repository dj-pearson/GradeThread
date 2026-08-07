// US-1846: turn the buyer legal register into a mechanism.
//
// Reads the named source files as TEXT — including two across the project
// boundary into the Deno edge service, the same trick
// buyer-plan-limits-parity.test.ts uses, because the web bundle cannot import
// Deno source and a comment saying "keep these in sync" is not a check.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUYER_LEGAL_SURFACES } from "../buyer-legal-surfaces";

const REPO_ROOT = resolve(__dirname, "../../..");

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

describe("buyer legal surfaces", () => {
  it("registers every surface with a distinct key", () => {
    const keys = BUYER_LEGAL_SURFACES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);
  });

  for (const surface of BUYER_LEGAL_SURFACES) {
    if (surface.posture.kind === "kill-switch") {
      const { envFlag, enforcedIn } = surface.posture;
      it(`${surface.key}: ${envFlag} gates it and defaults OFF`, () => {
        const src = read(enforcedIn);
        // The exact default-off shape. `=== "true"` means an unset flag is
        // false; `!== "false"` would ship the surface open on a fresh
        // deployment, which looks nearly identical in review.
        expect(src).toContain(`Deno.env.get("${envFlag}") === "true"`);
        expect(src).not.toContain(`Deno.env.get("${envFlag}") !== "false"`);
      });
    } else {
      const { phrases, authoredIn } = surface.posture;
      it(`${surface.key}: its disclosure is present in ${authoredIn}`, () => {
        const src = read(authoredIn);
        for (const phrase of phrases) {
          expect(
            src,
            `"${phrase}" is missing — the disclosure this surface relies on is gone`,
          ).toContain(phrase);
        }
      });
    }
  }
});
