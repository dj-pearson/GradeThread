import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { groupQueue, type ExtensionQueueItem } from "@/hooks/use-extension-queue";

const here = dirname(fileURLToPath(import.meta.url));

function job(over: Partial<ExtensionQueueItem>): ExtensionQueueItem {
  return {
    id: Math.random().toString(36).slice(2),
    kind: "list",
    platform: "poshmark",
    inventory_item_id: null,
    listing_id: null,
    payload: {},
    status: "queued",
    attempts: 0,
    source: "web",
    claimed_at: null,
    completed_at: null,
    result: null,
    expires_at: "2026-10-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

describe("groupQueue", () => {
  it("splits one flat list into per-channel counts by verb", () => {
    const groups = groupQueue([
      job({ platform: "poshmark", kind: "list" }),
      job({ platform: "poshmark", kind: "list" }),
      job({ platform: "poshmark", kind: "delist" }),
      job({ platform: "mercari", kind: "revise" }),
    ]);
    expect(groups.map((g) => g.platform)).toEqual(["poshmark", "mercari"]);
    expect(groups[0]!.kinds.list).toBe(2);
    expect(groups[0]!.kinds.delist).toBe(1);
    expect(groups[0]!.total).toBe(3);
    expect(groups[1]!.kinds.revise).toBe(1);
  });

  it("orders channels by outstanding count, so the one needing the browser leads", () => {
    const groups = groupQueue([
      job({ platform: "mercari" }),
      job({ platform: "poshmark" }),
      job({ platform: "poshmark" }),
    ]);
    expect(groups[0]!.platform).toBe("poshmark");
  });

  it("breaks a tie by name, so the order does not shuffle between renders", () => {
    const groups = groupQueue([job({ platform: "vinted" }), job({ platform: "grailed" })]);
    expect(groups.map((g) => g.platform)).toEqual(["grailed", "vinted"]);
  });

  it("counts a kind it does not recognise toward the total anyway", () => {
    // An undercount is a seller told less is waiting than actually is. A future
    // verb the client has not learned yet must still show up in the number.
    const groups = groupQueue([
      job({ platform: "poshmark", kind: "share" as unknown as ExtensionQueueItem["kind"] }),
    ]);
    expect(groups[0]!.total).toBe(1);
    expect(groups[0]!.kinds.list).toBe(0);
  });

  it("an empty queue produces no groups rather than an empty row", () => {
    expect(groupQueue([])).toEqual([]);
  });
});

describe("the drain signal is claimed_at, and its absence is stated out loud", () => {
  it("the edge reads claimed_at, not completed_at", () => {
    // completed_at would report "never drained" for a seller whose only drain
    // hit a failing listing form — the opposite of the truth, and it would send
    // them to reinstall a working extension.
    const route = readFileSync(
      resolve(here, "../../services/edge-functions/src/routes/flipdesk-extension-queue.ts"),
      "utf8",
    );
    const fn = route.slice(route.indexOf("async function lastDrainedAt"));
    expect(fn).toMatch(/\.select\("claimed_at"\)/);
    expect(fn).toMatch(/\.eq\("user_id", ownerId\)/); // US-268
    expect(fn.slice(0, fn.indexOf("\n}"))).not.toMatch(/completed_at/);
  });

  it("the queue section renders with an empty queue instead of returning null", () => {
    // The empty-state guard was the bug: "nothing queued" and "nothing has ever
    // run" rendered the same blank screen and mean opposite things.
    const page = readFileSync(resolve(here, "../pages/flipdesk/marketplaces.tsx"), "utf8");
    const section = page.slice(page.indexOf("function ExtensionQueueSection"));
    const guard = section.slice(0, section.indexOf("return ("));
    expect(guard).toMatch(/if \(isLoading\) return null;/);
    expect(guard).not.toMatch(/pending\.length === 0 && needsAttention\.length === 0/);
  });

  it("a null last-drain is worded, never rendered as a blank date", () => {
    const page = readFileSync(resolve(here, "../pages/flipdesk/marketplaces.tsx"), "utf8");
    expect(page).toMatch(/never run any of this/);
  });
});
