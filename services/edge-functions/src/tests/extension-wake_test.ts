// US-3142 — the push that wakes the seller's extension when a sale lands.
//
// The wake exists to turn "within five minutes" into "within seconds". Nothing
// about it fails loudly: with the payload wrong, the kind filter missing or the
// call in the wrong place, the delist still happens on the alarm and the only
// evidence is a seller wondering why it felt slow. So the properties below are
// pinned, and each one names the quiet failure it prevents.
//
// deliverExtensionWake pulls in the service-role client, so the env comes first
// and the assertions are on the pure payload plus the source. That is the same
// shape as notify-push_test.ts, for the same reason.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { EXTENSION_WAKE_PAYLOAD } = await import("../lib/notify.ts");

const NOTIFY = await Deno.readTextFile(new URL("../lib/notify.ts", import.meta.url));
const CROSS = await Deno.readTextFile(new URL("../lib/cross-listings.ts", import.meta.url));
const ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-extension-queue.ts", import.meta.url),
);
const EXT_BG = await Deno.readTextFile(
  new URL("../../../../extension-unified/background.js", import.meta.url),
);

Deno.test("US-3142: the wake says there is work, and says nothing else", () => {
  // A push endpoint is a bearer capability — whoever holds it can send the
  // worker anything. The only safe payload is one that carries no instruction,
  // so a leaked or replayed wake buys an attacker one authenticated queue read
  // the extension was about to make anyway.
  assertEquals(EXTENSION_WAKE_PAYLOAD, { type: "gt-drain" });
  assertEquals(
    Object.keys(EXTENSION_WAKE_PAYLOAD).length,
    1,
    "the wake grew a field. It must never carry a listing, a marketplace, a " +
      "URL or a token.",
  );
});

Deno.test("US-3142: the extension matches the same string the server sends", () => {
  // Two files, one literal, no shared module between a Deno service and a
  // browser extension. If these drift the push is delivered, ignored, and
  // nothing anywhere reports a problem.
  assert(
    EXT_BG.includes(`const PUSH_WAKE_TYPE = "${EXTENSION_WAKE_PAYLOAD.type}";`),
    `the extension's PUSH_WAKE_TYPE no longer matches the server's ` +
      `"${EXTENSION_WAKE_PAYLOAD.type}", so every wake is silently discarded`,
  );
});

Deno.test("US-3142: browser and extension subscriptions never cross", () => {
  // An extension subscription is silent (userVisibleOnly:false) and its worker
  // shows no notification; a browser one is not. Send a wake to a browser
  // subscription and Chrome surfaces its generic "updated in the background"
  // notice. Send a real notification to the extension and it vanishes.
  assert(
    /await fanOutPush\(userId, "browser", payload\)/.test(NOTIFY),
    "deliverPush no longer restricts itself to browser subscriptions",
  );
  assert(
    /await fanOutPush\(userId, "extension", EXTENSION_WAKE_PAYLOAD\)/.test(NOTIFY),
    "deliverExtensionWake no longer restricts itself to extension subscriptions",
  );
  assert(
    /\.eq\("kind", kind\)/.test(NOTIFY),
    "the fan-out query lost its kind filter, so every notification now reaches " +
      "both surfaces",
  );
});

Deno.test("US-3142: the wake fires only after the row is really queued", () => {
  const enqueue = CROSS.indexOf("await enqueueExtensionWork(");
  const refusal = CROSS.indexOf("if (!result.ok) {");
  const wake = CROSS.indexOf("void deliverExtensionWake(ownerId)");
  assert(enqueue > -1 && refusal > -1 && wake > -1, "the queue-and-wake block moved");
  assert(
    enqueue < refusal && refusal < wake,
    "the wake no longer sits after the refusal check, so a refused enqueue " +
      "wakes a browser to drain a queue with nothing in it",
  );
  // The refusal branch must actually stop, or the ordering above proves nothing.
  const between = CROSS.slice(refusal, wake);
  assert(
    between.includes("\n      return;\n"),
    "the refusal branch no longer returns, so the wake runs anyway",
  );
});

Deno.test("US-3142: the subscription's kind is the server's word, not the client's", () => {
  // A client that could name its own kind could register a SILENT subscription
  // that then received the seller's real notifications — every offer, payout
  // and sale, delivered somewhere they would never see them.
  const post = ROUTE.slice(
    ROUTE.indexOf('flipdeskExtensionQueueRoutes.post("/push-subscription"'),
    ROUTE.indexOf('flipdeskExtensionQueueRoutes.delete("/push-subscription"'),
  );
  assert(post.length > 200, "the push-subscription handler moved");
  assert(/kind: "extension",/.test(post), "the handler no longer stamps the kind");
  assert(
    !/body\?\.kind|body\.kind/.test(post),
    "the handler reads a kind from the request body",
  );
});

Deno.test("US-3142: the delete is scoped to the owner AND the kind", () => {
  // US-268: the endpoint arrives from the client, so it is filtered together
  // with the owner — a foreign endpoint must match zero rows rather than
  // deleting somebody else's subscription. The kind filter is the second half:
  // without it this route would also delete a seller's real browser push.
  const del = ROUTE.slice(ROUTE.indexOf('flipdeskExtensionQueueRoutes.delete("/push-subscription"'));
  const body = del.slice(0, del.indexOf("});"));
  assert(/\.eq\("user_id", ownerId\)/.test(body), "the delete is not owner-scoped");
  assert(/\.eq\("endpoint", endpoint\)/.test(body), "the delete no longer filters the endpoint");
  assert(
    /\.eq\("kind", "extension"\)/.test(body),
    "the delete can now remove a browser subscription, silently turning off " +
      "the seller's ordinary notifications",
  );
});
