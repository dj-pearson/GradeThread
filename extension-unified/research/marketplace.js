// GradeThread Condition Check — generic marketplace content script (US-1756)
//
// One code path, many marketplaces. It resolves the adapter matching the
// current host (from the bundled config, or the remotely-updatable override the
// background worker caches), and — if the page is a detail/item page — extracts
// the listing's gallery image URLs (+ title and brand), then renders a
// non-intrusive overlay that grades them on demand via the public
// /grade-from-url endpoint (US-1754).
//
// Graceful fallback (US-1756 AC3): if the host matches no enabled adapter, or a
// site's selectors resolve no images, the overlay says so plainly rather than
// grading an empty set or showing a wrong read — every marketplace's DOM can be
// corrected from the remote config without a store resubmission.
//
// Why click-to-grade (not auto on load): each read spends a Vision call and the
// public endpoint is quota-capped. See README.

(function () {
  "use strict";

  // Firefox exposes the (promise-based) API as `browser`; Chrome as `chrome`
  // (promise-based in MV3). Alias so `await chrome.runtime.sendMessage(...)` works
  // in both — Firefox's `chrome.*` is callback-only and would not resolve.
  const chrome = globalThis.browser || globalThis.chrome;

  const IMG = self.GT_CC_IMG; // pure helpers (research/image-utils.js)
  const FMT = self.GT_CC_FMT; // US-1884: pure result-formatting (condition-format.js)
  const DEFAULT_CFG = self.GT_CC_CONFIG; // bundled default (selectors.js)
  const HARD_MAX_URLS = 4; // endpoint cap — never exceed regardless of adapter
  const OVERLAY_ID = "gt-cc-overlay";

  if (!IMG || !DEFAULT_CFG) return; // dependencies failed to load — bail quietly

  let CFG = DEFAULT_CFG;
  let adapter = null;
  let grading = false;
  let escHandler = null; // US-1884 (AC3): active Esc-to-dismiss listener, if any.

  // US-1878 (AC3): the GENERATION token.
  //
  // A grade is a multi-second round trip, and on an SPA the shopper can click
  // through to a different listing while it is in flight. Nothing used to stop the
  // late response from rendering: listing A's score got painted onto listing B's
  // page, and — because the save read location.href AFTER the await — it was then
  // RECORDED against listing B's URL. A wrong grade, attributed to the wrong item,
  // persisted into the buyer's history.
  //
  // So every grade captures the epoch it started in. Anything that invalidates the
  // context (navigation, closing the overlay) bumps it, and a response whose epoch
  // is stale is dropped: not rendered, not saved. Monotonic and never reset — a
  // reused value could resurrect a dropped read.
  let epoch = 0;
  function invalidate() {
    epoch += 1;
    grading = false;
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (_e) {
      return null; // worker asleep / context invalidated
    }
  }

  // A stable identity for THIS listing, so a return visit recalls the same grade
  // (the background worker keys its grade cache on this). Normalize to origin +
  // path, lowercased, trailing slash trimmed — drops tracking/query params so the
  // same item is recognized across visits.
  function listingKey() {
    try {
      const u = new URL(location.href);
      return (u.origin + u.pathname).toLowerCase().replace(/\/+$/, "");
    } catch (_e) {
      return (location.host + location.pathname).toLowerCase();
    }
  }

  function timeAgo(ts) {
    const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  // ── extraction (adapter-driven) ─────────────────────────────────────────
  function firstText(selectors) {
    for (const sel of selectors || []) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch (_e) {
        continue; // a bad remote selector never breaks extraction
      }
      const txt = el && el.textContent && el.textContent.trim();
      if (txt) return txt;
    }
    return "";
  }

  function extractTitle() {
    return firstText(adapter.title).slice(0, 200);
  }

  function extractBrand() {
    // Most fashion marketplaces expose brand as a labeled link/element.
    const direct = firstText(adapter.brandSelectors);
    if (direct) return direct.slice(0, 80);
    // eBay-style item-specifics table fallback.
    const spec = adapter.itemSpec;
    if (spec && spec.row) {
      let rows = [];
      try {
        rows = document.querySelectorAll(spec.row);
      } catch (_e) {
        rows = [];
      }
      const wanted = (spec.brandLabels || []).map((s) => s.toLowerCase());
      for (const row of rows) {
        const labelEl = row.querySelector(spec.label);
        const label = labelEl && labelEl.textContent && labelEl.textContent.trim().toLowerCase();
        if (!label) continue;
        if (wanted.some((w) => label.includes(w))) {
          const valEl = row.querySelector(spec.value);
          const val = valEl && valEl.textContent && valEl.textContent.trim();
          if (val) return val.slice(0, 80);
        }
      }
    }
    return "";
  }

  // US-1880 (AC3): which selector list came up empty on the last extract. The
  // gallery has TWO distinct failure modes and conflating them wastes the
  // signal: "no gallery selector matched any element" points at the gallery
  // selectors, while "elements matched but produced no usable URL" points at
  // imageAttrs or the urlUpgrade rule instead. The dead Poshmark upgrade regex
  // this story fixed was exactly the second kind.
  let lastGalleryMatched = false;

  function extractImageUrls() {
    let imgs = [];
    lastGalleryMatched = false;
    for (const sel of adapter.gallery || []) {
      let found;
      try {
        found = document.querySelectorAll(sel);
      } catch (_e) {
        continue;
      }
      if (found && found.length) {
        imgs = Array.from(found);
        lastGalleryMatched = true;
        break;
      }
    }
    const attrs = adapter.imageAttrs || ["src"];
    const urls = [];
    for (const el of imgs) {
      const candidates = attrs.map((a) => firstSrcFromAttr(el, a));
      const chosen = IMG.pickImageUrl(candidates);
      if (chosen) urls.push(IMG.applyUrlUpgrade(chosen, adapter.urlUpgrade));
    }
    const cap = Math.min(HARD_MAX_URLS, Number(adapter.maxImages) || HARD_MAX_URLS);
    return IMG.dedupeUrls(urls, cap);
  }

  // `srcset` needs its largest candidate pulled out; plain attrs are read as-is.
  function firstSrcFromAttr(el, attr) {
    const raw = el.getAttribute(attr);
    if (!raw) return null;
    // US-1880: pick the max-width srcset candidate (order is not guaranteed), not
    // whatever happened to be last.
    if (attr === "srcset") return IMG.srcsetLargest(raw);
    return raw;
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
    // US-1884 (AC3): tear down the Esc-to-dismiss listener with the overlay.
    if (escHandler) {
      document.removeEventListener("keydown", escHandler, true);
      escHandler = null;
    }
  }

  function mountRoot() {
    removeOverlay();
    const root = el("div", "gt-cc-root");
    root.id = OVERLAY_ID;
    root.setAttribute("dir", "ltr");
    // US-1884 (AC3): announce loading→result/error transitions to assistive tech.
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    document.body.appendChild(root);
    // US-1884 (AC3): Escape closes the overlay. Capture phase so a site's own key
    // handlers can't swallow it; one listener per mounted overlay.
    escHandler = function (e) {
      // US-1878 (AC3): same as the close button — an explicit dismissal invalidates
      // the in-flight read so it can't reappear seconds later.
      if (e.key === "Escape" || e.key === "Esc") {
        invalidate();
        removeOverlay();
      }
    };
    document.addEventListener("keydown", escHandler, true);
    return root;
  }

  function header() {
    const bar = el("div", "gt-cc-head");
    bar.appendChild(el("span", "gt-cc-brand", "GradeThread"));
    bar.appendChild(el("span", "gt-cc-badge", "condition check"));
    const close = el("button", "gt-cc-close");
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", "Close GradeThread condition check");
    close.textContent = "×"; // ×
    // US-1878 (AC3): dismissing mid-grade must invalidate the in-flight read, or
    // the response lands a few seconds later and RESURRECTS an overlay the shopper
    // deliberately closed.
    close.addEventListener("click", function () {
      invalidate();
      removeOverlay();
    });
    bar.appendChild(close);
    return bar;
  }

  function renderState(build, opts) {
    const root = mountRoot();
    root.appendChild(header());
    const body = el("div", "gt-cc-body");
    build(body);
    root.appendChild(body);
    // US-1884 (AC3): on a terminal state (result/error) move focus to the close
    // button so keyboard users land on the overlay; never steal focus during the
    // transient loading state.
    if (opts && opts.focusClose) {
      const closeBtn = root.querySelector(".gt-cc-close");
      if (closeBtn && typeof closeBtn.focus === "function") {
        try { closeBtn.focus(); } catch (_e) { /* focus may be denied — harmless */ }
      }
    }
  }

  function renderLauncher() {
    renderState((body) => {
      const label = (adapter && adapter.label) || "this listing";
      body.appendChild(el("p", "gt-cc-lead", "Independent AI condition read on this " + label + " listing."));
      const btn = el("button", "gt-cc-cta");
      btn.setAttribute("type", "button");
      btn.textContent = "Get condition read";
      btn.addEventListener("click", () => runGrade());
      body.appendChild(btn);
    });
  }

  function renderLoading() {
    renderState((body) => {
      const spin = el("div", "gt-cc-spin");
      spin.setAttribute("aria-hidden", "true");
      body.appendChild(spin);
      body.appendChild(el("p", "gt-cc-lead", "Reading the listing photos…"));
    });
  }

  function scoreClass(score) {
    if (score >= 9) return "gt-cc-s-excellent";
    if (score >= 7) return "gt-cc-s-good";
    if (score >= 5) return "gt-cc-s-fair";
    if (score >= 3) return "gt-cc-s-poor";
    return "gt-cc-s-bad";
  }

  function renderResult(data, savedAt) {
    renderState((body) => {
      // A recalled read — show the buyer this is the SAME grade from a prior visit,
      // not a fresh (and possibly different) roll. "Re-read" below forces a new one.
      if (savedAt) {
        body.appendChild(
          el("p", "gt-cc-saved", "Saved read · " + timeAgo(savedAt) + " — same grade as before.")
        );
      }

      const scoreWrap = el("div", "gt-cc-scorewrap");
      // US-1884 (AC5): a NaN / non-finite overall score must never render as
      // "NaN" — show an em dash and a neutral class instead.
      var overallNum = Number(data.overallScore);
      var overallSafe = isFinite(overallNum) ? overallNum : null;
      const score = el("div", "gt-cc-score " + scoreClass(overallSafe == null ? 0 : overallSafe));
      score.textContent = overallSafe == null ? "—" : overallSafe.toFixed(1);
      const meta = el("div", "gt-cc-meta");
      meta.appendChild(el("div", "gt-cc-tier", String(data.gradeTier || "")));
      const conf = Math.round(Number(data.confidence || 0) * 100);
      meta.appendChild(el("div", "gt-cc-conf", "Confidence " + conf + "%"));
      scoreWrap.appendChild(score);
      scoreWrap.appendChild(meta);
      body.appendChild(scoreWrap);

      if (Number(data.confidence || 0) < 0.75) {
        body.appendChild(
          el("p", "gt-cc-note", "Low confidence from listing photos — grade it properly for a reliable read.")
        );
      }

      // US-1884: the five factor scores as compact labeled bars (the endpoint
      // already returns factorScores; the overlay used to drop them). NaN /
      // out-of-range factors are filtered out by FMT.factorBars — never rendered.
      if (FMT) {
        var bars = FMT.factorBars(data.factorScores);
        if (bars.length) {
          body.appendChild(el("p", "gt-cc-factors-h", FMT.STRINGS.factorsHeading));
          var flist = el("div", "gt-cc-factors");
          for (var bi = 0; bi < bars.length; bi++) {
            var bar = bars[bi];
            var frow = el("div", "gt-cc-factor");
            frow.appendChild(el("span", "gt-cc-factor-label", bar.label));
            var track = el("span", "gt-cc-factor-track");
            var fill = el("span", "gt-cc-factor-fill " + bar.cls);
            fill.style.width = bar.pct + "%";
            track.appendChild(fill);
            frow.appendChild(track);
            frow.appendChild(el("span", "gt-cc-factor-num", bar.score.toFixed(1)));
            flist.appendChild(frow);
          }
          body.appendChild(flist);
        }
        // US-1884: "Graded from N photos" + a nudge for thin photo sets.
        var pc = FMT.photoCountLabel(data.imagesAnalyzed);
        if (pc) body.appendChild(el("p", "gt-cc-photocount", pc));
        if (FMT.lowCoverage(data.imagesAnalyzed)) {
          body.appendChild(el("p", "gt-cc-note", FMT.STRINGS.lowCoverageNudge));
        }
      }

      // US-1834: claimed-vs-objective condition discrepancy signal.
      var disc = data.discrepancy;
      if (disc && disc.signal && disc.signal !== "unknown") {
        var DISC = {
          over_graded: ["gt-cc-disc-bad", "⚠ Seller may be over-grading"],
          mild_gap: ["gt-cc-disc-warn", "Slightly better than photos support"],
          match: ["gt-cc-disc-ok", "✓ Matches the seller's stated condition"],
        };
        var d = DISC[disc.signal];
        if (d) {
          var node = el("p", "gt-cc-disc " + d[0], d[1]);
          if (disc.signal !== "match" && disc.claimedGrade != null) {
            node.textContent = d[1] + " (photos ≈ " + Number(disc.objectiveGrade).toFixed(1) +
              " vs claimed ≈ " + Number(disc.claimedGrade).toFixed(1) + ")";
          }
          body.appendChild(node);
        }
      }

      // US-1835: condition-adjusted price-fairness meter.
      var pf = data.priceFairness;
      var val = data.value;
      if (pf && pf.verdict && pf.verdict !== "unknown" && val) {
        var PF = {
          low: ["gt-cc-disc-ok", "✓ Priced below fair value — a deal"],
          fair: ["gt-cc-disc-ok", "Priced fairly for its condition"],
          high: ["gt-cc-disc-bad", "⚠ Priced above fair value"],
        };
        var p = PF[pf.verdict];
        if (p) {
          var fairLine = el("p", "gt-cc-disc " + p[0], p[1]);
          if (typeof pf.deltaPct === "number") {
            fairLine.textContent = p[1] + " (" + (pf.deltaPct > 0 ? "+" : "") + pf.deltaPct + "% vs typical)";
          }
          body.appendChild(fairLine);
        }
        body.appendChild(
          el(
            "p",
            "gt-cc-note",
            "Condition-adjusted value: $" + Math.round(val.lowCents / 100) + "–$" +
              Math.round(val.highCents / 100),
          ),
        );
      }

      // US-1836: point-of-purchase fraud flags (coarse, risk-framed).
      if (Array.isArray(data.fraudFlags) && data.fraudFlags.length) {
        for (var i = 0; i < data.fraudFlags.length; i++) {
          var ff = data.fraudFlags[i];
          if (ff && ff.label) body.appendChild(el("p", "gt-cc-disc gt-cc-disc-bad", "⚑ " + ff.label));
        }
      }

      // US-1837: coverage-gap "request the missing photos" macro + watch handoff.
      var cg = data.coverageGap;
      if (cg && Array.isArray(cg.recommendedPhotos) && cg.recommendedPhotos.length) {
        body.appendChild(el("p", "gt-cc-note", "For a confident grade, ask the seller for:"));
        var ul = el("ul", "gt-cc-photos");
        for (var k = 0; k < cg.recommendedPhotos.length; k++) {
          ul.appendChild(el("li", null, String(cg.recommendedPhotos[k])));
        }
        body.appendChild(ul);
        var actions = el("div", "gt-cc-actions");
        var copyBtn = el("button", "gt-cc-secondary");
        copyBtn.setAttribute("type", "button");
        copyBtn.textContent = "Copy photo request";
        copyBtn.addEventListener("click", function () {
          try {
            navigator.clipboard.writeText(String(cg.message || ""));
            copyBtn.textContent = "Copied — paste it to the seller";
          } catch (_e) {
            copyBtn.textContent = "Couldn't copy — select the list above";
          }
        });
        actions.appendChild(copyBtn);
        // Auth-free watch: hand off to the logged-in buyer app, which does the
        // tenant-scoped write (US-1806). No automated messaging.
        var watch = el("a", "gt-cc-secondary");
        watch.textContent = "Watch on GradeThread";
        watch.href = "https://gradethread.com/buyer/alerts?watch=" + encodeURIComponent(location.href);
        watch.target = "_blank";
        watch.rel = "noopener noreferrer";
        actions.appendChild(watch);
        body.appendChild(actions);
      }

      // US-1839: inline "will it fit me?" (Guard+ entitlement) — deep-links to the
      // fit surface, which uses the buyer's saved body profile.
      if (data.fit && data.fit.available && data.fit.deepLink) {
        var fitLink = el("a", "gt-cc-link", "Will it fit you? →");
        fitLink.href = data.fit.deepLink;
        fitLink.target = "_blank";
        fitLink.rel = "noopener noreferrer";
        body.appendChild(fitLink);
      }

      // US-1838: anonymous → prompt sign-in to unlock the paid signals.
      if (data.signupPrompt && data.signupPrompt.url) {
        body.appendChild(el("p", "gt-cc-note", String(data.signupPrompt.message || "")));
        var su = el("a", "gt-cc-link", "Sign in / upgrade →");
        su.href = data.signupPrompt.url;
        su.target = "_blank";
        su.rel = "noopener noreferrer";
        body.appendChild(su);
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
    }, { focusClose: true });
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
    }, { focusClose: true });
  }

  // ── actions ─────────────────────────────────────────────────────────────
  // US-1834: the seller's stated condition (label or eBay id) — optional; the
  // endpoint degrades to 'unknown' when absent.
  function extractCondition() {
    if (!adapter || !adapter.condition) return "";
    return firstText(adapter.condition).slice(0, 60);
  }

  // US-1835: the listing price — optional; endpoint rates fairness when present.
  function extractPrice() {
    if (!adapter || !adapter.price) return "";
    return firstText(adapter.price).slice(0, 24);
  }

  // US-1880 (AC3): tell the background an adapter came up empty, so a silently
  // broken marketplace shows up as a counter instead of waiting for a shopper to
  // report it. Fire-and-forget by design.
  //
  // WHAT IS SENT: the adapter key, which selector LISTS were empty, and the
  // config version. Never the URL, the title, the brand, or any scraped text —
  // `title`/`brand` are passed in only to test them for emptiness, and their
  // VALUES never leave this function. The background drops it entirely unless
  // the shopper opted in.
  function reportSelectorMiss(title, brand) {
    try {
      const empty = [];
      // The gallery is the failure that matters — split by which half broke.
      empty.push(lastGalleryMatched ? "gallery-no-urls" : "gallery");
      if (!title) empty.push("title");
      if (!brand) empty.push("brand");
      send({
        type: "GT_CC_SELECTOR_MISS",
        adapter: (adapter && adapter.key) || "",
        emptySelectors: empty,
        configVersion: (CFG && CFG.version) || null,
      });
    } catch (_e) { /* never let telemetry break the degrade path */ }
  }

  async function runGrade() {
    if (grading) return;
    const title = extractTitle();
    const brand = extractBrand();
    const condition = extractCondition();
    const imageUrls = extractImageUrls();
    if (!imageUrls.length) {
      // AC5 first: the honest degrade is rendered unconditionally and never
      // depends on telemetry succeeding, being consented to, or being reachable.
      renderError(
        "Couldn't find this listing's photos. The site may have changed its layout — try reloading.",
        true
      );
      reportSelectorMiss(title, brand);
      return;
    }
    grading = true;
    renderLoading();

    // US-1878 (AC3/AC5): snapshot the identity of what we are ACTUALLY grading,
    // before the await. location.href read after the round trip is a different
    // listing whenever the shopper navigated — which is exactly how a score ended
    // up filed against the wrong item.
    const myEpoch = epoch;
    const gradedUrl = location.href;
    const gradedTitle = title || document.title;
    const gradedMarketplace = (adapter && adapter.key) || "";

    const res = await send({
      type: "GT_CC_GRADE",
      imageUrls,
      title,
      brand,
      condition,
      price: extractPrice(),
      marketplace: gradedMarketplace,
      listingKey: listingKey(), // background caches the result under this key
    });

    // The shopper moved on (or closed the overlay) while this was in flight. Drop
    // it on the floor: rendering would show the previous listing's grade on the new
    // one, and saving would attribute it to the wrong URL. The background has
    // already cached it under the ORIGINAL listingKey, so nothing is wasted —
    // returning to that listing recalls this very grade.
    if (myEpoch !== epoch) return;

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
          // AC5: the URL that was graded, captured pre-flight — never whatever the
          // address bar happens to say now.
          url: gradedUrl,
          title: gradedTitle,
          marketplace: gradedMarketplace,
          overallScore: res.data.overallScore,
          gradeTier: res.data.gradeTier,
          confidence: res.data.confidence,
          at: Date.now(),
        },
      });
      return;
    }
    if (res.status === 429) {
      renderError(res.error || "You've hit the free read limit for now. Try again later.", false);
      return;
    }
    // US-1883 (AC3): 503 capacity signal → NON-retryable "at capacity" state.
    if (res.status === 503 || res.code === "at_capacity" || res.retryable === false) {
      renderError(res.error || "GradeThread is at capacity right now. Try again later.", false);
      return;
    }
    renderError(res.error || "Couldn't grade this listing right now.", true);
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  // US-1878 (AC3): boot() awaits the config, the settings and the recall cache, so
  // it is just as navigable-away-from as a grade is. Without the same epoch guard,
  // a boot started on listing A can finish after the shopper is on listing B and
  // render A's CACHED grade onto B — the identical wrong-score-on-the-wrong-page
  // bug, reached through the recall path instead of the grading path.
  async function boot() {
    const myEpoch = epoch;
    const stale = () => myEpoch !== epoch;
    // US-1879: prefer the remotely-updatable config, but ONLY when it is a valid
    // upgrade — a stale/rolled-back hosted file must never downgrade the bundled
    // adapters (which could drop a newly-shipped marketplace). chooseConfig
    // enforces the version floor; a blocked downgrade is logged, not silent.
    const remote = await send({ type: "GT_CC_GET_CONFIG" });
    if (stale()) return;
    const chosen = IMG.chooseConfig(DEFAULT_CFG, remote);
    CFG = chosen.config;
    if (chosen.reason === "downgrade-blocked") {
      console.warn(
        "[GT-CC] hosted config v" + (remote && remote.version) +
          " is older than bundled v" + DEFAULT_CFG.version +
          " — keeping bundled adapters (no downgrade).",
      );
    }

    adapter = IMG.resolveAdapter(CFG.adapters, location.host);
    if (!adapter || adapter.enabled === false) return; // unknown/disabled site — no-op
    if (!IMG.isDetailPage(adapter, location.pathname)) return; // not a listing page

    // Permanent per-site opt-out from the popup.
    const settings = await send({ type: "GT_CC_GET_SETTINGS" });
    if (stale()) return;
    const host = location.host;
    if (settings && Array.isArray(settings.disabledHosts) && settings.disabledHosts.includes(host)) {
      return;
    }

    // Recall: if this exact listing was already graded, show that SAME grade
    // instead of the launcher (a return visit to a graded item is stable, and it
    // spends no quota). "Re-read" in the result forces a fresh grade.
    const cached = await send({ type: "GT_CC_GET_CACHED", listingKey: listingKey() });
    if (stale()) return;
    if (cached && cached.data) {
      renderResult(cached.data, cached.at);
      return;
    }

    renderLauncher();
    if (settings && settings.autoRun) runGrade(); // opt-in auto-run
  }

  // ── SPA navigation detection (US-1878 AC2/AC4) ───────────────────────────
  //
  // Five of our six marketplaces are SPA-first: clicking a listing from the feed is
  // a client-side navigation, not a page load, so nothing re-runs boot() by itself.
  //
  // The old hook monkey-patched history.pushState/replaceState — from the CONTENT
  // SCRIPT'S ISOLATED WORLD. That never fires. The isolated world has its own JS
  // globals, so patching its `history` wrapper leaves the PAGE's pushState (a
  // different wrapper over the same underlying object) completely untouched; the
  // page navigates and our override is never invoked. popstate did work, but SPA
  // routers push — they don't pop. So in-page navigation went undetected and the
  // pill simply never appeared. That, plus the detail-only manifest matches, is why
  // the research surface effectively only worked on eBay (an MPA).
  //
  // What DOES work from an isolated world:
  //   1. The Navigation API — window.navigation's `navigate` event fires for
  //      same-document navigations and is observable here. Chromium-only, hence (2).
  //   2. A location poll — crude but universal, and the only thing guaranteed to
  //      catch a router that bypasses both of the above.
  // Both are wired: (1) reacts immediately where available, (2) backstops it. Both
  // funnel through onUrlMaybeChanged, which is idempotent on an unchanged URL, so
  // double-firing costs nothing.
  let lastUrl = location.href;

  function onUrlMaybeChanged() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // Any navigation invalidates an in-flight grade for the PREVIOUS listing
    // (AC3) — without this the old listing's score renders over the new one.
    invalidate();
    removeOverlay();
    boot();
  }

  // (1) Navigation API — commitment-based, so no arbitrary delay is needed. AC4:
  // the old code did `setTimeout(reboot, 300)`, a guess that was simultaneously too
  // long (visible lag) and too short (a slow router hadn't committed yet). The
  // `navigate` event's committed promise tells us exactly when the URL is settled,
  // and the poll covers routers we can't observe this way.
  if (typeof navigation !== "undefined" && navigation && typeof navigation.addEventListener === "function") {
    try {
      navigation.addEventListener("navigate", function (e) {
        const done = e && e.committed && typeof e.committed.then === "function"
          ? e.committed
          : Promise.resolve();
        done.then(onUrlMaybeChanged, function () { /* navigation aborted — ignore */ });
      });
    } catch (_e) { /* fall through to the poll */ }
  }

  // (2) popstate still covers back/forward.
  window.addEventListener("popstate", onUrlMaybeChanged);

  // (3) The universal backstop. 400ms is imperceptible against a multi-second grade
  // and costs a string compare; it is deliberately NOT the primary mechanism.
  setInterval(onUrlMaybeChanged, 400);

  boot();
})();
