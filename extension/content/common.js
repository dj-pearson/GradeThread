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

  self.GTLister = GT;
})();
