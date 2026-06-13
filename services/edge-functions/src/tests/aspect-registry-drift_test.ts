// US-822: drift guard between the canonical aspect registry
// (lib/aspect-registry.ts) and the web's vendored copy
// (src/lib/ebay-aspect-registry.json). The web composer imports the JSON so
// Vite/vitest don't reach across the package boundary into the Deno edge code —
// but that copy MUST byte-match the source, or the field→aspect mapping drifts
// silently between publish (server) and the composer preview (web). Run
// `npm run sync:aspects` to regenerate the copy if this fails.
import { assertEquals } from "@std/assert";
import { serializeRegistry } from "../lib/aspect-registry.ts";

const VENDORED_PATH = new URL(
  "../../../../src/lib/ebay-aspect-registry.json",
  import.meta.url,
);

// Newline-agnostic: a Windows checkout (autocrlf) may store the vendored JSON
// with CRLF, while serializeRegistry() always emits LF. Compare on content, not
// line-ending bytes, so the guard is stable cross-platform.
const lf = (s: string) => s.replace(/\r\n/g, "\n");

Deno.test("vendored web aspect registry matches the canonical source", () => {
  const vendored = Deno.readTextFileSync(VENDORED_PATH);
  assertEquals(
    lf(vendored),
    lf(serializeRegistry()),
    "src/lib/ebay-aspect-registry.json is stale — run `npm run sync:aspects`",
  );
});
