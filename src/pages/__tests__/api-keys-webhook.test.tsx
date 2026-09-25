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
import { useApiUsage } from "@/hooks/use-api-usage";
import { WebhookPanel, type WebhookConfig, type WebhookDeliveryRow } from "@/components/api/webhook-panel";
import { ApiKeysPage } from "@/pages/api-keys";

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));
vi.mock("@/hooks/use-api-usage", () => ({ useApiUsage: vi.fn() }));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ can: () => true, isOwner: true }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const tenant = vi.hoisted(() => ({ key: "owner-1" }));
vi.mock("@/hooks/use-tenant-key", () => ({ useTenantKey: () => tenant.key }));

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
let testResponse: { outcome: string; event_id?: string };
let detailResponse: unknown;
let lastClient: QueryClient | null = null;

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

beforeEach(() => {
  tenant.key = "owner-1";
  calls = [];
  config = { webhook_url: null, has_signing_secret: false, secret_created_at: null, updated_at: null };
  deliveries = [];
  putResponse = null;
  testResponse = { outcome: "delivered" };
  detailResponse = null;
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (path: string, opts: { method?: string; json?: unknown } = {}) => {
    const method = opts.method ?? "GET";
    calls.push({ path, method, json: opts.json });
    if (method === "GET" && path === "/api/keys/webhook") return ok(config);
    const detailMatch = /^\/api\/keys\/webhook\/deliveries\/([^/?]+)$/.exec(path);
    if (method === "GET" && detailMatch) return ok(detailResponse);
    if (method === "POST" && /\/redeliver$/.test(path)) return ok({ event_id: "e1", outcome: "delivered" });
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
  lastClient = qc;
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

  it("Remove asks first, then clears the URL with a null PUT", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    putResponse = { ...config, webhook_url: null, has_signing_secret: false, signing_secret: null };
    await render();
    await click("Remove");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await confirmDialog("Remove webhook");
    expect(calls.find((c) => c.method === "PUT")!.json).toEqual({ url: null });
  });
});

async function confirmDialog(label: string) {
  const action = [...document.querySelectorAll('[role="alertdialog"] button')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement | undefined;
  if (!action) throw new Error(`no confirm "${label}" in: ${document.body.textContent}`);
  await act(async () => action.click());
  await flush();
}

describe("WebhookPanel secret handling (DEV-09)", () => {
  it("Rotate does nothing until confirmed", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    await render();
    await click("Rotate signing secret");
    expect(calls.some((c) => c.path === "/api/keys/webhook/secret/rotate")).toBe(false);
    expect(document.body.textContent).toContain("The old secret stops working now.");
    await confirmDialog("Rotate secret");
    expect(calls.some((c) => c.path === "/api/keys/webhook/secret/rotate")).toBe(true);
    expect(container!.textContent).toContain("whsec_rotated");
  });

  it("the Remove confirm counts pending deliveries it will cancel", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    deliveries = [
      { event_id: "p1", event_type: "grade.completed", status: "pending", attempts: 1, max_attempts: 6, last_status_code: 500, last_error: null, created_at: "2026-09-23T10:00:00Z", next_attempt_at: new Date(Date.now() + 120_000).toISOString() },
      { event_id: "p2", event_type: "grade.completed", status: "delivered", attempts: 1, max_attempts: 6, last_status_code: 200, last_error: null, created_at: "2026-09-23T10:00:00Z" },
    ];
    await render();
    await click("Remove");
    expect(document.body.textContent).toContain("cancels 1 pending delivery");
  });

  it("after Remove no whsec_ is left in the DOM, and the cache never holds the secret", async () => {
    putResponse = {
      webhook_url: "https://hooks.example.com/gt",
      has_signing_secret: true,
      secret_created_at: "2026-09-23T00:00:00Z",
      updated_at: "2026-09-23T00:00:00Z",
      signing_secret: "whsec_brandnew",
    };
    await render();
    typeUrl("https://hooks.example.com/gt");
    await click("Save");
    expect(container!.textContent).toContain("whsec_brandnew");
    const cached = lastClient!.getQueryData(["api-webhook", "owner-1"]) as Record<string, unknown>;
    expect(cached).toBeTruthy();
    expect("signing_secret" in cached).toBe(false);
    const live = container!.querySelector('[role="status"]')!;
    expect(live.textContent).toBe("New signing secret created");

    putResponse = { webhook_url: null, has_signing_secret: false, secret_created_at: null, updated_at: null, signing_secret: null };
    await click("Remove");
    await confirmDialog("Remove webhook");
    expect(document.body.innerHTML).not.toContain("whsec_");
  });

  it("a workspace switch clears a secret still on screen", async () => {
    await render();
    putResponse = {
      webhook_url: "https://hooks.example.com/gt",
      has_signing_secret: true,
      secret_created_at: "2026-09-23T00:00:00Z",
      updated_at: "2026-09-23T00:00:00Z",
      signing_secret: "whsec_workspace_a",
    };
    typeUrl("https://hooks.example.com/gt");
    await click("Save");
    expect(container!.textContent).toContain("whsec_workspace_a");
    tenant.key = "owner-2";
    act(() => root!.render(h(QueryClientProvider, { client: lastClient! }, h(WebhookPanel))));
    await flush();
    expect(container!.textContent).not.toContain("whsec_workspace_a");
  });

  it("I've saved it hides the secret", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: false };
    await render();
    await click("Create signing secret");
    expect(container!.textContent).toContain("whsec_rotated");
    await click("I've saved it");
    expect(container!.textContent).not.toContain("whsec_rotated");
  });
});

