// GradeThread Condition Check — shadow-root mounting for injected UI (US-1884 AC4)
//
// THE PROBLEM THIS CLOSES.
//
// Our overlay is a guest in someone else's document. Until now its defence
// against the host page's stylesheet was DISCIPLINE: `all: initial` on the root,
// `all: unset` on a few buttons, and a hope that no marketplace ships a rule
// broad enough to reach the rest. That defence has three holes, and none of them
// can be closed by writing more CSS:
//
//   1. A site rule with higher specificity beats ours. `#main p { ... }` outranks
//      `#gt-cc-overlay .gt-cc-lead`.
//   2. A site `!important` beats ours outright, whatever we write.
//   3. Every NEW element we add is unprotected until someone remembers to add
//      the reset. A guard cannot see that omission, and neither can a reviewer.
//
// So the hardening here is not a rule, it is a LOCATION: the overlay's nodes live
// in a shadow tree. A page's stylesheet cannot select into a shadow root at all —
// that is a platform guarantee, not a property of our selectors — so hole 1 and 2
// stop existing and hole 3 can never open, because a new child inherits the
// isolation by virtue of where it is mounted.
//
// The one thing the page CAN still style is the HOST element itself. So the
// host's layout is written as INLINE declarations with `!important`, which is the
// top of the author cascade: a page cannot outrank an inline `!important`, not
// even with an `!important` of its own.
//
// DOM-free by construction: every entry point takes the `document` to build
// against, so test/overlay-shadow.test.cjs drives it with a stub and can observe
// exactly where the styles landed. Loaded as a classic content script (sets
// self.GT_CC_SHADOW); the UMD shim gives node's require() a module.exports.

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_SHADOW = api; // content-script world
})(typeof self !== "undefined" ? self : this, function () {
  // ── Host layout, as inline !important declarations ──────────────────────
  //
  // `all` comes FIRST on purpose: it wipes whatever the page's cascade would
  // otherwise inherit into the host, and the declarations after it win because
  // among equally-weighted declarations the later one applies.
  //
  // These live here rather than in overlay.css because the host is the ONE node
  // the page can reach, so it is the one node whose layout must be unbeatable.
  //
  // US-2622 — THE HOST IS BOUNDED, AND IT IS A COLUMN.
  //
  // The host used to be `display: block` with a width and no height limit. A card
  // anchored at `bottom` that is free to grow grows UPWARDS, so a long read (a
  // full factor breakdown plus a coverage-gap list is over 1100px) put its own
  // header, and with it the close button, above the top of the viewport. Nothing
  // scrolled, because the card sets `overflow: hidden` and the page's own scroll
  // moves the page, not a fixed element. The overlay was unreadable and could not
  // be dismissed by mouse.
  //
  // So the host now caps its own height and lays its child out as a column. The
  // cap belongs HERE rather than in the sheet for the same reason the rest of the
  // layout does: it is the one node a marketplace can select, so the one node
  // whose bound has to be unbeatable.
  //
  // `dvh` is declared after `vh` on purpose. A phone's viewport shrinks when the
  // URL bar comes back, and `vh` is frozen at the tallest state, so a vh-only cap
  // hides the bottom of the card behind browser chrome. An engine without `dvh`
  // drops that declaration as invalid and keeps the `vh` one.
  var OVERLAY_HOST_STYLE = [
    ["all", "initial"],
    ["position", "fixed"],
    ["right", "16px"],
    ["bottom", "16px"],
    ["z-index", "2147483000"], // below the max so native dialogs still win
    ["width", "360px"],
    ["max-width", "calc(100vw - 32px)"],
    ["max-height", "calc(100vh - 32px)"],
    ["max-height", "calc(100dvh - 32px)"],
    ["display", "flex"],
    ["flex-direction", "column"],
    ["align-items", "stretch"],
  ];

  // Scan badges are appended INSIDE a marketplace's own result tile, so their
  // host takes the tile's width and stays in flow.
  var BADGE_HOST_STYLE = [
    ["all", "initial"],
    ["display", "block"],
    ["width", "100%"],
  ];

  function applyHostStyle(node, decls) {
    if (!node || !node.style || typeof node.style.setProperty !== "function") return;
    for (var i = 0; i < decls.length; i++) {
      try {
        node.style.setProperty(decls[i][0], decls[i][1], "important");
      } catch (_e) {
        /* a stub/old engine may refuse a property — never fatal */
      }
    }
  }

  // ── One stylesheet, many shadow roots ───────────────────────────────────
  //
  // A search page can carry two dozen badge hosts. Giving each its own <style>
  // copies the whole sheet two dozen times; a constructable stylesheet is built
  // once and ADOPTED by every root, so the cost is one copy regardless.
  var sheetCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function sheetFor(doc, css) {
    if (!sheetCache || !doc) return null;
    var view = doc.defaultView;
    var Ctor = view && view.CSSStyleSheet;
    if (typeof Ctor !== "function") return null;
    var byCss = sheetCache.get(doc);
    if (!byCss) {
      byCss = {};
      sheetCache.set(doc, byCss);
    }
    if (Object.prototype.hasOwnProperty.call(byCss, css)) return byCss[css];
    var sheet = null;
    try {
      sheet = new Ctor();
      sheet.replaceSync(css);
    } catch (_e) {
      sheet = null; // not constructable here — the <style> path below covers it
    }
    byCss[css] = sheet;
    return sheet;
  }

  /**
   * Put `css` into `container`. Returns "adopted" | "style" | "none" so a test
   * can assert WHERE the stylesheet landed rather than trusting that it did.
   */
  function injectStyles(container, doc, css, isShadow) {
    if (!css) return "none";
    if (isShadow) {
      var sheet = sheetFor(doc, css);
      if (sheet) {
        try {
          var existing = container.adoptedStyleSheets || [];
          container.adoptedStyleSheets = existing.concat([sheet]);
          return "adopted";
        } catch (_e) {
          /* fall through to a plain <style> */
        }
      }
    }
    var style = doc.createElement("style");
    style.textContent = css;
    container.appendChild(style);
    return "style";
  }

  function mountShadow(host, doc, css) {
    var shadow = null;
    if (typeof host.attachShadow === "function") {
      try {
        shadow = host.attachShadow({ mode: "open" });
      } catch (_e) {
        shadow = null;
      }
    }
    // No shadow DOM at all is not reachable on the browsers these manifests
    // support (Chrome MV3, Firefox 109+). If it ever were, degrade to the
    // pre-US-1884 behaviour rather than rendering an unstyled box: every rule in
    // the sheet is scoped under our own id or class, so the blast radius is our
    // own elements, not the page's.
    var container = shadow || host;
    var where = injectStyles(container, doc, css, !!shadow);
    return { shadow: shadow, container: container, styles: where };
  }

  /**
   * The condition overlay. Returns `{ host, shadow, root, styles }` — `host` is
   * what you append to the page, `root` is the card to build into.
   *
   * The overlay id is set on BOTH the host and the inner root. Ids are scoped to
   * their own tree, so those two are not duplicates of each other, and it lets
   * the stylesheet keep its `#gt-cc-overlay .gt-cc-x` selectors verbatim inside
   * the shadow root.
   */
  function createOverlayHost(doc, id, css) {
    var host = doc.createElement("div");
    if (id) host.id = id;
    applyHostStyle(host, OVERLAY_HOST_STYLE);
    var m = mountShadow(host, doc, css);
    if (!m.shadow) {
      // Degraded path: the host IS the card, exactly as before US-1884.
      host.className = "gt-cc-root";
      return { host: host, shadow: null, root: host, styles: m.styles };
    }
    var card = doc.createElement("div");
    card.className = "gt-cc-root";
    if (id) card.id = id;
    m.container.appendChild(card);
    return { host: host, shadow: m.shadow, root: card, styles: m.styles };
  }

  /**
   * A scan badge row, for appending into a marketplace's result tile — the most
   * hostile place we render, because it sits in the middle of someone else's
   * cascade with no container of ours around it.
   */
  function createBadgeHost(doc, css, extraClass) {
    var cls = "gt-cc-badge-row" + (extraClass ? " " + extraClass : "");
    var host = doc.createElement("div");
    applyHostStyle(host, BADGE_HOST_STYLE);
    var m = mountShadow(host, doc, css);
    if (!m.shadow) {
      host.className = cls;
      return { host: host, shadow: null, root: host, styles: m.styles };
    }
    var row = doc.createElement("div");
    row.className = cls;
    m.container.appendChild(row);
    return { host: host, shadow: m.shadow, root: row, styles: m.styles };
  }

  return {
    OVERLAY_HOST_STYLE: OVERLAY_HOST_STYLE,
    BADGE_HOST_STYLE: BADGE_HOST_STYLE,
    applyHostStyle: applyHostStyle,
    createOverlayHost: createOverlayHost,
    createBadgeHost: createBadgeHost,
  };
});
