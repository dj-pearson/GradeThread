// GradeThread — US-1884 (AC4) shadow-root hardening guards.
//
// WHAT THIS PROVES, AND WHY IT CAN BE PROVEN HERE.
//
// The overlay used to defend itself against a marketplace's stylesheet with
// per-element `all: initial` resets. That defence cannot be verified by reading
// it: whether some site's `!important` rule wins is a question about a page we
// don't control, which is exactly why three passes of this story deferred the
// AC as "needs cross-site browser verification".
//
// Mounting in a shadow root removes the question instead of answering it. A
// document stylesheet cannot select into a shadow tree — that is a platform
// guarantee, not a property of our selectors — so there is nothing left that a
// browser could disprove. What CAN still go wrong is mechanical, and all of it
// is checkable right here:
//
//   1. The nodes not actually landing in the shadow tree (a refactor that
//      appends to the host instead, and looks fine on a site with tame CSS).
//   2. The stylesheet not travelling with them. Manifest `"css"` injects into
//      the DOCUMENT, which the shadow root cannot see, so the sheet has to be
//      adopted — and the generated copy has to be in sync with the .css.
//   3. The host's own layout being outrankable. It is the one node the page can
//      select, so its declarations must be inline AND `!important`.
//   4. Every badge carrying its own copy of a 300-line sheet.
//
// Driven with a DOM stub rather than a browser: a stub can observe WHERE a node
// landed, which is the assertion that matters, and it can reach the
// no-shadow-DOM branch that no browser we ship to can produce.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(dir, "..");
// The two extensions put the research content scripts in different subtrees.
const SUB = fs.existsSync(path.join(dir, "research", "overlay-host.js")) ? "research" : "content";
const CSS_REL = SUB === "research" ? "research/overlay.css" : "overlay.css";

function loadIntoSelf(rel) {
  const selfObj = {};
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
   
  new Function("self", "module", src)(selfObj, { exports: {} });
  return selfObj;
}

const SHADOW = loadIntoSelf(`${SUB}/overlay-host.js`).GT_CC_SHADOW;
const CSS = loadIntoSelf(`${SUB}/overlay-css.js`).GT_CC_CSS;

// ── DOM stub ────────────────────────────────────────────────────────────────
//
// Only what overlay-host.js touches. `style.decls` keeps ORDER and PRIORITY,
// because "inline" and "!important" are the whole point of the host styling and
// a stub that dropped either would certify a defence that isn't there.
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    id: "",
    className: "",
    textContent: "",
    children: [],
    attrs: {},
    shadowRoot: null,
    style: {
      decls: [],
      setProperty(name, value, priority) {
        this.decls.push([name, value, priority || ""]);
      },
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(n) {
      this.children.push(n);
      return n;
    },
    attachShadow(opts) {
      this.shadowRoot = {
        mode: (opts || {}).mode,
        children: [],
        adoptedStyleSheets: [],
        appendChild(n) {
          this.children.push(n);
          return n;
        },
      };
      return this.shadowRoot;
    },
  };
}

/**
 * @param {object} opts
 *   constructable — expose a CSSStyleSheet constructor on defaultView
 *   noShadow      — created elements have no attachShadow (the degraded branch)
 */
function makeDoc(opts) {
  const o = opts || {};
  const built = [];
  const doc = {
    built,
    sheets: [],
    createElement(tag) {
      const n = makeEl(tag);
      if (o.noShadow) delete n.attachShadow;
      built.push(n);
      return n;
    },
    defaultView: {},
  };
  if (o.constructable) {
    const sheets = doc.sheets;
    doc.defaultView.CSSStyleSheet = function CSSStyleSheet() {
      this.cssText = null;
      this.replaceSync = function (css) {
        this.cssText = css;
      };
      sheets.push(this);
    };
  }
  return doc;
}

// ── 1. The generated stylesheet module is in sync with the .css ─────────────
//
// The shadow root's isolation is worth nothing if the styles it adopts are last
// week's. Re-run the derivation rather than trusting that someone remembered.
const { drift } = require(path.join(repoRoot, "scripts", "lib", "extension-overlay-css.cjs"));
assert.deepStrictEqual(
  drift(repoRoot),
  [],
  "overlay-css.js is stale or hand-edited. Run: node scripts/gen-extension-overlay-css.mjs",
);

const cssSource = fs.readFileSync(path.join(dir, CSS_REL), "utf8").replace(/\r\n/g, "\n");
assert.ok(CSS.length > 500, "the generated sheet is suspiciously short");
assert.ok(
  CSS.includes("#gt-cc-overlay.gt-cc-root"),
  "the generated sheet must carry the overlay card rule",
);

