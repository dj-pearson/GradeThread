// US-3458: connecting eBay starts the first listings pull.
//
// Before this, GET /oauth/callback stored the tokens and redirected, and the
// seller's listings waited for a Sync click nobody told them to make. The
// callback is a public redirect endpoint with no JSON body to assert on, so
// the guard reads the handler's source: the call has to be there, it has to be
// the FULL scope (the catalog, not just orders), and it has to be detached so
// a pull that fails to start can never change the redirect.
//
// Run: deno test --allow-read --allow-env src/tests/ebay-connect-pull_test.ts

import { assert } from "@std/assert";
import { ebayRouteFile } from "./_ebay-routes.ts";

const ROUTE = ebayRouteFile("flipdesk-ebay-oauth.ts");

async function callbackHandler(): Promise<string> {
  const src = await Deno.readTextFile(ROUTE);
  const start = src.indexOf('flipdeskEbayRoutes.get("/oauth/callback"');
  assert(start > 0, "the eBay OAuth callback route moved; update this scan");
  const end = src.indexOf("\n});\n", start);
  return src.slice(start, end);
}

Deno.test("the eBay OAuth callback fires a full pull for the connecting user", async () => {
  const handler = await callbackHandler();
  assert(
    handler.includes('triggerEbaySyncForUser(stateUserId, "full")'),
    "the callback must start a full-scope pull for the user the state row named",
  );
});

Deno.test("the pull is fired after the connection is saved, and only on success", async () => {
  const handler = await callbackHandler();
  const saved = handler.indexOf("await upsertConnection({");
  const fired = handler.indexOf('triggerEbaySyncForUser(stateUserId, "full")');
  const connected = handler.indexOf('return finish("connected")');
  assert(
    saved > 0 && fired > saved,
    "the pull must come after upsertConnection",
  );
  assert(
    fired < connected,
    "the pull must be started before the success redirect",
  );
  // Every error exit returns before the pull: a failed exchange must not sync.
  const failedExit = handler.indexOf('return finish("exchange_failed")');
  assert(
    failedExit > 0 && failedExit < fired,
    "a failed exchange must not start a pull",
  );
});

Deno.test("the pull is detached and cannot change the redirect", async () => {
  const handler = await callbackHandler();
  const fired = handler.indexOf('triggerEbaySyncForUser(stateUserId, "full")');
  const lead = handler.slice(Math.max(0, fired - 8), fired);
  assert(
    lead.includes("void "),
    "the sync must be fired with void, never awaited",
  );
  const tail = handler.slice(fired, fired + 400);
  assert(
    tail.includes(".catch("),
    "a rejected start must be caught, not left unhandled",
  );
});
