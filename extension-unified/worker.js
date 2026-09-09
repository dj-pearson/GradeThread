// GradeThread unified extension — the worker tab (US-3061).
//
// WHAT THIS IS. One pinned tab that drains the cross-listing queue all day. It
// is the honest version of what Nifty and Sidekick Tools sell: work that happens
// while the seller is not watching, except that it happens in the seller's own
// browser, in the seller's own session, and nobody's servers hold a marketplace
// password. See vault/60-decisions/adr-no-server-side-marketplace-automation.md.
//
// WHY A PAGE AND NOT JUST A SHORTER ALARM. Under MV3 the service worker is
// evicted between alarms, and Chrome will not run an alarm more often than once
// a minute anyway. A page holding a runtime port keeps the worker alive, which
// is the documented way to do this and the only way the 60-second cadence is
// real rather than aspirational. The 5-minute SWEEP_ALARM stays exactly as it
// was, for every seller who never opens this tab.
//
// WHAT THIS PAGE DOES NOT DO, and each one is deliberate:
//   • It never opens a marketplace tab itself. It asks the background to drain,
//     and the background applies the same guards an interactive cross-post gets
//     (lister-guard host pinning, the seller gates, one job at a time).
//   • It never navigates anywhere on a URL that arrived in a message. Every
//     link it renders is https and comes from the seller's own queue row, and
//     the only tab it will focus is one the background says the worker opened.
//   • It never resumes a paused drain on its own. A pause means a marketplace
//     asked for a person, and only the person can say they answered.
(function () {
  "use strict";

  var ext = globalThis.browser || globalThis.chrome;
  var W = self.GT_WORKER_STATE;
  var QUEUE_VIEW = self.GT_QUEUE_VIEW;

  /** How often the page re-renders. The countdown is per second; the drain is
   *  decided by W.shouldDrain, so the render tick can be fast without turning
   *  into a queue read per second. */
  var TICK_MS = 1000;

  var state = W.initialState(Date.now());
  var port = null;
  var reconnectTimer = null;
  var drainInFlight = false;
  var lastQueueAt = 0;
  /** How often the page re-reads the queue when nothing has drained. The drain
   *  itself refreshes it, so this is only for rows another surface changed. */
  var QUEUE_POLL_MS = 15 * 1000;

  function el(id) {
    return document.getElementById(id);
  }

  function send(msg) {
    try {
      return Promise.resolve(ext.runtime.sendMessage(msg)).catch(function () { return null; });
    } catch (_e) {
      return Promise.resolve(null);
    }
  }

  // ── the keep-alive port ────────────────────────────────────────────────────
  //
  // A connected port keeps the MV3 service worker from being evicted. It also
  // dies whenever the browser decides to restart the worker anyway, so the
  // reconnect is not an edge case — it is the normal path, several times a day.
  // Without it the tab sits open, looks fine, and stops keeping anything alive.

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      port = ext.runtime.connect({ name: W.PORT_NAME });
    } catch (_e) {
      port = null;
      scheduleReconnect();
      return;
    }
    if (!port) {
      scheduleReconnect();
      return;
    }
    port.onDisconnect.addListener(function () {
      port = null;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, 1000);
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function renderStatus() {
    var line = el("statusLine");
    if (line) line.textContent = W.statusLine(state, Date.now());

    var stop = el("stopBtn");
    if (stop) stop.textContent = state.running ? "Stop" : "Start";

    var box = el("pauseBox");
    var text = el("pauseText");
    var resume = el("resumeBtn");
    var open = el("pauseOpen");
    var paused = Boolean(state.pause);
    if (box) box.hidden = !paused;
    if (resume) resume.hidden = !paused;
    if (text && paused) text.textContent = W.statusLine(state, Date.now());
    // Offered only for a tab the BACKGROUND says the worker opened. A tab id
    // that arrived any other way is not something this page will focus.
    if (open) open.hidden = !(paused && typeof state.pause.tabId === "number");
  }

  function row(view) {
    var li = document.createElement("li");
    li.className = "pop-delist" + (view.needsAttention ? " is-attention" : "");

    var body = document.createElement("div");
    body.className = "pop-delist-body";

    var title = document.createElement("span");
    title.className = "pop-delist-title";
    title.textContent = view.title || (view.kindLabel + " on " + view.platformLabel);
    title.title = title.textContent;

    var meta = document.createElement("span");
    meta.className = "pop-delist-meta";
    var bits = [view.kindLabel, view.platformLabel];
    if (view.reason) bits.push(view.reason);
    meta.textContent = bits.join(" · ");
    meta.title = meta.textContent;

    body.appendChild(title);
    body.appendChild(meta);
    li.appendChild(body);

    var badge = document.createElement("span");
    badge.className = "pop-status " + view.stateClass;
    badge.textContent = view.stageLabel || view.stateLabel;
    li.appendChild(badge);
    return li;
  }

  function renderQueue(payload, stages) {
    var list = el("queueList");
    var empty = el("empty");
    if (!list) return;
    list.textContent = "";
    var views = QUEUE_VIEW.buildList(payload, { now: Date.now(), stages: stages });
    var groups = QUEUE_VIEW.groupRows(views);
    for (var g = 0; g < groups.length; g++) {
      var head = document.createElement("li");
      head.className = "pop-delist-group";
      head.textContent = groups[g].label;
      list.appendChild(head);
      for (var i = 0; i < groups[g].rows.length; i++) {
        list.appendChild(row(groups[g].rows[i]));
      }
    }
    if (empty) empty.hidden = views.length > 0;
  }

  function renderNote(message) {
    var note = el("note");
    if (!note) return;
    note.hidden = !message;
    note.textContent = message || "";
  }

  function renderStale(ids) {
    var box = el("stale");
    if (!box) return;
    var n = Array.isArray(ids) ? ids.length : 0;
    box.hidden = n === 0;
    if (n === 0) return;
    box.textContent = n === 1
      ? "One marketplace tab GradeThread opened is still open well past its " +
        "deadline. It has been left alone in case you are finishing it by hand."
      : n + " marketplace tabs GradeThread opened are still open well past " +
        "their deadlines. They have been left alone in case you are finishing " +
        "them by hand.";
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  var OUTCOME_NOTE = {
    "not-allowed": "Your FlipDesk plan does not cover cross-listing right now, " +
      "so nothing will run. Nothing has been lost: the queue is held on the server.",
    "needs-consent": "Open the GradeThread extension and accept the cross-listing " +
      "terms once. Nothing runs until you do.",
  };

  async function refreshQueue() {
    var results = await Promise.all([
      send({ type: "GT_QUEUE_STATE" }),
      send({ type: "GT_QUEUE_JOBS" }),
    ]);
    var payload = results[0];
    var jobs = results[1];
    lastQueueAt = Date.now();
    if (!payload || !payload.ok) {
      renderQueue({}, null);
      return;
    }
    renderQueue(payload, jobs && jobs.ok && jobs.byQueueId ? jobs.byQueueId : null);
  }

  async function refreshWorkerState() {
    var out = await send({ type: "GT_WORKER_STATE" });
    if (!out || !out.ok) return;
    // The PAUSE is the background's to report - it is the surface that sees the
    // login-wall and human-check notices. `running` stays this page's, because
    // Stop means "this tab, now" and must not outlive the tab.
    state.pause = out.pause || null;
    renderStale(out.staleTabs);
  }

  async function tick() {
    await refreshWorkerState();
    renderStatus();

    if (W.shouldDrain(state, Date.now()) && !drainInFlight) {
      drainInFlight = true;
      try {
        var out = await send({ type: "GT_QUEUE_RUN_NOW" });
        var outcome = out && typeof out.state === "string" ? out.state : null;
        state = W.noteDrain(state, outcome, Date.now());
        renderNote(OUTCOME_NOTE[outcome] || "");
        await refreshQueue();
      } finally {
        drainInFlight = false;
      }
      renderStatus();
      return;
    }

    if (Date.now() - lastQueueAt >= QUEUE_POLL_MS) await refreshQueue();
  }

  // ── US-1881: the Firefox host-permission grant ────────────────────────────
  //
  // On Firefox, desktop and Android alike, host_permissions is opt-in and an
  // un-granted add-on fails with no error anywhere: the drain opens a Poshmark
  // tab, the content script never injects, the job times out. From the seller's
  // side that is GradeThread being broken.
  //
  // The probe FAILS OPEN (see host-permissions.js), so this banner appears only
  // on a definite no. The request is the FIRST statement of the click handler,
  // because an await before it ends the user gesture and Firefox refuses it.

  var PERMS = self.GT_HOST_PERMS;
  /** One representative marketplace host. The manifest grants them as a block,
   *  so one definite no means all of them. */
  var PROBE_HOST = "poshmark.com";

  async function checkHostAccess() {
    var box = el("grantBox");
    if (!box || !PERMS) return;
    var ok = await PERMS.hasHostAccess(ext, PROBE_HOST);
    box.hidden = ok !== false;
  }

  function wireGrant() {
    var btn = el("grantBtn");
    if (!btn || !PERMS) return;
    btn.addEventListener("click", function () {
      // FIRST statement, synchronously. Do not await anything above this line.
      var asked = PERMS.requestHostAccess(ext, PROBE_HOST);
      btn.disabled = true;
      Promise.resolve(asked).then(function () {
        btn.disabled = false;
        void checkHostAccess();
      });
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  function wire() {
    var stop = el("stopBtn");
    if (stop) {
      stop.addEventListener("click", function () {
        state = state.running ? W.stop(state) : W.start(state, Date.now());
        renderStatus();
      });
    }

    var resume = el("resumeBtn");
    if (resume) {
      resume.addEventListener("click", async function () {
        // The seller says they dealt with it. Nothing else in this extension is
        // allowed to say so - not a timer, not a page load, not the next drain.
        await send({ type: "GT_WORKER_RESUME" });
        state = W.resume(state, true);
        renderStatus();
      });
    }

    var open = el("pauseOpen");
    if (open) {
      open.addEventListener("click", async function () {
        if (!state.pause || typeof state.pause.tabId !== "number") return;
        await send({ type: "GT_WORKER_FOCUS", tabId: state.pause.tabId });
      });
    }
  }

  connect();
  wire();
  wireGrant();
  void checkHostAccess();
  renderStatus();
  void refreshQueue();
  void tick();
  setInterval(function () { void tick(); }, TICK_MS);
})();