// ── 2. The card lands INSIDE the shadow tree, not in the page ───────────────
{
  const doc = makeDoc({ constructable: true });
  const m = SHADOW.createOverlayHost(doc, "gt-cc-overlay", CSS);
  assert.ok(m.shadow, "createOverlayHost must attach a shadow root");
  assert.strictEqual(m.shadow.mode, "open");
  assert.notStrictEqual(m.root, m.host, "the card must be a node inside the shadow, not the host");
  assert.ok(
    m.shadow.children.indexOf(m.root) >= 0,
    "the card must be a child of the shadow root — a card appended to the HOST is in the " +
      "page's tree and every rule the site ships can reach it",
  );
  assert.strictEqual(m.host.children.length, 0, "nothing may be appended to the host itself");
  assert.strictEqual(m.root.className, "gt-cc-root");
  // Ids are scoped per tree, so the same id on host and card is not a duplicate —
  // and it is what lets the stylesheet keep its `#gt-cc-overlay ...` selectors.
  assert.strictEqual(m.host.id, "gt-cc-overlay");
  assert.strictEqual(m.root.id, "gt-cc-overlay");
}

// ── 3. The host's layout is inline AND !important ───────────────────────────
//
// The host is the only node a marketplace can select. An author `!important`
// rule beats any normal declaration we write, including an inline one — only an
// inline `!important` sits above it.
{
  const doc = makeDoc({ constructable: true });
  const m = SHADOW.createOverlayHost(doc, "gt-cc-overlay", CSS);
  const decls = m.host.style.decls;
  assert.ok(decls.length > 0, "the host must carry inline layout declarations");
  assert.strictEqual(
    decls[0][0],
    "all",
    "`all` must be the FIRST inline declaration — it resets everything, so anything " +
      "declared before it would be wiped",
  );
  for (const d of decls) {
    assert.strictEqual(
      d[2],
      "important",
      `host declaration "${d[0]}" is not !important — a site rule could outrank it`,
    );
  }
  const names = decls.map((d) => d[0]);
  for (const required of ["position", "z-index", "width", "max-width", "max-height", "display"]) {
    assert.ok(names.includes(required), `the host must declare ${required} inline`);
  }
  assert.strictEqual(
    decls.filter((d) => d[0] === "position")[0][1],
    "fixed",
    "the overlay is a fixed corner card",
  );

  // ── US-2622: the host is BOUNDED, and it is a column ──────────────────────
  //
  // Without a height cap a card anchored at `bottom` grows upward off the top of
  // the viewport, taking its header (and therefore the close button) with it, and
  // nothing scrolls because a fixed element ignores the page's scroll. That is
  // not a styling nit: it is an overlay the shopper can neither read nor dismiss.
  const maxHeights = decls.filter((d) => d[0] === "max-height").map((d) => d[1]);
  assert.ok(
    maxHeights.length >= 1,
    "the host must cap its own height — an uncapped card grows off the top of the viewport",
  );
  assert.ok(
    maxHeights.some((v) => v.includes("dvh")),
    "the last max-height must be in dvh: on a phone `vh` is frozen at the tallest viewport, " +
      "so a vh-only cap hides the bottom of the card behind the URL bar",
  );
  assert.ok(
    maxHeights.some((v) => v.includes("vh") && !v.includes("dvh")),
    "keep a `vh` cap before the dvh one — an engine without dvh drops that declaration " +
      "as invalid and would be left with no cap at all",
  );
  assert.strictEqual(
    decls.filter((d) => d[0] === "display").pop()[1],
    "flex",
    "the host lays the card out as a flex item so the card can shrink inside the cap",
  );
  assert.ok(
    names.includes("flex-direction"),
    "the host must declare flex-direction — a row would cap the card's WIDTH, not its height",
  );
}

