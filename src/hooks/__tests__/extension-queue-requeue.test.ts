// MP-10 review: "Queue again" re-POSTs a dead row's instruction.
//
// A revise is refused (400) by the enqueue path unless the request names its
// `fields`, which the original enqueue stamped onto the payload. A relist is
// not requeueable at all: each enqueue inserts a new draft copy of the listing.
import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (...args: unknown[]) => edgeFetch(...args),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
}));

const { canRequeue, useRequeueExtensionWork } = await import("@/hooks/use-extension-queue");

type Job = Parameters<ReturnType<typeof useRequeueExtensionWork>["mutate"]>[0];

function job(kind: string, payload: Record<string, unknown>): Job {
  return {
    id: "dead-1",
    kind,
    platform: "poshmark",
    inventory_item_id: null,
    listing_id: "22222222-2222-4222-8222-222222222222",
    payload,
    status: "expired",
    attempts: 0,
    source: "web",
    claimed_at: null,
    completed_at: null,
    result: null,
    created_at: new Date().toISOString(),
  } as unknown as Job;
}

const ok = { ok: true, status: 201, json: () => Promise.resolve({}) } as unknown as Response;

describe("useRequeueExtensionWork", () => {
  beforeEach(() => {
    edgeFetch.mockReset();
    edgeFetch.mockResolvedValue(ok);
  });

  it("sends a revise's field list, or the edge refuses it", async () => {
    const m = useRequeueExtensionWork() as unknown as { mutationFn: (j: Job) => Promise<void> };
    await m.mutationFn(job("revise", { fields: ["price"], price: 20 }));
    const body = (edgeFetch.mock.calls[0]![1] as { json: Record<string, unknown> }).json;
    expect(body.kind).toBe("revise");
    expect(body.fields).toEqual(["price"]);
  });

  it("sends no fields key for other kinds", async () => {
    const m = useRequeueExtensionWork() as unknown as { mutationFn: (j: Job) => Promise<void> };
    await m.mutationFn(job("delist", {}));
    const body = (edgeFetch.mock.calls[0]![1] as { json: Record<string, unknown> }).json;
    expect("fields" in body).toBe(false);
  });

  it("offers no requeue for a relist", () => {
    expect(canRequeue({ kind: "relist" } as Job)).toBe(false);
    expect(canRequeue({ kind: "delist" } as Job)).toBe(true);
    expect(canRequeue({ kind: "revise" } as Job)).toBe(true);
  });
});
