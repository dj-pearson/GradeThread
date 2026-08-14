import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2510. Both customer shells must carry the notification affordance.
//
// The seller header has had NotificationCenter for a while. The buyer shell
// never did — and that was not merely a missing nicety: US-1803's notifyBuyer()
// fans condition-alert matches, reward grants, guarantee updates and portfolio
// events INTO the same `notifications` table, so those rows were being written
// with nowhere in the buyer app to read them.
//
// One table, RLS-scoped to auth.uid(), so the same component serves both shells.
// This test exists because the gap was invisible: nothing failed, no error was
// logged, the notifications simply went unread forever.

const SHELLS = [
  "src/components/dashboard/header.tsx",
  "src/layouts/buyer-layout.tsx",
];

describe("both customer shells mount the notification centre (US-2510)", () => {
  for (const rel of SHELLS) {
    it(`${rel} renders <NotificationCenter />`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(
        /<NotificationCenter\b/.test(src),
        `${rel} does not render NotificationCenter. Rows written to the ` +
          "notifications table for this audience would never be seen.",
      ).toBe(true);
      // Rendering it without importing it would not compile, but assert the
      // import too so a stray comment mentioning the component can't pass.
      expect(/from "@\/components\/dashboard\/notification-center"/.test(src)).toBe(true);
    });
  }
});
