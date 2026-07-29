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
  const SCAN = self.GT_CC_SCAN; // US-2237: pure scan helpers (scan-format.js)
  const FLIP = self.GT_CC_FLIP; // US-2238: pure flip-mode formatting (flip-format.js)
  const SELLER = self.GT_CC_SELLER; // US-2239: pure seller aggregation (seller-memory.js)
  const TRAY = self.GT_CC_TRAY; // US-2240: pure compare-tray logic (compare-tray.js)
  const DEFAULT_CFG = self.GT_CC_CONFIG; // bundled default (selectors.js)
  const HARD_MAX_URLS = 4; // endpoint cap — never exceed regardless of adapter
  const OVERLAY_ID = "gt-cc-overlay";
  // US-2237: marks a card we've already badged, so a re-scan (infinite scroll,
  // filter change) doesn't stack a second badge on the same tile.
  const SCAN_MARK = "data-gt-cc-scanned";

  if (!IMG || !DEFAULT_CFG) return; // dependencies failed to load — bail quietly

  let CFG = DEFAULT_CFG;
  let adapter = null;
  let grading = false;
  // US-2237 scan-mode state. `scanEnabled` is resolved once per boot from the
  // shopper's setting; `onSearchPage` gates the lazy-load re-scan tick so it
  // costs a boolean check on a detail page.
  let scanning = false;
  let scanEnabled = false;
  let onSearchPage = false;
  // US-2238 flip-mode state. `caps` is the resolved capability map; the Flip
  // panel only exists for an install whose account has an active FlipDesk plan.
  let caps = null;
  let appraising = false;
  // The Flip panel's host node inside the result overlay. Declared up here with
  // the rest of the module state because removeOverlay() and invalidate() both
  // clear it, and both run before the flip section further down the file.
  let flipHost = null;
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
    // US-2237: an in-flight SCAN is invalidated the same way. Its cards belong
    // to the grid that was on screen when it started; after a navigation those
    // nodes are gone (or worse, recycled by the router for different listings),
    // so a late response must not badge them.
    scanning = false;
    // US-2238: the Flip panel lives INSIDE the result overlay, so once that is
    // gone its host node is detached. Dropping the reference stops a late
    // appraisal writing into a node nobody can see.
    appraising = false;
    flipHost = null;
    // And the re-scan tick stops until the next boot re-establishes where we
    // are. Without this, navigating from a search page to a page boot bails on
    // (an unsupported path, a disabled host) leaves the tick running the OLD
    // adapter's card selectors against the NEW page — badging whatever happens
    // to match.
    onSearchPage = false;
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
    flipHost = null; // US-2238: the panel went with the overlay.
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

      // US-2239: what THIS shopper has found on this seller's other listings.
      // Rendered async (it reads storage) and appended in place, so a slow read
      // never delays the grade itself. Absent below the 2-read floor.
      if (SELLER) {
        var sellerSlot = el("p", "gt-cc-note gt-cc-seller");
        sellerSlot.hidden = true;
        body.appendChild(sellerSlot);
        renderSellerHistory(sellerSlot, epoch);
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

      // US-2240: pin this read so it can be lined up against the other listings
      // the shopper is weighing. Costs nothing — it stores the payload already
      // in `data`, so no second call and no second Vision spend.
      // Snapshot the URL at RENDER time, for the same reason the save path uses
      // gradedUrl: nothing inside a rendered result may re-read location.href.
      // The overlay is torn down on navigation, so this is the listing this
      // result actually belongs to.
      if (TRAY) body.appendChild(pinControls(data, location.href));

      // US-2238: the seller's half of this listing. Appended LAST and only for a
      // FlipDesk account — a shopper must never see a resale-margin panel on the
      // item they are trying to buy.
      if (FLIP && caps && caps.sellerEnabled === true) {
        body.appendChild(flipSection());
      }
    }, { focusClose: true });
  }

  // ── compare tray (US-2240) ──────────────────────────────────────────────
  //
  // Nobody buys one listing. They pick between six of the same jacket at six
  // prices, and until now every read was discarded the moment they clicked
  // through to the next candidate — so the comparison happened from memory.
  function pinControls(data, renderedUrl) {
    const wrap = el("div", "gt-cc-actions");
    const pin = el("button", "gt-cc-secondary");
    pin.setAttribute("type", "button");
    pin.textContent = TRAY.STRINGS.pin;
    pin.addEventListener("click", async () => {
      const entry = TRAY.makeEntry(
        {
          url: renderedUrl,
          title: extractTitle() || document.title,
          marketplace: (adapter && adapter.key) || "",
          seller: extractSeller(),
          priceText: extractPrice(),
          thumbUrl: extractImageUrls()[0] || null,
        },
        data,
        Date.now(),
      );
      if (!entry) return;
      const res = await send({ type: "GT_CC_TRAY_PIN", entry: entry });
      // Only claim it worked once the worker says it stored it. A button that
      // says "Pinned" over a failed write sends the shopper to an empty table.
      if (res && res.ok) {
        pin.textContent = TRAY.STRINGS.pinned + " (" + res.count + ")";
        pin.disabled = true;
      }
    });
    wrap.appendChild(pin);

    // Opened through the WORKER (tabs.create), not as a link to
    // chrome.runtime.getURL(). A content script linking to an extension page
    // makes that page a web-origin navigation target, which would mean adding
    // compare.html to web_accessible_resources — exposing it to every
    // marketplace page we run on, to save one message.
    const open = el("button", "gt-cc-secondary");
    open.setAttribute("type", "button");
    open.textContent = TRAY.STRINGS.open;
    open.addEventListener("click", () => send({ type: "GT_CC_TRAY_OPEN" }));
    wrap.appendChild(open);
    return wrap;
  }

  // US-2239: fill the seller-history slot, or leave it hidden. Takes the epoch it
  // was started in for the usual reason — this awaits storage, and by the time it
  // resolves the shopper may be on a different listing by a different seller.
  async function renderSellerHistory(slot, myEpoch) {
    const seller = extractSeller();
    if (!seller) return; // unreadable seller — no line, no guess
    const res = await send({
      type: "GT_CC_GET_SELLER",
      marketplace: (adapter && adapter.key) || "",
      seller: seller,
    });
    if (myEpoch !== epoch) return;
    if (!res || !res.copy) return; // below the floor, or nothing notable
    slot.textContent = res.copy;
    slot.hidden = false;
  }

  // ── flip mode: "should I flip this?" (US-2238) ───────────────────────────
  //
  // The buyer overlay asks whether the item is in the condition claimed. A
  // reseller sourcing on the same page is asking something else entirely: buy at
  // the asking price, resell, does it clear? ScoutAI already computes that from
  // an uploaded photo; this is the same pipeline fed by the listing's own photos.
  //
  // Deliberately CLICK-TO-RUN, never automatic: unlike the buyer read it spends
  // one of the seller's metered AI actions plus comp pulls, and a panel that
  // silently burned quota on every listing they scrolled past would be a bill
  // they never agreed to.
  function flipSection() {
    flipHost = el("div", "gt-cc-flip");
    const cta = el("button", "gt-cc-secondary gt-cc-flip-cta");
    cta.setAttribute("type", "button");
    cta.textContent = FLIP.STRINGS.cta;
    cta.addEventListener("click", () => runAppraise());
    flipHost.appendChild(cta);
    return flipHost;
  }

  function renderFlip(build) {
    if (!flipHost) return;
    flipHost.textContent = "";
    flipHost.appendChild(el("p", "gt-cc-factors-h", FLIP.STRINGS.heading));
    build(flipHost);
  }

  function renderFlipMessage(message, opts) {
    renderFlip((host) => {
      host.appendChild(el("p", "gt-cc-note", message));
      if (opts && opts.upgradeUrl) {
        const up = el("a", "gt-cc-link", "See FlipDesk plans →");
        up.href = opts.upgradeUrl;
        up.target = "_blank";
        up.rel = "noopener noreferrer";
        host.appendChild(up);
      }
      if (opts && opts.retry) {
        const again = el("button", "gt-cc-secondary");
        again.setAttribute("type", "button");
        again.textContent = "Try again";
        again.addEventListener("click", () => runAppraise());
        host.appendChild(again);
      }
    });
  }

  function renderFlipResult(data) {
    const panel = FLIP.panelFor(data);
    if (!panel) {
      renderFlipMessage(FLIP.STRINGS.noComps);
      return;
    }
    renderFlip((host) => {
      if (panel.verdict) {
        const v = el("div", "gt-cc-verdict " + panel.verdict.cls, panel.verdict.label);
        host.appendChild(v);
      }
      for (const row of panel.rows) {
        const line = el("div", "gt-cc-flip-row");
        line.appendChild(el("span", "gt-cc-factor-label", row.label));
        line.appendChild(el("span", "gt-cc-flip-val", row.value));
        host.appendChild(line);
      }
      if (panel.reason) host.appendChild(el("p", "gt-cc-note", panel.reason));
      if (panel.note) host.appendChild(el("p", "gt-cc-note", panel.note));
      host.appendChild(el("p", "gt-cc-disclaimer", String(data.disclaimer || FLIP.STRINGS.privateNote)));

      const again = el("button", "gt-cc-secondary");
      again.setAttribute("type", "button");
      again.textContent = "Re-check";
      again.addEventListener("click", () => runAppraise());
      host.appendChild(again);
    });
  }

  async function runAppraise() {
    if (appraising || !FLIP) return;
    const imageUrls = extractImageUrls();
    if (!imageUrls.length) {
      renderFlipMessage("Couldn't find this listing's photos to appraise.");
      return;
    }
    appraising = true;
    renderFlipMessage(FLIP.STRINGS.working);

    // Same generation guard as a grade — and it matters more here, because the
    // panel is nested inside a result the shopper may have navigated away from.
    const myEpoch = epoch;
    const res = await send({
      type: "GT_CC_APPRAISE",
      imageUrls: imageUrls,
      title: extractTitle(),
      brand: extractBrand(),
      priceCents: FLIP.priceToCents(extractPrice()),
      marketplace: (adapter && adapter.key) || "",
    });
    if (myEpoch !== epoch) return;
    appraising = false;

    if (!res) {
      renderFlipMessage("Something interrupted the flip check.", { retry: true });
      return;
    }
    if (res.ok && res.data) {
      renderFlipResult(res.data);
      return;
    }
    if (res.needsUpgrade) {
      renderFlipMessage(res.error || FLIP.STRINGS.upgrade, {
        upgradeUrl: "https://gradethread.com/pricing?utm_source=extension&utm_medium=flip",
      });
      return;
    }
    // A spent monthly cap is not retryable — offering "try again" would just
    // walk the seller into the same 429.
    if (res.quotaExhausted) {
      renderFlipMessage(res.error || FLIP.STRINGS.quota);
      return;
    }
    renderFlipMessage(res.error || "Couldn't appraise this listing right now.", { retry: true });
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

  // US-2239: who is selling it. Optional and NEVER sent anywhere — it is stored
  // with the read in storage.local so a second read of the same seller can be
  // recognised. A listing whose seller we can't resolve simply never aggregates.
  function extractSeller() {
    if (!adapter || !adapter.sellerSelectors) return "";
    return firstText(adapter.sellerSelectors).slice(0, 80);
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
    const gradedSeller = extractSeller();

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
          // US-2239: captured pre-flight alongside the URL, for the same reason
          // — after the await this is a different listing whenever the shopper
          // navigated, and a read filed against the wrong SELLER is the bug the
          // epoch guard exists to prevent, one field over.
          seller: gradedSeller,
          // The endpoint's discrepancy block carries the seller's claim on our
          // scale. It is a paid signal, so it is often absent; storing null
          // rather than 0 keeps "no claim" out of the average.
          claimedGrade: res.data.discrepancy && typeof res.data.discrepancy.claimedGrade === "number"
            ? res.data.discrepancy.claimedGrade
            : null,
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

  // ── scan mode: the search-results grid (US-2237) ─────────────────────────
  //
  // Everything above this point is the DETAIL-page surface: one listing, one
  // click, one Vision read. That surface only ever appears after the shopper has
  // already committed to a listing — the choice between twelve listings happened
  // a screen earlier, where the extension showed nothing at all.
  //
  // Scan mode badges the grid. It deliberately does NOT grade: no photo is
  // fetched and no Vision call is made (see /scan on the edge). It reports the
  // seller's own claimed condition and how their price sits against comps for
  // that claim — the two things printed on the card itself. Clicking a badge is
  // what escalates to the real read.

  function firstMatchIn(node, selectors) {
    for (const sel of selectors || []) {
      let el;
      try {
        el = node.querySelector(sel);
      } catch (_e) {
        continue; // a bad remote selector never breaks the scan
      }
      if (el) return el;
    }
    return null;
  }

  function textIn(node, selectors) {
    const el = firstMatchIn(node, selectors);
    const txt = el && el.textContent && el.textContent.trim();
    return txt || "";
  }

  // Collect the result tiles and the fields printed on them. Returns [] when the
  // adapter's card selector matches nothing — the honest degrade: a marketplace
  // that changed its grid markup shows today's behaviour (no badges), never a
  // row of empty pills.
  function collectCards(cfgSearch) {
    let nodes = [];
    for (const sel of cfgSearch.card || []) {
      let found;
      try {
        found = document.querySelectorAll(sel);
      } catch (_e) {
        continue;
      }
      if (found && found.length) {
        nodes = Array.from(found);
        break;
      }
    }
    const cards = [];
    nodes.forEach((node, i) => {
      if (node.getAttribute(SCAN_MARK)) return; // already badged
      const linkEl = firstMatchIn(node, cfgSearch.link);
      const href = (linkEl && linkEl.href) || "";
      cards.push({
        node: node,
        href: href,
        key: SCAN.cardKey(href, i),
        title: textIn(node, cfgSearch.title).slice(0, 200),
        priceText: textIn(node, cfgSearch.price).slice(0, 40),
        conditionText: textIn(node, cfgSearch.condition).slice(0, 60),
        // No marketplace prints a photo count on a result card today; the field
        // exists because the endpoint accepts it and an adapter may gain one.
        photoCount: null,
      });
    });
    return SCAN.usableCards(cards, SCAN.MAX_CARDS);
  }

  function renderBadge(card, result) {
    const badge = SCAN.badgeFor(result);
    if (!badge) return; // nothing honest to say about this card
    card.node.setAttribute(SCAN_MARK, "1");

    const wrap = el("div", "gt-cc-badge-row " + badge.cls);
    wrap.setAttribute("dir", "ltr");
    for (const part of badge.parts) {
      wrap.appendChild(el("span", "gt-cc-badge-chip " + part.cls, part.text));
    }
    // The escalation path: the badge is a triage signal, and this is how the
    // shopper turns it into an actual condition read.
    const open = el("button", "gt-cc-badge-cta");
    open.setAttribute("type", "button");
    open.textContent = "Read condition";
    open.title = SCAN.STRINGS.footnote;
    open.addEventListener("click", function (e) {
      // The tile is a link on most grids; badging inside it means a click would
      // navigate before we could act.
      e.preventDefault();
      e.stopPropagation();
      if (card.href) window.open(card.href, "_blank", "noopener");
    });
    wrap.appendChild(open);

    try {
      card.node.appendChild(wrap);
    } catch (_e) { /* detached node (the grid re-rendered) — drop this badge */ }
  }

  async function runScan() {
    if (scanning || !SCAN) return;
    const cfgSearch = adapter && adapter.search;
    if (!cfgSearch) return;
    const cards = collectCards(cfgSearch);
    if (!cards.length) return; // unreadable grid — degrade to nothing

    scanning = true;
    // Same generation guard as a grade: a scan is a round trip and the shopper
    // can re-filter or click through mid-flight, at which point these cards are
    // gone and the response belongs to a page that no longer exists.
    const myEpoch = epoch;
    const res = await send({
      type: "GT_CC_SCAN",
      marketplace: (adapter && adapter.key) || "",
      query: SCAN.searchQueryFrom(location.href, cfgSearch.queryParams),
      cards: cards.map((c) => ({
        key: c.key,
        title: c.title,
        priceText: c.priceText,
        conditionText: c.conditionText,
        photoCount: c.photoCount,
      })),
    });
    if (myEpoch !== epoch) return;
    scanning = false;

    // A scan that fails is silent by design. There is no user action to retry —
    // they didn't ask for this — so an error banner over a search page would be
    // pure noise. The detail-page read is unaffected either way.
    if (!res || !res.ok || !res.data || !Array.isArray(res.data.cards)) return;
    // Refuse to render anything that isn't the claim/price signal: if the
    // endpoint ever starts returning graded reads here, the badges must not
    // silently start presenting them as if they were triage.
    if (res.data.signal !== "claimed-condition-and-price") return;

    const byKey = new Map();
    for (const row of res.data.cards) {
      if (row && typeof row.key === "string") byKey.set(row.key, row);
    }
    for (const card of cards) {
      const row = byKey.get(card.key);
      if (row) renderBadge(card, row);
    }
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

    const onDetail = IMG.isDetailPage(adapter, location.pathname);
    const onSearch = IMG.isSearchPage(adapter, location.pathname);
    if (!onDetail && !onSearch) return; // neither surface applies here

    // Permanent per-site opt-out from the popup. Read BEFORE either surface
    // renders: a host the shopper switched off must be silent on its search
    // pages too, not just its listings.
    const settings = await send({ type: "GT_CC_GET_SETTINGS" });
    if (stale()) return;
    const host = location.host;
    if (settings && Array.isArray(settings.disabledHosts) && settings.disabledHosts.includes(host)) {
      return;
    }

    // US-2237: the search grid. Defaults ON (scanMode is undefined until the
    // shopper touches the toggle) because it costs no Vision call and no quota —
    // unlike autoRun, which stays opt-in precisely because it does.
    onSearchPage = onSearch;
    scanEnabled = !settings || settings.scanMode !== false;
    if (onSearch) {
      if (scanEnabled) runScan();
      return;
    }

    // US-2238: resolve what this account may do BEFORE any result renders, so
    // the Flip panel is present on the first paint rather than popping in after.
    // The background caches entitlements for 5 minutes, so this is a message
    // round trip and not a network call on most boots. A failure leaves caps
    // null, which reads as "no seller tools" — the same fail-safe the registry
    // applies everywhere else.
    caps = await send({ type: "GT_GET_CAPABILITIES" });
    if (stale()) return;

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

  // US-2237: results grids paginate by INFINITE SCROLL on every marketplace we
  // support, and the new cards arrive with no navigation and no URL change — so
  // neither the Navigation API nor the poll above sees them, and a one-shot scan
  // at boot would badge only the first screen and then look broken.
  //
  // runScan already skips cards carrying SCAN_MARK and returns immediately when
  // no unbadged card matched, so a tick over a settled grid costs one
  // querySelectorAll and no network. 2s (not 400ms) because a scan IS a round
  // trip: the slower cadence lets a burst of newly-rendered cards batch into one
  // request instead of firing several partial ones.
  setInterval(function () {
    if (!onSearchPage || !scanEnabled || scanning) return;
    runScan();
  }, 2000);

  boot();
})();
