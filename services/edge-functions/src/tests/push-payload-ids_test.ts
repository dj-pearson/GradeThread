// US-3275: the ids the iOS notification actions need, stamped by the edge.
//
// ⚠ WHAT THIS IS GUARDING. iOS hides an inline button whose payload cannot
// serve it (US-3274), and it decides that from a hand-mirrored list in
// NotificationActions.swift. The mirror is the risk: a key added on the Swift
// side that the edge does not send re-enables a button that fires a Face ID
// prompt and then does nothing, which is the exact defect that story fixed.
//
// So this reads the SWIFT FILE and the sender source and fails when they
// disagree. The Swift test asserts the same thing from its side; neither is
// sufficient alone, because each can only see the file it is compiled with.

import { assert, assertEquals } from "@std/assert";
import { PUSH_CONTRACT, payloadKeysFor } from "../lib/transactional-push.ts";

const PUSH = await Deno.readTextFile(
  new URL("../lib/transactional-push.ts", import.meta.url),
);
const SWIFT = await Deno.readTextFile(
  new URL(
    "../../../../ios/GradeThread/Notifications/NotificationActions.swift",
    import.meta.url,
  ),
);

/** Source with comments stripped, so a sentence about a key is not a key. */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("///") && !t.startsWith("*");
    })
    .join("\n");
}

const PUSH_CODE = codeOf(PUSH);
const SWIFT_CODE = codeOf(SWIFT);