// ── 4. …and the stylesheet must NOT re-declare that layout ──────────────────
//
// Two copies of the same layout is two copies that drift. The card rule lives
// inside the shadow root where it cannot position the host anyway, so a
// `position` there is dead weight that reads as authoritative.
{
  const cardRule = /#gt-cc-overlay\.gt-cc-root\s*\{([^}]*)\}/.exec(cssSource);
  assert.ok(cardRule, `${CSS_REL} must still declare the card rule`);
  for (const dead of ["position:", "z-index:", "right:", "bottom:"]) {
    assert.ok(
      !cardRule[1].includes(dead),
      `${CSS_REL}: the card rule declares "${dead}" — positioning belongs to the shadow HOST ` +
        `(overlay-host.js OVERLAY_HOST_STYLE), and a second copy here will drift from it`,
    );
  }
  assert.ok(
    /box-sizing:\s*border-box/.test(cardRule[1]),
    `${CSS_REL}: the card rule resets with \`all: initial\`, which restores content-box — ` +
      "without border-box its 1px border overflows the host's fixed width",
  );

  // ── US-2622: the card absorbs a report of ANY length by scrolling ─────────
  //
  // The host's cap is only half the fix. A capped host containing a card that
  // cannot shrink just moves the overflow one node down: the card still renders
  // at its full 1100px, `overflow: hidden` on it clips the rest, and the shopper
  // reads a report that stops mid-sentence with no way to see the end.
  //
  // Three declarations make the difference, and each is easy to drop in a later
  // edit without anything looking wrong on a SHORT read — which is exactly the
  // read a developer tests with.
  assert.ok(
    /display:\s*flex/.test(cardRule[1]) && /flex-direction:\s*column/.test(cardRule[1]),
    `${CSS_REL}: the card must be a flex COLUMN — the header is fixed-size and the body is ` +
      "the part that scrolls, which is a relationship only a flex column expresses",
  );
  assert.ok(
    /min-height:\s*0/.test(cardRule[1]),
    `${CSS_REL}: the card needs \`min-height: 0\` — a flex item refuses to shrink below its ` +
      "content without it, so the card would overflow the host's cap and clip the report",
  );

  const bodyRule = /#gt-cc-overlay\s+\.gt-cc-body\s*\{([^}]*)\}/.exec(cssSource);
  assert.ok(bodyRule, `${CSS_REL} must declare the body rule`);
  assert.ok(
    /overflow-y:\s*auto/.test(bodyRule[1]),
    `${CSS_REL}: .gt-cc-body must scroll — it is the only part of the card that may, and ` +
      "the report's length is the endpoint's choice, not ours",
  );
  assert.ok(
    /min-height:\s*0/.test(bodyRule[1]),
    `${CSS_REL}: .gt-cc-body needs \`min-height: 0\` or it never shrinks and never scrolls`,
  );
  assert.ok(
    /overscroll-behavior:\s*contain/.test(bodyRule[1]),
    `${CSS_REL}: .gt-cc-body must contain its overscroll — otherwise a flick that reaches the ` +
      "end of the report keeps going and scrolls the marketplace's page underneath",
  );
}

// ── 4b. The header carries a way out, and it is always reachable ────────────
//
// The close button used to be the only control, and it lived at the top of a card
// that could be taller than the screen. Both controls are now pinned in a header
// the card may not shrink, so this checks the pieces are all present: the content
// script builds them, and the sheet styles them.
{
  const src = fs.readFileSync(path.join(dir, `${SUB}/marketplace.js`), "utf8");
  assert.ok(
    /class="gt-cc-head"|"gt-cc-head"/.test(src),
    `${SUB}/marketplace.js must still render a header bar`,
  );
  assert.ok(
    src.includes('el("button", "gt-cc-collapse")'),
    `${SUB}/marketplace.js must render the collapse control — on a long read it is the only ` +
      "way to get the page back without discarding the grade",
  );
  assert.ok(
    /body\.setAttribute\("tabindex", "0"\)/.test(src),
    `${SUB}/marketplace.js: the scrolling body must be focusable, or it cannot be scrolled ` +
      "from the keyboard at all",
  );
  const headRule = /#gt-cc-overlay\s+\.gt-cc-head\s*\{([^}]*)\}/.exec(cssSource);
  assert.ok(headRule, `${CSS_REL} must declare the header rule`);
  assert.ok(
    /flex:\s*0 0 auto/.test(headRule[1]),
    `${CSS_REL}: .gt-cc-head must not shrink — it carries the collapse and close controls, ` +
      "and a squeezed header is an overlay that cannot be dismissed",
  );
  assert.ok(
    /\.gt-cc-collapsed\s+\.gt-cc-body\s*\{[^}]*display:\s*none/.test(cssSource),
    `${CSS_REL}: the collapsed state must hide the body`,
  );
}

// ── 5. The sheet travels with the nodes, both ways ──────────────────────────
{
  const doc = makeDoc({ constructable: true });
  const m = SHADOW.createOverlayHost(doc, "gt-cc-overlay", CSS);
  assert.strictEqual(m.styles, "adopted");
  assert.strictEqual(m.shadow.adoptedStyleSheets.length, 1);
  assert.strictEqual(m.shadow.adoptedStyleSheets[0].cssText, CSS);
  assert.ok(
    !m.shadow.children.some((c) => c.tagName === "STYLE"),
    "an adopted sheet should not also append a <style>",
  );
}
{
  // No constructable stylesheets → a plain <style>, still inside the shadow.
  const doc = makeDoc({ constructable: false });
  const m = SHADOW.createOverlayHost(doc, "gt-cc-overlay", CSS);
  assert.strictEqual(m.styles, "style");
  const style = m.shadow.children.filter((c) => c.tagName === "STYLE")[0];
  assert.ok(style, "the fallback must append a <style> to the SHADOW root");
  assert.strictEqual(style.textContent, CSS);
}

