// US-2228 AC2 — the browser half of expense receipts.
//
// Three things here are easy to get subtly wrong and impossible to see once
// they are:
//
//   1. The multipart boundary. `uploadExpenseReceipt` must NOT set a
//      Content-Type header — the browser writes one that includes the random
//      boundary, and a hand-written "multipart/form-data" omits it, so the
//      server parses zero parts and answers "Missing receipt file" for a
//      request that plainly carried one.
//   2. The server's error text. The edge returns `{ error }` with a message
//      written for the seller; swallowing it and toasting a generic string
//      turns "That file is over 10MB" into "Receipt upload failed."
//   3. The signed URL is never cached. It expires, and a stale one 403s.

import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (...args: unknown[]) => edgeFetch(...args),
}));

const {
  MAX_RECEIPT_BYTES,
  RECEIPT_ACCEPT,
  deleteExpenseReceipt,
  expenseReceiptUrl,
  uploadExpenseReceipt,
} = await import("./expense-receipts");

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function fail(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

function file(bytes: number, type = "application/pdf"): File {
  return new File([new Uint8Array(bytes)], "receipt.pdf", { type });
}

beforeEach(() => {
  edgeFetch.mockReset();
});

describe("RECEIPT_ACCEPT", () => {
  it("offers exactly what the bucket's allowed_mime_types permits", () => {
    // Migration 00564 lists these four and no others. A picker that offered
    // HEIC would let a seller choose a file the server then refuses.
    expect(RECEIPT_ACCEPT.split(",").sort()).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

describe("uploadExpenseReceipt", () => {
  it("posts multipart WITHOUT a Content-Type header", async () => {
    edgeFetch.mockResolvedValue(ok({ receipt_path: "u/e/receipt_1.pdf" }));
    await uploadExpenseReceipt("exp-1", file(10));

    expect(edgeFetch).toHaveBeenCalledTimes(1);
    const [path, init] = edgeFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/flipdesk/expenses/exp-1/receipt");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("receipt")).toBeInstanceOf(File);
    // The header that must be absent. Present in any form → boundary lost.
    expect(init.headers).toBeUndefined();
  });

  it("refuses an oversized file without a round trip", async () => {
    await expect(
      uploadExpenseReceipt("exp-1", file(MAX_RECEIPT_BYTES + 1)),
    ).rejects.toThrow(/10MB/);
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  it("accepts a file exactly at the cap — the bound is inclusive", async () => {
    edgeFetch.mockResolvedValue(ok({}));
    await uploadExpenseReceipt("exp-1", file(MAX_RECEIPT_BYTES));
    expect(edgeFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's own message, not a generic one", async () => {
    edgeFetch.mockResolvedValue(
      fail(400, { error: "Only JPEG, PNG, WebP or PDF receipts are accepted" }),
    );
    await expect(uploadExpenseReceipt("exp-1", file(10))).rejects.toThrow(
      "Only JPEG, PNG, WebP or PDF receipts are accepted",
    );
  });

  it("falls back to a readable message when the body is not JSON", async () => {
    edgeFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    } as unknown as Response);
    await expect(uploadExpenseReceipt("exp-1", file(10))).rejects.toThrow(
      "Receipt upload failed.",
    );
  });
});

describe("expenseReceiptUrl", () => {
  it("returns the signed URL from a fresh request every time", async () => {
    edgeFetch.mockResolvedValue(ok({ url: "https://signed/one?token=abc" }));
    expect(await expenseReceiptUrl("exp-1")).toBe("https://signed/one?token=abc");

    // A cached URL would still be held after it expired, and the seller would
    // get a 403 on a link that worked ten minutes ago.
    edgeFetch.mockResolvedValue(ok({ url: "https://signed/two?token=def" }));
    expect(await expenseReceiptUrl("exp-1")).toBe("https://signed/two?token=def");
    expect(edgeFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when the response carries no url", async () => {
    edgeFetch.mockResolvedValue(ok({}));
    await expect(expenseReceiptUrl("exp-1")).rejects.toThrow(/open the receipt/);
  });

  it("throws the server's message on a 404 (no receipt attached)", async () => {
    edgeFetch.mockResolvedValue(fail(404, { error: "No receipt attached" }));
    await expect(expenseReceiptUrl("exp-1")).rejects.toThrow(
      "No receipt attached",
    );
  });
});

describe("deleteExpenseReceipt", () => {
  it("sends DELETE and resolves quietly on success", async () => {
    edgeFetch.mockResolvedValue(ok({ ok: true }));
    await deleteExpenseReceipt("exp-1");
    const [path, init] = edgeFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/flipdesk/expenses/exp-1/receipt");
    expect(init.method).toBe("DELETE");
  });

  it("throws on failure so the UI does not claim the receipt is gone", async () => {
    edgeFetch.mockResolvedValue(fail(500, { error: "Couldn't remove the receipt." }));
    await expect(deleteExpenseReceipt("exp-1")).rejects.toThrow(
      "Couldn't remove the receipt.",
    );
  });
});
