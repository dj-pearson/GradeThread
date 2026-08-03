// US-730: extend automated axe coverage from the public legal pages to the
// reusable dashboard UI primitives (the building blocks of the list pages and
// cards). Renders each to static markup and fails on serious/critical
// violations. color-contrast is disabled (jsdom can't compute layout) — that's
// covered by the US-728 AA color tokens + manual review.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import { Package } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { ItemCardList } from "@/components/flipdesk/item-card-list";
import { FieldError, FormErrorSummary } from "@/components/ui/form-feedback";
import { ImageLightbox } from "@/components/certificate/image-lightbox";
import type { ItemFullRow } from "@/types/database";

const sampleItem = {
  id: "11111111-1111-1111-1111-111111111111",
  item_title: "Vintage Levi's 501",
  item_number: "SKU-001",
  brand: "Levi's",
  style: "501",
  size: "32",
  status: "graded",
  target_price: 65,
  list_price: null,
  purchase_price: 8,
  grade_value: 8.5,
  measurements: { waist: 32 },
  has_required_photos: true,
  listing_id: null,
} as unknown as ItemFullRow;

const CASES: Array<[string, React.ReactNode]> = [
  [
    "empty-state",
    <EmptyState
      key="e"
      icon={Package}
      title="No inventory items yet"
      description="Add your first item to start tracking."
      action={{ label: "Add item", to: "/dashboard/inventory/new" }}
    />,
  ],
  ["status-badge", <StatusBadge key="s" status="sold" />],
  [
    "item-card-list",
    <ItemCardList key="c" items={[sampleItem]} onOpen={() => {}} />,
  ],
  [
    "field-error",
    <FieldError key="fe" id="email-error">
      Enter a valid email address
    </FieldError>,
  ],
  [
    "form-error-summary",
    <FormErrorSummary
      key="fes"
      errors={["Email is required", "Password is too short"]}
    />,
  ],
  [
    "image-lightbox",
    <ImageLightbox
      key="lb"
      images={[
        { id: "1", src: "/a.jpg", caption: "Front" },
        { id: "2", src: "/b.jpg", caption: "Back" },
      ]}
      index={0}
      onClose={() => {}}
      onNavigate={() => {}}
    />,
  ],
];

async function violations(node: React.ReactNode) {
  const html = renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
  document.body.innerHTML = html;
  const results = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

describe("dashboard UI primitives a11y (axe)", () => {
  for (const [name, node] of CASES) {
    it(`${name} has no serious/critical axe violations`, async () => {
      const v = await violations(node);
      const summary = v.map((x) => `${x.id}: ${x.help}`).join("; ");
      expect(v, summary).toEqual([]);
    });
  }
});
