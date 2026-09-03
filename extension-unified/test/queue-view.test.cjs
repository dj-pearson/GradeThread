// GradeThread unified extension — cross-listing queue view model (US-3048).
//
// Zero-dependency node script: throws on drift.
//
// What this file is protecting is not the labels. It is the four places where
// the queue can lie to a seller, each of which has already happened somewhere
// in this codebase:
//
//   1. Rendering an expired or failed row as one that is still coming. The API
//      splits `pending` from `needsAttention` for exactly this reason; a client
//      that merges them and forgets the distinction has undone the split.
//   2. Offering Cancel on a CLAIMED row. DELETE would accept it, and the job is
//      at that moment halfway through a marketplace form in a background tab.
//   3. A badge that drops when a job fails. Failed work needs a human MORE than
//      waiting work does.
//   4. "Failed" with no reason. A row that says only that is a row nobody can
//      act on, and it is the sentence people uninstall over.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = {};
const src = fs.readFileSync(
  path.resolve(__dirname, "..", "queue", "queue-view.js"),
  "utf8",
);
new Function("self", src)(root);
const V = root.GT_QUEUE_VIEW;
assert.ok(V, "queue-view.js must assign self.GT_QUEUE_VIEW");

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const HOUR = 3600 * 1000;

function row(over) {
  return Object.assign({
    id: "11111111-1111-4111-8111-111111111111",
    kind: "list",
    platform: "poshmark",
    inventory_item_id: null,
    listing_id: null,
    payload: {},
    status: "queued",
    attempts: 0,
    source: "mobile",
    claimed_at: null,
    completed_at: null,
    result: null,
    expires_at: new Date(NOW + 6 * 24 * HOUR).toISOString(),
    created_at: new Date(NOW - 2 * HOUR).toISOString(),
  }, over || {});
}

// ── 1. the states survive the trip ─────────────────────────────────────────
{
  const v = V.viewRow(row(), { now: NOW });
  assert.strictEqual(v.state, "queued");
  assert.strictEqual(v.stateLabel, "Waiting");
  assert.strictEqual(v.kindLabel, "Cross-post");
  assert.strictEqual(v.platformLabel, "Poshmark");
  assert.strictEqual(v.needsAttention, false);
  assert.strictEqual(v.ageMs, 2 * HOUR);
}
{
  const v = V.viewRow(row({ status: "claimed", claimed_at: new Date(NOW).toISOString() }), { now: NOW });
  assert.strictEqual(v.stateLabel, "Running now");
  assert.strictEqual(v.needsAttention, false);
}

// ── 2. Cancel is offered on a WAITING row and NOTHING else ─────────────────
//
// The one that matters. DELETE /:id will remove a claimed row, and a claimed
// row is a job with a marketplace tab open on it right now: cancelling it
// leaves a half-filled form and no server-side memory that it was ever asked
// for. `canCancel` is the only thing standing between the popup and that.
{
  assert.strictEqual(V.viewRow(row({ status: "queued" }), { now: NOW }).canCancel, true);
  for (const status of ["claimed", "failed", "expired"]) {
    assert.strictEqual(
      V.viewRow(row({ status }), { now: NOW }).canCancel,
      false,
      `canCancel must be false for a ${status} row — Cancel on a claimed job ` +
        "deletes it out from under the marketplace tab that is mid-fill",
    );
  }
  // Dismiss is the mirror: only on work that will never run.
  assert.strictEqual(V.viewRow(row({ status: "queued" }), { now: NOW }).canDismiss, false);
  assert.strictEqual(V.viewRow(row({ status: "claimed" }), { now: NOW }).canDismiss, false);
  assert.strictEqual(V.viewRow(row({ status: "failed" }), { now: NOW }).canDismiss, true);
  assert.strictEqual(V.viewRow(row({ status: "expired" }), { now: NOW }).canDismiss, true);
}

// ── 3. every row that will not run carries a reason ────────────────────────
{
  const written = V.viewRow(
    row({ status: "failed", result: { error: "Poshmark asked for a login." } }),
    { now: NOW },
  );
  assert.strictEqual(written.reason, "Poshmark asked for a login.");

  // The case the extension cannot write prose for: a completion that never
  // arrived leaves result null, and "Failed" alone is unactionable.
  for (const status of ["failed", "expired"]) {
    const bare = V.viewRow(row({ status, result: null }), { now: NOW });
    assert.ok(
      bare.reason && bare.reason.length > 20,
      `a ${status} row with a null result must still explain itself — "Failed" ` +
        "on its own is the message people uninstall over",
    );
  }
  // And a healthy row carries none, so the popup has nothing to render.
  assert.strictEqual(V.viewRow(row({ status: "queued" }), { now: NOW }).reason, null);
}

