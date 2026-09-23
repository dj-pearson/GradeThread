// The API Keys page's webhook card (extensions-api plan, action 5): set the
// URL, see the signing secret once, send a test event, read the delivery log.
// Every call goes through a mocked edgeFetch, so these pin the exact requests
// the card makes against /api/keys/webhook* (routes/api-keys.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import { edgeFetch } from "@/lib/edge-fetch";
import { usePlanUsage, type PlanUsage } from "@/hooks/use-plan-usage";
import { WebhookPanel, type WebhookConfig, type WebhookDeliveryRow } from "@/components/api/webhook-panel";
import { ApiKeysPage } from "@/pages/api-keys";

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));
vi.mock("@/hooks/use-plan-usage", () => ({ usePlanUsage: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockedFetch = vi.mocked(edgeFetch);

interface Call {
  path: string;
  method: string;
  json: unknown;
}

let calls: Call[] = [];
let config: WebhookConfig;
let deliveries: WebhookDeliveryRow[];
let putResponse: unknown;
let testResponse: { outcome: string };

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

beforeEach(() => {
  calls = [];
  config = { webhook_url: null, has_signing_secret: false, secret_created_at: null, updated_at: null };
  deliveries = [];
  putResponse = null;
  testResponse = { outcome: "delivered" };
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (path: string, opts: { method?: string; json?: unknown } = {}) => {
    const method = opts.method ?? "GET";
    calls.push({ path, method, json: opts.json });
    if (method === "GET" && path === "/api/keys/webhook") return ok(config);
    if (method === "GET" && path.startsWith("/api/keys/webhook/deliveries")) return ok(deliveries);
    if (method === "PUT" && path === "/api/keys/webhook") return ok(putResponse);
    if (method === "POST" && path === "/api/keys/webhook/test") return ok(testResponse);
    if (method === "POST" && path === "/api/keys/webhook/secret/rotate") {
      return ok({ signing_secret: "whsec_rotated", secret_created_at: "2026-09-23T00:00:00Z" });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  });
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root = createRoot(container!);
    root.render(h(QueryClientProvider, { client: qc }, h(WebhookPanel)));
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  const b = [...container!.querySelectorAll("button")].find((x) => x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}" in: ${container!.textContent}`);
  return b as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await flush();
}

function typeUrl(value: string) {
  const input = container!.querySelector<HTMLInputElement>("#webhook-url")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("WebhookPanel", () => {
  it("setting a URL PUTs it and shows the signing secret once", async () => {
    await render();
    expect(container!.textContent).not.toContain("Send test event");

    putResponse = {
      webhook_url: "https://hooks.example.com/gt",
      has_signing_secret: true,
      secret_created_at: "2026-09-23T00:00:00Z",
      updated_at: "2026-09-23T00:00:00Z",
      signing_secret: "whsec_brandnew",
    };
    typeUrl("  https://hooks.example.com/gt ");
    await click("Save");

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/api/keys/webhook");
    expect(put.json).toEqual({ url: "https://hooks.example.com/gt" });
    expect(container!.textContent).toContain("whsec_brandnew");
    expect(container!.textContent).toContain("Send test event");
  });

  it("lists recent deliveries with status and response code", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    deliveries = [
      {
        event_id: "e1",
        event_type: "grade.completed",
        status: "failed",
        attempts: 6,
        max_attempts: 6,
        last_status_code: 503,
        last_error: "nope",
        created_at: "2026-09-23T10:00:00Z",
      },
      {
        event_id: "e2",
        event_type: "webhook.test",
        status: "delivered",
        attempts: 1,
        max_attempts: 1,
        last_status_code: 200,
        last_error: null,
        created_at: "2026-09-23T11:00:00Z",
      },
    ];
    await render();
    expect(calls.some((c) => c.path === "/api/keys/webhook/deliveries?limit=20")).toBe(true);
    const text = container!.textContent!;
    expect(text).toContain("grade.completed");
    expect(text).toContain("Failed");
    expect(text).toContain("HTTP 503");
    expect(text).toContain("6 of 6");
    expect(text).toContain("Delivered");
  });

  it("Send test event POSTs, reports the outcome and reloads the log", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    await render();
    const before = calls.filter((c) => c.path.startsWith("/api/keys/webhook/deliveries")).length;
    await click("Send test event");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/keys/webhook/test")).toBe(true);
    expect(toast.success).toHaveBeenCalled();
    expect(calls.filter((c) => c.path.startsWith("/api/keys/webhook/deliveries")).length).toBeGreaterThan(before);

    testResponse = { outcome: "failed" };
    await click("Send test event");
    expect(toast.error).toHaveBeenCalled();
  });

  it("a legacy webhook with no secret says so and offers to create one", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: false };
    await render();
    expect(container!.textContent).toContain("can't be verified");
    await click("Create signing secret");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/keys/webhook/secret/rotate")).toBe(true);
    expect(container!.textContent).toContain("whsec_rotated");
  });

  it("Remove clears the URL with a null PUT", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    putResponse = { ...config, webhook_url: null, has_signing_secret: false, signing_secret: null };
    await render();
    await click("Remove");
    expect(calls.find((c) => c.method === "PUT")!.json).toEqual({ url: null });
  });
});

describe("ApiKeysPage", () => {
  it("mounts the webhook card for a Business account", () => {
    const cap = { used: 0, limit: 0, pct: 0, unlimited: false };
    vi.mocked(usePlanUsage).mockReturnValue({
      plan: "business",
      activeListings: cap,
      aiActions: cap,
      includedGrades: cap,
      marketplacesConnected: cap,
      thresholds: [80],
      lastWarning: {},
      isLoading: false,
    } as PlanUsage);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(ApiKeysPage))),
    );
    expect(html).toContain("once per grade for your whole account");
  });
});
