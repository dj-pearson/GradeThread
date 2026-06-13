// US-822: regenerate the vendored web copy of the eBay aspect registry from the
// canonical edge source. Invoked by scripts/sync-aspect-registry.mjs (which is
// the npm entry point); kept as a real file rather than `deno eval` so Windows
// shell quoting can't mangle the inline code. Run via `npm run sync:aspects`.
import { serializeRegistry } from "../services/edge-functions/src/lib/aspect-registry.ts";

const out = new URL("../src/lib/ebay-aspect-registry.json", import.meta.url);
await Deno.writeTextFile(out, serializeRegistry());
console.log(`sync-aspect-registry: wrote ${out.pathname}`);
