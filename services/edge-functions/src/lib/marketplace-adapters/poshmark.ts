import { makeStubAdapter } from "./stub.ts";

// Stub (US-708): cross-push maps + creates the Poshmark listings row locally;
// its publish/connect/sync return a typed 501 until the integration ships.
export const poshmarkAdapter = makeStubAdapter("poshmark");
