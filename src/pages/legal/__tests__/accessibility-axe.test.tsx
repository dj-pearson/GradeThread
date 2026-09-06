// US-515: automated accessibility (axe) check in CI.
//
// Renders representative public legal pages to static markup, mounts it in the
// jsdom document, and runs axe-core. Fails on any serious/critical violation.
// color-contrast is disabled because jsdom doesn't compute layout/styles, so
// axe can't evaluate it here (contrast is covered by the AA color tokens +
// manual review per the Accessibility Statement).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import axe from "axe-core";

import { AccessibilityPage } from "@/pages/legal/accessibility";
import { DmcaPage } from "@/pages/legal/dmca";
import { SubprocessorsPage } from "@/pages/legal/subprocessors";
import { DpaPage } from "@/pages/legal/dpa";
import { RefundPage } from "@/pages/legal/refund";
import { ImprintPage } from "@/pages/legal/imprint";
import { TrademarksPage } from "@/pages/legal/trademarks";

const PAGES: Array<[string, React.ReactNode]> = [
  ["accessibility", <AccessibilityPage key="a" />],
  ["dmca", <DmcaPage key="d" />],
  ["subprocessors", <SubprocessorsPage key="s" />],
  ["dpa", <DpaPage key="p" />],
  ["refund", <RefundPage key="r" />],
  ["imprint", <ImprintPage key="i" />],
  ["trademarks", <TrademarksPage key="t" />],
];

async function violations(node: React.ReactNode) {
  const html = renderToStaticMarkup(
      <MemoryRouter>{node}</MemoryRouter>
  );
  document.body.innerHTML = html;
  const results = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

describe("legal pages a11y (axe)", () => {
  for (const [name, node] of PAGES) {
    it(`${name} page has no serious/critical axe violations`, async () => {
      const v = await violations(node);
      const summary = v.map((x) => `${x.id}: ${x.help}`).join("; ");
      expect(v, summary).toEqual([]);
    });
  }
});
