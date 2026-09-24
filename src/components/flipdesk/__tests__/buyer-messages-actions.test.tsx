// OM-08..10: the buyer inbox under interaction. Same harness as
// best-offers-actions.test.tsx: the messages list is a real query on the real
// key, seeded in the cache, so setQueryData is what is being tested.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { EbayBuyerMessage } from "@/hooks/use-ebay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "tenant-1";
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const replyMutate = vi.fn();
const aiMutate = vi.fn();

vi.mock("@/hooks/use-tenant-key", () => ({ useTenantKey: () => TENANT }));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayMessages: () =>
    useQuery({
      queryKey: ["ebay_messages", TENANT],
      queryFn: () => new Promise<EbayBuyerMessage[]>(() => {}),
      staleTime: Infinity,
    }),
  useEbayReplyMessage: () => ({ isPending: false, mutateAsync: replyMutate }),
  resolveInventoryItemIdForEbayItem: async () => "inv-1",
}));
vi.mock("@/hooks/use-ai-extract", () => ({
  useNegotiationDraft: () => ({ isPending: false, mutateAsync: aiMutate }),
}));

const { BuyerMessagesPanel } = await import("@/components/flipdesk/buyer-messages-table");

function message(over: Partial<EbayBuyerMessage> & { messageId: string }): EbayBuyerMessage {
  return {
    itemId: "110000000001",
    senderUsername: "denimfan",
    subject: `Question ${over.messageId}`,
    body: "What is the waist laid flat?",
    creationDate: ago(2),
    answered: false,
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let qc: QueryClient;

function render(messages: EbayBuyerMessage[], url = "/offers?tab=messages") {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["ebay_messages", TENANT], messages);
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <BuyerMessagesPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function table(): HTMLElement {
  return container!.querySelector("table") as HTMLElement;
}

function button(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(label),
  ) as HTMLButtonElement | undefined;
}

function rowFor(text: string): HTMLTableRowElement {
  return [...table().querySelectorAll("tr")].find((tr) =>
    tr.textContent?.includes(text),
  ) as HTMLTableRowElement;
}

async function click(el: Element | undefined) {
  expect(el, "element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function type(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function replyBox(): HTMLTextAreaElement {
  return table().querySelector('textarea[aria-label="Reply to this buyer"]') as HTMLTextAreaElement;
}

function open(subject: string) {
  act(() => {
    (rowFor(subject).querySelector("button[aria-expanded]") as HTMLElement).click();
  });
}

beforeEach(() => {
  replyMutate.mockReset();
  aiMutate.mockReset();
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("the reply box (OM-09)", () => {
  it("Draft with AI keeps typed text and offers the draft as a suggestion", async () => {
    aiMutate.mockResolvedValueOnce({ message: "It measures 16 inches flat.", suggested_counter: null });
    render([message({ messageId: "m1" })]);
    open("Question m1");
    type(replyBox(), "Hi! Let me check.");
    await click(button(table(), "Draft with AI"));
    expect(replyBox().value).toBe("Hi! Let me check.");
    expect(table().textContent).toContain("It measures 16 inches flat.");
    await click(button(table(), "Insert below"));
    expect(replyBox().value).toBe("Hi! Let me check.\n\nIt measures 16 inches flat.");
  });

  it("a 2001-character reply cannot be sent", () => {
    render([message({ messageId: "m1" })]);
    open("Question m1");
    type(replyBox(), "a".repeat(2001));
    expect(button(table(), "Send reply")!.disabled).toBe(true);
    expect(table().textContent).toContain("2,001 / 2,000");
    type(replyBox(), "a".repeat(2000));
    expect(button(table(), "Send reply")!.disabled).toBe(false);
  });

  it("contact details need their own click before Send", () => {
    render([message({ messageId: "m1" })]);
    open("Question m1");
    type(replyBox(), "Text me at 555-123-4567");
    expect(button(table(), "Send reply")!.disabled).toBe(true);
    expect(table().textContent).toContain("a phone number");
    expect(button(table(), "Send anyway")!.disabled).toBe(false);
  });
});

describe("the inbox list (OM-10)", () => {
  it("a sent reply marks the row answered before any refetch", async () => {
    replyMutate.mockResolvedValueOnce({ ok: true });
    render([message({ messageId: "m1" })], "/offers?tab=messages&filter=all");
    open("Question m1");
    type(replyBox(), "Sixteen inches.");
    await click(button(table(), "Send reply"));
    expect(replyMutate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m1", body: "Sixteen inches." }),
    );
    expect(rowFor("Question m1").textContent).not.toContain("Needs reply");
    expect(rowFor("Question m1").textContent).toContain("Replied");
    const cached = qc.getQueryData<EbayBuyerMessage[]>(["ebay_messages", TENANT]);
    expect(cached?.[0]?.answered).toBe(true);
  });

  it("opens on Needs reply when something is waiting", () => {
    render([
      message({ messageId: "m1", subject: "Open question" }),
      message({ messageId: "m2", subject: "Done question", answered: true }),
    ]);
    const toggle = button(container!, "Needs reply")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(table().textContent).not.toContain("Done question");
  });

  it("keeps an explicit filter=all", () => {
    render([
      message({ messageId: "m1", subject: "Open question" }),
      message({ messageId: "m2", subject: "Done question", answered: true }),
    ], "/offers?tab=messages&filter=all");
    expect(button(container!, "Needs reply")!.getAttribute("aria-pressed")).toBe("false");
    expect(table().textContent).toContain("Done question");
  });

  it("says how long an unanswered buyer has waited", () => {
    render([message({ messageId: "m1", creationDate: ago(30) })]);
    expect(rowFor("Question m1").textContent).toContain("Waiting 30h");
  });

  it("keeps a typed reply when the row closes and reopens", () => {
    render([message({ messageId: "m1" })]);
    open("Question m1");
    type(replyBox(), "Half written");
    open("Question m1");
    expect(rowFor("Question m1").textContent).toContain("Draft");
    open("Question m1");
    expect(replyBox().value).toBe("Half written");
  });
});
