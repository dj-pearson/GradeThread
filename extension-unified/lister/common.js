// GradeThread Lister — shared content-script helpers (US-716)
//
// These run inside the marketplace tab (Poshmark/Mercari/Grailed) in the user's
// OWN authenticated session. They NEVER read cookies, localStorage credentials,
// or send anything to GradeThread servers — the only network traffic is the
// optional photo download from the public item-photos bucket. The listing
// result (URL) is handed back to the background worker, which relays it to the
// GradeThread tab that started the job; GradeThread itself writes the listings
// row using the user's existing SaaS session.

(function () {
  // Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
  const chrome = globalThis.browser || globalThis.chrome;

  const GT = {};

  GT.log = function (msg) {
    try {
      chrome.runtime.sendMessage({ type: "GT_LISTER_LOG", message: String(msg) });
    } catch (_e) {
      /* background may be asleep; logging is best-effort */
    }
    // eslint-disable-next-line no-console
    console.debug("[GradeThread Lister]", msg);
  };

  // Wait for an element matching any of the comma-separated selectors.
  GT.waitFor = function (selector, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    return new Promise(function (resolve) {
      const tick = function () {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, 150);
      };
      tick();
    });
  };

  // Probe the flow's required selectors. Returns the list of required keys that
  // are currently MISSING from the DOM — empty means the form looks healthy.
  //
  // US-1875 AC4: the waits run CONCURRENTLY. They used to be awaited in a `for`
  // loop, which is a serial 6s-per-selector penalty paid in the worst case — the
  // one where the form is broken and every selector runs its timeout out. Three
  // required selectors meant 18s (and the fill flow's larger sets 24s+) to reach a
  // diagnosis, most of a 30s worker lifetime spent waiting on independent timers.
  // The selectors do not depend on each other, so there was never a reason to
  // serialize them: Promise.all bounds the whole probe at ONE timeout (~6s).
  GT.probe = async function (flow, timeoutMs) {
    const results = await Promise.all(
      flow.required.map(async function (key) {
        const selector = key === "submit" ? flow.submit : flow.fields[key];
        if (!selector) return key;
        const el = await GT.waitFor(selector, timeoutMs || 6000);
        return el ? null : key;
      }),
    );
    return results.filter(function (k) { return k !== null; });
  };

  // US-1875 AC3: is this a marketplace login/interstitial page rather than the
  // page we were sent to?
  //
  // WHY IT MATTERS. A logged-out seller gets redirected to a sign-in page, where
  // none of the listing selectors exist. The old code read that as "every required
  // selector is missing" and reported the brand's page had CHANGED — telling the
  // seller the extension needs an update, when they simply needed to log in. Worse,
  // it consumed the job doing so, so logging in and retrying required starting over
  // from the SaaS.
  //
  // Two independent signals, either of which is enough — a redirect usually changes
  // the URL, but SPA marketplaces sometimes render the login form in place:
  //   • URL: the login config's urlPattern matches location.href.
  //   • FORM: a password input is present. That is the definitive tell — a listing
  //     form never has one, and every login page does.
  GT.isLoginWall = function (loginConfig) {
    try {
      if (document.querySelector('input[type="password"]')) return true;
      const pattern = loginConfig && loginConfig.urlPattern;
      if (pattern && new RegExp(pattern, "i").test(location.href)) return true;
      const sel = loginConfig && loginConfig.selector;
      if (sel && document.querySelector(sel)) return true;
      return false;
    } catch (_e) {
      return false;
    }
  };

  // Set a value on a React/Vue-controlled input so the framework's onChange
  // actually fires (a plain `el.value = x` is ignored by React).
  GT.setValue = function (el, value) {
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) {
      setter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };

  GT.fill = function (selector, value) {
    if (value == null || value === "") return false;
    const el = document.querySelector(selector);
    return GT.setValue(el, String(value));
  };

  // Best-effort: download the (public, EXIF-stripped) item photos and inject them
  // into the form's file input via a DataTransfer. Marketplaces often reject
  // programmatic file drops, so the flow tells the user to drag the exported zip
  // in when photos don't land.
  //
  // US-1877 (AC4): report what ACTUALLY attached — { attached, failed, total }.
  //
  // This used to return a bare boolean, true if ANY photo made it. So 6 of 8 was
  // reported as success: the seller was told the photos were attached, published a
  // listing missing two of them, and only found out from a buyer. The two failures
  // were also invisible — a non-ok fetch was `continue`d silently.
  //
  // The per-fetch timeout is the other half. There was none, so one hung photo
  // request stalled the whole fill indefinitely — and since US-1874 the job's alarm
  // eventually kills it, turning "one slow photo" into "the cross-post timed out"
  // with no clue why.
  var PHOTO_FETCH_TIMEOUT_MS = 15000;

  function fetchWithTimeout(url, timeoutMs) {
    // AbortController rather than Promise.race: race leaves the real request
    // running, so a stalled photo would keep its connection (and the marketplace's
    // rate limit) busy for the rest of the fill.
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    return fetch(url, { credentials: "omit", signal: ctrl.signal })
      .finally(function () { clearTimeout(timer); });
  }

  GT.attachPhotos = async function (fileInputSelector, photoUrls, max) {
    const urls = Array.isArray(photoUrls)
      ? photoUrls.slice(0, max || photoUrls.length)
      : [];
    const result = { attached: 0, failed: 0, total: urls.length };
    try {
      const input = document.querySelector(fileInputSelector);
      if (!input || urls.length === 0) {
        // No input (or nothing to attach) is not a partial failure — there was
        // nothing to do. Reporting failed:N here would nag about a non-problem.
        result.total = 0;
        return result;
      }
      const dt = new DataTransfer();
      for (let i = 0; i < urls.length; i++) {
        try {
          const res = await fetchWithTimeout(urls[i], PHOTO_FETCH_TIMEOUT_MS);
          if (!res.ok) {
            result.failed += 1;
            continue;
          }
          const blob = await res.blob();
          const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
          const name = String(i + 1).padStart(2, "0") + "." + ext;
          dt.items.add(new File([blob], name, { type: blob.type || "image/jpeg" }));
          result.attached += 1;
        } catch (_e) {
          // Timeout or network error on THIS photo only — keep going. One bad
          // photo must not cost the seller the other seven.
          result.failed += 1;
        }
      }
      if (dt.files.length === 0) return result;
      Object.defineProperty(input, "files", { value: dt.files, configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return result;
    } catch (_e) {
      // The marketplace rejected the programmatic drop outright — nothing landed.
      return { attached: 0, failed: urls.length, total: urls.length };
    }
  };

  // Build the success/failure result envelope the background worker expects.
  GT.result = function (jobId, partial) {
    return Object.assign({ type: "GT_LISTER_RESULT", jobId: jobId }, partial);
  };

  // US-1885 AC5: a small on-page banner so a form filling itself is never
  // unexplained. Shown once the form is confirmed present + we start filling;
  // the seller dismisses it (or it clears when they navigate away).
  GT.BANNER_ID = "gt-lister-banner";
  GT.showBanner = function (text) {
    try {
      var existing = document.getElementById(GT.BANNER_ID);
      if (existing) existing.remove();
      var bar = document.createElement("div");
      bar.id = GT.BANNER_ID;
      bar.setAttribute("dir", "ltr");
      bar.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
        "background:#0F3460;color:#fff;font:600 13px/1.4 Inter,system-ui,sans-serif;" +
        "padding:10px 16px;display:flex;align-items:center;gap:12px;" +
        "box-shadow:0 2px 8px rgba(0,0,0,.25)";
      var msg = document.createElement("span");
      msg.style.cssText = "flex:1";
      msg.textContent = text;
      var close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "×"; // ×
      close.style.cssText =
        "background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer;line-height:1";
      close.addEventListener("click", function () { bar.remove(); });
      bar.appendChild(msg);
      bar.appendChild(close);
      (document.body || document.documentElement).appendChild(bar);
    } catch (_e) { /* banner is best-effort — never block the fill */ }
  };

  // Generic fill flow shared by every platform. Returns a result `partial`:
  //   { ok:true, listingUrl }                 — filled (+ submitted if asked)
  //   { ok:false, manual:true, error, version } — degraded; user lists manually
  // The platform script decides whether to auto-submit; by default we fill and
  // leave the seller to review + click the platform's own List button, then we
  // read the resulting URL.
  GT.runFlow = async function (flow, payload, opts) {
    opts = opts || {};
    if (!flow || !flow.enabled) {
      return {
        ok: false,
        manual: true,
        error: (payload.platformLabel || payload.platform) +
          " automation isn't enabled yet — please list manually for now.",
        version: flow && flow.version,
      };
    }

    const missing = await GT.probe(flow);
    if (missing.length > 0) {
      // FAIL LOUDLY (AC5): the form changed under us. Do NOT half-fill.
      return {
        ok: false,
        manual: true,
        error:
          payload.platformLabel + "'s listing form changed (selector v" +
          flow.version + " can't find: " + missing.join(", ") +
          "). Please list manually — the GradeThread Lister needs an update.",
        version: flow.version,
      };
    }

    // US-1885 AC5: explain the auto-fill on the page before we touch the form.
    GT.showBanner(
      "GradeThread is prefilling this " + (payload.platformLabel || payload.platform) +
        " listing — review the form, then click List.",
    );

    const f = flow.fields;
    GT.fill(f.title, payload.title);
    GT.fill(f.description, payload.description);
    if (f.price) GT.fill(f.price, payload.price);
    if (f.originalPrice && payload.originalPrice) {
      GT.fill(f.originalPrice, payload.originalPrice);
    }

    // US-1877 (AC4): carry the real counts, not a boolean. photosAttached stays for
    // the existing consumers, but it is now only true when EVERY photo landed —
    // "some of them" must never read as "attached".
    const photos = f.photoInput
      ? await GT.attachPhotos(f.photoInput, payload.photoUrls, payload.maxPhotos)
      : { attached: 0, failed: 0, total: 0 };
    const photosAttached = photos.total > 0 && photos.failed === 0;

    GT.log("filled " + payload.platform + " form (photos " +
      photos.attached + "/" + photos.total + " attached)");

    // We deliberately do NOT auto-submit by default: category/size/condition
    // pickers vary too much to set safely, and the seller is responsible for a
    // final review (clickwrap). We mark the title field so it's obvious the
    // form was prefilled, then report a "filled" result.
    return {
      ok: true,
      filled: true,
      photosAttached: photosAttached,
      // AC4: the counts the SaaS renders as "attached 6 of 8 — drag the rest in".
      photosTotal: photos.total,
      photosFailed: photos.failed,
      // The listing URL only exists after the seller submits; the SaaS records
      // the cross-listing from the "filled" signal and the seller can paste the
      // final URL later. If the platform navigates to the live listing in this
      // tab, GT.captureListingUrl picks it up.
      listingUrl: null,
      version: flow.version,
    };
  };

  // US-717: end a live listing on the marketplace (cross-listing auto-delist
  // after the item sold elsewhere). Same fail-loud contract as runFlow — probe
  // the required controls first, never guess. Returns:
  //   { ok:true, delisted:true, version }            — ended on the marketplace
  //   { ok:false, manual:true, error, version }       — degraded; end it manually
  GT.runDelistFlow = async function (delistFlow, payload) {
    const label = payload.platformLabel || payload.platform;
    if (!delistFlow || !delistFlow.enabled) {
      return {
        ok: false,
        manual: true,
        error: label +
          " auto-delist isn't enabled yet — please end this listing manually on " +
          label + ".",
        version: delistFlow && delistFlow.version,
      };
    }

    // US-1875 AC1: probe in INTERACTION ORDER.
    //
    // The old probe required `remove` to be in the DOM before anything was clicked
    // — but `remove` lives INSIDE the overflow menu and only exists once the menu is
    // open. So the required set could essentially never be satisfied, and the
    // shipped-enabled Poshmark flow bailed out at the probe on every run, reporting
    // a selector break on a page that was working fine.
    //
    // Only `menu` can exist pre-interaction, so only `menu` is probed up front;
    // everything downstream is validated at the point it is supposed to appear.
    const missing = await GT.probe({
      required: delistFlow.required,
      fields: { menu: delistFlow.menu, remove: delistFlow.remove },
      submit: delistFlow.confirm,
    });
    if (missing.length > 0) {
      return {
        ok: false,
        manual: true,
        error: label + "'s page changed (delist selector v" + delistFlow.version +
          " can't find: " + missing.join(", ") +
          "). Please end the listing manually — the GradeThread Lister needs an update.",
        version: delistFlow.version,
      };
    }

    // Per-platform wait tuning, defaulted. Config-driven like everything else in
    // the selectors file — a marketplace that renders its confirm dialog slowly can
    // be given more room without touching this code (and the DOM fixture tests can
    // exercise the real timeout branches without sleeping for 8 seconds).
    const t = delistFlow.timeouts || {};
    const controlMs = typeof t.control === "number" ? t.control : 6000;
    const verifyMs = typeof t.verify === "number" ? t.verify : 8000;

    const startUrl = location.href;
    // Snapshot the "gone" witness BEFORE we touch anything. Its disappearance is
    // only evidence if it was actually there to begin with — see verifyDelist.
    const goneWasPresent = Boolean(
      delistFlow.verify && delistFlow.verify.gone &&
      document.querySelector(delistFlow.verify.gone),
    );

    const menu = document.querySelector(delistFlow.menu);
    if (!menu) {
      return {
        ok: false,
        manual: true,
        error: label + "'s listing menu didn't open — end the listing manually.",
        version: delistFlow.version,
      };
    }
    menu.click();

    const remove = await GT.waitFor(delistFlow.remove, controlMs);
    if (!remove) {
      return {
        ok: false,
        manual: true,
        error: label + " delete control didn't appear — end the listing manually.",
        version: delistFlow.version,
      };
    }
    remove.click();

    if (delistFlow.confirm) {
      const confirm = await GT.waitFor(delistFlow.confirm, controlMs);
      if (!confirm) {
        // We clicked delete and the confirmation never rendered, so we genuinely do
        // not know whether it took. Report unverified — see the note below on why
        // guessing here is the expensive mistake.
        return {
          ok: false,
          manual: true,
          unverified: true,
          error: label + " didn't show the delete confirmation, so GradeThread " +
            "couldn't confirm the listing ended. Check " + label + " and end it manually.",
          version: delistFlow.version,
        };
      }
      confirm.click();
    }

    // US-1875 AC2: VERIFY, don't assume.
    //
    // This is the most expensive bug in the product. The old code returned
    // ok:true/delisted:true the instant it had clicked confirm — it never checked
    // that anything happened. A click that silently no-ops (stale selector matching
    // the wrong button, an error toast, a slow request that fails) reported SUCCESS,
    // GradeThread cleared the pending-delist stamp, and the item stayed live on a
    // marketplace after it had already sold elsewhere. That is a double sale: the
    // seller owes an item they no longer have, and eats the defect.
    //
    // So success now requires positive evidence, and the absence of evidence is
    // reported as ok:false + unverified:true — which deliberately does NOT clear the
    // US-1629 pending-delist stamp, leaving the double-sale protection armed. A
    // false "please double-check" costs the seller ten seconds; a false "delisted"
    // costs them the sale.
    const evidence = await GT.verifyDelist(
      delistFlow,
      { startUrl: startUrl, goneWasPresent: goneWasPresent },
      verifyMs,
    );
    if (!evidence) {
      return {
        ok: false,
        manual: true,
        unverified: true,
        error: "GradeThread clicked delete on " + label + " but couldn't confirm the " +
          "listing actually ended. Check " + label + " and end it manually if it's still live.",
        version: delistFlow.version,
      };
    }

    GT.log("delist verified on " + payload.platform + " via " + evidence);
    return { ok: true, delisted: true, verifiedBy: evidence, version: delistFlow.version };
  };

  // US-1875 AC2: watch for positive proof that the delete took effect. Returns the
  // NAME of the evidence found (for diagnostics), or null if none arrived in time.
  //
  // Three independent signals, because the marketplaces differ and any one of them
  // is sufficient proof:
  //   • navigated  — the page left the listing URL (Poshmark bounces to the closet).
  //   • gone       — a control that only exists on a LIVE listing disappeared.
  //   • toast      — the marketplace rendered its own success confirmation.
  GT.verifyDelist = function (delistFlow, ctx, timeoutMs) {
    const v = delistFlow.verify || {};
    const startUrl = ctx && ctx.startUrl;
    // CRITICAL: the `gone` signal is only admissible if the witness was present
    // BEFORE we started. Otherwise a selector that never matched anything — a stale
    // one, say, which is exactly the case we are trying to catch — would be "absent"
    // on the first tick and rubber-stamp every single delete as verified. That would
    // rebuild the false-success bug inside the very check meant to prevent it.
    const goneAdmissible = Boolean(v.gone) && Boolean(ctx && ctx.goneWasPresent);
    const deadline = Date.now() + (timeoutMs || 8000);
    return new Promise(function (resolve) {
      const tick = function () {
        try {
          if (v.urlChanged !== false && startUrl && location.href !== startUrl) {
            return resolve("navigated");
          }
          if (v.toast && document.querySelector(v.toast)) return resolve("toast");
          if (goneAdmissible && !document.querySelector(v.gone)) return resolve("gone");
        } catch (_e) { /* keep polling */ }
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, 200);
      };
      tick();
    });
  };

  // US-1875 AC3: run a queued job for one platform. Shared by poshmark.js /
  // mercari.js / grailed.js, which were three byte-identical copies of this — the
  // login-wall rule is exactly the kind of thing that rots when it has to be fixed
  // in triplicate.
  //
  // THE JOB-CONSUMPTION RULE. Sending GT_LISTER_RESULT is what ENDS a job. So a
  // login wall must NOT send one: the seller has done nothing wrong, the page just
  // isn't the page we were sent to, and the work is still pending. We push a
  // non-terminal NOTICE instead (which also extends the job's deadline, since
  // logging in takes longer than the 120s job timeout), leave the job open, and let
  // the content script re-injected on the post-login page pick it straight back up.
  GT.runJobForPlatform = async function (sel, platformKey, label, job) {
    if (!job || job.platform !== platformKey) return;
    const cfg = sel[platformKey];
    if (!cfg) return;
    const payload = Object.assign(
      { platform: platformKey, platformLabel: label },
      job.payload,
    );

    if (GT.isLoginWall(cfg.login)) {
      GT.log(platformKey + ": login wall — leaving the job queued");
      GT.showBanner(
        "Log in to " + label + " — GradeThread will finish this automatically once you're in.",
      );
      try {
        chrome.runtime.sendMessage({
          type: "GT_LISTER_NOTICE",
          jobId: job.jobId,
          notice: {
            loginWall: true,
            platform: platformKey,
            error: "Log in to " + label + " and this will retry automatically.",
          },
        });
      } catch (_e) { /* worker asleep — the job is still queued either way */ }
      return; // deliberately NO GT_LISTER_RESULT: the job stays pending.
    }

    let partial;
    try {
      partial = job.kind === "delist"
        ? await GT.runDelistFlow(cfg.delist, payload)
        : await GT.runFlow(cfg, payload, { autoSubmit: false });
    } catch (err) {
      partial = {
        ok: false,
        manual: true,
        error: label + " " + (job.kind === "delist" ? "delist" : "listing") +
          " failed: " + (err && err.message ? err.message : String(err)),
        version: cfg.version,
      };
    }
    try {
      chrome.runtime.sendMessage(GT.result(job.jobId, partial));
    } catch (_e) { /* the background's push/alarm still reports the job */ }
  };

  self.GTLister = GT;
})();
