// US-796: the API Keys page must gate on the effective FlipDesk plan (the same
// source the backend enforces — apiAccess, business-only), not the legacy
// user_plan column. These tests pin usePlanUsage to a plan and assert the
// rendered branch: Business sees the management UI; lower plans see the gate.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePlanUsage, type PlanUsage } from "@/hooks/use-plan-usage";
import type { FlipdeskPlanKey } from "@/lib/constants";
import { ApiKeysPage } from "@/pages/api-keys";

vi.mock("@/hooks/use-plan-usage", () => ({ usePlanUsage: vi.fn() }));

const mockedUsePlanUsage = vi.mocked(usePlanUsage);

function planUsage(plan: FlipdeskPlanKey, isLoading = false): PlanUsage {
  const cap = { used: 0, limit: 0, pct: 0, unlimited: false };
  return {
    plan,
    activeListings: cap,
    aiActions: cap,
    includedGrades: cap,
    marketplacesConnected: cap,
    thresholds: [80],
    lastWarning: {},
    isLoading,
  };
}

function render(plan: FlipdeskPlanKey, isLoading = false): string {
  mockedUsePlanUsage.mockReturnValue(planUsage(plan, isLoading));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ApiKeysPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const GATE_TEXT = "API Access Requires the Business Plan";

describe("ApiKeysPage plan gate (US-796)", () => {
  beforeEach(() => mockedUsePlanUsage.mockReset());

  it("Business plan: renders the management UI, not the gate", () => {
    const html = render("business");
    expect(html).not.toContain(GATE_TEXT);
    expect(html).toContain("Create Key");
  });

  it("Free plan: renders the upgrade gate, not the management UI", () => {
    const html = render("free");
    expect(html).toContain(GATE_TEXT);
    expect(html).not.toContain("Create Key");
  });

  it("Pro plan (no apiAccess): also gated", () => {
    const html = render("pro");
    expect(html).toContain(GATE_TEXT);
  });

  it("while the billing summary loads, shows neither the gate nor the UI (no flash)", () => {
    const html = render("free", /* isLoading */ true);
    expect(html).not.toContain(GATE_TEXT);
    expect(html).not.toContain("Create Key");
  });
});
