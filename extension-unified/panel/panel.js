// US-3062: the side panel's own wiring.
//
// The panel exists because a popup closes on the first click on the page, and
// filling a marketplace form is nothing but clicks on the page. So the queue and
// the item stay visible beside the form instead of being something the seller
// reopens between every field.
//
// WHAT THIS FILE IS NOT. It is not a second popup. The queue's grouping, labels,
// ordering and which-actions-a-row-offers rules all come from
// queue/queue-view.js, the same module popup.js uses and the one
// test/queue-view.test.cjs pins. A second implementation of those rules is a
// second set of answers to keep in step, and the first thing to drift would be
// which rows offer Cancel — the rule that stops a job being pulled out from
// under a marketplace tab that is mid-fill.
//
// IT HOLDS NO TOKEN AND MAKES NO FETCH. Every call goes through a background
// message type that already exists. panel/*.js is asserted to contain no
// `fetch(` by test/panel-no-fetch.test.cjs, the same source-assertion shape
// ebay-no-scrape.test.cjs uses for the eBay path. The reason is the same in both
// places: the rule is easy to state, invisible at runtime when broken, and one
// autocomplete away from being violated by someone being helpful.

(function () {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const QUEUE_VIEW = self.GT_QUEUE_VIEW;
  const ITEM_CARD = self.GT_PANEL_ITEM_CARD;
  const ATTR = self.GT_ATTRIBUTION;

  /**
   * Ask the background for something.
   *
   * Resolves to null rather than rejecting when the worker is asleep or there is
   * no receiver, so every caller below can treat "no answer" as a state to
   * render instead of an exception to swallow. Same contract as popup.js's
   * send(), deliberately: two message helpers with different failure shapes is
   * how one surface starts showing an empty queue where the other shows an
   * error.
   */
  function send(msg) {
    try {
      return Promise.resolve(ext.runtime.sendMessage(msg)).catch(() => null);
    } catch (_e) {
      return Promise.resolve(null);
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  /** The account chip, mirroring popup.js's states so the two agree. */
  function renderAccount(caps) {
    const chip = byId("headAcct");
    const label = byId("headAcctLabel");
    if (!chip || !label) return;
    const signedIn = Boolean(caps && caps.signedIn);
    chip.dataset.state = signedIn ? "in" : "anon";
    label.textContent = signedIn ? (caps.email || "Signed in") : "Sign in";
    chip.setAttribute(
      "aria-label",
      signedIn ? `Account: ${label.textContent}` : "Account: sign in",
    );
  }

  /**
   * The queue block.
   *
   * An unanswerable queue renders as UNKNOWN, never as empty. "Nothing queued"
   * over a failed read is the worst outcome available here: the seller stops
   * looking, and the jobs are still there.
   */
  async function renderQueue() {
    const list = byId("queueList");
    const empty = byId("queueEmpty");
    if (!list) return;

    const [res, jobsRes] = await Promise.all([
      send({ type: "GT_QUEUE_STATE" }),
      send({ type: "GT_QUEUE_JOBS" }),
    ]);

    list.textContent = "";
    if (!res || !res.ok) {
      const p = document.createElement("p");
      p.className = "pop-muted";
      p.textContent = res && res.reason === "no-plan"
        ? "Cross-listing is not on your plan."
        : "Could not read your queue.";
      list.appendChild(p);
      if (empty) empty.hidden = true;
      return;
    }

    const stages = jobsRes && jobsRes.ok && jobsRes.byQueueId
      ? jobsRes.byQueueId
      : null;
    const rows = QUEUE_VIEW.buildList(res, { now: Date.now(), stages: stages });

    if (!rows.length) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = "Nothing queued.";
        list.appendChild(empty);
      }
      return;
    }
    if (empty) empty.hidden = true;

    for (const group of QUEUE_VIEW.groupRows(rows)) {
      const h = document.createElement("h3");
      h.className = "gt-panel-group";
      h.textContent = QUEUE_VIEW.GROUP_LABELS[group.key] || group.key;
      list.appendChild(h);

      for (const row of group.rows) {
        const li = document.createElement("div");
        li.className = "gt-panel-row";

        const title = document.createElement("span");
        title.className = "gt-panel-row-title";
        title.textContent = QUEUE_VIEW.titleFor(row);
        li.appendChild(title);

        const status = document.createElement("span");
        status.className = "gt-panel-row-status";
        status.textContent = QUEUE_VIEW.statusLine(row);
        li.appendChild(status);

        // Cancel is offered on a QUEUED row only. A claimed row is mid-fill in
        // some marketplace tab and pulling it would leave that tab half done —
        // the rule lives in queue-view.js and is pinned there, so this asks
        // rather than deciding.
        if (row.canCancel) {
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "pop-btn pop-btn-ghost";
          cancel.textContent = "Cancel";
          cancel.addEventListener("click", async () => {
            cancel.disabled = true;
            await send({ type: "GT_QUEUE_CANCEL", id: row.id });
            await renderQueue();
          });
          li.appendChild(cancel);
        }

        list.appendChild(li);
      }
    }
  }

  /** The tab the panel is beside, and whether we have anything to say about it. */
  async function currentTab() {
    try {
      const tabs = await ext.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (_e) {
      return null;
    }
  }

  async function renderItem() {
    if (!ITEM_CARD) return;
    const host = byId("itemCard");
    const empty = byId("itemEmpty");
    if (!host) return;

    const tab = await currentTab();
    const res = await send({
      type: "GT_PANEL_ITEM",
      tabId: tab && typeof tab.id === "number" ? tab.id : null,
      url: (tab && tab.url) || "",
    });

    const view = ITEM_CARD.viewFor(res);

    // WHY REVISE IS DRIVEN BY THE PENDING ROW, and not by the button alone.
    // GT_LISTER_REVISE validates a payload of {platform, listingUrl, fields},
    // and `fields` is the set of things a FlipDesk edit made stale. The panel
    // does not know that and must not guess it: a revise with invented fields
    // rewrites a live listing with values nobody asked to change. The server
    // already computes it — `listings.platform_fields.revise_pending` is the
    // queue entry, and GT_GET_PENDING_REVISES is how the popup counts them — so
    // the panel offers Revise only when a real pending row exists for this item
    // and sends THAT row.
    const pending = await send({ type: "GT_GET_PENDING_REVISES" });
    const row = ITEM_CARD.pendingFor(pending, view);

    ITEM_CARD.render(host, view, {
      pending: row,
      onRevise: async () => {
        if (!row) return;
        await send({ type: "GT_LISTER_REVISE", payload: row });
        await renderQueue();
      },
      // Relist is deliberately a LINK, not a message. A relist payload names
      // the NEW listing row the server created for the copy, which does not
      // exist until FlipDesk makes it — so the panel sends the seller to the
      // item rather than firing a message that can only be refused.
      relistHref: view.kind === "item" && view.item.id && ATTR
        ? ATTR.siteUrl("/dashboard/flipdesk/items/" + view.item.id, "panel", {
          campaign: "relist",
        })
        : null,
    });
    if (empty) empty.hidden = view.kind !== "none";
  }

  /**
   * Firefox has no per-tab sidebar toggle, so the sidebar is open everywhere and
   * has to say why it is empty. Chromium disables the panel per tab in
   * background.js, so this branch is Firefox's and the off-host state is not
   * dead code there.
   */
  async function renderHostState() {
    const off = byId("offHostSection");
    const item = byId("itemSection");
    const queue = byId("queueSection");
    if (!off) return;
    const tab = await currentTab();
    const res = await send({ type: "GT_PANEL_SUPPORTED", url: (tab && tab.url) || "" });
    // Fail OPEN: an unanswerable check shows the panel rather than hiding it.
    // A blank sidebar with no explanation is worse than one extra empty queue.
    const supported = !res || res.supported !== false;
    off.hidden = supported;
    if (item) item.hidden = !supported;
    if (queue) queue.hidden = !supported;
    return supported;
  }

  async function refresh() {
    const supported = await renderHostState();
    const caps = await send({ type: "GT_GET_CAPABILITIES" });
    renderAccount(caps);
    if (supported) {
      await Promise.all([renderQueue(), renderItem()]);
    }
  }

  function wire() {
    const runNow = byId("queueRunNow");
    if (runNow) {
      runNow.addEventListener("click", async () => {
        runNow.disabled = true;
        // The same drain the five-minute alarm calls, under the same seller
        // gates. Says it started, never that it finished.
        await send({ type: "GT_QUEUE_RUN_NOW" });
        runNow.disabled = false;
        await renderQueue();
      });
    }
    const refreshBtn = byId("queueRefresh");
    if (refreshBtn) refreshBtn.addEventListener("click", () => void refresh());

    const acct = byId("headAcct");
    if (acct) {
      acct.addEventListener("click", () => {
        void send({ type: "GT_OPEN_SIGN_IN" });
      });
    }

    // The panel outlives a navigation, which a popup never does. Re-read when
    // the tab it sits beside changes, or the panel shows the previous listing's
    // item until the seller notices.
    try {
      ext.tabs.onActivated.addListener(() => void refresh());
      ext.tabs.onUpdated.addListener((_id, info) => {
        if (info && info.status === "complete") void refresh();
      });
    } catch (_e) {
      // Firefox sidebars have tabs access too, but a missing listener must not
      // take the panel down with it.
    }
  }

  function start() {
    try {
      if (self.GT_THEME && self.GT_THEME.init) {
        void self.GT_THEME.init(ext, document);
      }
    } catch (_e) {
      // Theme is a nicety; the panel renders without it.
    }
    const ver = byId("panelVer");
    if (ver) {
      try {
        ver.textContent = "v" + ext.runtime.getManifest().version;
      } catch (_e) {
        ver.textContent = "";
      }
    }
    wire();
    void refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