// ── 4. the badge counts failures IN ────────────────────────────────────────
{
  const list = V.buildList({
    pending: [row({ id: "a", status: "queued" }), row({ id: "b", status: "claimed" })],
    needsAttention: [row({ id: "c", status: "failed" }), row({ id: "d", status: "expired" })],
  }, { now: NOW });
  const counts = V.summarize(list);
  assert.deepStrictEqual(counts, { waiting: 1, running: 1, attention: 2, total: 4 });
  assert.strictEqual(
    counts.total, 4,
    "the badge total must include failed/expired rows — a badge that drops to " +
      "zero the moment a job fails is the silence this feature exists to end",
  );
}

// ── 5. attention first, then running, then waiting oldest-first ────────────
//
// The oldest-first tail is not cosmetic: the drain claims by created_at
// ascending, so a newest-first list would name a different next job than the
// one the extension is actually about to run.
{
  const list = V.buildList({
    pending: [
      row({ id: "new", status: "queued", created_at: new Date(NOW - 1 * HOUR).toISOString() }),
      row({ id: "old", status: "queued", created_at: new Date(NOW - 9 * HOUR).toISOString() }),
      row({ id: "run", status: "claimed" }),
    ],
    needsAttention: [row({ id: "bad", status: "failed" })],
  }, { now: NOW });
  assert.deepStrictEqual(list.map((r) => r.id), ["bad", "run", "old", "new"]);
}

// ── 6. a title only when the row really has one ────────────────────────────
{
  // A `list` queued from a phone is an item id and a platform. Nothing else.
  assert.strictEqual(V.viewRow(row(), { now: NOW }).title, null);
  assert.strictEqual(
    V.viewRow(row({ item_title: "  Carhartt Detroit jacket  " }), { now: NOW }).title,
    "Carhartt Detroit jacket",
  );
  // The server's enqueue-time snapshot, for a revise/relist.
  assert.strictEqual(
    V.viewRow(row({ kind: "revise", payload: { title: "Levi's 501" } }), { now: NOW }).title,
    "Levi's 501",
  );
  assert.strictEqual(V.viewRow(row({ item_title: "   " }), { now: NOW }).title, null);
}

// ── 7. a payload URL is rendered only if it is https ───────────────────────
//
// A queue row is server-held but client-originated, which makes it exactly as
// trusted as a message from a page. The drain applies this standard before it
// opens a tab; the popup applies it before it renders an anchor.
{
  assert.strictEqual(
    V.viewRow(row({ payload: { listingUrl: "https://poshmark.com/listing/x" } }), { now: NOW }).listingUrl,
    "https://poshmark.com/listing/x",
  );
  for (const bad of [
    "http://poshmark.com/listing/x",
    "javascript:alert(1)",
    "data:text/html,x",
    42,
    null,
  ]) {
    assert.strictEqual(
      V.viewRow(row({ payload: { listingUrl: bad } }), { now: NOW }).listingUrl,
      null,
      `listingUrl must refuse ${String(bad)}`,
    );
  }
}

// ── 8. a kind or platform this build does not know is still SHOWN ──────────
//
// A row rendered as nothing is a row the seller cannot cancel. An unknown name
// falls back to itself rather than being dropped or turned into "Job".
{
  const v = V.viewRow(row({ kind: "teleport", platform: "depop" }), { now: NOW });
  assert.strictEqual(v.kindLabel, "teleport");
  assert.strictEqual(v.platformLabel, "depop");
  assert.strictEqual(V.buildList({ pending: [row({ kind: "teleport" })] }, { now: NOW }).length, 1);
}

// ── 9. malformed input never throws and never invents a row ────────────────
{
  assert.strictEqual(V.viewRow(null, { now: NOW }), null);
  assert.strictEqual(V.viewRow({ id: 7 }, { now: NOW }), null);
  assert.deepStrictEqual(V.buildList(null, { now: NOW }), []);
  assert.deepStrictEqual(V.buildList({ pending: "nope" }, { now: NOW }), []);
  assert.deepStrictEqual(V.summarize(null), { waiting: 0, running: 0, attention: 0, total: 0 });
  // A row with no created_at sorts last rather than to the epoch, which would
  // put it above every real job.
  const list = V.buildList({
    pending: [row({ id: "nodate", created_at: null }), row({ id: "dated" })],
  }, { now: NOW });
  assert.deepStrictEqual(list.map((r) => r.id), ["dated", "nodate"]);
}