describe("WebhookPanel live log and form (DEV-10)", () => {
  it("a retrying row shows its next try, and the log polls every 10s while one exists", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    deliveries = [
      { event_id: "p1", event_type: "grade.completed", subject_id: "sub-123", status: "pending", attempts: 1, max_attempts: 6, last_status_code: 500, last_error: null, created_at: "2026-09-23T10:00:00Z", next_attempt_at: new Date(Date.now() + 120_000).toISOString() },
    ];
    await render();
    expect(container!.textContent).toContain("Next try in 2 min");
    expect(container!.textContent).toContain("sub-123");
    const reads = () => calls.filter((c) => c.path === "/api/keys/webhook/deliveries?limit=20").length;
    const before = reads();
    await act(async () => { await new Promise((r) => setTimeout(r, 10_200)); });
    await flush();
    expect(reads()).toBeGreaterThan(before);
  }, 20_000);

  it("pressing Enter in the URL field submits it", async () => {
    await render();
    typeUrl("https://hooks.example.com/enter");
    const input = container!.querySelector<HTMLInputElement>("#webhook-url")!;
    await act(async () => input.form!.requestSubmit());
    await flush();
    expect(calls.find((c) => c.method === "PUT")?.json).toEqual({ url: "https://hooks.example.com/enter" });
  });

  it("an http URL is refused inline without a request, and a server 400 shows inline", async () => {
    await render();
    typeUrl("http://hooks.example.com/plain");
    await click("Save");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(container!.textContent).toContain("Use a full https:// address.");

    mockedFetch.mockImplementationOnce(async (path: string, opts: { method?: string; json?: unknown } = {}) => {
      calls.push({ path, method: opts.method ?? "GET", json: opts.json });
      return new Response(JSON.stringify({ error: "URL rejected: URL resolves to a non-public address" }), { status: 400 });
    });
    typeUrl("https://10.0.0.1/hook");
    await click("Save");
    expect(container!.textContent).toContain("URL rejected: URL resolves to a non-public address");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("WebhookPanel drill-in (DEV-12)", () => {
  it("Details opens every attempt's status code, and Resend posts for a failed row", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    deliveries = [
      { event_id: "e1", event_type: "grade.completed", status: "failed", attempts: 2, max_attempts: 2, last_status_code: 503, last_error: "nope", created_at: "2026-09-23T10:00:00Z" },
    ];
    detailResponse = {
      ...deliveries[0],
      payload: { id: "e1", event: "grade.completed" },
      header_names: ["Content-Type", "webhook-id", "webhook-signature"],
      attempts_log: [
        { attempt: 1, success: false, status_code: 500, error: "x", response_excerpt: "server down", duration_ms: 40, created_at: "2026-09-23T10:00:00Z" },
        { attempt: 2, success: false, status_code: 503, error: "y", response_excerpt: null, duration_ms: 55, created_at: "2026-09-23T10:05:00Z" },
      ],
    };
    await render();
    await click("Details");
    const sheet = document.querySelector('[role="dialog"]')!;
    expect(sheet.textContent).toContain("HTTP 500 in 40 ms");
    expect(sheet.textContent).toContain("HTTP 503 in 55 ms");
    expect(sheet.textContent).toContain("server down");
    const resend = [...sheet.querySelectorAll("button")].find((b) => b.textContent?.includes("Resend"))!;
    await act(async () => resend.click());
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/keys/webhook/deliveries/e1/redeliver")).toBe(true);
  });

  it("the test send reports the status code and a signature hint on a 401", async () => {
    config = { ...config, webhook_url: "https://hooks.example.com/gt", has_signing_secret: true };
    testResponse = { outcome: "failed", event_id: "t1" };
    detailResponse = {
      event_id: "t1", event_type: "webhook.test", status: "failed", attempts: 1, max_attempts: 1,
      last_status_code: 401, last_error: null, created_at: "2026-09-23T10:00:00Z",
      payload: {}, header_names: [],
      attempts_log: [{ attempt: 1, success: false, status_code: 401, error: null, response_excerpt: null, duration_ms: 31, created_at: "2026-09-23T10:00:00Z" }],
    };
    await render();
    await click("Send test event");
    const result = container!.querySelector('[data-testid="webhook-test-result"]')!;
    expect(result.textContent).toContain("HTTP 401 in 31 ms");
    expect(result.textContent).toContain("different secret");
  });
});

const USAGE = {
  summary: { since: "", days: 30, total_requests: 0, success_requests: 0, error_requests: 0, sandbox_requests: 0, by_endpoint: [], daily: [] },
  plan: "business",
  overage: { quota_enabled: false, balance: 0 },
  rate_limits: { read_per_minute: 1, write_per_minute: 1, window_seconds: 60 },
};

describe("ApiKeysPage", () => {
  it("mounts the webhook card for a Business account", () => {
    vi.mocked(useApiUsage).mockReturnValue({
      data: { ...USAGE, api_access: true },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useApiUsage>);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(ApiKeysPage))),
    );
    expect(html).toContain("once per grade for your whole account");
  });
});
