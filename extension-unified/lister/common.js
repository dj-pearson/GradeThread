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
  GT.probe = async function (flow) {
    const missing = [];
    for (const key of flow.required) {
      const selector = key === "submit" ? flow.submit : flow.fields[key];
      if (!selector) {
        missing.push(key);
        continue;
      }
      const el = await GT.waitFor(selector, 6000);
      if (!el) missing.push(key);
    }
    return missing;
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

  // Best-effort: download the (public, EXIF-stripped) item photos and inject
  // them into the form's file input via a DataTransfer. Marketplaces often
  // reject programmatic file drops; on any failure we resolve false so the flow
  // tells the user to drag the exported zip in manually.
  GT.attachPhotos = async function (fileInputSelector, photoUrls, max) {
    try {
      const input = document.querySelector(fileInputSelector);
      if (!input || !Array.isArray(photoUrls) || photoUrls.length === 0) return false;
      const dt = new DataTransfer();
      const urls = photoUrls.slice(0, max || photoUrls.length);
      for (let i = 0; i < urls.length; i++) {
        const res = await fetch(urls[i], { credentials: "omit" });
        if (!res.ok) continue;
        const blob = await res.blob();
        const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const name = String(i + 1).padStart(2, "0") + "." + ext;
        dt.items.add(new File([blob], name, { type: blob.type || "image/jpeg" }));
      }
      if (dt.files.length === 0) return false;
      Object.defineProperty(input, "files", { value: dt.files, configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (_e) {
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

    const photosAttached = f.photoInput
      ? await GT.attachPhotos(f.photoInput, payload.photoUrls, payload.maxPhotos)
      : false;

    GT.log("filled " + payload.platform + " form (photos " +
      (photosAttached ? "attached" : "manual") + ")");

    // We deliberately do NOT auto-submit by default: category/size/condition
    // pickers vary too much to set safely, and the seller is responsible for a
    // final review (clickwrap). We mark the title field so it's obvious the
    // form was prefilled, then report a "filled" result.
    return {
      ok: true,
      filled: true,
      photosAttached: photosAttached,
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

    const menu = document.querySelector(delistFlow.menu);
    if (menu) menu.click();
    const remove = await GT.waitFor(delistFlow.remove, 6000);
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
      const confirm = await GT.waitFor(delistFlow.confirm, 6000);
      if (confirm) confirm.click();
    }
    GT.log("requested delist on " + payload.platform);
    return { ok: true, delisted: true, version: delistFlow.version };
  };

  self.GTLister = GT;
})();
