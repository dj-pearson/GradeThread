// GradeThread unified extension: the photo witness on a QUEUE row (US-3407).
//
// Zero-dependency node script: throws on drift.
//
// WHAT THIS FILE IS PROTECTING. queue/queue-view.js read exactly one field off
// `row.result`, namely `result.error`, so a drained cross-post whose uploader took
// the file selection and then rendered nothing out of the bytes came back with
// no error at all. It completed. The row carried no reason, nothing on it said
// the listing has no images, and the seller had no cause to open it. That is
// the same failure US-2738 (commit 163095e66) fixed on the DIRECT send, reached
// by the other route, and it is the route where a seller is least likely to look
// at the listing afterwards.
//
// Five things are asserted here and none of them can be answered by reading the
// source for a string:
//
//   1. Every witness shape DRIVES viewRow, absent and unrecognised included.
//      A branch that never runs is a branch nobody has checked (AC5).
//   2. The default arm is "unknown". Absence is not confirmation, and a fifth
//      outcome a future extension invents must not land in the success sentence
//      (AC2). Driven with words this build does not know, not just with absence.
//   3. "unknown" raises no alarm. Mercari, Grailed, Vinted and Facebook declare
//      no photoConfirm, so it is every ordinary run on four of the five
//      channels, and a warning that always fires teaches the seller to dismiss
//      the one that matters (AC3).
//   4. The TypeScript taxonomy and this one are the SAME taxonomy. The body of
//      photoWitnessState in src/lib/lister-extension.ts is extracted and
//      EXECUTED against the extension's copy over the same input matrix, so the
//      two surfaces cannot quietly start disagreeing about whether a listing has
//      photos on it (AC4). If that extraction ever stops working (a type
//      annotation lands in the body, the signature is renamed) this test fails
//      loudly rather than skipping, because a parity check that silently stops
//      checking is worse than not having one.

//   5. The shipped popup renderer attaches exactly one refusal warning and
//      keeps unconfirmed runs quiet across all five marketplaces.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.resolve(__dirname, "..");
const REPO = path.resolve(EXT, "..");

const root = {};
new Function(
  "self",
  fs.readFileSync(path.join(EXT, "queue", "queue-view.js"), "utf8"),
)(root);
const V = root.GT_QUEUE_VIEW;
assert.ok(V, "queue-view.js must assign self.GT_QUEUE_VIEW");
assert.strictEqual(
  typeof V.photoWitnessState,
  "function",
  "queue-view.js must export photoWitnessState: the popup cannot read a " +
    "witness the view model does not resolve",
);

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const HOUR = 3600 * 1000;

let seq = 0;
function row(result, over) {
  seq += 1;
  return Object.assign({
    id: "33670000-0000-4000-8000-00000000000" + (seq % 10),
    kind: "list",
    platform: "poshmark",
    inventory_item_id: null,
    listing_id: null,
    payload: {},
    status: "queued",
    attempts: 1,
    source: "mobile",
    claimed_at: new Date(NOW - HOUR).toISOString(),
    completed_at: null,
    result: result,
    expires_at: new Date(NOW + 6 * 24 * HOUR).toISOString(),
    created_at: new Date(NOW - 2 * HOUR).toISOString(),
  }, over || {});
}

function view(result, over) {
  const v = V.viewRow(row(result, over), { now: NOW });
  assert.ok(v, "viewRow returned null for a well-formed row");
  return v;
}

