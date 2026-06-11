import { type MarketplaceAdapter, notImplemented } from "./types.ts";

// Stub (US-149): cross-push creates the Mercari listings row locally; this
// adapter starts publishing it once the Mercari integration ships.
export const mercariAdapter: MarketplaceAdapter = {
  platform: "mercari",
  publish: () => Promise.resolve(notImplemented("mercari")),
  end: () => Promise.resolve(notImplemented("mercari")),
};
