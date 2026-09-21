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

/** The `data` keys one sender ships, read out of the TypeScript. */
function senderKeys(fnName: string): Set<string> {
  const at = PUSH_CODE.indexOf(`export function ${fnName}(`);
  assert(at > 0, `${fnName} not found in transactional-push.ts`);
  const body = PUSH_CODE.slice(at, at + 1400);
  const data = /data: \{([^}]*)\}/.exec(body);
  assert(data, `${fnName} has no data block`);
  const keys = new Set<string>(["kind"]);
  // idFields() expands to the four id keys; which of them actually arrive is
  // decided by the caller, so the contract this file holds is "may carry".
  if (data[1]!.includes("idFields(")) {
    for (const k of ["best_offer_id", "inventory_item_id", "sale_id", "case_id"]) {
      keys.add(k);
    }
  }
  // And any key written literally into the block, so a sender that stops
  // using idFields is still read rather than silently reported as bare.
  for (const m of data[1]!.matchAll(/\b([a-z][a-z_]*_id|kind|action)\s*:/g)) {
    keys.add(m[1]!);
  }
  return keys;
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
  // ⚠ THE MIRROR, FROM THE EDGE'S SIDE. The Swift test checks the same thing
  // against its own hand-written table; this one checks the Swift against the
  // senders. A key claimed on one side and not sent on the other is a button
  // that asks for a fingerprint and then does nothing.
  const offer = senderKeys("pushOfferReceived");
  for (const k of swiftKeysFor("offerReceived")) {
    assert(offer.has(k), `iOS expects "${k}" on offer.received and the edge cannot send it`);
  }
  const sale = senderKeys("pushSaleCreated");
  for (const k of swiftKeysFor("saleCreated")) {
    assert(sale.has(k), `iOS expects "${k}" on sale.created and the edge cannot send it`);
  }
  const delist = senderKeys("pushDelistNeeded");
  for (const k of swiftKeysFor("delistNeeded")) {
    assert(delist.has(k), `iOS expects "${k}" on delist.needed and the edge cannot send it`);
  }
});

Deno.test("US-3275: an absent id is OMITTED, never sent as null", () => {
  // iOS tests membership of the key. A null would read as present and
  // re-enable a button that still cannot work.
  const at = PUSH_CODE.indexOf("function idFields(");
  assert(at > 0, "idFields is gone");
  const body = PUSH_CODE.slice(at, PUSH_CODE.indexOf("\n}", at));
  for (const key of ["best_offer_id", "inventory_item_id", "sale_id", "case_id"]) {
    assert(
      new RegExp(`if \\(ids\\?\\.[a-zA-Z]+\\) out\\.${key} =`).test(body),
      `${key} is not guarded by a truthiness check`,
    );
  }
  assert(!/\?\?\s*null/.test(body), "idFields writes a null into the payload");
});

Deno.test("US-3275: the key names are the wire contract, spelled the same", () => {
  // Renaming one on either side disables the button on every installed app,
  // and nothing else would notice.
  for (const key of ["best_offer_id", "inventory_item_id", "sale_id"]) {
    assert(PUSH_CODE.includes(key), `the edge no longer spells "${key}"`);
    assert(SWIFT_CODE.includes(`"${key}"`), `iOS no longer spells "${key}"`);
  }
});
