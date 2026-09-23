// INV-7 follow-up: the bulk dialogs now receive a cross-page selection (up to
// 2,000 ids), and the ads route resolves them with one `.in()` read in the URL.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));

import { sendPromoteInChunks } from "../bulk-promote-send";

function reply(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

describe("sendPromoteInChunks", () => {
  it("sends 250 ids as 100 / 100 / 50 and merges the results", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `l${i}`);
    const sizes: number[] = [];
    const fetcher = vi.fn((_p: string, init?: RequestInit) => {
      const part = JSON.parse(String(init?.body)).listing_ids as string[];
      sizes.push(part.length);
      return Promise.resolve(
        reply({
          succeeded: part.length - 1,
          failed: 1,
          results: part.map((id, i) => ({ listingId: id, ok: i > 0, error: i > 0 ? null : "no" })),
        }),
      );
    });
    const res = await sendPromoteInChunks(ids, 5, "create", fetcher as never);
    expect(sizes).toEqual([100, 100, 50]);
    expect(res.succeeded).toBe(247);
    expect(res.failed).toBe(3);
    expect(res.results).toHaveLength(250);
  });

  it("a later chunk failing says how many were already sent", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `l${i}`);
    let n = 0;
    const fetcher = vi.fn(() =>
      Promise.resolve(
        ++n === 1
          ? reply({ succeeded: 100, failed: 0, results: [] })
          : reply({ error: "Some listings can't be promoted." }, 409),
      ),
    );
    await expect(sendPromoteInChunks(ids, 5, "update", fetcher as never)).rejects.toThrow(
      "Some listings can't be promoted. (100 of 150 were already sent.)",
    );
  });
});