// ── 10. the status line says what the browser will do, in words ────────────
{
  assert.strictEqual(V.statusLine({ waiting: 1, running: 0, attention: 0 }), "1 waiting");
  assert.strictEqual(
    V.statusLine({ waiting: 3, running: 1, attention: 2 }),
    "1 running now · 3 waiting · 2 need you",
  );
  assert.strictEqual(V.statusLine({ waiting: 0, running: 0, attention: 1 }), "1 needs you");
  assert.strictEqual(V.statusLine({ waiting: 0, running: 0, attention: 0 }), "");
}

// ── 11. the kinds match the edge's own list ────────────────────────────────
//
// EXTENSION_QUEUE_KINDS in services/edge-functions/src/lib/extension-queue.ts is
// the source. A kind added there and not here renders with its raw name (case 8
// above), which is survivable — but a kind here that the server cannot produce
// is dead copy, and a missing one is a row the seller reads as a bug.
{
  const edge = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "services", "edge-functions", "src", "lib", "extension-queue.ts"),
    "utf8",
  );
  const m = /EXTENSION_QUEUE_KINDS\s*=\s*\[([^\]]*)\]/.exec(edge);
  assert.ok(m, "could not find EXTENSION_QUEUE_KINDS in the edge lib");
  const kinds = Array.from(m[1].matchAll(/"([a-z]+)"/g)).map((x) => x[1]).sort();
  assert.deepStrictEqual(
    Object.keys(V.KIND_LABELS).sort(),
    kinds,
    "KIND_LABELS must name exactly the kinds the queue can hold — the edge's " +
      "EXTENSION_QUEUE_KINDS is the source of that list",
  );
}