// ── 1. every shape reaches the row, and each is its own answer ─────────────
//
// Driven, not scanned. Each case below is a real call into viewRow with a real
// `result` envelope of the shape lister/common.js emits (:891).
{
  const confirmed = view({
    photosWitness: "page", photosTotal: 8, photosFailed: 0, photosAttached: true,
  });
  assert.strictEqual(confirmed.photoState, "confirmed");
  assert.strictEqual(confirmed.photoAlert, false);
  assert.ok(confirmed.photoNote, "a confirmed run must still say what was checked");
  assert.ok(
    confirmed.photoNote.indexOf("Poshmark") === 0,
    "the sentence names the channel that answered",
  );
  // THE WITNESS IS A BOOLEAN. One carousel node can stand for eight files, so
  // the confirmation proves the uploader read the list and nothing more. A
  // number here would be a count we never took.
  assert.ok(
    !/\d/.test(confirmed.photoNote),
    "a confirmed run must NOT put a photo count in front of the seller: the " +
      "witness is one preview node, not a tally. Got: " + confirmed.photoNote,
  );

  const refused = view({
    photosWitness: "none", photosTotal: 8, photosFailed: 8, photosAttached: false,
  });
  assert.strictEqual(refused.photoState, "refused");
  assert.strictEqual(refused.photoAlert, true);
  assert.ok(
    /not on the listing/.test(refused.photoNote),
    "a refusal must say the photos are not on the listing",
  );
  // The next step is a DIFFERENT mechanism, not another go. attachPhotos has
  // already marked every photo failed; handing the same uploader the same list
  // gets the same nothing, and the queue offers a Retry button two lines away.
  assert.ok(
    /running this again/i.test(refused.photoNote),
    "a refusal must say a retry will not help, because the queue puts a Retry button " +
      "on the same row. Got: " + refused.photoNote,
  );

  const notAsked = view({ photosWitness: "not-asked", photosTotal: 8, photosFailed: 0 });
  assert.strictEqual(notAsked.photoState, "unknown");
  assert.strictEqual(
    notAsked.photoAlert,
    false,
    "AC3: `not-asked` is every ordinary Mercari, Grailed, Vinted and Facebook " +
      "run. An alarm there is a warning the seller learns to skip.",
  );
  assert.ok(notAsked.photoNote, "AC3 records it: quiet is not the same as absent");

  // ABSENT. The shape an older install can send.
  const absentWitness = view({ photosTotal: 8, photosFailed: 0 });
  assert.strictEqual(absentWitness.photoState, "unknown");
  assert.strictEqual(absentWitness.photoAlert, false);

  // No result envelope at all: a row that never reported. Nothing to qualify,
  // so nothing is said. This is the one state that renders as silence, and it
  // is silence about a question nobody asked rather than about an answer.
  const noResult = view(null);
  assert.strictEqual(noResult.photoState, "nothing-to-attach");
  assert.strictEqual(noResult.photoNote, null);
  assert.strictEqual(noResult.photoAlert, false);

  const noPhotos = view({ photosTotal: 0, photosAttached: false });
  assert.strictEqual(noPhotos.photoState, "nothing-to-attach");
  assert.strictEqual(noPhotos.photoNote, null);

  // The pre-US-1877 boolean: a claim with nothing behind it. It calls itself a
  // success and must not be read as one.
  const oldBoolean = view({ photosAttached: true });
  assert.strictEqual(
    oldBoolean.photoState,
    "unknown",
    "photosAttached:true from a build that sends no counts is a claim with " +
      "nothing behind it, not a confirmation",
  );

  // Every state the row can carry is one of the four. A fifth would be a word
  // no surface has a sentence for.
  for (const v of [confirmed, refused, notAsked, absentWitness, noResult, noPhotos, oldBoolean]) {
    assert.ok(
      V.PHOTO_WITNESS_STATES.indexOf(v.photoState) > -1,
      "unknown photoState " + v.photoState,
    );
  }

  // Four states, four distinct sentences (or silence). Two states sharing a
  // sentence is two states the seller cannot tell apart.
  const said = [confirmed.photoNote, refused.photoNote, notAsked.photoNote];
  assert.strictEqual(new Set(said).size, 3, "each state needs its own words");

  // ASCII only, and no em dash. These strings are seller-facing and travel
  // through textContent, a toast and a prd note.
  for (const s of said) {
    assert.ok(!/[^\x20-\x7E]/.test(s), "non-ASCII in a seller sentence: " + s);
  }
}

