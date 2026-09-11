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

  // US-3373: THE EXTENSION'S ONE PLATFORM VOCABULARY. Every surface reads this
  // map and none of them may carry its own; popup.js, panel.html and worker.html
  // all load this file first, and queue/worker-state.js already reads it through
  // GT_QUEUE_VIEW for the pause line.
  //
  // It used to be one of two. popup.js held a copy calling facebook "Facebook"
  // and passed it in as an override, so a single queue row read "Facebook" in
  // the popup and "Facebook Marketplace" in the side panel and the worker tab.
  // Nothing broke; it just made one queue look like two features.
  //
  // "Facebook Marketplace" is the one that won, for two reasons that are not
  // about length. It is what the code that actually runs the job already says
  // (background.js SUPPORTED_LISTER, lister/facebook.js), so the shorter form
  // would have left the queue disagreeing with the runner. And "Facebook" on
  // its own names a company that sells things two ways: this extension drives
  // Marketplace and cannot touch Shops.
  //
  // A key with no entry here renders as its raw name rather than being dropped
  // (see `label`), for the same reason KIND_LABELS does it: a row the seller
  // cannot see is a row they cannot cancel.
  var PLATFORM_LABELS = {
    poshmark: "Poshmark",
    mercari: "Mercari",
    grailed: "Grailed",
    vinted: "Vinted",
    facebook: "Facebook Marketplace",
  };

  // FIVE states reach a client since US-3370, and the fifth is the one this
  // file used to say could never arrive. `done` reached the wire when the GET
  // grew `finishedNeedsReview`: finished runs from the last 48 hours that left
  // the seller something to do. It is a state, not a success; "Ran" is the
  // whole claim, and the row's reason or photo note says what is left.
  var STATE_LABELS = {
    queued: "Waiting",
    claimed: "Running now",
    failed: "Failed",
    expired: "Expired",
    done: "Ran",
  };

  // Maps to the popup's .pop-status modifiers, of which exactly three exist:
  // on, warn, off (popup.css). "warn" for running is deliberate: a claimed row
  // means a background marketplace tab is open right now, which is something
  // the seller should be able to account for. `done` is "warn" for the same
  // reason and not "off": nothing failed, and a red pill on a listing that is
  // live on the marketplace is the wrong alarm.
  var STATE_CLASS = {
    queued: "on",
    claimed: "warn",
    failed: "off",
    expired: "off",
    done: "warn",
  };

  // US-3050: what a claimed row is doing right now, in the seller's words.
  // The keys are the stages lister/common.js reports (GT_LISTER_STAGE);
  // `null` is a job whose tab has opened and not yet reported. An unknown
  // stage falls back to the plain state label rather than to blank.
  var STAGE_LABELS = {
    opening: "Opening the tab",
    navigated: "Opening the page",
    filling: "Filling the form",
    photos: "Attaching photos",
  };

  function stageLabel(stage) {
    if (stage === null || stage === undefined) return STAGE_LABELS.opening;
    if (typeof stage !== "string" || !stage) return null;
    return Object.prototype.hasOwnProperty.call(STAGE_LABELS, stage) ? STAGE_LABELS[stage] : null;
  }

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
   * US-3374: the one string a FINISHED row must carry.
   *
   * `reasonFor` above is for work that never happened, and two of its three
   * arms say so out loud ("queue it again", "do it by hand"). Neither sentence
   * can go in front of a run that reached the marketplace: told that nothing
   * happened and to queue it again, a seller makes a second listing.
   *
   * So these are the finished causes, in the order the edge's own
   * finishedNeedsReview lists them (routes/flipdesk-extension-queue.ts), minus
   * the one it leads with. `photosWitness === "none"` is deliberately ABSENT:
   * US-3367 already wrote that sentence as `photoNote`, and a row that renders
   * both prints the same paragraph twice.
   *
   * THAT IS ALSO WHY `photoState` IS AN ARGUMENT. A refused witness almost
   * always arrives with `photosFailed` set as well (the same run, counted two
   * ways), so the count arm is skipped when photoNote is already going to say
   * it, and two lines that nearly agree never end up stacked under one row.
   *
   * Every arm points at the listing rather than at the queue, because the
   * listing is where the remaining work is.
   */
  function finishedReasonFor(row, platformLabel, photoState) {
    var res = row && row.result && typeof row.result === "object" ? row.result : {};
    var who = platformLabel || "the marketplace";
    // The flow's own words, when it had any. Already seller-facing prose, and
    // an independent fact from the photos: a run can fill the form, get no
    // photos in, and still have something of its own to report.
    if (typeof res.error === "string" && res.error.trim()) return res.error.trim();
    if (photoState !== "refused" && typeof res.photosFailed === "number" && res.photosFailed > 0) {
      return (res.photosFailed === 1 ? "One photo " : res.photosFailed + " photos ") +
        "did not go in. The listing is on " + who + " already, so add them " +
        "there rather than running this again.";
    }
    if (res.manual === true) {
      return "GradeThread filled what it could and handed the rest back. Open " +
        "the listing on " + who + " and finish it there.";
    }
    if (res.unverified === true) {
      return "We clicked save and " + who + " never confirmed it took. Open the " +
        "listing there and check it before you count this one as posted.";
    }
    return null;
  }

  // ── US-3367: what the PAGE said about the photos ─────────────────────────
  //
  // `reasonFor` above reads exactly ONE field off `row.result`, and that is the
  // whole defect this section exists to close. A cross-post whose uploader
  // accepted the file selection and then rendered nothing out of the bytes sets
  // no `error` at all: the run completed, the row carries no reason, and the
  // seller is given no cause to go and look at a listing that has no images on
  // it. The queue is the surface where that costs the most, because a seller who
  // queued six from a thrift store and walked away is the seller least likely to
  // open any of them afterwards.
  //
  // THE WORDS ARE NOT OURS TO CHOOSE. US-2738 settled this taxonomy for the
  // direct send, in photoWitnessState (src/lib/lister-extension.ts). This is the
  // same four states, in the same order, deciding the same way, because a second
  // vocabulary for one fact is a pair of surfaces that will disagree about
  // whether a listing has photos. test/queue-photo-witness.test.cjs EXECUTES the
  // TypeScript one against this one over the same inputs, so the copy cannot
  // drift quietly.
  //
  //   "confirmed"          the page rendered a preview out of our bytes.
  //   "refused"            the page was asked and rendered nothing.
  //   "unknown"            nobody checked, or this build does not know the word.
  //   "nothing-to-attach"  there were no photos in play; no claim to qualify.
  var PHOTO_WITNESS_STATES = ["confirmed", "refused", "unknown", "nothing-to-attach"];

  /**
   * The stored run's own answer about its photos, in one word.
   *
   * THE DEFAULT ARM IS "unknown" AND THAT IS THE POINT. An absent witness, a
   * witness word a future extension invents, and a channel that declares no
   * preview selector all mean the same thing here: nothing outside the extension
   * has said the photos landed. Mapping any of them into the confirmed sentence
   * is how a seller reads "done" and never opens the listing. Absence is not
   * confirmation.
   */
  function photoWitnessState(result) {
    var res = result && typeof result === "object" ? result : {};
    switch (res.photosWitness) {
      case "page":
        return "confirmed";
      case "none":
        return "refused";
      default:
        break;
    }
    // No witness we know. Either nothing was attempted or nothing recorded an
    // answer, and those are different sentences to a seller.
    if (res.photosTotal === undefined) {
      // An install old enough to send no counts at all. `photosAttached: true`
      // from that build is the pre-US-1877 boolean, a claim with nothing behind
      // it, so it reads as unknown rather than as the success it calls itself.
      return res.photosAttached === undefined ? "nothing-to-attach" : "unknown";
    }
    if (res.photosTotal <= 0) return "nothing-to-attach";
    return "unknown";
  }

  /**
   * The sentence, or null when there is nothing to say.
   *
   * QUIET EXCEPT FOR THE REFUSAL. Mercari, Grailed, Vinted and Facebook declare
   * no photoConfirm, so every ordinary run on four of the five channels lands in
   * "unknown". That state is RECORDED here and carried on the row; what it must
   * never be is an alarm, because a warning that fires on every ordinary run is
   * how a seller learns to dismiss the one that matters. Only "refused" sets
   * `photoAlert`.
   *
   * "confirmed" says what was actually checked and no more. The witness is a
   * BOOLEAN (some uploaders draw one carousel node for eight files) so it
   * proves the uploader read the list, never that every file is on the listing,
   * and it must not put a number in front of the seller.
   */
  function photoNoteFor(state, platformLabel) {
    var who = platformLabel || "the marketplace";
    if (state === "refused") {
      return who + " never showed the photos it was handed, so they are not on " +
        "the listing. Add them there yourself: running this again hands the same " +
        "uploader the same list and gets the same nothing.";
    }
    if (state === "confirmed") {
      return who + " previewed the photos we sent, so its uploader took them. " +
        "That check is one preview and not a count, so look at the listing " +
        "before you post.";
    }
    if (state === "unknown") {
      return "Nothing confirmed the photos reached " + who + ". We handed them " +
        "over and this run recorded no answer either way, so check the listing " +
        "before you post.";
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
   *
   * IT TAKES AN API ROW, NOT A VIEW (US-3371). The side panel called it with a
   * view object: none of the three sources exist on a view, so it returned null
   * on every row and the panel painted an empty title span. It looked fine doing
   * that, which is why nobody found it: a falsy return is indistinguishable
   * from "this row honestly has no title", and that is a real case here. So the
   * one shape that can ONLY be a mistake is refused out loud instead. A view
   * already carries the answer as `.title`; ask it for that.
   */
  function titleFor(row) {
    if (!row) return null;
    if (row.stateLabel !== undefined || row.kindLabel !== undefined) {
      throw new TypeError(
        "titleFor takes a queue API row, not a view object. A view already " +
          "carries the answer as .title (see viewRow).",
      );
    }
    var p = row.payload && typeof row.payload === "object" ? row.payload : {};
    var candidates = [row.item_title, p.title, p.listingTitle];
    for (var i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === "string" && candidates[i].trim()) {
        return candidates[i].trim().slice(0, 120);
      }
    }
    return null;
  }

  /**
   * The listing this row is about, when there is one to open.
   *
   * TWO SOURCES SINCE US-3374. The payload copy is what a delist/revise/relist
   * was pointed at, and it is the only one a row has before it runs. A `list`
   * job has none: the listing does not exist until the run creates it, and the
   * URL of the one it created comes back on the RESULT (`listingUrl` is in
   * background.js's QUEUE_RESULT_FIELDS as an always-sent key). Reading only
   * the payload is why a finished cross-post had no link to the very listing
   * its note tells the seller to go and fix.
   *
   * https only, and only ever rendered as a link. A queue row is server-held
   * but client-originated, which makes it exactly as trusted as a message from
   * a page, the same standard the drain applies before it opens a tab.
   */
  function urlFor(row) {
    var p = row && row.payload && typeof row.payload === "object" ? row.payload : {};
    var res = row && row.result && typeof row.result === "object" ? row.result : {};
    var candidates = [p.listingUrl, res.listingUrl];
    for (var i = 0; i < candidates.length; i++) {
      var u = candidates[i];
      if (typeof u === "string" && /^https:\/\//i.test(u)) return u;
    }
    return null;
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
    // US-3374. Kept strictly apart from `attention`, which means "this never
    // reached the marketplace" everywhere it is read. A finished row is the
    // opposite fact and every action below turns on the difference.
    var finished = status === "done";
    var at = asMs(row.created_at);
    // The running row's stage, when the worker has a job for it. A claimed row
    // with no local job is one another browser claimed, and it stays
    // "Running now" here: we cannot see that machine's tab.
    var stages = o.stages && typeof o.stages === "object" ? o.stages : null;
    var jobInfo = status === "claimed" && stages && stages[row.id] ? stages[row.id] : null;
    var stageText = jobInfo ? stageLabel(jobInfo.stage) : null;
    // US-3373: NO PER-SURFACE OVERRIDE, AND THERE MUST NOT BE ONE AGAIN.
    //
    // This read used to be `o.platformLabels || PLATFORM_LABELS`. The argument
    // for keeping it was that the popup's meta line is narrower than the
    // panel's, so it wants a shorter name. That argument does not survive
    // looking at where the string ends up: it is spliced into whole sentences
    // built a few lines below this one: finishedReasonFor's "The listing is on
    // X already", photoNoteFor's note, dismissHint's "The listing stays up on
    // X." All three surfaces print those sentences word for word, on purpose,
    // so an override does not shorten a chip, it renames the subject of a
    // shared sentence in one surface only.
    //
    // The narrowness it was supposed to buy was imaginary anyway: popup.css
    // gives .pop-delist-meta `white-space: nowrap; text-overflow: ellipsis`, so
    // that line truncates at 380px whatever the name is, and the full string is
    // already on the row's `title` tooltip.
    var platformLabel = label(PLATFORM_LABELS, row.platform, "the marketplace");
    // US-3367: the run's own answer about its photos, on every row, whatever
    // the row's status. It is deliberately NOT folded into `needsAttention`:
    // that flag means "this never reached the marketplace", which is the one
    // thing a refused-photo run did do, and it carries Retry with it, which is the
    // single action that cannot help here.
    var photoState = photoWitnessState(row.result);
    return {
      id: row.id,
      kind: typeof row.kind === "string" ? row.kind : "list",
      kindLabel: label(KIND_LABELS, row.kind, "Job"),
      platform: typeof row.platform === "string" ? row.platform : "",
      platformLabel: platformLabel,
      photoState: photoState,
      photoAlert: photoState === "refused",
      photoNote: photoNoteFor(photoState, platformLabel),
      title: titleFor(row),
      state: status,
      stateLabel: label(STATE_LABELS, status, status),
      stage: jobInfo ? (typeof jobInfo.stage === "string" ? jobInfo.stage : null) : undefined,
      stageLabel: stageText,
      stateClass: label(STATE_CLASS, status, "warn"),
      at: at,
      ageMs: at === null ? null : Math.max(0, now - at),
      needsAttention: attention,
      // US-3374: a finished row gets a reason too, from its own vocabulary.
      // A row that renders a state badge and nothing else is the blank row
      // US-3371 spent a story finding.
      reason: attention
        ? reasonFor(row)
        : (finished ? finishedReasonFor(row, platformLabel, photoState) : null),
      finished: finished,
      listingUrl: urlFor(row),
      canCancel: status === "queued",
      // US-3374: DISMISS MEANS TWO DIFFERENT THINGS AND SAYS SO.
      //
      // On a failed or expired row it throws away an instruction that never
      // ran: after it, nothing anywhere remembers the seller asked. On a
      // finished row the marketplace already has the listing, and DELETE /:id
      // (which takes a `done` row; it filters on id and user_id only) removes
      // the NOTICE and nothing else. One word for both is how a seller reads
      // "Dismiss" as "undo that listing", so the label and the hint change with
      // the state and the three surfaces ask rather than deciding.
      canDismiss: attention || finished,
      dismissLabel: finished ? "Clear" : (attention ? "Dismiss" : null),
      dismissHint: finished
        ? "This clears the notice only. The listing stays up on " + platformLabel + "."
        : null,
      // A failed or expired row can be asked for again. The instruction is
      // still on the row (kind, platform, the item or listing it names, the
      // payload snapshot), so a retry is a new row with the same instruction
      // and the dead one removed — see retryBody. Only kinds this build knows
      // are offered: re-queueing a kind the drain will refuse again is a loop.
      //
      // IT IS `attention`, NOT `attention || finished`, AND THAT IS US-3374's
      // ONE REAL DECISION. Retry re-queues the identical instruction, so a
      // finished run gets the identical run: the same uploader handed the same
      // file list, which is the sentence photoNoteFor has been saying since
      // US-3367: "running this again hands the same uploader the same list
      // and gets the same nothing". Worse, it runs a second cross-post against
      // a marketplace that already has the first, which is a duplicate
      // listing. The action that helps is opening the listing, and that is the
      // one a finished row offers (`listingUrl`).
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
   * Order: what went wrong, then what ran and wants a look, then what is
   * running, then what is waiting, oldest first inside each group.
   *
   * The oldest-first tail matches the drain, which claims by `created_at`
   * ascending. A list ordered newest-first would show the seller a different
   * next job than the one the extension is actually about to run.
   *
   * US-3374 puts `done` SECOND rather than last. The top two groups are both
   * work a human has to do; the bottom two are progress. A finished cross-post
   * whose photos were refused is a live listing with no images on it, which is
   * not something to read under the waiting queue.
   */
  var GROUP = { failed: 0, expired: 0, done: 1, claimed: 2, queued: 3 };

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
   * Turn the API's THREE lists into one ordered view list.
   *
   * They arrive separated (`pending` / `needsAttention` / `finishedNeedsReview`)
   * precisely so a client cannot render one as another. Merging them here is
   * safe only because `state` survives on every row and drives the badge, the
   * grouping and which actions the row offers; the separation is preserved in
   * what the seller SEES, which is the thing the split was protecting.
   *
   * THE THIRD CONCAT IS US-3374 AND IT IS THE WHOLE STORY. The key shipped in
   * US-3370 and background.js has forwarded it since; this function read two of
   * the three and the rows were dropped on the floor. Folding them into either
   * existing list was measured and is worse than dropping them: into `pending`
   * a `done` row lands under Waiting with a stateClass no stylesheet answers and
   * turns on "Run it now", and under needsAttention the web tells the seller
   * nothing happened on the marketplace and to queue it again, which is how one
   * listing becomes two.
   */
  function buildList(payload, opts) {
    var p = payload && typeof payload === "object" ? payload : {};
    var rows = []
      .concat(Array.isArray(p.pending) ? p.pending : [])
      .concat(Array.isArray(p.needsAttention) ? p.needsAttention : [])
      .concat(Array.isArray(p.finishedNeedsReview) ? p.finishedNeedsReview : []);
    var views = [];
    for (var i = 0; i < rows.length; i++) {
      var v = viewRow(rows[i], opts);
      if (v) views.push(v);
    }
    return sortRows(views);
  }

  /**
   * The list split into the four groups the popup labels, in render order.
   * Empty groups are omitted so the popup never draws a heading over nothing.
   * The rows inside each keep sortRows' order, so the "waiting" group reads
   * top-to-bottom in the order the drain will run them.
   *
   * THE HEADING HAS TO NAME WHAT THE ROWS ARE (US-3374). "Needs you" and
   * "Waiting" are both false of a finished run, and a seller reads the heading
   * before the row. "Ran, check the listing" says the two things that separate
   * this group from the other three: it happened, and the rest is on the
   * marketplace rather than here.
   */
  var GROUP_ORDER = ["attention", "review", "running", "waiting"];
  var GROUP_LABELS = {
    attention: "Needs you",
    review: "Ran, check the listing",
    running: "Running now",
    waiting: "Waiting",
  };

  function groupOf(view) {
    // `done` is tested FIRST and by state, not by a flag. A finished row sets
    // neither `needsAttention` nor anything else the other arms read, so a
    // fall-through would put it under Waiting, which is exactly the bug.
    if (view.state === "done") return "review";
    if (view.state === "claimed") return "running";
    if (view.needsAttention) return "attention";
    return "waiting";
  }

  function groupRows(views) {
    var by = { attention: [], review: [], running: [], waiting: [] };
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
    var out = { waiting: 0, running: 0, attention: 0, review: 0, total: 0 };
    for (var i = 0; i < (views || []).length; i++) {
      var v = views[i];
      // US-3374 AC2: `done` is counted FIRST, into a bucket of its own.
      // `waiting` is the else-arm, and every consumer of it drives a call to
      // action for work that has not happened yet: the popup hides "Run it
      // now" on `waiting < 1` and "Cancel all" on `waiting < 2`. One finished
      // row falling through to it turns both on for a queue with nothing left
      // to run. `attention` is no better: it names "Clear N failed", and the
      // row did not fail. `total` DOES include it, deliberately, for the same
      // reason it includes the attention rows: it is the nav badge, the row
      // wants a human, and a badge that cannot see it is silence.
      if (v.state === "done") out.review++;
      else if (v.state === "claimed") out.running++;
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
    // IT TAKES THE OUTPUT OF summarize(), NOT A ROW AND NOT A VIEW (US-3371).
    // The side panel called it with a view object, which carries none of these
    // three keys, so it returned "" on every row and the panel painted an empty
    // status span. Null stays tolerated because "we have not read the queue" is
    // a real state with a real answer here (say nothing), but an OBJECT that
    // holds none of the three counts can only be the wrong shape, and returning
    // "" for it is how a caller is told nothing at all.
    if (counts !== null && counts !== undefined) {
      if (
        typeof counts !== "object" ||
        (typeof counts.running !== "number" &&
          typeof counts.waiting !== "number" &&
          typeof counts.attention !== "number")
      ) {
        throw new TypeError(
          "statusLine takes a counts object from summarize(), not a row or a " +
            "view. A single view's line is `view.stageLabel || view.stateLabel`.",
        );
      }
    }
    var c = counts || { waiting: 0, running: 0, attention: 0 };
    var parts = [];
    if (c.running) parts.push(c.running === 1 ? "1 running now" : c.running + " running now");
    if (c.waiting) parts.push(c.waiting === 1 ? "1 waiting" : c.waiting + " waiting");
    if (c.attention) {
      parts.push(c.attention === 1 ? "1 needs you" : c.attention + " need you");
    }
    // Last, and worded so it cannot be read as pending work. "1 ran with a
    // problem" is the only one of the four parts in the past tense, which is
    // the distinction the whole story turns on.
    if (c.review) {
      parts.push(c.review === 1 ? "1 ran with a problem" : c.review + " ran with problems");
    }
    return parts.join(" · ");
  }

  root.GT_QUEUE_VIEW = {
    KIND_LABELS: KIND_LABELS,
    GROUP_LABELS: GROUP_LABELS,
    STAGE_LABELS: STAGE_LABELS,
    stageLabel: stageLabel,
    groupRows: groupRows,
    retryBody: retryBody,
    PLATFORM_LABELS: PLATFORM_LABELS,
    STATE_LABELS: STATE_LABELS,
    STATE_CLASS: STATE_CLASS,
    PHOTO_WITNESS_STATES: PHOTO_WITNESS_STATES,
    photoWitnessState: photoWitnessState,
    photoNoteFor: photoNoteFor,
    viewRow: viewRow,
    sortRows: sortRows,
    buildList: buildList,
    summarize: summarize,
    statusLine: statusLine,
    reasonFor: reasonFor,
    finishedReasonFor: finishedReasonFor,
    titleFor: titleFor,
  };
})(typeof self !== "undefined" ? self : globalThis);
