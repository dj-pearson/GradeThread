// GradeThread unified extension — the cross-listing queue's view model (US-3048).
//
// WHY THIS FILE EXISTS. The extension has drained the server-side work queue
// since US-2481, on a five-minute alarm, and never showed it. That is the whole
// bug: a seller queues six cross-posts from their phone at a thrift store, opens
// the laptop, and the one surface that CAN run them says nothing at all. No
// count, no "these are waiting", no way to start them, and — the half that
// actually costs money — no sight of the rows that expired or failed, which the
// API has returned in `needsAttention` the entire time.
//
// The shaping lives here rather than in popup.js for the reason lister-guard.js
// and engagement.js do: it is the part that is easy to get wrong (a claimed row
// is not a waiting one; an expired row is not a pending one) and it needs to be
// testable with no browser. popup.js is left as markup and event wiring.
//
// ONE RULE runs through all of it, and it is the same rule the queue's own edge
// route is built around: work that will not run must never render as work that
// is about to. A row nobody will pick up looks, from the phone that queued it,
// exactly like one about to go — and for a delist that mistake is a double sale.
(function (root) {
  "use strict";

  // The verbs the queue carries. Mirrors EXTENSION_QUEUE_KINDS in the edge's
  // lib/extension-queue.ts; a kind this build does not know is still rendered
  // (with its raw name) rather than dropped, because a row the seller cannot
  // see is a row they cannot cancel.
  var KIND_LABELS = {
    list: "Cross-post",
    delist: "End listing",
    revise: "Update listing",
    relist: "Relist",
  };

  var PLATFORM_LABELS = {
    poshmark: "Poshmark",
    mercari: "Mercari",
    grailed: "Grailed",
    vinted: "Vinted",
    facebook: "Facebook Marketplace",
  };

  // Four states reach a client. `done` never does — the GET filters it out —
  // so it is absent here on purpose rather than by omission.
  var STATE_LABELS = {
    queued: "Waiting",
    claimed: "Running now",
    failed: "Failed",
    expired: "Expired",
  };

  // Maps to the popup's .pop-status modifiers. "warn" for running is deliberate:
  // a claimed row means a background marketplace tab is open right now, which is
  // something the seller should be able to account for.
  var STATE_CLASS = {
    queued: "on",
    claimed: "warn",
    failed: "off",
    expired: "off",
  };

  function label(map, key, fallback) {
    if (typeof key !== "string" || !key) return fallback;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : key;
  }

  function asMs(iso) {
    if (typeof iso !== "string" || !iso) return null;
    var t = Date.parse(iso);
    return isFinite(t) ? t : null;
  }

  /**
   * The one string a failed row must carry. `result.error` is written by the
   * extension itself when it gives up on a job, so it is already seller-facing
   * prose — but a row can also fail with a null result (a completion that never
   * arrived), and "Failed" with no reason is the message that makes someone
   * uninstall rather than retry.
   */
  function reasonFor(row) {
    var result = row && row.result;
    if (result && typeof result.error === "string" && result.error.trim()) {
      return result.error.trim();
    }
    if (row && row.status === "expired") {
      return "This waited a week without your desktop browser opening, so it " +
        "was dropped. Queue it again if you still want it run.";
    }
    if (row && row.status === "failed") {
      return "GradeThread could not finish this one and did not say why. Open " +
        "the marketplace and do it by hand, or queue it again.";
    }
    return null;
  }

  /**
   * A title, when the row has one to give.
   *
   * Three sources, in the order they can be trusted. `item_title` is joined on
   * by the GET route from the seller's own inventory row; the payload copies are
   * snapshots the server took at enqueue time for a revise/relist. A `list` job
   * queued from a phone genuinely has none of them, and the kind label carries
   * the row on its own rather than showing an invented placeholder.
   */
  function titleFor(row) {
    if (!row) return null;
    var p = row.payload && typeof row.payload === "object" ? row.payload : {};
    var candidates = [row.item_title, p.title, p.listingTitle];
    for (var i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === "string" && candidates[i].trim()) {
        return candidates[i].trim().slice(0, 120);
      }
    }
    return null;
  }

  function urlFor(row) {
    var p = row && row.payload && typeof row.payload === "object" ? row.payload : {};
    var u = p.listingUrl;
    // https only, and only ever rendered as a link. A queue row is server-held
    // but client-originated, which makes it exactly as trusted as a message
    // from a page — the same standard the drain applies before it opens a tab.
    return typeof u === "string" && /^https:\/\//i.test(u) ? u : null;
  }

  /**
   * Shape one row for rendering.
   *
   * `canCancel` is deliberately narrower than the API allows. DELETE /:id will
   * remove a CLAIMED row too, and doing that from here would delete the job out
   * from under a marketplace tab that is mid-fill — the listing half-created and
   * nothing left server-side that remembers it was ever asked for. So cancel is
   * offered for `queued` only, and a running row is left to finish or time out.
   */
  function viewRow(row, opts) {
    if (!row || typeof row !== "object" || typeof row.id !== "string") return null;
    var o = opts || {};
    var now = typeof o.now === "number" ? o.now : Date.now();
    var status = typeof row.status === "string" ? row.status : "queued";
    var attention = status === "failed" || status === "expired";
    var at = asMs(row.created_at);
    return {
      id: row.id,
      kind: typeof row.kind === "string" ? row.kind : "list",
      kindLabel: label(KIND_LABELS, row.kind, "Job"),
      platform: typeof row.platform === "string" ? row.platform : "",
      platformLabel: label(
        (o.platformLabels || PLATFORM_LABELS), row.platform, "the marketplace",
      ),
      title: titleFor(row),
      state: status,
      stateLabel: label(STATE_LABELS, status, status),
      stateClass: label(STATE_CLASS, status, "warn"),
      at: at,
      ageMs: at === null ? null : Math.max(0, now - at),
      needsAttention: attention,
      reason: attention ? reasonFor(row) : null,
      listingUrl: urlFor(row),
      canCancel: status === "queued",
      canDismiss: attention,
      // A failed or expired row can be asked for again. The instruction is
      // still on the row (kind, platform, the item or listing it names, the
      // payload snapshot), so a retry is a new row with the same instruction
      // and the dead one removed — see retryBody. Only kinds this build knows
      // are offered: re-queueing a kind the drain will refuse again is a loop.
      canRetry: attention && Object.prototype.hasOwnProperty.call(KIND_LABELS, row.kind),
      source: typeof row.source === "string" ? row.source : "",
      // Kept for retryBody; never rendered.
      _row: row,
    };
  }

  /**
   * The POST body that re-queues a dead row.
   *
   * Everything on it came from the seller's own earlier request, which the
   * server already validated and normalised (no credential keys can be in
   * the payload — normalizeQueuePayload refused them on the way in and the
   * table's CHECK constraint would refuse them again). `source` is the
   * surface asking, which is the extension, and the server's vocabulary for
   * that is "web".
   */
  function retryBody(view) {
    var row = view && view._row;
    if (!row || !view.canRetry) return null;
    return {
      kind: row.kind,
      platform: row.platform,
      inventory_item_id: typeof row.inventory_item_id === "string" ? row.inventory_item_id : null,
      listing_id: typeof row.listing_id === "string" ? row.listing_id : null,
      payload: row.payload && typeof row.payload === "object" ? row.payload : {},
      source: "web",
    };
  }

  /**
   * Order: what went wrong, then what is running, then what is waiting —
   * oldest first inside each group.
   *
   * The oldest-first tail matches the drain, which claims by `created_at`
   * ascending. A list ordered newest-first would show the seller a different
   * next job than the one the extension is actually about to run.
   */
  var GROUP = { failed: 0, expired: 0, claimed: 1, queued: 2 };

  function sortRows(views) {
    return (views || []).slice().sort(function (a, b) {
      var ga = GROUP[a.state] === undefined ? 3 : GROUP[a.state];
      var gb = GROUP[b.state] === undefined ? 3 : GROUP[b.state];
      if (ga !== gb) return ga - gb;
      var ta = a.at === null ? Infinity : a.at;
      var tb = b.at === null ? Infinity : b.at;
      return ta - tb;
    });
  }

  /**
   * Turn the API's two lists into one ordered view list.
   *
   * They arrive separated (`pending` / `needsAttention`) precisely so a client
   * cannot render the second as the first. Merging them here is safe only
   * because `state` survives on every row and drives both the badge and the
   * grouping — the separation is preserved in what the seller SEES, which is
   * the thing the split was protecting.
   */
  function buildList(payload, opts) {
    var p = payload && typeof payload === "object" ? payload : {};
    var rows = []
      .concat(Array.isArray(p.pending) ? p.pending : [])
      .concat(Array.isArray(p.needsAttention) ? p.needsAttention : []);
    var views = [];
    for (var i = 0; i < rows.length; i++) {
      var v = viewRow(rows[i], opts);
      if (v) views.push(v);
    }
    return sortRows(views);
  }

  /**
   * The list split into the three groups the popup labels, in render order.
   * Empty groups are omitted so the popup never draws a heading over nothing.
   * The rows inside each keep sortRows' order, so the "waiting" group reads
   * top-to-bottom in the order the drain will run them.
   */
  var GROUP_ORDER = ["attention", "running", "waiting"];
  var GROUP_LABELS = { attention: "Needs you", running: "Running now", waiting: "Waiting" };

  function groupOf(view) {
    if (view.state === "claimed") return "running";
    if (view.needsAttention) return "attention";
    return "waiting";
  }

  function groupRows(views) {
    var by = { attention: [], running: [], waiting: [] };
    for (var i = 0; i < (views || []).length; i++) by[groupOf(views[i])].push(views[i]);
    var out = [];
    for (var g = 0; g < GROUP_ORDER.length; g++) {
      var key = GROUP_ORDER[g];
      if (by[key].length) out.push({ key: key, label: GROUP_LABELS[key], rows: by[key] });
    }
    return out;
  }

  /**
   * The counts the Selling tab renders.
   *
   * `total` is what the nav badge shows, and it includes the attention rows on
   * purpose: they are the ones that need a human most, and a badge that dropped
   * to zero the moment a job failed would be the exact silence this feature
   * exists to end.
   */
  function summarize(views) {
    var out = { waiting: 0, running: 0, attention: 0, total: 0 };
    for (var i = 0; i < (views || []).length; i++) {
      var v = views[i];
      if (v.state === "claimed") out.running++;
      else if (v.needsAttention) out.attention++;
      else out.waiting++;
      out.total++;
    }
    return out;
  }

  /**
   * The line under the header. Says what the browser will do next, in the words
   * the seller needs — never "3 jobs", which tells them nothing about whether
   * they have to stay at the machine.
   */
  function statusLine(counts) {
    var c = counts || { waiting: 0, running: 0, attention: 0 };
    var parts = [];
    if (c.running) parts.push(c.running === 1 ? "1 running now" : c.running + " running now");
    if (c.waiting) parts.push(c.waiting === 1 ? "1 waiting" : c.waiting + " waiting");
    if (c.attention) {
      parts.push(c.attention === 1 ? "1 needs you" : c.attention + " need you");
    }
    return parts.join(" · ");
  }

  root.GT_QUEUE_VIEW = {
    KIND_LABELS: KIND_LABELS,
    GROUP_LABELS: GROUP_LABELS,
    groupRows: groupRows,
    retryBody: retryBody,
    PLATFORM_LABELS: PLATFORM_LABELS,
    STATE_LABELS: STATE_LABELS,
    STATE_CLASS: STATE_CLASS,
    viewRow: viewRow,
    sortRows: sortRows,
    buildList: buildList,
    summarize: summarize,
    statusLine: statusLine,
    reasonFor: reasonFor,
    titleFor: titleFor,
  };
})(typeof self !== "undefined" ? self : globalThis);
