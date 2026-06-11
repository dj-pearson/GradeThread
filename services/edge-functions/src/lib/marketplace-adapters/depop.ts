import { type MarketplaceAdapter, notImplemented } from "./types.ts";

// Stub (US-149): cross-push creates the Depop listings row locally; this
// adapter starts publishing it once the Depop integration ships.
export const depopAdapter: MarketplaceAdapter = {
  platform: "depop",
  publish: () => Promise.resolve(notImplemented("depop")),
  end: () => Promise.resolve(notImplemented("depop")),
};