/** What `payloadKeys` returns for one category, read out of the Swift. */
function swiftKeysFor(swiftCase: string): Set<string> {
  const body = SWIFT_CODE.slice(SWIFT_CODE.indexOf("var payloadKeys: Set<String>"));
  const end = body.indexOf("var declaredActions");
  const seg = body.slice(0, end === -1 ? undefined : end);
  const at = seg.indexOf(`case .${swiftCase}:`);
  if (at === -1) return new Set(["kind"]);
  const ret = seg.slice(at, seg.indexOf("return", at) + 200);
  const list = /return \[([^\]]*)\]/.exec(ret);
  if (!list) return new Set();
  return new Set([...list[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
}

/**
 * The `data` keys one sender ships.
 *
 * ⚠ THIS USED TO PARSE A `data: { ... }` BLOCK OUT OF EACH SENDER, and it
 * answered "may carry" rather than "carries": every sender that called
 * idFields() reported all four id keys whatever it actually passed, so the
 * check below could only be a subset test. US-3279 moved the answer into
 * PUSH_CONTRACT, where it is exact, and this now reads that.
 */
function senderKeys(category: keyof typeof PUSH_CONTRACT): Set<string> {
  return new Set(payloadKeysFor(category));
}

Deno.test("US-3275 AC1: the offer push carries the ids Accept and Counter need", () => {
  const notify = Deno.readTextFileSync(
    new URL("../lib/marketplace-event-notify.ts", import.meta.url),
  );
  const call = /pushOfferReceived\(userId, ev\.itemTitle, \{([\s\S]{0,200}?)\}\)/.exec(notify);
  assert(call, "notifyOfferReceived no longer passes ids to pushOfferReceived");
  // ⚠ THE VALUE, NOT THE KEY. A first draft asserted the key name was present
  // and a sabotage replacing `ev.bestOfferId` with `null` left it green --
  // which is a push that carries the shape of an id and none of the id.
  assert(
    /bestOfferId:\s*ev\.bestOfferId\b/.test(call[1]!),
    "the offer id passed is not the event's",
  );
  assert(
    /inventoryItemId:\s*ev\.inventoryItemId\b/.test(call[1]!),
    "the item id passed is not the event's",
  );
  assertEquals(swiftKeysFor("offerReceived"), new Set([
    "kind",
    "best_offer_id",
    "inventory_item_id",
  ]));
});

Deno.test("US-3275 AC2: the sale push carries the id Mark shipped closes", () => {
  const selling = Deno.readTextFileSync(
    new URL("../lib/selling-activity-notify.ts", import.meta.url),
  );
  const call = /pushSaleCreated\(uid, opts\.itemTitle, \{([\s\S]{0,200}?)\}\)/.exec(selling);
  assert(call, "notifySaleRecorded no longer passes ids to pushSaleCreated");
  // The value, for the same reason as above.
  assert(
    /saleId:\s*opts\.saleId\b/.test(call[1]!),
    "the sale id passed is not the caller's",
  );
  assert(
    /inventoryItemId:\s*opts\.itemId\b/.test(call[1]!),
    "the item id passed is not the caller's",
  );
  assertEquals(swiftKeysFor("saleCreated"), new Set([
    "kind",
    "sale_id",
    "inventory_item_id",
  ]));
});

Deno.test("US-3275 AC2: the sale caller actually has a sale id to pass", () => {
  // The id is free at the call site -- it comes off the insert a few lines
  // above -- and passing `null` here would leave the button hidden while the
  // wiring looked done.
  const route = Deno.readTextFileSync(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  const call = /notifySaleRecorded\(userId, \{([\s\S]{0,400}?)\}\)/.exec(route);
  assert(call, "the eBay sync no longer calls notifySaleRecorded");
  assert(
    /saleId:\s*newSaleId/.test(call[1]!),
    "the sale id is not passed from the sync's own insert",
  );
});

Deno.test("US-3275 AC3: every post-order sender names its case", () => {
  const notify = codeOf(
    Deno.readTextFileSync(new URL("../lib/marketplace-event-notify.ts", import.meta.url)),
  );
  const expected: Array<[string, string]> = [
    ["pushReturnOpened", "returnId"],
    ["pushInquiryOpened", "inquiryId"],
    ["pushCaseOpened", "caseId"],
    ["pushPostSaleDeadline", "externalId"],
    ["pushCancellationRequested", "cancelId"],
    ["pushDisputeOpened", "disputeId"],
  ];
  for (const [fn, field] of expected) {
    const at = notify.indexOf(`${fn}(userId,`);
    assert(at > 0, `${fn} is no longer called`);
    const call = notify.slice(at, at + 200);
    assert(
      new RegExp(`caseId:\\s*ev\\.${field}\\b`).test(call),
      `${fn} does not stamp ev.${field}`,
    );
  }
});

Deno.test("US-3275 AC4: iOS and the edge agree about every category", () => {
  // ⚠ THE MIRROR, FROM THE EDGE'S SIDE, AND IT IS AN EQUALITY NOW.
  // It used to be a subset check, because the sender parse could only say
  // which keys a category MIGHT carry -- so iOS claiming `sale_id` on
  // offer.received would have passed. US-3279's PUSH_CONTRACT answers exactly,
  // so the two lists have to match.
  const pairs: Array<[string, keyof typeof PUSH_CONTRACT]> = [
    ["offerReceived", "offer.received"],
    ["saleCreated", "sale.created"],
    ["delistNeeded", "delist.needed"],
  ];
  for (const [swiftCase, category] of pairs) {
    assertEquals(
      [...swiftKeysFor(swiftCase)].sort(),
      [...senderKeys(category)].sort(),
      `iOS and the edge disagree about ${category}`,
    );
  }
});

Deno.test("US-3275: an absent id is OMITTED, never sent as null", () => {
  // iOS tests membership of the key. A null would read as present and
  // re-enable a button that still cannot work.
  const at = PUSH_CODE.indexOf("function idFields(");
  assert(at > 0, "idFields is gone");
  const body = PUSH_CODE.slice(at, PUSH_CODE.indexOf("\n}", at));
  assert(
    /if \(value\) out\[key\] = value;/.test(body),
    "idFields no longer gates each key on the value being present",
  );
  assert(!/\?\?\s*null/.test(body), "idFields writes a null into the payload");
  // And the behaviour, not only its shape: a category's declared ids are the
  // ceiling, so nothing else can reach the wire however a caller is written.
  assertEquals(payloadKeysFor("listing.ended"), ["kind"]);
});

Deno.test("US-3275: the key names are the wire contract, spelled the same", () => {
  // Renaming one on either side disables the button on every installed app,
  // and nothing else would notice.
  for (const key of ["best_offer_id", "inventory_item_id", "sale_id"]) {
    assert(PUSH_CODE.includes(key), `the edge no longer spells "${key}"`);
    assert(SWIFT_CODE.includes(`"${key}"`), `iOS no longer spells "${key}"`);
  }
});