// ── 2. AC2: absence is not confirmation, and neither is a word we do not know ─
//
// The whole point of the default arm. A future extension that invents a fifth
// witness word must land on "unknown", never on the sentence that tells the
// seller their photos are on the listing.
{
  const futureWords = [
    "carousel", "shadow", "PAGE", "Page", "pages", "none-of-them", "confirmed",
    "true", "", "  ", "not_asked", "page ", " page",
  ];
  for (const word of futureWords) {
    const v = view({ photosWitness: word, photosTotal: 8, photosFailed: 0 });
    assert.strictEqual(
      v.photoState,
      "unknown",
      'a witness word this build does not know ("' + word + '") must read as ' +
        "unknown, never as a success. Absence is not confirmation.",
    );
    assert.strictEqual(v.photoAlert, false);
  }

  // Non-strings too. `result` is JSON from a browser extension by way of a
  // server column; it is exactly as trusted as a message from a page.
  for (const junk of [0, 1, true, false, null, {}, [], ["page"]]) {
    const v = view({ photosWitness: junk, photosTotal: 8 });
    assert.strictEqual(
      v.photoState,
      "unknown",
      "a non-string witness must read as unknown, got " + v.photoState,
    );
  }

  // And the sentence itself must never be the confirmed one.
  const confirmedNote = V.photoNoteFor("confirmed", "Poshmark");
  for (const word of futureWords) {
    const v = view({ photosWitness: word, photosTotal: 8 });
    assert.notStrictEqual(
      v.photoNote,
      confirmedNote,
      "an unrecognised witness produced the CONFIRMED sentence",
    );
  }
}

// ── 3. AC1: a refusal is not a failure and not a success ───────────────────
//
// It must not borrow `needsAttention`. That flag means the job never reached
// the marketplace, which is the one thing a refused-photo run DID do, and it is what
// puts the row under "Needs you" with a Retry button and offers a Dismiss. A
// refusal is its own thing, on its own field, with its own words.
{
  const refused = view({ photosWitness: "none", photosTotal: 8, photosFailed: 8 });
  assert.strictEqual(refused.state, "queued");
  assert.strictEqual(
    refused.needsAttention,
    false,
    "a photo refusal must NOT be laundered into needsAttention: that group " +
      'says "never reached the marketplace" and offers the retry that cannot help',
  );
  assert.strictEqual(refused.reason, null, "the refusal is not an error string");
  assert.strictEqual(refused.photoAlert, true);

  // Through the whole list path, not just viewRow: buildList -> sortRows ->
  // groupRows. The fields have to survive the trip the popup actually makes.
  const grouped = V.groupRows(V.buildList({
    pending: [row({ photosWitness: "none", photosTotal: 3, photosFailed: 3 })],
    needsAttention: [row({ error: "Poshmark asked for a login." }, { status: "failed" })],
  }, { now: NOW }));
  const byKey = {};
  for (const g of grouped) byKey[g.key] = g.rows;
  assert.ok(byKey.attention && byKey.attention.length === 1, "the failed row groups as attention");
  assert.ok(byKey.waiting && byKey.waiting.length === 1, "the refused row stays in waiting");
  assert.strictEqual(byKey.waiting[0].photoAlert, true, "and keeps its alert through buildList");
  assert.strictEqual(byKey.attention[0].photoAlert, false);
  assert.strictEqual(byKey.attention[0].reason, "Poshmark asked for a login.");

  // An error row can carry a witness too, and they are independent facts. A job
  // that filled the form, got no photos, and then failed for a second reason
  // must say both things.
  const both = view(
    { photosWitness: "none", photosTotal: 3, photosFailed: 3, error: "The tab closed." },
    { status: "failed" },
  );
  assert.strictEqual(both.reason, "The tab closed.");
  assert.strictEqual(both.photoAlert, true);
  assert.notStrictEqual(both.photoNote, both.reason);
}

