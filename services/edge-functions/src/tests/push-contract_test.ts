// US-3279: the generated push contract, and the guard that stops it rotting.
//
// ⚠ WHAT THIS IS GUARDING. iOS and Android used to keep their own copy of the
// category list and the payload keys, written by hand. Three bugs in one
// session came out of that and each had a nearby comment asserting the
// opposite, written when it was true:
//   US-3266  the edge sent seven categories iOS had never heard of, so every
//            tap on a return, case or dispute push went nowhere
//   US-3268  iOS offered three Settings toggles for pushes nothing can send
//   US-3274  five inline buttons the payload could not serve, one of which
//            asked for Face ID and then did nothing
//
// A checked-in artefact only helps if a stale one fails. That is this file.

// US-2379: the static import graph reaches src/lib/supabase.ts, so the env
// stub loads first. Kept as the first import on purpose.
import "./_env.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildPushContractArtifact,
  sendersFromSource,
  serializePushContractArtifact,
} from "../lib/push-contract-artifact.ts";
import { PUSH_CONTRACT, payloadKeysFor } from "../lib/transactional-push.ts";

const ARTIFACT_URL = new URL(
  "../../../../contracts/push-contract.json",
  import.meta.url,
);
const PUSH_SRC = Deno.readTextFileSync(
  new URL("../lib/transactional-push.ts", import.meta.url),
);

Deno.test("US-3279 AC2: the checked-in artefact matches the senders", () => {
  const onDisk = Deno.readTextFileSync(ARTIFACT_URL);
  const rebuilt = serializePushContractArtifact(buildPushContractArtifact());
  assertEquals(
    onDisk,
    rebuilt,
    "contracts/push-contract.json is stale. Run:\n" +
      "  cd services/edge-functions && deno task push-contract",
  );
});

Deno.test("US-3279 AC1: every category the edge sends is in the artefact", () => {
  const artifact = JSON.parse(Deno.readTextFileSync(ARTIFACT_URL));
  const ids = new Set<string>(
    artifact.categories.map((c: { id: string }) => c.id),
  );
  // Read the sends out of the source rather than off the table, so a sender
  // added without a table entry is caught here and not only by the builder.
  for (const category of sendersFromSource(PUSH_SRC).keys()) {
    assert(ids.has(category), `the edge sends "${category}" and the artefact omits it`);
  }
  assertEquals(ids.size, Object.keys(PUSH_CONTRACT).length);
});

Deno.test("US-3279: NO push in this service sends a category the artefact omits", () => {
  // ⚠ THE SCAN THAT FOUND "marketing". Reading transactional-push.ts alone
  // proves the helpers agree with the table and nothing about a route that
  // calls sendPushToUser directly -- which admin-growth.ts does, with a
  // category iOS had never heard of. That is US-3266 again, in a file nobody
  // looked at because the contract lived somewhere else.
  const known = new Set(Object.keys(PUSH_CONTRACT));
  const found = new Map<string, string>();
  for (const entry of walk(new URL("../", import.meta.url))) {
    if (!entry.endsWith(".ts") || entry.includes("/tests/")) continue;
    const src = Deno.readTextFileSync(entry);
    if (!src.includes("sendPushToUser(")) continue;
    for (const m of src.matchAll(/category:\s*"([a-z][a-z_.]*)"/g)) {
      found.set(m[1]!, entry);
    }
  }
  assert(found.size > 0, "the scan matched nothing, so it proves nothing");
  for (const [category, file] of found) {
    assert(
      known.has(category),
      `${file} pushes "${category}" and PUSH_CONTRACT does not declare it`,
    );
  }
});

/** Every file under `dir`, recursively. */
function walk(dir: URL): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    const child = new URL(`${e.name}${e.isDirectory ? "/" : ""}`, dir);
    if (e.isDirectory) out.push(...walk(child));
    else out.push(child.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  }
  return out;
}

Deno.test("US-3279: an external sender has to actually send it", () => {
  // The escape hatch for a category sent outside transactional-push.ts is the
  // obvious way to get a dead entry into the artefact, so the path is read.
  assertThrows(
    () => buildPushContractArtifact(PUSH_SRC, () => "// nothing sends anything"),
    Error,
    'sends "marketing" and it does not',
  );
});

Deno.test("US-3279: a category nothing sends cannot reach the artefact", () => {
  // US-3268 in one assertion. A declared-but-unsent category is what put three
  // toggles in Settings for pushes that could never arrive.
  //
  // The sabotage is the realistic one: a sender goes back to spelling its own
  // category and `data` by hand, so the table keeps promising a push nothing
  // ships. That is how the three dead toggles got there in the first place.
  const gutted = PUSH_SRC.replace(
    '...describe("payout.cleared"),',
    'category: "payout.cleared", data: { kind: "payout_cleared" },',
  );
  assert(gutted !== PUSH_SRC, "the payout.cleared sender no longer looks like this");
  assertThrows(
    () => buildPushContractArtifact(gutted),
    Error,
    "payout.cleared",
  );
});

Deno.test("US-3279: two senders cannot claim one category", () => {
  // Otherwise `sender` in the artefact names whichever one the regex reached
  // first, and the file reads authoritative while being half the answer.
  const doubled = PUSH_SRC.replace(
    '...describe("listing.ended"),',
    '...describe("payout.cleared"),',
  );
  assertThrows(
    () => buildPushContractArtifact(doubled),
    Error,
    'two senders ship "payout.cleared"',
  );
});

Deno.test("US-3279: the artefact's payload keys are the ones the code builds", () => {
  const artifact = JSON.parse(Deno.readTextFileSync(ARTIFACT_URL));
  for (const entry of artifact.categories as Array<{ id: string; payloadKeys: string[] }>) {
    assertEquals(
      entry.payloadKeys,
      payloadKeysFor(entry.id as keyof typeof PUSH_CONTRACT).slice().sort(),
      `${entry.id}'s payload keys in the artefact are not what payloadKeysFor returns`,
    );
  }
});

Deno.test("US-3279: an id a category does not declare never reaches the wire", () => {
  // The fail-safe direction, and the reason `ids` is a ceiling. A caller that
  // passes the wrong id to the wrong sender gets it dropped, rather than
  // shipping a key that re-enables a button which cannot work.
  const keys = payloadKeysFor("listing.ended");
  assertEquals(keys, ["kind"]);
  const sale = payloadKeysFor("sale.created").slice().sort();
  assertEquals(sale, ["inventory_item_id", "kind", "sale_id"]);
  assert(!sale.includes("best_offer_id"), "sale.created must not carry an offer id");
});

Deno.test("US-3279: the artefact says out loud that it is generated", () => {
  // A reader who hand-edits it re-creates the defect the file prevents, and
  // the only thing standing between them and that is this sentence.
  const artifact = JSON.parse(Deno.readTextFileSync(ARTIFACT_URL));
  assert(/do not hand-edit/i.test(artifact.note));
  assert(
    artifact.generatedBy.endsWith("generate-push-contract.ts"),
    "the artefact does not name the script that writes it",
  );
});
