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

  // Send to the background and swallow BOTH ways it can fail.
  //
  // The try/catch these calls used to carry was written for a throwing
  // sendMessage and does not catch what MV3 actually does: with no callback it
  // returns a PROMISE, and a sleeping worker REJECTS it. A synchronous catch
  // never sees that, so every fill on a page whose worker had gone to sleep
  // printed "Uncaught (in promise) Error: Could not establish connection.
  // Receiving end does not exist." into the marketplace's console — seen live
  // on poshmark.com/create-listing 2026-08-20.
  //
  // Noise is the smaller half. The same pattern wraps the RESULT delivery, so a
  // genuinely undelivered result looked identical to a log line nobody reads.
  GT.tell = function (message) {
    try {
      var p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(function () { /* asleep */ });
    } catch (_e) {
      /* background may be asleep; every caller here is best-effort */
    }
  };

  GT.log = function (msg) {
    GT.tell({ type: "GT_LISTER_LOG", message: String(msg) });
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
    // US-2775: `unverified` is a SUBSET of `attached`, not a fourth bucket —
    // attached + failed still equals total. It counts photos the page took only
    // through the shadow fallback, where nothing outside this extension has
    // confirmed they landed.
    const result = { attached: 0, failed: 0, total: urls.length, unverified: 0 };
    try {
      const input = document.querySelector(fileInputSelector);
      if (!input || urls.length === 0) {
        // No input (or nothing to attach) is not a partial failure — there was
        // nothing to do. Reporting failed:N here would nag about a non-problem.
        result.total = 0;
        return result;
      }
      // 2026-08-20: fetched CONCURRENTLY, and the reason is the worst case
      // rather than the average one. These ran in a serial `for` loop, each with
      // its own 15s timeout, so a dozen photos on a slow connection could spend
      // three minutes here — longer than the job's own deadline, which turned
      // "the photos were slow" into "the cross-post timed out" with no clue why.
      // The requests are independent, so the whole set is now bounded by ONE
      // timeout instead of their sum. Same reasoning as the concurrent probe.
      //
      // ORDER IS PRESERVED, and it matters: the first photo is the seller's
      // cover image. Promise.all resolves positionally, so the results are
      // indexed exactly as the urls were and the DataTransfer is built in that
      // order afterwards — never in completion order.
      const blobs = await Promise.all(urls.map(async function (url) {
        try {
          const res = await fetchWithTimeout(url, PHOTO_FETCH_TIMEOUT_MS);
          if (!res.ok) return null;
          return await res.blob();
        } catch (_e) {
          // Timeout or network error on THIS photo only — keep going. One bad
          // photo must not cost the seller the other seven.
          return null;
        }
      }));

      const dt = new DataTransfer();
      for (let i = 0; i < blobs.length; i++) {
        const blob = blobs[i];
        if (!blob) {
          result.failed += 1;
          continue;
        }
        const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const name = String(i + 1).padStart(2, "0") + "." + ext;
        dt.items.add(new File([blob], name, { type: blob.type || "image/jpeg" }));
        result.attached += 1;
      }
      if (dt.files.length === 0) return result;

      // 2026-08-20: ASSIGN the FileList, do not shadow it — and then check that
      // the BROWSER accepted it.
      //
      // This used Object.defineProperty to hang a `files` value off the element.
      // That shadows the prototype getter, so anything reading el.files sees the
      // list, but the input's REAL state never changes: `el.value` stays empty,
      // no internal file selection exists, and an uploader that checks value —
      // or reads the selection at submit time rather than from the event — sees
      // an empty input. The result was the worst kind of failure: every count
      // said 8 of 8 attached, the seller was told the photos were on, and
      // Poshmark had nothing.
      //
      // Chrome accepts a direct assignment from a DataTransfer, which sets the
      // real selection and populates `value` with a fake path. That non-empty
      // `value` is the browser confirming it took, which is a witness we did not
      // write ourselves. defineProperty stays as a fallback for any host that
      // refuses the assignment — reported honestly rather than assumed.
      let accepted = false;
      try {
        input.files = dt.files;
        accepted = input.files && input.files.length === dt.files.length &&
          typeof input.value === "string" && input.value !== "";
      } catch (_e) {
        accepted = false;
      }
      if (!accepted) {
        // US-2775: the fallback shadow, reported as UNVERIFIED rather than as
        // attached.
        //
        // This used to decide acceptance with
        // `input.files.length === dt.files.length` immediately after
        // defineProperty had WRITTEN input.files — reading back exactly what the
        // line above set, so it could not fail. A guard that confirms itself,
        // and it re-created the very silent success US-2738 removed: el.files
        // reports eight, el.value stays empty, an uploader reading the real
        // selection at submit time sees nothing, and the seller is told the
        // photos are on.
        //
        // Three states, not two. Flipping this to FAILED would raise a false
        // alarm on the hosts where the shadow genuinely works, across seven
        // platforms. Saying "we could not confirm" is the only reading that is
        // true on both kinds of host: the photos may well be there, and nothing
        // outside this extension has said so.
        try {
          Object.defineProperty(input, "files", { value: dt.files, configurable: true });
          if (input.files && input.files.length === dt.files.length) {
            accepted = true;
            result.unverified = result.attached;
            GT.log("photo list set by shadow on " + (input.id || "the uploader") +
              " — the browser did not confirm it");
          }
        } catch (_e) { /* nothing more to try */ }
      }

      // Some uploaders listen for `input`, some for `change`. Both, in the order
      // a real selection fires them.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      if (!accepted) {
        // We fetched them and the page would not take them. That is a failure of
        // every photo, and it must read as one — this is exactly the case that
        // used to report a clean success.
        GT.log("photo input refused the file list on " + (input.id || "the uploader"));
        result.failed += result.attached;
        result.attached = 0;
      }
      return result;
    } catch (_e) {
      // The marketplace rejected the programmatic drop outright — nothing landed.
      return { attached: 0, failed: urls.length, total: urls.length, unverified: 0 };
    }
  };

  // US-2737: commit a chip/token field, one entry at a time.
  //
  // A tag box is not a text box. Setting its value TYPES the word and stops
  // there — the tag only exists once Enter turns it into a chip. Filling it the
  // ordinary way leaves uncommitted text in a field that looks finished, which
  // is why `tags` was declared but not filled until now.
  //
  // WITNESSED BY THE FIELD ITSELF. A committed chip clears the input, so the
  // input going empty is the site telling us it accepted the entry. Nothing is
  // counted that we cannot see land, and an entry that does not clear stops the
  // loop rather than typing the next word on top of it.
  GT.commitTags = async function (selector, tags, max) {
    const out = { committed: 0, total: 0 };
    if (!selector || !Array.isArray(tags) || tags.length === 0) return out;
    const input = document.querySelector(selector);
    if (!input) return out;

    // The marketplace's own cap, not ours. Poshmark says "Add up to 3 tags";
    // pushing a fourth is a rejected keystroke at best.
    const wanted = tags.filter(function (t) { return t && String(t).trim(); })
      .slice(0, max || tags.length);
    out.total = wanted.length;

    for (let i = 0; i < wanted.length; i++) {
      const tag = String(wanted[i]).trim();
      if (!GT.setValue(input, tag)) break;
      ["keydown", "keypress", "keyup"].forEach(function (type) {
        input.dispatchEvent(new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }));
      });
      // Give the framework a tick to turn the text into a chip.
      await new Promise(function (r) { setTimeout(r, 150); });
      if (input.value !== "") {
        // It did not take. Stop: another word typed on top of this one would
        // concatenate into a single nonsense tag.
        GT.log("tag not committed (input did not clear) — stopping after " +
          out.committed);
        break;
      }
      out.committed += 1;
    }
    return out;
  };

  // US-2735: open a marketplace's price dialog and fill it.
  //
  // Poshmark keeps both amounts in `listing-price-suggestion-modal` rather than
  // on the create form, which is why every price selector missed and why the
  // seller was told "we could not set the price" on every cross-post.
  //
  // THREE RULES, and they are what keep a click safe:
  //   1. It opens a dialog. It never submits, and there is no path here that
  //      could — the only elements touched are the opener and the two inputs.
  //   2. Every step is optional. No opener, no dialog, or no price input and we
  //      return false, which reports the price as unfilled exactly as before.
  //      Nothing about this can make a run worse than not having it.
  //   3. The dialog is left OPEN on success, on purpose. Poshmark commits the
  //      amount through its own Apply control, and clicking that for the seller
  //      would be us deciding the price is right. Leaving it open puts the
  //      number in front of them at the moment they can still change it.
  // Is this element actually IN the dialog, or does it just answer to the same
  // selector?
  //
  // US-2739 (2026-08-21): the already-open check below is `querySelector(
  // cfg.price)`, and Poshmark's cfg.price ends in a bare
  // `input[aria-label="Listing Price"]` clause. A create-form control carrying
  // that same label matches it with no dialog open anywhere — so the check said
  // "already open", the modal was never opened, the value went into the opener,
  // and the run reported the price FILLED. A silent wrong success, which is the
  // worst of the three outcomes: the seller is told the price is set, sees a
  // blank Listing price, and has no reason to connect the two.
  //
  // The modal's own inputs are id-anchored, so they answer for themselves.
  // Anything else has to prove it by sitting inside a dialog container. When
  // neither holds we fall through and click the opener, which is exactly what
  // this function did before the already-open check existed.
  GT.inPriceDialog = function (el) {
    if (!el) return false;
    if (typeof el.id === "string" && el.id.indexOf("modal") !== -1) return true;
    if (typeof el.closest !== "function") return false;
    return !!el.closest('[role="dialog"], [aria-modal="true"], .modal');
  };

  GT.fillPriceDialog = async function (cfg, payload) {
    if (!cfg || !cfg.price) return false;
    try {
      // ALREADY OPEN? Then do not click anything.
      //
      // A dialog renders over a backdrop that swallows clicks, so "click the
      // opener" while one is up either does nothing or lands on the backdrop
      // and DISMISSES the dialog we were about to fill. Checking for the input
      // first is both faster and the only version that cannot close a dialog
      // the seller opened themselves.
      let input = document.querySelector(cfg.price);
      if (input && !GT.inPriceDialog(input)) {
        GT.log("price selector matched outside the dialog — opening it instead");
        input = null;
      }
      if (!input) {
        if (!cfg.open) return false;
        const opener = document.querySelector(cfg.open);
        if (!opener) return false;
        opener.click();
        // Short wait: a dialog that has not rendered in two seconds is not
        // going to, and the seller is watching the form.
        input = await GT.waitFor(cfg.price, 2000);
      }
      if (!input) {
        GT.log("price dialog did not open on " + payload.platform);
        return false;
      }

      // setValue reports that it SET the value, not that the value STUCK. A
      // React-controlled input can reject one and re-render its old contents,
      // and reporting that as filled tells the seller the price is handled when
      // the field is empty. Read it back.
      GT.setValue(input, String(payload.price));
      const filled = String(input.value ?? "") === String(payload.price);
      if (!filled) {
        GT.log("price dialog input did not hold the value on " + payload.platform);
      }
      if (cfg.originalPrice && payload.originalPrice) {
        GT.fill(cfg.originalPrice, payload.originalPrice);
      }
      return filled;
    } catch (_e) {
      // A click that throws is a page we do not understand. Report unfilled.
      return false;
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
  GT.runFlow = async function (flow, payload) {
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

    // US-2730: brand. WITNESSED, like price, and for the same reason — a field
    // we tried and failed to set has to leave a mark rather than quietly not
    // happening. This is the first field beyond title/description the Lister has
    // ever filled on any platform.
    //
    // Only where the flow declares a selector: `f.brand` is undefined on every
    // channel that has not been verified, so nothing is attempted there.
    //
    // NOT a failure when it misses. Poshmark's brand anchor is a placeholder and
    // therefore English-only, so a seller on a localised page gets an unfilled
    // brand and a working prefill — losing the whole cross-post over one field
    // they can type themselves would be the wrong trade.
    const brandFilled = f.brand && payload.brand
      ? GT.fill(f.brand, payload.brand)
      : false;
    if (f.brand && payload.brand && !brandFilled) {
      GT.log("brand NOT filled on " + payload.platform + " (selector matched nothing)");
    }

    // US-2737: tags, committed as chips rather than typed and abandoned.
    // Only where the flow declares the selector, so no other channel is touched.
    const tagResult = f.tags
      ? await GT.commitTags(f.tags, payload.tags, flow.tagsMax)
      : { committed: 0, total: 0 };
    if (tagResult.total > 0 && tagResult.committed < tagResult.total) {
      GT.log("tags: committed " + tagResult.committed + " of " + tagResult.total +
        " on " + payload.platform);
    }

    // 2026-08-11: the price fill is now WITNESSED, not assumed.
    //
    // On Poshmark this returned false on every run and said nothing about it.
    // The price input is not on the create page at all — it lives inside a price
    // dialog the seller opens later — so `f.price` matched nothing, GT.fill
    // no-opped, and the flow reported a clean `filled: true`. The seller saw a
    // prefilled listing and no hint that the one field that decides what they
    // get paid was untouched.
    //
    // Photos already had this treatment (the counts below): a thing we tried and
    // failed to do has to leave a mark. Price is money, so it gets the louder
    // one — the banner is rewritten in place rather than only reported home,
    // because the seller is looking at the form right now and is about to post.
    //
    // This does NOT fail the run. An unfilled price is a form the seller
    // finishes, not a form that changed under us — bailing out would cost them
    // the whole prefill over a field they were going to set anyway.
    // US-2741: where a platform keeps a DIALOG for its price, the form field is
    // not the price — it is a button that looks like one.
    //
    // On Poshmark, setting the create-form input does take: vee-validate reads
    // it and the page flashes an estimated earnings figure ($25.60 on a $32
    // listing, its 20% fee). Then it reverts, because the authoritative value
    // lives in the price dialog and the form field is only a display that opens
    // it. Filling it therefore LOOKS like success — GT.fill returns true, the
    // seller sees a number appear — and leaves the listing priced at nothing.
    //
    // So when a flow declares a priceDialog, that is the price, and the form
    // field is skipped entirely rather than filled and then contradicted.
    const usesPriceDialog = Boolean(flow.priceDialog && flow.priceDialog.price);
    const priceFilled = !usesPriceDialog && f.price
      ? GT.fill(f.price, payload.price)
      : false;
    if (!usesPriceDialog && f.price && !priceFilled) {
      GT.showBanner(
        "GradeThread prefilled this " + (payload.platformLabel || payload.platform) +
          " listing, but it could NOT set the price — enter it yourself before you post.",
      );
      GT.log("price NOT filled on " + payload.platform + " (selector matched nothing)");
    }

    if (f.originalPrice && payload.originalPrice) {
      GT.fill(f.originalPrice, payload.originalPrice);
    }

    // US-2735/US-2742: the price lives behind a dialog on Poshmark, so reach it.
    //
    // BEFORE the photos, and the earlier order was a mistake worth naming. It
    // ran after, on the reasoning that "an open modal sits over the file input"
    // — but attachPhotos never CLICKS anything. It resolves the input with
    // querySelector and assigns `.files`, and an overlay blocks pointer events,
    // not property assignment. So the stated hazard could not happen.
    //
    // The real hazard ran the other way. Poshmark opens its own confirmation
    // modal once photos are attached, and THAT backdrop swallows the click that
    // opens the price dialog — so the price silently never got set, which is
    // exactly what a seller reported: photos confirmed, price blank, no numbers
    // ever flashed.
    //
    // Non-fatal throughout — if the dialog never appears we report the price as
    // unfilled, which is what happened before this existed.
    let dialogPriceFilled = false;
    if (usesPriceDialog && payload.price) {
      dialogPriceFilled = await GT.fillPriceDialog(flow.priceDialog, payload);
      if (dialogPriceFilled) {
        GT.showBanner(
          "GradeThread prefilled this " + (payload.platformLabel || payload.platform) +
            " listing, including the price — review it and post.",
        );
      }
    }
    const anyPriceFilled = priceFilled || dialogPriceFilled;
    if (usesPriceDialog && !dialogPriceFilled && payload.price) {
      // Same loud treatment the form-field miss has had since US-2477. A price
      // we could not set is the one thing the seller must not discover after
      // publishing.
      GT.showBanner(
        "GradeThread prefilled this " + (payload.platformLabel || payload.platform) +
          " listing, but it could NOT set the price — enter it yourself before you post.",
      );
      GT.log("price dialog fill failed on " + payload.platform);
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

    // We NEVER auto-submit, and there is no option to: category/size/condition
    // pickers vary too much to set safely, and the seller is responsible for a
    // final review (clickwrap). We mark the title field so it's obvious the
    // form was prefilled, then report a "filled" result.
    return {
      ok: true,
      filled: true,
      // Same contract as the photo counts: the SaaS renders this, so a price we
      // could not set is visible after the tab is closed, not only while the
      // banner is on screen. A platform with no price field at all (none today)
      // reports false too — "we did not set a price" is true either way.
      priceFilled: anyPriceFilled,
      // US-2730: same contract as priceFilled. `undefined` where the channel
      // declares no brand selector or the draft carries no brand — which must
      // read as "not applicable", never as "we failed", or every unverified
      // channel would report a miss on a field it was never going to try.
      brandFilled: f.brand && payload.brand ? brandFilled : undefined,
      // US-2737: counts, not a boolean — same contract as the photos. "2 of 3"
      // is the difference between a seller fixing it now and finding out later.
      tagsCommitted: tagResult.total > 0 ? tagResult.committed : undefined,
      tagsTotal: tagResult.total > 0 ? tagResult.total : undefined,
      photosAttached: photosAttached,
      // AC4: the counts the SaaS renders as "attached 6 of 8 — drag the rest in".
      photosTotal: photos.total,
      photosFailed: photos.failed,
      // US-2775: how many of the attached ones nothing but us has confirmed.
      // Sent only when it is non-zero, so an ordinary run carries no new field
      // and an older SaaS build reads exactly what it read before.
      photosUnverified: photos.unverified > 0 ? photos.unverified : undefined,
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
    // US-2486: TWO-PAGE DELIST.
    //
    // Poshmark and Grailed keep "delete this listing" on a different page from
    // the listing itself, so `menu` is a LINK rather than a control that opens
    // a panel in place. `navigatesTo` in the config is what says so — its
    // presence changes nothing about the selectors, only about what happens
    // between clicking `menu` and looking for `remove`.
    //
    // The run is therefore split across two documents:
    //   page 1  probe `menu`, click it, record the stage, and STOP — sending no
    //           result, exactly as the login-wall path does, so the job stays
    //           pending instead of being reported as a failure;
    //   page 2  the content script re-injects, asks for its job by tab id, gets
    //           the same one back and sees stage === "navigated". It skips
    //           `menu` entirely and goes straight to `remove`.
    //
    // The stage is one-way, and the destination is checked against
    // `navigatesTo` before anything is clicked on the far side. Between them
    // those two rules are what stop the obvious failure: a job that arrives
    // somewhere unexpected clicking a link that is no longer there, forever.
    const navigatesTo = delistFlow.navigatesTo || null;
    const hasNavigated = payload.stage === "navigated";

    if (navigatesTo && hasNavigated) {
      if (!new RegExp(navigatesTo, "i").test(location.origin + location.pathname)) {
        return {
          ok: false,
          manual: true,
          error: label + " didn't open its listing editor, so GradeThread stopped " +
            "rather than clicking on an unexpected page. Please end the listing manually.",
          version: delistFlow.version,
        };
      }
      const tNav = delistFlow.timeouts || {};
      const navControlMs = typeof tNav.control === "number" ? tNav.control : 6000;
      const navVerifyMs = typeof tNav.verify === "number" ? tNav.verify : 8000;
      const navStartUrl = location.href;
      // Snapshotted BEFORE the click, for the same reason as the single-page
      // path: an absent witness is only evidence if it was ever present.
      const navGoneWasPresent = Boolean(
        delistFlow.verify && delistFlow.verify.gone &&
        document.querySelector(delistFlow.verify.gone),
      );

      const removeAfterNav = await GT.waitFor(delistFlow.remove, navControlMs);
      if (!removeAfterNav) {
        return {
          ok: false,
          manual: true,
          error: label + " delete control didn't appear on the listing editor — " +
            "end the listing manually.",
          version: delistFlow.version,
        };
      }
      removeAfterNav.click();
      if (delistFlow.confirm) {
        const c = await GT.waitFor(delistFlow.confirm, navControlMs);
        if (!c) {
          return {
            ok: false,
            manual: true,
            unverified: true,
            error: label + " didn't show the delete confirmation, so GradeThread " +
              "couldn't confirm the listing ended. Check " + label +
              " and end it manually.",
            version: delistFlow.version,
          };
        }
        c.click();
      }

      const navEvidence = await GT.verifyDelist(
        delistFlow,
        { startUrl: navStartUrl, goneWasPresent: navGoneWasPresent },
        navVerifyMs,
      );
      if (!navEvidence) {
        return {
          ok: false,
          manual: true,
          unverified: true,
          error: "GradeThread clicked delete on " + label + " but couldn't confirm " +
            "the listing actually ended. Check " + label +
            " and end it manually if it's still live.",
          version: delistFlow.version,
        };
      }
      return {
        ok: true,
        delisted: true,
        verifiedBy: navEvidence,
        version: delistFlow.version,
      };
    }

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
    // US-2486: on a two-page channel this click is a NAVIGATION, so record the
    // stage BEFORE following the link. Recording it afterwards would race the
    // page unload — and a lost stage marker is precisely the loop this exists
    // to prevent, since the far page would then think it had never navigated.
    if (navigatesTo) {
      try {
        await Promise.resolve(chrome.runtime.sendMessage({
          type: "GT_LISTER_STAGE",
          jobId: payload.jobId,
          stage: "navigated",
        }));
      } catch (_e) {
        // The worker is asleep or the message failed. Do NOT navigate: without
        // the marker the far page would click a link that is not there, and a
        // delist that fails to report is better than one that loops.
        return {
          ok: false,
          manual: true,
          error: label + " delist couldn't be tracked across its listing editor — " +
            "end the listing manually.",
          version: delistFlow.version,
        };
      }
      menu.click();
      GT.log(payload.platform + ": following the listing editor link; the delist " +
        "continues after the page loads");
      // Deliberately no result: the job stays pending and the content script on
      // the far page finishes it. Same contract as the login wall.
      return { deferred: true };
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
      // US-2486: a two-page delist needs to know WHICH page it is on, and which
      // job to stamp when it follows the link. Assigned last so a payload from
      // the SaaS can never supply either — the stage is ours, not the page's.
      { jobId: job.jobId, stage: job.stage || null },
    );

    if (GT.isLoginWall(cfg.login)) {
      GT.log(platformKey + ": login wall — leaving the job queued");
      GT.showBanner(
        "Log in to " + label + " — GradeThread will finish this automatically once you're in.",
      );
      // worker asleep — the job is still queued either way
      GT.tell({
        type: "GT_LISTER_NOTICE",
        jobId: job.jobId,
        notice: {
          loginWall: true,
          platform: platformKey,
          error: "Log in to " + label + " and this will retry automatically.",
        },
      });
      return; // deliberately NO GT_LISTER_RESULT: the job stays pending.
    }

    let partial;
    try {
      partial = job.kind === "delist"
        ? await GT.runDelistFlow(cfg.delist, payload)
        : await GT.runFlow(cfg, payload);
    } catch (err) {
      partial = {
        ok: false,
        manual: true,
        error: label + " " + (job.kind === "delist" ? "delist" : "listing") +
          " failed: " + (err && err.message ? err.message : String(err)),
        version: cfg.version,
      };
    }
    // US-2486: a deferred run has followed a link and is continuing on the far
    // page. Reporting anything here would end a job that is still working.
    if (partial && partial.deferred) return;

    // The background's push/alarm still reports the job if this never lands.
    GT.tell(GT.result(job.jobId, partial));
  };

  // US-2484: answer the popup's "check this page" request.
  //
  // The one step CI cannot do is loading a marketplace's sell form behind a
  // login and confirming our selectors still resolve. This is that step, minus
  // the devtools session: the popup asks, this replies with a structured report
  // the seller can paste back.
  //
  // Registered per platform script rather than here-and-guessing, because only
  // the platform script knows which config it is running under.
  //
  // The report deliberately carries location.HOST and not location.href — a
  // listing URL contains an item id and, on several marketplaces, a seller
  // handle, and this string is meant to be pasted into a chat.
  //
  // US-2485 adds two things the first round of real reports proved were needed:
  // location.PATHNAME (so the report can say "you are not on the sell form",
  // which was the actual explanation for three of five "everything missing"
  // results) and a candidate collector, so a broken selector comes back with
  // what replaced it instead of another round of guessing.

  /** Attributes safe to echo: site UI chrome, never anything a seller typed. */
  var PROBE_ATTRS = [
    "name", "id", "type", "role", "aria-label", "placeholder",
    "data-testid", "data-test", "data-test-id", "data-et-name", "data-cy", "data-qa",
    // 2026-08-20: the attribute that finally solved Poshmark's price. Its
    // editor is Vue + vee-validate, which stamps every validated field with the
    // site's OWN model name — `data-vv-name="listingPrice"`. Semantic, stable
    // across restyles, and free of English, which is more than any other anchor
    // on that page offered. It was on the element in every earlier report and
    // invisible because this list did not ask for it, so two rounds were spent
    // on placeholder text instead. Still UI chrome, never seller data.
    "data-vv-name", "data-vv-as",
    // US-2485 round two: the first real report came back with a Poshmark title
    // input carrying nothing but a placeholder, which makes for a fragile,
    // English-only selector. `class` is the site's own styling hook and is
    // often the only stable anchor left — it is UI chrome, never seller data.
    "class",
  ];

  var PROBE_SELECTORS = {
    input: "input:not([type=hidden]):not([type=file])",
    textarea: "textarea",
    file: "input[type=file]",
    select: "select",
    // Anchors included: an overflow menu or a "Delete listing" control is as
    // often an <a> as a <button>, and every delist report so far has come back
    // with a dozen header buttons and no listing control.
    button: "button, [role=button], input[type=submit], a[href]",
    any: "input:not([type=hidden]), textarea, select, button, [role=button], a[href]",
  };

  /** Test attributes, in the order sites tend to prefer them. */
  var PROBE_TEST_ATTRS = ["data-et-name", "data-test", "data-testid", "data-test-id"];

  /**
   * Site chrome, excluded from every sweep.
   *
   * THE BUG THIS FIXES (2026-08-10, third round of reports). Three delist
   * reports came back listing search, chat, notifications, cart, log out and the
   * category nav — and then hit the cap. Mercari's list was truncated exactly
   * where the item's own section began, so the controls we were hunting were
   * cut off by the site's own header. The one useful signal was drowned by the
   * one part of the page that is identical everywhere.
   *
   * A listing control is never in the header, so nothing is lost by dropping it.
   */
  var PROBE_CHROME =
    "header, nav, footer, [role=banner], [role=navigation], [role=contentinfo]";

  function inChrome(el) {
    return typeof el.closest === "function" && el.closest(PROBE_CHROME) !== null;
  }

  /**
   * Every distinct test-attribute value on the page, whatever element carries it.
   *
   * This is the list that actually answers "where is the menu". A control we
   * cannot find is usually one whose ELEMENT type we guessed wrong — a div, an
   * anchor, a custom element — but almost every marketplace tags its own
   * controls for its own test suite, so the name is there even when the shape
   * is not. Values only, no elements and no text: a test attribute is a
   * developer's own identifier, never anything a seller typed.
   */
  /**
   * Values that name an ACTION, hoisted to the top of the sweep.
   *
   * Poshmark's listing editor tags all ~150 of its style options — 70s,
   * Activewear, Balletcore, Cottagecore — with `data-et-name`, and they filled
   * the whole budget in document order before the page's own controls were
   * reached. Ranking is the only thing that survives a page like that: a
   * control called "delete" is never crowded out by a content tag again, and
   * document order is preserved inside each group so nothing is reordered
   * arbitrarily.
   */
  // The short words are boundaried on purpose. Bare `no` matches Monochrome and
  // Notifications, bare `end` matches Recommended and Trending — so the very
  // content tags this ranking exists to demote would have been hoisted above
  // the controls instead. A loose ranking is worse than none: it looks like it
  // worked.
  var PROBE_ACTIONISH = new RegExp(
    "delete|remove|destroy|discard|archive|unlist|close|confirm|cancel|submit|" +
      "save|update|publish|edit|menu|option|action|share|offer|follow|" +
      "\\byes\\b|\\bno\\b|\\bend\\b",
    "i",
  );

  function probeTestIds() {
    var hits = [];
    var rest = [];
    var seen = {};
    var nodes = document.querySelectorAll(
      "[data-et-name], [data-test], [data-testid], [data-test-id]",
    );
    for (var i = 0; i < nodes.length; i++) {
      if (inChrome(nodes[i])) continue;
      for (var a = 0; a < PROBE_TEST_ATTRS.length; a++) {
        var v = nodes[i].getAttribute(PROBE_TEST_ATTRS[a]);
        if (!v) continue;
        var sig = PROBE_TEST_ATTRS[a] + "=" + String(v).slice(0, 60);
        if (seen[sig]) continue;
        seen[sig] = true;
        (PROBE_ACTIONISH.test(v) ? hits : rest).push(sig);
      }
    }
    return hits.concat(rest).slice(0, 120);
  }

  // ── Watching for something that does not stay ─────────────────────────────
  //
  // WHY THIS EXISTS (US-2487). A success toast is the one control that cannot
  // be described by looking at a page. Poshmark's "Shared" banner is gone in a
  // couple of seconds, and the only way to catch it by hand is to share a
  // listing, open the popup, tick a box and press a button inside that window.
  // We asked for that four times and got four reports of a page it had already
  // left — which is not the seller being careless, it is the wrong instrument.
  //
  // So: arm a watcher, go and do the thing, come back. The observer records
  // what APPEARED while it ran, and the next report includes it. The seller's
  // hands are free during the only moment that matters.
  //
  // Same privacy rule as everywhere else in this file, and it matters more
  // here: a toast contains a SENTENCE, and that sentence can name a buyer or a
  // listing. So a watched node is described by its attribute signature only —
  // never its text, not even for buttons. `WATCH_MS` is short and the watcher
  // disarms itself; nothing observes a marketplace page in the background.
  // 60s, raised from 25s once a real run showed the shape of the job: the
  // seller has to press Watch, close the popup, complete a flow that is itself
  // several clicks, then re-open the popup. 25 seconds captured the share modal
  // opening and ran out before the confirmation.
  var WATCH_MS = 60000;
  // Raised with the inner cap: one modal can legitimately account for twenty
  // signatures, and two modals in sequence is the flow we are trying to see.
  var WATCH_MAX = 90;
  var watched = [];
  var watchUntil = 0;
  var watchObserver = null;

  // A banner that is TOGGLED rather than inserted.
  //
  // The first watcher assumed a toast is a new node. Plenty are, but plenty
  // more are a permanent element whose class flips — and that produces no
  // childList record at all, so the watcher would sit through the exact moment
  // it was armed for and report nothing. Attribute changes are watched too,
  // narrowed to class values that look like a banner: watching every class
  // change on a marketplace SPA is thousands of records a second.
  var WATCH_BANNERISH = /toast|snack|banner|alert|notif|flash|message--|--show|--visible|is-open/i;

  function watchSignature(el) {
    if (!el || el.nodeType !== 1 || inChrome(el)) return null;
    var sig = el.tagName.toLowerCase();
    var described = false;
    PROBE_ATTRS.forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a);
      // `id` is skipped: a toast's id is generated per toast, so keeping it
      // would make every appearance unique and defeat the dedupe.
      if (!v || a === "id") return;
      sig += "[" + a + "=\"" + String(v).slice(0, 60) + "\"]";
      described = true;
    });
    return described ? sig : null;
  }

  function startWatch() {
    watched = [];
    watchUntil = Date.now() + WATCH_MS;
    if (watchObserver) watchObserver.disconnect();
    var seen = {};
    watchObserver = new MutationObserver(function (records) {
      if (Date.now() > watchUntil) { watchObserver.disconnect(); watchObserver = null; return; }
      for (var i = 0; i < records.length && watched.length < WATCH_MAX; i++) {
        // A toggled banner: an element that was already there whose class just
        // became banner-shaped. No node was added, so childList sees nothing.
        if (records[i].type === "attributes") {
          var t = records[i].target;
          var cls = (t && t.getAttribute && t.getAttribute("class")) || "";
          if (!WATCH_BANNERISH.test(cls) || inChrome(t)) continue;
          var tsig = watchSignature(t);
          if (tsig && !seen["~" + tsig]) {
            seen["~" + tsig] = true;
            watched.push(tsig + "   (class changed — a toggled banner)");
          }
          continue;
        }
        var added = records[i].addedNodes || [];
        for (var j = 0; j < added.length && watched.length < WATCH_MAX; j++) {
          var el = added[j];
          if (!el || el.nodeType !== 1) continue;
          // The node itself, plus anything under it carrying a test attribute —
          // a toast is usually a wrapper with the interesting name inside.
          // 2026-08-11: this used to look only for test attributes inside an
          // added node, capped at 8. Poshmark's SECOND share modal — the one
          // holding "To My Followers" — came back as four empty wrappers,
          // because its options carry classes and no test attribute, and
          // nothing without one was ever considered.
          //
          // So interactive elements count too, and the cap is 25. The thing we
          // are hunting is by definition a control, and a control with no test
          // id is the normal case on most of the web.
          var candidates = [el];
          if (el.querySelectorAll) {
            var inner = el.querySelectorAll(
              "[data-et-name], [data-test], [data-testid], [data-test-id], " +
                "[role=alert], [role=status], button, a[href], [role=button]",
            );
            for (var k = 0; k < inner.length && k < 25; k++) candidates.push(inner[k]);
          }
          for (var c = 0; c < candidates.length && watched.length < WATCH_MAX; c++) {
            var sig = watchSignature(candidates[c]);
            if (!sig || seen[sig]) continue;
            seen[sig] = true;
            watched.push(sig);
          }
        }
      }
    });
    watchObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    setTimeout(function () {
      if (watchObserver) { watchObserver.disconnect(); watchObserver = null; }
    }, WATCH_MS);
    return WATCH_MS;
  }

  /**
   * Describe up to 30 controls of one kind as attribute signatures.
   *
   * 30 rather than the 12 this started at: the sweep exists to name the control
   * that replaced a broken selector, and on a marketplace page the answer sat
   * past the twelfth row more often than not — a Grailed listing filled the
   * first eleven with the follow-heart on each related listing.
   *
   * `value` is never read — that is the seller's listing. A button's own label
   * IS read, capped, because "which button is Publish" is unanswerable without
   * it and the label is the site's word, not the seller's.
   */
  function probeCandidates(kind) {
    if (kind === "testids") return probeTestIds();
    var sel = PROBE_SELECTORS[kind] || PROBE_SELECTORS.any;
    var nodes = Array.prototype.slice.call(document.querySelectorAll(sel), 0, 400);
    var out = [];
    var seen = {};
    nodes.forEach(function (el) {
      if (out.length >= 30) return;
      // A control the seller cannot see is not the one we are looking for.
      if (el.offsetParent === null && el.type !== "file") return;
      // Nor is anything in the site's header, nav or footer — see PROBE_CHROME.
      if (inChrome(el)) return;
      var sig = el.tagName.toLowerCase();
      // The dedupe key drops `id`, because a REPEATED control differs only by
      // id — and repeated controls are the flood that hides the one that
      // matters. A Grailed listing page filled 11 of 20 slots with the
      // follow-heart on each related listing, identical but for `fr101251474`
      // and friends, and the page's own Delete button never made the cut.
      var dedupe = el.tagName.toLowerCase();
      PROBE_ATTRS.forEach(function (a) {
        var v = el.getAttribute && el.getAttribute(a);
        if (!v) return;
        var part = "[" + a + "=\"" + String(v).slice(0, 60) + "\"]";
        sig += part;
        if (a !== "id") dedupe += part;
      });
      var isButton = sig.indexOf("button") === 0 ||
        (el.getAttribute && el.getAttribute("role") === "button");
      if (isButton) {
        var label = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
        if (label) { sig += " \"" + label + "\""; dedupe += " \"" + label + "\""; }
      }
      // An element described by its id ALONE keeps that id in the key: dropping
      // it would collapse every such element into one line, which is the same
      // information loss in the other direction.
      if (dedupe === el.tagName.toLowerCase()) dedupe = sig;
      if (sig === el.tagName.toLowerCase() || seen[dedupe]) return;
      seen[dedupe] = true;
      out.push(sig);
    });
    return out;
  }

  GT.registerProbe = function (sel, platformKey) {
    try {
      chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
        if (msg && msg.type === "GT_LISTER_WATCH") {
          if (msg.platform && msg.platform !== platformKey) return false;
          sendResponse({ ok: true, ms: startWatch() });
          return false;
        }
        if (!msg || msg.type !== "GT_LISTER_PROBE") return false;
        if (msg.platform && msg.platform !== platformKey) return false;
        var PROBE = self.GT_SELECTOR_PROBE;
        if (!PROBE) {
          sendResponse({ ok: false, error: "selector-probe.js did not load" });
          return false;
        }
        var report = PROBE.buildProbeReport(
          sel,
          platformKey,
          function (selector) { return Boolean(document.querySelector(selector)); },
          {
            host: location.host,
            // origin + pathname, never `href`: the query string is the part
            // that carries session-shaped junk, and no URL pattern needs it.
            origin: location.origin,
            path: location.pathname,
            candidates: probeCandidates,
            // Set by the popup's "I have already opened the menu" checkbox.
            deep: Boolean(msg.deep),
            // Whatever the watcher saw appear, if one was armed (US-2487).
            appeared: watched.slice(0),
            at: new Date().toISOString().slice(0, 10),
          },
        );
        sendResponse({
          ok: true,
          report: report,
          text: PROBE.formatProbeReport(report),
          clean: PROBE.reportIsClean(report),
        });
        return false;
      });
    } catch (_e) {
      // No runtime messaging on this page — the popup reports "couldn't reach
      // the page", which is the honest answer.
    }
  };

  self.GTLister = GT;
})();