// ── 12. the popup actually wires all of it ────────────────────────────────
//
// The model above can be perfect and reach nobody. Same guard shape as
// host-permissions.test.cjs: every id the renderer touches must exist in the
// markup, and the script that defines GT_QUEUE_VIEW must load before the script
// that reads it at module scope.
{
  const dir = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8").replace(/\r\n/g, "\n");
  const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8").replace(/\r\n/g, "\n");

  for (const id of [
    "queueBlock", "queueList", "queueNote", "queueStatus", "queueRunNow", "queueRunNote",
    "workSummary", "workSumClear",
    "chipDelist", "chipDelistN", "chipQueue", "chipQueueN", "chipRevise", "chipReviseN",
    "readNow", "readNowHint", "openOptions", "channelsCount",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `popup.html is missing #${id}`);
    assert.ok(js.includes(`"${id}"`), `popup.js never uses #${id}`);
  }
  // Markup-only: the collapse is the <details> element's own behaviour, so no
  // script touches it. Asserted anyway — the count inside its summary is
  // rendered by popup.js and would have nowhere to land without it.
  assert.ok(html.includes('id="channelsBlock"'), "popup.html is missing #channelsBlock");

  // Each chip must actually name the block it claims to jump to.
  for (const [chip, target] of [
    ["chipDelist", "delistBlock"], ["chipQueue", "queueBlock"], ["chipRevise", "reviseBlock"],
  ]) {
    const m = new RegExp(`id="${chip}"[^>]*data-target="([a-zA-Z]+)"`).exec(html) ||
      new RegExp(`data-target="([a-zA-Z]+)"[^>]*id="${chip}"`).exec(html);
    assert.ok(m, `#${chip} must carry a data-target`);
    assert.strictEqual(m[1], target, `#${chip} jumps to #${m[1]}, expected #${target}`);
    assert.ok(html.includes(`id="${target}"`), `#${chip} jumps to #${target}, which does not exist`);
  }

  const viewAt = html.indexOf('src="queue/queue-view.js"');
  const popupAt = html.indexOf('src="popup.js"');
  assert.ok(
    viewAt > -1 && viewAt < popupAt,
    "queue/queue-view.js must load before popup.js — popup.js reads " +
      "self.GT_QUEUE_VIEW at module scope",
  );

  // The worker needs it too, and by both bootstraps: Chrome importScripts and
  // the Firefox event page's manifest background.scripts.
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    /importScripts\([^)]*queue\/queue-view\.js/s.test(bg),
    "background.js must importScripts queue/queue-view.js",
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8").replace(/\r\n/g, "\n"));
  assert.ok(
    manifest.background.scripts.includes("queue/queue-view.js"),
    "manifest background.scripts must carry queue/queue-view.js — Firefox has no " +
      "importScripts, so this is the only way its event page gets the module",
  );

  // The three message types the popup sends, answered by the worker.
  for (const type of ["GT_QUEUE_STATE", "GT_QUEUE_CANCEL", "GT_QUEUE_RUN_NOW"]) {
    assert.ok(js.includes(type), `popup.js never sends ${type}`);
    assert.ok(bg.includes(`case "${type}"`), `background.js never handles ${type}`);
  }

  // ── the badge has ONE writer ─────────────────────────────────────────────
  // Three queues used to each set it from their own number, so a seller with
  // two sold items still to end and four failed cross-posts saw whichever
  // renderer happened to finish last. setSellingCount may now be called only
  // from renderWorkSummary (which sums workCounts) and from the two
  // not-a-seller branches of renderSellerSections, which legitimately mean
  // "no seller work at all".
  const callers = js.split("\n").filter((l) => /setSellingCount\(/.test(l) && !/^function /.test(l.trim()));
  assert.strictEqual(
    callers.length, 3,
    "setSellingCount must have exactly three call sites (renderWorkSummary plus " +
      "the locked and anonymous branches of renderSellerSections). Found:\n" +
      callers.join("\n"),
  );
  assert.ok(
    /function renderWorkSummary\(\)[\s\S]*?setSellingCount\(total\)/.test(js),
    "renderWorkSummary must be the one place the badge is written, from the sum",
  );
  for (const q of ["delist", "queue", "revise"]) {
    assert.ok(
      new RegExp("workCounts\\." + q + "\\s*=").test(js),
      `nothing assigns workCounts.${q}, so its queue cannot reach the badge`,
    );
  }

  // ── the "run now" wording never claims completion ────────────────────────
  // The drain opens a background tab per job; each takes as long as the
  // marketplace takes. "Done" the moment the click returns is the exact
  // overstatement QUEUED_NOTICE exists to prevent.
  const runNote = /runNote\.textContent = ([\s\S]*?);\n/.exec(js);
  assert.ok(runNote, "the run-now note must set its own text");
  assert.ok(
    !/\b(Done|Complete|Finished|Listed)\b/.test(runNote[1]),
    "the run-now note must not claim the jobs are done — it has only started them",
  );
}

// ── 13. timeAgo takes an ISO string, not just an epoch ────────────────────
//
// Two of its callers pass a server row's ISO timestamp. It used to accept only
// a number, so the pending-delist block — the most time-critical thing in this
// popup — rendered "Poshmark · NaNd ago" on every row for as long as it existed.
{
  const js = fs.readFileSync(path.resolve(__dirname, "..", "popup.js"), "utf8").replace(/\r\n/g, "\n");
  const m = /function timeAgo\(ts\)[\s\S]*?\n}/.exec(js);
  assert.ok(m, "popup.js must define timeAgo");
  const timeAgo = new Function("return " + m[0])();
  assert.strictEqual(timeAgo(Date.now() - 3 * HOUR), "3h ago");
  assert.strictEqual(
    timeAgo(new Date(Date.now() - 2 * 24 * HOUR).toISOString()), "2d ago",
    "timeAgo must accept an ISO string — pending delists and revises pass one",
  );
  for (const junk of [null, undefined, "", "not a date", NaN, {}]) {
    assert.strictEqual(
      timeAgo(junk), "",
      `timeAgo(${String(junk)}) must return "" so the caller can omit the ` +
        "clause entirely, rather than printing NaN",
    );
  }
}

