// V11: a reveal toggle patches its own hop in the cache instead of refetching.
import { describe, it, expect } from "vitest";
import { patchNode, type NodesResponse } from "@/hooks/use-passport-identity";

const base: NodesResponse = {
  verified_profile_public: true,
  verified_handle: "alpha",
  nodes: [
    { node_id: "a", label: "A", kind: "seller", revealed: false, revealed_at: null, revealed_effective: false, passport_slug: null, sku_class: {} },
    { node_id: "b", label: "B", kind: "seller", revealed: true, revealed_at: null, revealed_effective: true, passport_slug: null, sku_class: {} },
  ],
};

describe("patchNode", () => {
  it("changes only the named hop", () => {
    const out = patchNode(base, "a", { revealed: true, revealed_effective: true })!;
    expect(out.nodes[0]).toMatchObject({ node_id: "a", revealed: true, revealed_effective: true });
    expect(out.nodes[1]).toBe(base.nodes[1]);
    expect(base.nodes[0]?.revealed).toBe(false);
  });

  it("leaves an empty cache empty", () => {
    expect(patchNode(undefined, "a", { revealed: true })).toBeUndefined();
  });
});
