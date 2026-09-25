// The earned-link capture: one click per landing, the visitor's own click id
// carried to redeem, and the ref params gone from the address bar afterwards.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://functions.example.test" }));
const edgeFetch = vi.fn(async (...args: unknown[]) => {
  void args;
  return new Response("{}", { status: 200 });
});
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: (...a: unknown[]) => edgeFetch(...a) }));

import {
  captureAffiliateRef,
  clearStoredAffiliateRef,
  redeemStoredAffiliateRef,
  storedAffiliateClickId,
} from "@/lib/affiliate";

const fetchMock = vi.fn();

function land(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  clearStoredAffiliateRef();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true, click_id: "click-1" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  edgeFetch.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  land("");
});

describe("captureAffiliateRef", () => {
  it("sends one click, then none on a reload of the same link inside 30 minutes", async () => {
    land("?ref=abcd2345&utm_source=whatsapp");
    expect(captureAffiliateRef()).toBe("ABCD2345");
    await settle();
    land("?ref=ABCD2345&utm_source=whatsapp");
    expect(captureAffiliateRef()).toBe("ABCD2345");
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.source).toBe("whatsapp");
  });

  it("strips ref and utm_source from the address bar and keeps the rest", () => {
    land("?ref=ABCD2345&utm_source=badge&keep=1");
    captureAffiliateRef();
    expect(window.location.search).toBe("?keep=1");
  });

  it("treats an unknown utm_source as a plain link", async () => {
    land("?ref=ABCD2345&utm_source=spam");
    captureAffiliateRef();
    await settle();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).source).toBe("link");
  });

  it("parks the click id and sends it with the redeem", async () => {
    land("?ref=ABCD2345");
    captureAffiliateRef();
    await settle();
    expect(storedAffiliateClickId("abcd2345")).toBe("click-1");
    expect(storedAffiliateClickId("OTHER234")).toBeNull();
    await redeemStoredAffiliateRef();
    const opts = edgeFetch.mock.calls[0]![1] as { json: Record<string, unknown> };
    expect(opts.json).toEqual({ code: "ABCD2345", source: "affiliate", click_id: "click-1" });
  });
});

describe("referralLink", () => {
  it("is one canonical signup link on the real site, tagged by channel", async () => {
    const { referralLink } = await import("@/lib/affiliate");
    for (const ch of ["copy", "x", "facebook", "whatsapp", "email", "badge"] as const) {
      const link = referralLink("ABCD2345", ch);
      expect(link.startsWith("https://gradethread.com/signup?ref=ABCD2345")).toBe(true);
      expect(new URL(link).searchParams.get("utm_source")).toBe(ch);
    }
  });
});

describe("proof-of-grade copy", () => {
  it("marketplace lines carry no link and the site badge is plain ASCII", async () => {
    const { EBAY_PROOF_LINE, MARKETPLACE_PROOF_LINE } = await import("@/lib/proof-of-grade");
    const { affiliateBadgeEmbed } = await import("@/lib/affiliate");
    for (const line of [EBAY_PROOF_LINE, MARKETPLACE_PROOF_LINE]) {
      expect(line).not.toMatch(/http|<a|gradethread\.com/i);
    }
    const badge = affiliateBadgeEmbed("ABCD2345");
    expect(badge).toMatch(/^[\x20-\x7E\n]*$/);
    expect(badge).toContain("&#10003;");
    expect(badge).toContain('href="https://gradethread.com/signup?ref=ABCD2345&amp;utm_source=badge"');
  });
});
