// MP-15: the queue refreshes itself while the desktop is running a job, and
// stays quiet otherwise.
import { describe, expect, it } from "vitest";
import { queueRefetchInterval } from "@/hooks/use-extension-queue";

const base = { needsAttention: [], finishedNeedsReview: [], lastDrainedAt: null };
const job = (status: string) => ({ id: status, status }) as never;

describe("queueRefetchInterval", () => {
  it("polls every 10 seconds while a row is claimed", () => {
    expect(queueRefetchInterval({ ...base, pending: [job("queued"), job("claimed")] })).toBe(10_000);
  });
  it("does not poll with only queued rows, or with no data", () => {
    expect(queueRefetchInterval({ ...base, pending: [job("queued")] })).toBe(false);
    expect(queueRefetchInterval(undefined)).toBe(false);
  });
});
