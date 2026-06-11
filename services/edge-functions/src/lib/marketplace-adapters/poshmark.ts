import { type MarketplaceAdapter, notImplemented } from "./types.ts";

// Stub (US-149): cross-push creates the Poshmark listings row locally; this
// adapter starts publishing it once the Poshmark integration ships.
export const poshmarkAdapter: MarketplaceAdapter = {
  platform: "poshmark",
  publish: () => Promise.resolve(notImplemented("poshmark")),
  end: () => Promise.resolve(notImplemented("poshmark")),
};
