// US-2966 + US-2968: the two "start from a sample" entry points, pinned.
//
// Both surfaces exist to fix the same thing — a seller landing on an empty page
// with a button that asks them to invent the feature. The failure this guards
// is silent: the picker keeps rendering, the samples keep passing their own
// content tests, and the page simply stops offering them. Nothing goes red.
//
// Source-reading rather than rendering, the same way
// listing-templates-web-parity.test.ts does it: both pages need a router, a
// query client and an authed session to paint, and none of that is what is at
// risk here.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STARTER_SNIPPETS } from "@/lib/starter-snippets";
import { STARTER_TEMPLATES } from "@/lib/starter-templates";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const SURFACES = [
  {
    label: "description snippets",
    file: "src/pages/flipdesk/description-snippets.tsx",
    samples: "STARTER_SNIPPETS",
    noun: 'noun="snippet"',
    count: STARTER_SNIPPETS.length,
  },
  {
    label: "listing templates",
    file: "src/pages/flipdesk/templates.tsx",
    samples: "STARTER_TEMPLATES",
    noun: 'noun="template"',
    count: STARTER_TEMPLATES.length,
  },
];

describe("both starter libraries are reachable", () => {
  for (const s of SURFACES) {
    describe(s.label, () => {
      const src = read(s.file);

      it("renders the shared picker, not just imports it", () => {
        // The RENDER, not the import line. Deleting the JSX and leaving the
        // import behind is exactly the change that would go unnoticed.
        expect(src).toMatch(/<SamplePicker\b/);
        expect(src).toContain(s.noun);
      });

      it("feeds it the starter library", () => {
        expect(src).toContain(`samples={${s.samples}}`);
        expect(src).toContain(`from "@/lib/${s.samples.toLowerCase().replace(/_/g, "-")}"`);
      });

      it("offers it from the empty state AND from the header", () => {
        // Two entry points on purpose: the empty state is for the seller who
        // has nothing, the header button for the one who wrote a single line
        // and would otherwise never see the other eight.
        expect(src).toContain("secondaryAction={{");
        expect(src.match(/Browse samples/g) ?? []).toHaveLength(2);
      });

      it("has samples to show", () => {
        expect(s.count).toBeGreaterThan(0);
      });
    });
  }
});
