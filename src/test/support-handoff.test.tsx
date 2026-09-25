// H14: Help hands a question to the ticket form, so it is never typed twice.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, settle } from "./helpers/mount";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.fetch }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), identify: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SupportTicketsPage } from "@/pages/support-tickets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  mocks.fetch.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith("/api/help/search")) {
      return new Response(JSON.stringify({ query: "", hits: [], viewer: "member" }));
    }
    return new Response(JSON.stringify({ tickets: [] }));
  });
});

describe("support ticket handoff", () => {
  it("?subject= opens the form with the subject filled", async () => {
    const m = mount(<SupportTicketsPage />, "/dashboard/support?subject=where%20is%20my%20payout");
    await settle(20);
    const input = m.container.querySelector<HTMLInputElement>("#ticket-subject");
    expect(input?.value).toBe("where is my payout");
    m.unmount();
  });

  it("?article= names the article that did not answer it", async () => {
    const m = mount(<SupportTicketsPage />, "/dashboard/support?article=refunds-and-invoices");
    await settle(20);
    const input = m.container.querySelector<HTMLInputElement>("#ticket-subject");
    expect(input?.value).toBe('Question about the help article "refunds-and-invoices"');
    m.unmount();
  });

  it("with neither, the form stays closed", async () => {
    const m = mount(<SupportTicketsPage />, "/dashboard/support");
    await settle(20);
    expect(m.container.querySelector("#ticket-subject")).toBeNull();
    m.unmount();
  });
});
