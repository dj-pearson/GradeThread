// GradeThread Condition Check — eBay content script (US-1755)
//
// Detects an eBay item page, extracts the listing's gallery image URLs (+ title
// and brand for context), and renders a NON-INTRUSIVE overlay that, on demand,
// asks the background worker to grade the photos via the public
// /api/grading/public/grade-from-url endpoint and shows the GradeThread
// condition read inline (score + tier + confidence + full-report link).
//
// Why click-to-grade (not auto on load): each read spends a Vision call and the
// public endpoint is quota-capped (20/IP/hr). Auto-firing on every eBay page an
// active shopper opens would burn the quota in minutes and cost real money for
// pages the buyer never cared about. So the default is a small launcher pill the
// buyer clicks; an opt-in "auto-run" setting exists in the popup for power users.
//
// Resilience (AC): every selector comes from a config that is bundled
// (selectors.js) AND remotely updatable (background merges the hosted override).
// If no gallery images resolve, the overlay says so plainly — it never grades an
// empty set or guesses at the DOM.

(function () {
  "use strict";

  const IMG = self.GT_EBAY_IMAGE; // pure helpers (content/ebay-image.cjs)
  const DEFAULT_CFG = self.GT_CC_SELECTORS; // bundled default (selectors.js)
  const MAX_URLS = 4; // endpoint cap
  const OVERLAY_ID = "gt-cc-overlay";

  if (!IMG || !DEFAULT_CFG) return; // dependencies failed to load — bail quietly

  let CFG = DEFAULT_CFG; // replaced by the merged (remote) config once loaded
  let grading = false; // guard against double-submits

  // ── config + settings via the background worker ────────────────────────
  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (_e) {
      // Worker asleep / context invalidated (e.g. extension reloaded). Callers
      // treat a null as "use the bundled default / show a soft error".
      return null;
    }
  }

  function isItemPage(cfg) {
    const needle = (cfg && cfg.ebay && cfg.ebay.itemPathIncludes) || "/itm/";
    return location.pathname.includes(needle);
  }

  // ── extraction (uses CFG.ebay selectors) ───────────────────────────────
  function firstText(selectors) {
    for (const sel of selectors || []) {
      const el = document.querySelector(sel);
      const txt = el && el.textContent && el.textContent.trim();
      if (txt) return txt;
    }
    return "";
  }

  function extractTitle() {
    return firstText(CFG.ebay.title).slice(0, 200);
  }

  // Brand lives in an item-specifics label/value row. Scan the rows and return
  // the value paired with a label matching one of CFG.ebay.brandLabels.
  function extractBrand() {
    const rows = document.querySelectorAll(CFG.ebay.itemSpecRow);
    const wanted = (CFG.ebay.brandLabels || []).map((s) => s.toLowerCase());
    for (const row of rows) {
      const labelEl = row.querySelector(CFG.ebay.itemSpecLabel);
      const label = labelEl && labelEl.textContent && labelEl.textContent.trim().toLowerCase();
      if (!label) continue;
      if (wanted.some((w) => label.includes(w))) {
        const valEl = row.querySelector(CFG.ebay.itemSpecValue);
        const val = valEl && valEl.textContent && valEl.textContent.trim();
        if (val) return val.slice(0, 80);
      }
    }
    return "";
  }

  function extractImageUrls() {
    let imgs = [];
    for (const sel of CFG.ebay.gallery) {
      const found = document.querySelectorAll(sel);
      if (found && found.length) {
        imgs = Array.from(found);
        break;
      }
    }
    const attrs = CFG.ebay.imageAttrs || ["src"];
    const urls = [];
    for (const el of imgs) {
      const candidates = attrs.map((a) => el.getAttribute(a));
      const chosen = IMG.pickImageUrl(candidates);
      if (chosen) urls.push(IMG.upgradeEbayImageUrl(chosen));
    }
    return IMG.dedupeUrls(urls, MAX_URLS);
  }

  // ── overlay UI ─────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent — never innerHTML with listing data
    return n;
  }

  function removeOverlay() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();
  }

  function mountRoot() {
    removeOverlay();
    const root = el("div", "gt-cc-root");
    root.id = OVERLAY_ID;
    // Guard against inheriting eBay's page styles as much as a plain overlay can.
    root.setAttribute("dir", "ltr");
    document.body.appendChild(root);
    return root;
  }

  function header(onClose) {
    const bar = el("div", "gt-cc-head");
    const brand = el("span", "gt-cc-brand", "GradeThread");
    const badge = el("span", "gt-cc-badge", "condition check");
    bar.appendChild(brand);
    bar.appendChild(badge);
    if (onClose) {
      const close = el("button", "gt-cc-close");
      close.setAttribute("type", "button");
      close.setAttribute("aria-label", "Close GradeThread condition check");
      close.textContent = "×"; // ×
      close.addEventListener("click", onClose);
      bar.appendChild(close);
    }
    return bar;
  }

  function renderLauncher() {
    const root = mountRoot();
    root.appendChild(header(() => hideForSession()));
    const body = el("div", "gt-cc-body");
    const p = el("p", "gt-cc-lead", "Independent AI condition read on this listing.");
    const btn = el("button", "gt-cc-cta");
    btn.setAttribute("type", "button");
    btn.textContent = "Get condition read";
    btn.addEventListener("click", () => runGrade());
    body.appendChild(p);
    body.appendChild(btn);
    root.appendChild(body);
  }

  function renderState(build) {
    const root = mountRoot();
    root.appendChild(header(() => hideForSession()));
    const body = el("div", "gt-cc-body");
    build(body);
    root.appendChild(body);
  }

  function renderLoading() {
    renderState((body) => {
      const spin = el("div", "gt-cc-spin");
      spin.setAttribute("aria-hidden", "true");
      const p = el("p", "gt-cc-lead", "Reading the listing photos…");
      body.appendChild(spin);
      body.appendChild(p);
    });
  }

  function scoreClass(score) {
    if (score >= 9) return "gt-cc-s-excellent";
    if (score >= 7) return "gt-cc-s-good";
    if (score >= 5) return "gt-cc-s-fair";
    if (score >= 3) return "gt-cc-s-poor";
    return "gt-cc-s-bad";
  }

  function renderResult(data) {
    renderState((body) => {
      const scoreWrap = el("div", "gt-cc-scorewrap");
      const score = el("div", "gt-cc-score " + scoreClass(data.overallScore));
      score.textContent = Number(data.overallScore).toFixed(1);
      const meta = el("div", "gt-cc-meta");
      meta.appendChild(el("div", "gt-cc-tier", String(data.gradeTier || "")));
      const conf = Math.round(Number(data.confidence || 0) * 100);
      meta.appendChild(el("div", "gt-cc-conf", "Confidence " + conf + "%"));
      scoreWrap.appendChild(score);
      scoreWrap.appendChild(meta);
      body.appendChild(scoreWrap);

      // Human-review threshold parity (CLAUDE.md: confidence < 0.75 → review).
      if (Number(data.confidence || 0) < 0.75) {
        body.appendChild(
          el(
            "p",
            "gt-cc-note",
            "Low confidence from listing photos — grade it properly for a reliable read."
          )
        );
      }

      body.appendChild(el("p", "gt-cc-disclaimer", String(data.disclaimer || "")));

      if (data.deepLink) {
        const a = el("a", "gt-cc-link", "Grade it properly →");
        a.href = data.deepLink;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        body.appendChild(a);
      }

      const again = el("button", "gt-cc-secondary");
      again.setAttribute("type", "button");
      again.textContent = "Re-read";
      again.addEventListener("click", () => runGrade());
      body.appendChild(again);
    });
  }

  function renderError(message, canRetry) {
    renderState((body) => {
      body.appendChild(el("p", "gt-cc-lead", message));
      if (canRetry) {
        const retry = el("button", "gt-cc-cta");
        retry.setAttribute("type", "button");
        retry.textContent = "Try again";
        retry.addEventListener("click", () => runGrade());
        body.appendChild(retry);
      }
    });
  }

  // ── actions ─────────────────────────────────────────────────────────────
  async function runGrade() {
    if (grading) return;
    const title = extractTitle();
    const brand = extractBrand();
    const imageUrls = extractImageUrls();
    if (!imageUrls.length) {
      renderError(
        "Couldn't find this listing's photos. eBay may have changed its layout — try reloading.",
        true
      );
      return;
    }
    grading = true;
    renderLoading();
    const res = await send({ type: "GT_CC_GRADE", imageUrls, title, brand });
    grading = false;
    if (!res) {
      renderError("Something interrupted the read. Try again in a moment.", true);
      return;
    }
    if (res.ok && res.data) {
      renderResult(res.data);
      send({
        type: "GT_CC_SAVE_READ",
        read: {
          url: location.href,
          title: title || document.title,
          overallScore: res.data.overallScore,
          gradeTier: res.data.gradeTier,
          confidence: res.data.confidence,
          at: Date.now(),
        },
      });
      return;
    }
    // Rate-limited vs other errors: the endpoint returns 429 with a clear message.
    if (res.status === 429) {
      renderError(res.error || "You've hit the free read limit for now. Try again later.", false);
      return;
    }
    renderError(res.error || "Couldn't grade this listing right now.", true);
  }

  // Hide the overlay for the rest of this page view (a soft dismiss — comes back
  // on the next listing). A permanent per-site opt-out lives in the popup.
  function hideForSession() {
    removeOverlay();
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  async function boot() {
    // Merge in the remotely-updatable config (background caches it); fall back
    // to the bundled default on any failure.
    const merged = await send({ type: "GT_CC_GET_CONFIG" });
    if (merged && merged.ebay) CFG = merged;

    if (!isItemPage(CFG)) return; // injected on a non-item eBay page — no-op

    // Respect a permanent per-site opt-out set from the popup.
    const settings = await send({ type: "GT_CC_GET_SETTINGS" });
    const host = location.host;
    if (settings && Array.isArray(settings.disabledHosts) && settings.disabledHosts.includes(host)) {
      return;
    }

    if (settings && settings.autoRun) {
      // Opt-in auto-run: grade once on load.
      renderLauncher();
      runGrade();
    } else {
      renderLauncher();
    }
  }

  // eBay is an SPA-ish site; re-boot on history navigation between item pages.
  let lastPath = location.pathname;
  const reboot = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      removeOverlay();
      grading = false;
      boot();
    }
  };
  window.addEventListener("popstate", reboot);
  // Patch pushState/replaceState to catch client-side nav.
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(reboot, 300);
      return r;
    };
  }

  boot();
})();