// ── 4. the platform is named, and an unknown platform still gets a sentence ─
{
  const mercari = V.viewRow(
    row({ photosWitness: "none", photosTotal: 2, photosFailed: 2 }, { platform: "mercari" }),
    { now: NOW },
  );
  assert.ok(/^Mercari /.test(mercari.photoNote), "the sentence names Mercari");

  // A platform this build has no label for falls back to the same words the
  // rest of the row uses, never to a blank or to "undefined".
  const alien = V.viewRow(
    row({ photosWitness: "none", photosTotal: 2, photosFailed: 2 }, { platform: "depop" }),
    { now: NOW },
  );
  assert.ok(alien.photoNote && alien.photoNote.indexOf("undefined") === -1, alien.photoNote);
  assert.ok(alien.photoNote.indexOf(alien.platformLabel) === 0);
}

// ── 5. AC4: ONE taxonomy, executed in both languages ───────────────────────
//
// src/lib/lister-extension.ts is read-only to this test. Its photoWitnessState
// body is plain JavaScript once the signature is stripped, so it is extracted
// and RUN, not grepped, against the extension's copy over the same matrix.
// Two implementations agreeing on a list of strings is not parity; two
// implementations returning the same answer for the same input is.
{
  const tsPath = path.join(REPO, "src", "lib", "lister-extension.ts");
  const TS = fs.readFileSync(tsPath, "utf8").replace(/\r\n/g, "\n");

  // (a) the union the web surface switches on
  const union = /export type PhotoWitnessState =([\s\S]*?);/.exec(TS);
  assert.ok(union, "PhotoWitnessState is gone from " + tsPath + ". Find out why.");
  const tsStates = union[1]
    .split("|")
    .map((s) => s.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter((s) => s.length > 0);
  assert.deepStrictEqual(
    tsStates.slice().sort(),
    V.PHOTO_WITNESS_STATES.slice().sort(),
    "the extension and the web app disagree about which photo-witness states " +
      "exist. One vocabulary, two copies, and this is the copy that drifted.",
  );

  // (b) the function body, executed
  const SIG = "}): PhotoWitnessState {";
  const at = TS.indexOf("export function photoWitnessState(");
  assert.ok(at > -1, "photoWitnessState is gone from " + tsPath);
  const open = TS.indexOf(SIG, at);
  assert.ok(
    open > -1,
    "photoWitnessState's signature in " + tsPath + " no longer ends in " + SIG +
      ". This parity check extracts the body by that marker, so it must be " +
      "repaired rather than deleted",
  );
  const bodyStart = open + SIG.length;
  let depth = 1;
  let i = bodyStart;
  while (i < TS.length && depth > 0) {
    if (TS[i] === "{") depth += 1;
    else if (TS[i] === "}") depth -= 1;
    if (depth === 0) break;
    i += 1;
  }
  assert.strictEqual(depth, 0, "unbalanced braces extracting photoWitnessState");
  const body = TS.slice(bodyStart, i);
  for (const marker of ['case "page"', 'case "none"', "default:", '"nothing-to-attach"']) {
    assert.ok(body.includes(marker), "extracted body is missing " + marker);
  }
  let tsFn;
  try {
    tsFn = new Function("res", body);
  } catch (e) {
    assert.fail(
      "photoWitnessState's body no longer parses as plain JavaScript, so this " +
        "parity check can no longer execute it: " + e.message,
    );
  }

  const witnesses = [
    undefined, "page", "none", "not-asked", "carousel", "PAGE", "", "pages",
  ];
  const totals = [undefined, 0, 1, 8];
  const attached = [undefined, true, false];
  let compared = 0;
  for (const w of witnesses) {
    for (const t of totals) {
      for (const a of attached) {
        const res = {};
        if (w !== undefined) res.photosWitness = w;
        if (t !== undefined) res.photosTotal = t;
        if (a !== undefined) res.photosAttached = a;
        const mine = V.photoWitnessState(res);
        const theirs = tsFn(res);
        assert.strictEqual(
          mine,
          theirs,
          "taxonomy drift on " + JSON.stringify(res) + ": the extension says " +
            mine + ", src/lib/lister-extension.ts says " + theirs,
        );
        assert.ok(V.PHOTO_WITNESS_STATES.indexOf(mine) > -1, "off-taxonomy: " + mine);
        compared += 1;
      }
    }
  }
  assert.strictEqual(compared, witnesses.length * totals.length * attached.length);

  // The one case worth naming on its own: the TypeScript default arm agrees
  // that a word it does not know is unknown. If that ever becomes "confirmed"
  // over there, this fails here.
  assert.strictEqual(tsFn({ photosWitness: "carousel", photosTotal: 8 }), "unknown");

  // The queue's copy takes one input the web one never sees: `row.result` is
  // null on a row that never reported. It normalises rather than throwing, and
  // that is an ADDITION to the shared taxonomy, not a departure from it.
  for (const junk of [null, undefined, "", 0, "page"]) {
    assert.strictEqual(V.photoWitnessState(junk), "nothing-to-attach");
  }
}

// US-3407: execute the shipped popup renderer for every witness shape.
// The small DOM records attached nodes, so reading photoNote without putting
// it in the list cannot pass. Existing envelope and finished-review suites
// cover transport and the bounded list of completed jobs (US-3368/US-3370).
{
  const js = fs.readFileSync(path.join(EXT, "popup.js"), "utf8").replace(/\r\n/g, "\n");
  const start = js.indexOf("function renderQueueRow(");
  const end = js.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "popup renderQueueRow must be loadable");
  const document = {
    createElement(tag) {
      return {
        tagName: tag, children: [], className: "", textContent: "",
        appendChild(child) { this.children.push(child); return child; },
        addEventListener() {},
      };
    },
  };
  const render = new Function("document", "monogram", "timeAgo",
    js.slice(start, end + 2) + "\nreturn renderQueueRow;",
  )(document, () => document.createElement("span"), () => "");
  function nodes(node) {
    return [node].concat(node.children.flatMap(nodes));
  }
  const cases = [
    ["page", "confirmed", false],
    ["none", "refused", true],
    ["not-asked", "unknown", false],
    [undefined, "unknown", false],
    ["future-witness", "unknown", false],
    [null, "unknown", false],
    [true, "unknown", false],
  ];
  for (const platform of ["poshmark", "mercari", "grailed", "vinted", "facebook"]) {
    for (const [witness, state, alarm] of cases) {
      const result = { photosTotal: 3 };
      if (witness !== undefined) result.photosWitness = witness;
      const v = view(result, { platform, status: "done" });
      assert.strictEqual(v.photoState, state);
      const list = document.createElement("ul");
      render(list, v, {});
      const rendered = nodes(list);
      const photoLines = rendered.filter((n) => n.textContent === v.photoNote);
      assert.strictEqual(photoLines.length, alarm ? 1 : 0,
        platform + "/" + String(witness) + ": refusal must render once; unknown must stay quiet");
      if (alarm) {
        assert.ok(photoLines[0].className.includes("is-review"));
        assert.ok(/Add them there yourself/.test(photoLines[0].textContent));
      }
      assert.ok(rendered.some((n) => n.textContent === "Ran"), "done is not a success claim");
      assert.ok(!rendered.some((n) => n.textContent === "Retry"), "a finished run must not offer retry");
      assert.ok(!rendered.some((n) => /success|confirmed|previewed/.test(n.textContent)),
        "the queue must not invent confirmation");
    }
  }
}
console.log("queue-photo-witness.test.cjs: taxonomy parity and 35 shipped popup render cases passed");