// ── 14. retry: only a dead row, only a known kind, same instruction ────────
//
// A failed cross-post is re-queued as a NEW row carrying the same kind,
// platform, ids and payload — and `source` says the extension asked, in the
// server's vocabulary ("web"). A waiting or running row has nothing to retry,
// and a kind this build cannot run must not be re-queued: the drain would
// refuse it again and the seller would be clicking Retry on a loop.
{
  const dead = V.viewRow(row({
    status: "failed",
    kind: "delist",
    listing_id: "22222222-2222-4222-8222-222222222222",
    payload: { listingUrl: "https://poshmark.com/listing/abc", locale: "us" },
    result: { error: "The listing page never loaded." },
  }), { now: NOW });
  assert.strictEqual(dead.canRetry, true, "a failed known kind is retryable");
  const body = V.retryBody(dead);
  assert.deepStrictEqual(body, {
    kind: "delist",
    platform: "poshmark",
    inventory_item_id: null,
    listing_id: "22222222-2222-4222-8222-222222222222",
    payload: { listingUrl: "https://poshmark.com/listing/abc", locale: "us" },
    source: "web",
  });

  const expired = V.viewRow(row({ status: "expired", inventory_item_id: "33333333-3333-4333-8333-333333333333" }), { now: NOW });
  assert.strictEqual(expired.canRetry, true, "an expired row is retryable");
  assert.strictEqual(V.retryBody(expired).inventory_item_id, "33333333-3333-4333-8333-333333333333");

  for (const status of ["queued", "claimed"]) {
    const live = V.viewRow(row({ status }), { now: NOW });
    assert.strictEqual(live.canRetry, false, status + " has nothing to retry");
    assert.strictEqual(V.retryBody(live), null, "retryBody refuses a live row");
  }

  const alien = V.viewRow(row({ status: "failed", kind: "share" }), { now: NOW });
  assert.strictEqual(alien.canRetry, false, "an unknown kind is not re-queued into the same refusal");
  assert.strictEqual(V.retryBody(alien), null);
}

// ── 15. grouping: what went wrong, what runs, what waits — and no empty group ─
{
  const rows = V.buildList({
    pending: [row({ id: "a1111111-1111-4111-8111-111111111111" }), row({ id: "a2222222-2222-4222-8222-222222222222", status: "claimed" })],
    needsAttention: [row({ id: "a3333333-3333-4333-8333-333333333333", status: "failed" })],
  }, { now: NOW });
  const groups = V.groupRows(rows);
  assert.deepStrictEqual(groups.map((g) => g.key), ["attention", "running", "waiting"]);
  assert.deepStrictEqual(groups.map((g) => g.rows.length), [1, 1, 1]);
  assert.strictEqual(groups[0].label, "Needs you");
  assert.strictEqual(groups[1].label, "Running now");
  assert.strictEqual(groups[2].label, "Waiting");

  const onlyWaiting = V.groupRows(V.buildList({ pending: [row()] }, { now: NOW }));
  assert.deepStrictEqual(onlyWaiting.map((g) => g.key), ["waiting"], "empty groups are omitted");
  assert.deepStrictEqual(V.groupRows([]), []);

  // The popup wires the retry and the bulk controls, and the worker answers.
  const dir = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8").replace(/\r\n/g, "\n");
  const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8").replace(/\r\n/g, "\n");
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8").replace(/\r\n/g, "\n");
  for (const id of ["queueRetryAll", "queueClearFailed", "queueCancelAll"]) {
    assert.ok(html.includes(`id="${id}"`), `popup.html is missing #${id}`);
    assert.ok(js.includes(`"${id}"`), `popup.js never uses #${id}`);
  }
  assert.ok(js.includes("GT_QUEUE_RETRY"), "popup.js never sends GT_QUEUE_RETRY");
  assert.ok(bg.includes('case "GT_QUEUE_RETRY"'), "background.js never handles GT_QUEUE_RETRY");
  // POST first, DELETE second: a failed POST must leave the dead row in place.
  const retryFn = bg.slice(bg.indexOf("async function retryQueueRow("), bg.indexOf("/** Report a revise outcome"));
  assert.ok(retryFn.indexOf('method: "POST"') < retryFn.indexOf('method: "DELETE"'),
    "retryQueueRow must create the new row before deleting the old one");
  assert.ok(/if \(!created\) return/.test(retryFn), "a failed POST must stop before the DELETE");
}