// ── 6. One sheet, not one per host ──────────────────────────────────────────
//
// A search grid badges up to a couple of dozen tiles. Per-host <style> nodes
// would copy the whole sheet that many times into the page.
{
  const doc = makeDoc({ constructable: true });
  const a = SHADOW.createBadgeHost(doc, CSS, "gt-cc-b-good");
  const b = SHADOW.createBadgeHost(doc, CSS, "gt-cc-b-bad");
  assert.strictEqual(doc.sheets.length, 1, "the sheet must be constructed once per document");
  assert.strictEqual(
    a.shadow.adoptedStyleSheets[0],
    b.shadow.adoptedStyleSheets[0],
    "every shadow root must adopt the SAME sheet object",
  );
  assert.strictEqual(a.root.className, "gt-cc-badge-row gt-cc-b-good");
  assert.strictEqual(b.root.className, "gt-cc-badge-row gt-cc-b-bad");
  assert.ok(a.shadow.children.indexOf(a.root) >= 0, "the badge row must live in its shadow root");
}

// ── 7. The degraded branch is the OLD behaviour, not a broken one ───────────
//
// Unreachable on the browsers these manifests support, which is why it is worth
// pinning: nobody would notice it rotting.
{
  const doc = makeDoc({ noShadow: true });
  const m = SHADOW.createOverlayHost(doc, "gt-cc-overlay", CSS);
  assert.strictEqual(m.shadow, null);
  assert.strictEqual(m.root, m.host, "with no shadow DOM the host IS the card");
  assert.strictEqual(m.root.className, "gt-cc-root");
  assert.strictEqual(m.root.id, "gt-cc-overlay", "the id-scoped selectors must still match");
  const style = m.host.children.filter((c) => c.tagName === "STYLE")[0];
  assert.ok(style, "the degraded path still needs its styles");

  const badge = SHADOW.createBadgeHost(doc, CSS, "gt-cc-b-warn");
  assert.strictEqual(badge.root, badge.host);
  assert.strictEqual(badge.root.className, "gt-cc-badge-row gt-cc-b-warn");
}

// ── 8. The content script actually mounts through it ────────────────────────
//
// Everything above tests the helper. This is what stops a future edit from
// quietly going back to appending the card straight into the page — which no
// styling test would catch, because on a tame site it looks identical.
{
  const src = fs.readFileSync(path.join(dir, `${SUB}/marketplace.js`), "utf8");
  assert.ok(
    src.includes("SHADOW.createOverlayHost("),
    `${SUB}/marketplace.js must mount the overlay through the shadow host`,
  );
  assert.ok(
    !/document\.body\.appendChild\(root\)/.test(src),
    `${SUB}/marketplace.js appends the CARD to document.body — it must append the shadow HOST`,
  );
  assert.ok(
    /document\.body\.appendChild\(host\)/.test(src),
    `${SUB}/marketplace.js must append the shadow host to the page`,
  );
  // Badges only exist in the unified extension's scan mode.
  if (src.includes("gt-cc-badge-row")) {
    assert.ok(
      src.includes("SHADOW.createBadgeHost("),
      `${SUB}/marketplace.js builds badge rows without a shadow host`,
    );
  }
}

// ── 9. The manifest ships the pieces, in order ──────────────────────────────
//
// overlay-css.js and overlay-host.js must load BEFORE marketplace.js reads them
// off `self`, and the old document-level `"css"` entry must be gone: it would
// inject a sheet the shadow root cannot use while implying the styling is
// handled.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const cs = (manifest.content_scripts || []).find(
    (c) => Array.isArray(c.js) && c.js.some((j) => j.endsWith("marketplace.js")),
  );
  assert.ok(cs, "manifest must have the marketplace content_scripts entry");
  assert.ok(
    !cs.css || cs.css.length === 0,
    "the marketplace content script must not inject a document stylesheet — the overlay lives " +
      "in a shadow root, which a document stylesheet cannot reach",
  );
  const iCss = cs.js.indexOf(`${SUB}/overlay-css.js`);
  const iHost = cs.js.indexOf(`${SUB}/overlay-host.js`);
  const iMain = cs.js.findIndex((j) => j.endsWith("marketplace.js"));
  assert.ok(iCss >= 0, `manifest must load ${SUB}/overlay-css.js`);
  assert.ok(iHost >= 0, `manifest must load ${SUB}/overlay-host.js`);
  assert.ok(iCss < iMain && iHost < iMain, "both must load before marketplace.js");
}

console.log(`overlay-shadow.test.cjs (${SUB}): all assertions passed`);
