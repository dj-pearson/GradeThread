// The eBay route SOURCE, for guards that read it as text.
//
// routes/flipdesk-ebay.ts used to hold every eBay route and helper. It now only
// mounts flipdesk-ebay-*.ts (one file per concern) and re-exports what it
// exported before; the code lives in those files and in flipdesk-ebay-shared.ts.
// A guard that still read flipdesk-ebay.ts alone would scan an 80-line mount
// file, and every "X must not appear" check in it would pass by finding nothing.
//
// Two ways in:
//   - ebayRouteFile(name): one file, for a guard pinned to where a handler or
//     helper actually lives. Prefer this; it is the stricter read.
//   - readEbayRouteSource(): every eBay route file joined, for a guard whose
//     question is about the whole module ("nothing here calls X", "every
//     /jobs/* path here is registered").
//
// The file list is read from the directory, so a new flipdesk-ebay-*.ts file is
// covered without editing this helper.

const ROUTES_DIR = new URL("../routes/", import.meta.url);

/** Every eBay route file: the mount file first, then the rest by name. */
export const EBAY_ROUTE_FILES: readonly string[] = (() => {
  const names: string[] = [];
  for (const e of Deno.readDirSync(ROUTES_DIR)) {
    if (e.isFile && /^flipdesk-ebay-.+\.ts$/.test(e.name)) names.push(e.name);
  }
  if (names.length < 10) {
    throw new Error(`expected the flipdesk-ebay-*.ts route files, found ${names.length}`);
  }
  return ["flipdesk-ebay.ts", ...names.sort()];
})();

/** URL of one eBay route file, e.g. ebayRouteFile("flipdesk-ebay-oauth.ts"). */
export function ebayRouteFile(name: string): URL {
  if (!EBAY_ROUTE_FILES.includes(name)) throw new Error(`not an eBay route file: ${name}`);
  return new URL(name, ROUTES_DIR);
}

/** Every eBay route file's text, joined in EBAY_ROUTE_FILES order. */
export function readEbayRouteSource(): string {
  return EBAY_ROUTE_FILES.map((n) => Deno.readTextFileSync(new URL(n, ROUTES_DIR))).join("\n");
}