// ── 16. the running row's stage (US-3050) ──────────────────────────────────
//
// A claimed row this browser is driving says what it is doing, from the job
// store's stage; a claimed row with no local job (another browser took it)
// stays "Running now"; an unknown stage never renders blank.
{
  assert.strictEqual(V.stageLabel(null), "Opening the tab", "a job that has not reported yet is opening its tab");
  assert.strictEqual(V.stageLabel("filling"), "Filling the form");
  assert.strictEqual(V.stageLabel("photos"), "Attaching photos");
  assert.strictEqual(V.stageLabel("navigated"), "Opening the page");
  assert.strictEqual(V.stageLabel("teleporting"), null, "an unknown stage yields null so the caller falls back to the state label");

  const id = "b1111111-1111-4111-8111-111111111111";
  const mine = V.viewRow(row({ id, status: "claimed" }), { now: NOW, stages: { [id]: { stage: "photos", stagedAt: NOW } } });
  assert.strictEqual(mine.stageLabel, "Attaching photos");
  assert.strictEqual(mine.stage, "photos");
  const theirs = V.viewRow(row({ id, status: "claimed" }), { now: NOW, stages: {} });
  assert.strictEqual(theirs.stageLabel, null, "no local job: the popup shows the plain state");
  assert.strictEqual(theirs.stateLabel, "Running now");
  const waiting = V.viewRow(row({ id, status: "queued" }), { now: NOW, stages: { [id]: { stage: "photos" } } });
  assert.strictEqual(waiting.stageLabel, null, "only a claimed row carries a stage");

  // The chain: content script reports the two new stages, the worker answers
  // GT_QUEUE_JOBS, the popup asks for it, shows it, and re-renders on change.
  const dir = path.resolve(__dirname, "..");
  const common = fs.readFileSync(path.join(dir, "lister", "common.js"), "utf8").replace(/\r\n/g, "\n");
  for (const stage of ["filling", "photos"]) {
    assert.ok(new RegExp('reportStage\\(payload\\.jobId, "' + stage + '"\\)').test(common),
      "lister/common.js must report the " + stage + " stage");
  }
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(bg.includes('case "GT_QUEUE_JOBS"'), "background.js never handles GT_QUEUE_JOBS");
  assert.ok(/isPending\(job\)\) continue/.test(bg.slice(bg.indexOf("async function getQueueJobStages"))),
    "getQueueJobStages must skip terminal jobs");
  const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(js.includes("GT_QUEUE_JOBS"), "popup.js never asks for GT_QUEUE_JOBS");
  assert.ok(/row\.stageLabel \|\| row\.stateLabel/.test(js), "the badge must prefer the stage and fall back to the state");
  assert.ok(/storage\.onChanged\.addListener\(onStorageChanged\)/.test(js), "popup.js must subscribe to storage.onChanged");
  assert.ok(/storage\.onChanged\.removeListener\(onStorageChanged\)/.test(js), "popup.js must unsubscribe on pagehide");
  assert.ok(!/setInterval\(/.test(js), "no polling: the refresh is event-driven");
}

// ── 17. a server-refused list row reads as an inventory fact (US-3096) ─────
//
// The claim route now fails a `list` row whose item was deleted, or has no
// photos, rather than handing the extension a job it would run against a blank
// form. Those rows come back with `result.error` set to a sentence about the
// seller's own inventory, and the popup has to show it in the needs-you group
// like any other dead row — a failure the seller cannot see is the same silence
// this whole view model exists to end.
{
  const deleted = V.viewRow(
    row({
      status: "failed",
      completed_at: new Date(NOW - HOUR).toISOString(),
      result: {
        ok: false,
        error:
          "This item was deleted after the cross-post was queued, so there was nothing left to list.",
      },
    }),
    { now: NOW },
  );
  assert.strictEqual(deleted.state, "failed");
  assert.strictEqual(deleted.needsAttention, true, "a refused cross-post needs the seller");
  assert.match(deleted.reason, /deleted after the cross-post was queued/);
  assert.strictEqual(
    deleted.canCancel,
    false,
    "there is nothing left to cancel on a row that already failed",
  );

  const noPhotos = V.viewRow(
    row({
      status: "failed",
      completed_at: new Date(NOW - HOUR).toISOString(),
      result: {
        ok: false,
        error:
          "This item has no photos, and every marketplace requires at least one. Add photos and queue it again.",
      },
    }),
    { now: NOW },
  );
  assert.match(noPhotos.reason, /no photos/i);
  assert.match(
    noPhotos.reason,
    /queue it again/i,
    "the reason has to name the fix, not just the fault",
  );

  // Both land in the group a seller opens first.
  const grouped = V.groupRows([deleted, noPhotos]);
  const attention = grouped.find((g) => g.key === "attention");
  assert.ok(attention, "refused rows must appear in the needs-you group");
  assert.strictEqual(attention.rows.length, 2);
}

console.log(
  "queue-view.test.cjs: 17 groups — cancel is queued-only, failures count " +
    "toward the badge, every dead row carries a reason, kinds match the edge, " +
    "the popup wires all of it, timeAgo takes ISO, retry re-queues only dead known rows, grouping omits empties, and a claimed row carries its stage, and a server-refused cross-post reads as an inventory fact",
);
