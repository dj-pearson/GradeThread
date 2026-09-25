// US-796 / DEV-03: the Developers page gates on the workspace OWNER's plan as
// GET /api/keys/usage reports it (api_access), the same source every key route
// enforces, and never on the viewer's personal plan. These pin the usage hook
// and assert the rendered branch.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useApiUsage } from "@/hooks/use-api-usage";
import { ApiKeysPage } from "@/pages/api-keys";

vi.mock("@/hooks/use-api-usage", () => ({ useApiUsage: vi.fn() }));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ can: () => true, isOwner: true }),
}));

const mockedUsage = vi.mocked(useApiUsage);

const USAGE = {
  summary: { since: "", days: 30, total_requests: 0, success_requests: 0, error_requests: 0, sandbox_requests: 0, by_endpoint: [], daily: [] },
  plan: "business",
  overage: { quota_enabled: false, balance: 0 },
  rate_limits: { read_per_minute: 1, write_per_minute: 1, window_seconds: 60 },
};

function render(state: { apiAccess?: boolean; isLoading?: boolean; isError?: boolean }): string {
  mockedUsage.mockReturnValue({
    data: state.isLoading || state.isError ? undefined : { ...USAGE, api_access: state.apiAccess },
    isLoading: state.isLoading ?? false,
    isError: state.isError ?? false,
    isFetching: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useApiUsage>);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ApiKeysPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const GATE_TEXT = "API access needs the Business plan";

describe("ApiKeysPage plan gate (US-796, DEV-03)", () => {
  beforeEach(() => mockedUsage.mockReset());

  it("owner plan has API access: renders the management UI, not the gate", () => {
    const html = render({ apiAccess: true });
    expect(html).not.toContain(GATE_TEXT);
    expect(html).toContain("Create Key");
  });

  it("owner plan lacks API access: renders the upgrade gate, not the management UI", () => {
    const html = render({ apiAccess: false });
    expect(html).toContain(GATE_TEXT);
    expect(html).not.toContain("Create Key");
  });

  it("while the plan loads, shows neither the gate nor the UI (no flash)", () => {
    const html = render({ isLoading: true });
    expect(html).not.toContain(GATE_TEXT);
    expect(html).not.toContain("Create Key");
    expect(html).toContain("Developers");
  });

  it("a failed plan check is an error, not the upsell", () => {
    const html = render({ isError: true });
    expect(html).not.toContain(GATE_TEXT);
    expect(html).toContain("Couldn&#x27;t check your workspace plan");
  });
});
