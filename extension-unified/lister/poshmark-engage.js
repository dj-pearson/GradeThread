// GradeThread Lister — Poshmark engagement content script (US-2482).
//
// Runs share / follow / send-offer in the seller's OWN logged-in closet tab.
// Nothing here talks to GradeThread's API: the run asks the background for its
// gate decision before every single action, and reports counts back. The
// background is what owns storage; this file owns the DOM and the waiting.
//
// THREE RULES, all of which this file exists to keep:
//
//   1. ASK BEFORE EVERY ACTION, not once per run. A 5,000-share run that checked
//      its cap and consent at the start would sail past both — through a
//      revocation, through the cap being hit by a second tab, through a plan
//      lapsing mid-run. The gate is cheap; the failure it prevents is not.
//
//   2. COUNT WHAT LANDED, not what was clicked. A click that no-ops still costs
//      nothing, but counting it would make the meter optimistic — and an
//      optimistic meter is worse than none, because the seller trusts it. Only a
//      confirmed action increments.
//
//   3. NEVER ANSWER A HUMAN CHECK. When one appears the run stops, tells the
//      seller, and waits for them. No solver, no retry loop, no clicking through.
//      See the ADR bright line — it holds even in the seller's own browser.

(function () {
  // Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
  const chrome = globalThis.browser || globalThis.chrome;
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  const cfg = SEL.poshmark && SEL.poshmark.engage;
  if (!cfg) return;

  /** Is Poshmark asking for a human right now? */
  function humanCheckPresent() {
    try {
      return Boolean(cfg.humanCheck && document.querySelector(cfg.humanCheck));
    } catch (_e) {
      return false;
    }
  }

  function send(msg) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(msg));
    } catch (_e) {
      return Promise.resolve(null);
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ── Stop ────────────────────────────────────────────────────────────────
  //
  // The banner this run draws tells the seller they can end it from the
  // extension, so there has to be something on the other end of that sentence.
  // The flag is checked at the TOP of each iteration, next to the human check,
  // so a stop lands before the next click rather than after it — a stop that
  // took effect one share late would be a stop the seller cannot trust.
  //
  // It is per-run: a stale STOP arriving after a run ended must not silently
  // kill the next one the seller starts.
  var stopRequestedFor = null;
  var currentRunId = null;

  function stopRequested() {
    return currentRunId !== null && stopRequestedFor === currentRunId;
  }

  /**
   * Wait for Poshmark's own success signal.
   *
   * Returns true only on positive evidence. A timeout returns false and the
   * action is NOT counted — see rule 2. The window is short because a share that
   * has not confirmed in two seconds has almost certainly not happened, and
   * waiting longer just slows a run that is already paced.
   */
  /**
   * Positive proof that ONE action landed.
   *
   * TWO SIGNALS, because one of them could not be caught (2026-08-11).
   *
   * The design has always been that only a CONFIRMED action increments the
   * meter — an optimistic meter is worse than none, since the seller trusts it
   * and share jail is the thing on the other side of the number. The signal was
   * a success toast, and four watcher runs across two evenings failed to record
   * one: Poshmark's confirmation is gone in about two seconds, and it may not be
   * a DOM insertion at all.
   *
   * So the modal CLOSING counts too, and it is the same evidence delist has
   * relied on since US-1875: a witness that was present before the click and is
   * absent after it. `confirmGone` is checked exactly that way — its presence
   * is captured at entry, and only a present-then-absent transition is
   * admissible. Without that rule a selector that never matched anything would
   * read as "absent" on the first tick and rubber-stamp every action, which is
   * the false-success bug this whole check exists to prevent, rebuilt inside the
   * check itself.
   *
   * It is weaker than a toast — a modal can also close because the seller hit
   * escape — and that is acceptable HERE and nowhere else: we clicked the
   * confirm ourselves a moment earlier, and the cost of a wrong count is one
   * share of slack against a cap set thousands below Poshmark's real edge. The
   * cost of no signal at all is a meter that reads zero forever.
   */
  async function confirmed(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 2500);
    let goneWasPresent = false;
    try {
      goneWasPresent = Boolean(cfg.confirmGone && document.querySelector(cfg.confirmGone));
    } catch (_e) { /* an unusable selector is simply no signal */ }

    while (Date.now() < deadline) {
      try {
        if (cfg.actionConfirmed && document.querySelector(cfg.actionConfirmed)) return true;
        if (goneWasPresent && !document.querySelector(cfg.confirmGone)) return true;
      } catch (_e) { /* keep polling */ }
      await sleep(120);
    }
    return false;
  }

  /** One share: open the tile's share control, then share to followers. */
  async function shareOne(tile) {
    const control = tile.querySelector(cfg.shareButton) ||
      (tile.matches && tile.matches(cfg.shareButton) ? tile : null);
    if (!control) return false;
    control.click();

    // 2026-08-11: sharing is TWO modals, and the first one is mostly exits.
    //
    // Watching a real share showed the first modal is a share MENU whose
    // options are largely outbound — share_facebook, share_pinterest,
    // share_email, share_copy, and a people_search box that DMs the listing to
    // a named person. Only `share_poshmark` stays inside Poshmark, and it opens
    // the second modal where "To My Followers" lives.
    //
    // So this step is not optional politeness, it is the guard: without it a
    // selector drift in the second modal could resolve against the FIRST one,
    // and the failure would not be a missed share — it would be the seller's
    // listing posted to their Facebook, or sent to a stranger, a few thousand
    // times. Missing the step means no share at all, which is the right way for
    // this to break.
    if (cfg.shareInternal) {
      const internal = await GT.waitFor(cfg.shareInternal, 3000);
      if (!internal) return false;
      internal.click();
    }

    const toFollowers = await GT.waitFor(cfg.shareToFollowers, 3000);
    if (!toFollowers) {
      // The modal did not open, or its markup moved. Do NOT fall back to
      // clicking whatever is nearby — on a share modal the neighbouring control
      // is "share to a party", and a bot dropping a closet into the wrong party
      // is the most visible thing it can do.
      return false;
    }
    toFollowers.click();
    return confirmed();
  }

  async function followOne(button) {
    if (!button) return false;
    button.click();
    return confirmed();
  }

  async function offerOne(button, price) {
    if (!button) return false;
    button.click();
    const input = await GT.waitFor(cfg.offerPriceInput, 3000);
    if (!input) return false;
    GT.setValue(input, String(price));
    const submit = await GT.waitFor(cfg.offerSubmit, 3000);
    if (!submit) return false;
    submit.click();
    return confirmed();
  }

  /**
   * Run one engagement pass.
   *
   * `run` comes from the background and carries only what the DOM work needs:
   * the action, how many to attempt, and (for offers) the price. It never
   * carries a cap or a consent flag — those are decided per action by the gate,
   * so a stale copy in this tab cannot outvote them.
   */
  async function runEngagement(run) {
    const label = "Poshmark";
    currentRunId = run.runId || null;
    stopRequestedFor = null;

    if (!cfg.enabled) {
      return send({
        type: "GT_ENGAGE_RESULT",
        runId: run.runId,
        result: {
          ok: false,
          manual: true,
          error: label + " sharing isn't switched on yet — the controls are still " +
            "being re-checked against the live site (selector v" + cfg.version + ").",
          version: cfg.version,
        },
      });
    }

    if (GT.isLoginWall(SEL.poshmark.login)) {
      GT.showBanner("Log in to Poshmark — GradeThread will pick this run up once you're in.");
      return send({
        type: "GT_ENGAGE_NOTICE",
        runId: run.runId,
        notice: { loginWall: true, error: "Log in to Poshmark and start the run again." },
      });
    }

    const missing = await GT.probe(
      { required: cfg.required, fields: { shareButton: cfg.shareButton }, submit: cfg.shareButton },
      4000,
    );
    if (missing.length > 0) {
      return send({
        type: "GT_ENGAGE_RESULT",
        runId: run.runId,
        result: {
          ok: false,
          manual: true,
          error: label + "'s closet page changed (selector v" + cfg.version +
            " can't find: " + missing.join(", ") + "). Share manually — the " +
            "GradeThread Lister needs an update.",
          version: cfg.version,
        },
      });
    }

    GT.showBanner(
      "GradeThread is sharing this closet. Close this tab or click Stop in the " +
        "extension to end the run at any point.",
    );

    let done = 0;
    let attempted = 0;
    let stoppedBy = null;

    const targets = collectTargets(run.action);
    for (let i = 0; i < targets.length; i++) {
      // The seller's own stop, checked before anything is clicked.
      if (stopRequested()) {
        stoppedBy = "stopped";
        GT.showBanner("Run stopped. " + done + " " + run.action + "s done today so far.");
        break;
      }

      // RULE 3 first: a human check outranks everything, including the cap.
      if (humanCheckPresent()) {
        stoppedBy = "human_check";
        // The banner is the half of AC2 the seller actually sees. The notice
        // below reaches the popup, which may not be open — a run that pauses
        // silently in the tab the seller is looking at reads as a run that hung.
        GT.showBanner(
          "Poshmark asked for a human check. Finish it in this tab, then start " +
            "the run again — GradeThread will never answer one for you.",
        );
        await send({
          type: "GT_ENGAGE_NOTICE",
          runId: run.runId,
          notice: {
            humanCheck: true,
            done: done,
            error: "Poshmark asked for a human check. Finish it in this tab and " +
              "start the run again — GradeThread will never answer one for you.",
          },
        });
        break;
      }

      // RULE 1: the gate, per action.
      const decision = await send({
        type: "GT_ENGAGE_GATE",
        action: run.action,
        humanCheck: false,
      });
      if (!decision || decision.ok !== true) {
        stoppedBy = (decision && decision.reason) || "gate";
        break;
      }

      attempted += 1;
      let landed = false;
      try {
        if (run.action === "share") landed = await shareOne(targets[i]);
        else if (run.action === "follow") landed = await followOne(targets[i]);
        else if (run.action === "offer") landed = await offerOne(targets[i], run.offerPrice);
      } catch (_e) {
        landed = false;
      }

      // RULE 2: only a confirmed action counts, on the meter and in storage.
      if (landed) {
        done += 1;
        await send({ type: "GT_ENGAGE_RECORD", action: run.action, count: 1 });
      }

      // Paced, randomized, floored. The background owns the settings so the
      // floor cannot be lowered from inside a marketplace page.
      const delay = (decision && decision.nextDelayMs) || 1500;
      await sleep(delay);
    }

    return send({
      type: "GT_ENGAGE_RESULT",
      runId: run.runId,
      result: {
        // A seller-requested stop and a cap are ENDINGS, not failures. Reporting
        // them as errors would train the seller to ignore the one line that
        // tells them a run really did break.
        ok: stoppedBy === null || stoppedBy === "daily_cap" || stoppedBy === "stopped",
        action: run.action,
        done: done,
        attempted: attempted,
        // Deliberately reported rather than swallowed: a run that stops at 300 of
        // a requested 5,000 is a run the seller otherwise thinks completed.
        stoppedBy: stoppedBy,
        version: cfg.version,
      },
    });
  }

  /** The elements a run will act on, in document order. */
  function collectTargets(action) {
    try {
      if (action === "share") {
        return Array.prototype.slice.call(document.querySelectorAll(cfg.shareButton));
      }
      if (action === "follow") {
        return Array.prototype.slice.call(document.querySelectorAll(cfg.followButton));
      }
      if (action === "offer") {
        return Array.prototype.slice.call(document.querySelectorAll(cfg.offerButton));
      }
    } catch (_e) { /* fall through */ }
    return [];
  }

  // A run is started from the popup, which asks the background, which asks this
  // tab. There is no auto-start on page load: an engagement run that begins
  // because a seller happened to open their own closet is not something they
  // asked for.
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg) return false;

    if (msg.type === "GT_ENGAGE_RUN") {
      // One run per tab. Starting a second while the first is walking the closet
      // would double the pace without either loop knowing, and the pacing floor
      // is the whole reason a run looks human.
      if (currentRunId !== null) {
        sendResponse({ ok: false, reason: "already_running" });
        return false;
      }
      sendResponse({ ok: true, started: true });
      // The reset is in a finally, not at the end of the happy path: every early
      // return (switched off, login wall, moved selectors) also ends the run, and
      // one that forgot to clear the flag would leave the tab refusing to start
      // another until it was reloaded.
      void runEngagement(msg.run || {}).catch(function () {}).then(function () {
        currentRunId = null;
        stopRequestedFor = null;
      });
      return false;
    }

    if (msg.type === "GT_ENGAGE_STOP") {
      stopRequestedFor = currentRunId;
      sendResponse({ ok: true, stopping: currentRunId !== null });
      return false;
    }

    return false;
  });
})();
