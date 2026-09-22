// GradeThread closet import — the reader's refusals, executed (US-9201).
//
// Runs closet-import/content.js against a stub page and asks it to read, the
// way the background does with GT_CLOSET_IMPORT_READ. The assertions are about
// the reader's DECISIONS: it must refuse a human check, a login wall, a page
// that is not a closet, and a closet that is not the seller's own, and it must
// read nothing at all until asked.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dir = path.resolve(__dirname, "..");
const CONTENT_SRC = fs.readFileSync(path.join(dir, "closet-import/content.js"), "utf8");
const EXTRACT_SRC = fs.readFileSync(path.join(dir, "closet-import/extract.js"), "utf8");

function makeDocument(hits) {
  const get = (sel) => (Object.prototype.hasOwnProperty.call(hits, sel) ? hits[sel] : []);
  return {
    body: {},
    querySelector: (sel) => get(sel)[0] || null,
    querySelectorAll: (sel) => get(sel),
  };
}

/** Run the content script on a fake page; return { sent, listeners, ask }. */
function runContent({ href, hits, selectors, document, window }) {
  const sent = [];
  const listeners = [];
  const sandbox = {
    console, setTimeout, clearTimeout, Date, RegExp, Array, Object, Boolean, String, JSON, Number, Set,
    Promise, Math,
    URL,
    location: new URL(href),
    document: document || makeDocument(hits),
    // US-3459: the reader scrolls before it reads. Rounds wait 5ms here rather
    // than the shipped 700ms, and a test that wants growth passes a window
    // whose scrollTo appends tiles.
    GT_CLOSET_IMPORT_TUNING: { settleMs: 5, maxRounds: 20 },
  };
  if (window) sandbox.window = window;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.chrome = {
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACT_SRC, sandbox);
  sandbox.GT_CLOSET_IMPORT_SELECTORS = selectors;
  vm.runInContext(CONTENT_SRC, sandbox);
  // US-3459: the listener answers asynchronously (it returns true and calls
  // sendResponse after the scroll drive), so asking is a promise. A message
  // type the reader ignores resolves null on the next tick.
  const ask = (type) =>
    new Promise((resolve) => {
      let answered = false;
      let kept = false;
      for (const fn of listeners) {
        const r = fn({ type: type || "GT_CLOSET_IMPORT_READ" }, {}, (out) => {
          answered = true;
          // Objects built inside the vm context carry that context's Object
          // prototype, which deepStrictEqual treats as a different type. The
          // background receives this over runtime messaging as structured-cloned
          // JSON anyway, so compare what it would see.
          resolve(out == null ? out : JSON.parse(JSON.stringify(out)));
        });
        if (r === true) kept = true;
      }
      if (!kept && !answered) setTimeout(() => resolve(null), 0);
    });
  return { sent, listeners, ask };
}

const POSH_ID = "5f1e2d3c4b5a69788796a5b4";

const ADAPTER = {
  poshmark: {
    enabled: true,
    hosts: ["poshmark.com"],
    login: { urlPattern: "poshmark\\.com/(login|signup)" },
    humanCheck: "#captcha",
    urlUpgrade: { pattern: "/(?:s|m|t)_(?=[^/]*$)", replacement: "/l_", flags: "i" },
    imageAttrs: ["src", "data-src"],
    closet: {
      urlPattern: "poshmark\\.com/closet/",
      ownClosetTell: "#mine",
      tile: ".tile",
      fields: { listingUrl: "a.listing", title: ".title", priceText: ".price", sizeText: ".size", brandText: ".brand", image: "img" },
      soldBadge: ".sold",
      pagination: { endMarker: "#end" },
    },
    detail: {
      urlPattern: "poshmark\\.com/listing/",
      ownListingTell: "#edit",
      title: "h1",
      description: ".desc",
      priceText: ".price",
      sizeText: ".size",
      brandText: ".brand",
      conditionText: ".cond",
      gallery: ".gallery img",
    },
  },
};

function tile({ url, title, price, size, brand, img, sold }) {
  return makeDocument({
    "a.listing": url ? [{ href: url }] : [],
    ".title": title ? [{ textContent: title }] : [],
    ".price": price ? [{ textContent: price }] : [],
    ".size": size ? [{ textContent: size }] : [],
    ".brand": brand ? [{ textContent: brand }] : [],
    "img": img ? [{ getAttribute: (a) => (a === "src" ? img : null) }] : [],
    ".sold": sold ? [{}] : [],
  });
}

(async () => {
// ── 1. Nothing is read or sent until asked ─────────────────────────────────
{
  const r = runContent({
    href: "https://poshmark.com/closet/me",
    hits: { "#mine": [{}], ".tile": [tile({ url: `https://poshmark.com/listing/x-${POSH_ID}`, title: "Tee" })] },
    selectors: ADAPTER,
  });
  assert.strictEqual(r.sent.length, 0, "the reader sent something without being asked");
  assert.strictEqual(r.listeners.length, 1, "the reader must listen for GT_CLOSET_IMPORT_READ");
  assert.strictEqual(await r.ask("GT_SOMETHING_ELSE"), null, "another message type gets no answer");
}

// ── 2. A human check stops the read and says so ────────────────────────────
{
  const r = runContent({
    href: "https://poshmark.com/closet/me",
    hits: { "#captcha": [{}], "#mine": [{}], ".tile": [tile({ url: `https://poshmark.com/listing/x-${POSH_ID}`, title: "Tee" })] },
    selectors: ADAPTER,
  });
  assert.deepStrictEqual(await r.ask(), { ok: false, reason: "human_check" });
}

// ── 3. A login wall reads no rows ─────────────────────────────────────────
{
  const r = runContent({
    href: "https://poshmark.com/closet/me",
    hits: { 'input[type="password"]': [{}], "#mine": [{}], ".tile": [tile({ url: `https://poshmark.com/listing/x-${POSH_ID}`, title: "Tee" })] },
    selectors: ADAPTER,
  });
  assert.deepStrictEqual(await r.ask(), { ok: false, reason: "not_signed_in" });
  const r2 = runContent({ href: "https://poshmark.com/login?next=/closet/me", hits: {}, selectors: ADAPTER });
  assert.strictEqual((await r2.ask()).reason, "wrong_page", "the login URL is not a closet page at all");
}

// ── 4. Somebody else's closet is refused before a tile is read ─────────────
{
  const r = runContent({
    href: "https://poshmark.com/closet/somebody_else",
    hits: { ".tile": [tile({ url: `https://poshmark.com/listing/x-${POSH_ID}`, title: "Their tee" })] },
    selectors: ADAPTER,
  });
  assert.deepStrictEqual(await r.ask(), { ok: false, reason: "not_own_closet" });
}

// ── 5. The wrong host does nothing; a disabled adapter does nothing ───────
{
  const r = runContent({ href: "https://poshmark.example/closet/me", hits: { "#mine": [{}] }, selectors: ADAPTER });
  assert.strictEqual(r.listeners.length, 0, "a lookalike host must not even register the listener");
  const off = JSON.parse(JSON.stringify(ADAPTER));
  off.poshmark.enabled = false;
  const r2 = runContent({ href: "https://poshmark.com/closet/me", hits: { "#mine": [{}] }, selectors: off });
  assert.strictEqual(r2.listeners.length, 0, "a disabled adapter must not register the listener");
}

// ── 6. The closet read: tiles become allowlisted listings, sold tiles skipped ─
{
  const r = runContent({
    href: "https://poshmark.com/closet/me",
    hits: {
      "#mine": [{}],
      "#end": [{}],
      ".tile": [
        tile({ url: `https://poshmark.com/listing/Tee-${POSH_ID}`, title: "Tee", price: "$24", size: "M", brand: "Madewell", img: "https://di2ponv0v5otw.cloudfront.net/posts/1/s_abcdef1234.jpg" }),
        tile({ url: "https://poshmark.com/listing/Sold-aaaaaaaaaaaaaaaaaaaaaaaa", title: "Sold one", sold: true }),
        tile({ title: "No link" }),
      ],
    },
    selectors: ADAPTER,
  });
  const out = await r.ask();
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.batch.platform, "poshmark");
  assert.strictEqual(out.batch.page, "closet");
  assert.strictEqual(out.batch.listings.length, 1, "sold and unlinked tiles are not listings");
  const l = out.batch.listings[0];
  assert.strictEqual(l.platformListingId, POSH_ID);
  assert.strictEqual(l.priceCents, 2400);
  assert.strictEqual(l.size, "M");
  assert.strictEqual(l.brand, "Madewell");
  assert.deepStrictEqual(l.photoUrls, ["https://di2ponv0v5otw.cloudfront.net/posts/1/l_abcdef1234.jpg"]);
  assert.strictEqual(l.detail, false);
  assert.deepStrictEqual(out.batch.coverage, { tilesRead: 3, reachedEnd: true, scrollRounds: 0, stoppedBecause: "end_marker" });
  assert.strictEqual(r.sent.length, 0, "the reader answers the request; it does not post on its own");
}

// ── 7. The detail read on the seller's own listing page ───────────────────
{
  const href = `https://poshmark.com/listing/Nice-Tee-${POSH_ID}`;
  const r = runContent({
    href,
    hits: {
      "#edit": [{}],
      "h1": [{ textContent: "Nice Tee" }],
      ".desc": [{ textContent: "Soft cotton, worn twice." }],
      ".price": [{ textContent: "$24" }],
      ".size": [{ textContent: "M" }],
      ".brand": [{ textContent: "Madewell" }],
      ".cond": [{ textContent: "Like new" }],
      ".gallery img": [
        { getAttribute: (a) => (a === "src" ? "https://di2ponv0v5otw.cloudfront.net/posts/1/s_aaaaaaaaaa.jpg" : null) },
        { getAttribute: (a) => (a === "src" ? "https://di2ponv0v5otw.cloudfront.net/posts/1/s_bbbbbbbbbb.jpg" : null) },
      ],
    },
    selectors: ADAPTER,
  });
  const out = await r.ask();
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.batch.page, "detail");
  const l = out.batch.listings[0];
  assert.strictEqual(l.description, "Soft cotton, worn twice.");
  assert.strictEqual(l.condition, "Like new");
  assert.strictEqual(l.detail, true);
  assert.strictEqual(l.photoUrls.length, 2);

  // A stranger's listing page (no owner control) is refused.
  const r2 = runContent({ href, hits: { "h1": [{ textContent: "Their tee" }] }, selectors: ADAPTER });
  assert.deepStrictEqual(await r2.ask(), { ok: false, reason: "not_own_listing" });
}

// ── 8. A closet with nothing recognisable says so rather than "zero listings" ─
{
  const r = runContent({ href: "https://poshmark.com/closet/me", hits: { "#mine": [{}] }, selectors: ADAPTER });
  assert.deepStrictEqual(await r.ask(), { ok: false, reason: "nothing_read" });
}

// ── 9. US-3459: the reader drives an infinite-scroll closet to its end ────
{
  // A closet that appends 2 tiles per scroll, 3 times, then stops.
  const tiles = [tile({ url: `https://poshmark.com/listing/A-${POSH_ID}`, title: "A" })];
  const ids = ["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccc", "dddddddddddddddddddddddd", "eeeeeeeeeeeeeeeeeeeeeeee", "ffffffffffffffffffffffff"];
  let scrolls = 0;
  const doc = {
    body: { scrollHeight: 1000 },
    documentElement: { scrollHeight: 1000 },
    querySelector: (sel) => (sel === "#mine" ? {} : null),
    querySelectorAll: (sel) => (sel === ".tile" ? tiles.slice() : []),
  };
  const win = {
    scrollTo: () => {
      scrolls += 1;
      if (scrolls <= 3) {
        for (let k = 0; k < 2; k += 1) {
          const id = ids.shift();
          tiles.push(tile({ url: `https://poshmark.com/listing/T-${id}`, title: "T" + id }));
        }
      }
    },
  };
  const r = runContent({ href: "https://poshmark.com/closet/me", document: doc, window: win, selectors: ADAPTER });
  const out = await r.ask();
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.batch.listings.length, 7, "every tile the scroll produced is read, not just the first screen");
  assert.strictEqual(out.batch.coverage.tilesRead, 7);
  assert.strictEqual(out.batch.coverage.reachedEnd, true, "a closet that stopped growing counts as read to the end");
  assert.strictEqual(out.batch.coverage.stoppedBecause, "settled");
  // 3 growing rounds + 3 quiet rounds.
  assert.strictEqual(out.batch.coverage.scrollRounds, 6);
  assert.strictEqual(scrolls, 6, "the drive scrolls once per round and stops after three quiet rounds");
}

// ── 10. The end marker stops the drive before any scroll ──────────────────
{
  let scrolls = 0;
  const r = runContent({
    href: "https://poshmark.com/closet/me",
    hits: { "#mine": [{}], "#end": [{}], ".tile": [tile({ url: `https://poshmark.com/listing/x-${POSH_ID}`, title: "Tee" })] },
    window: { scrollTo: () => { scrolls += 1; } },
    selectors: ADAPTER,
  });
  const out = await r.ask();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(scrolls, 0, "a closet already showing its end marker is not scrolled");
  assert.deepStrictEqual(out.batch.coverage, { tilesRead: 1, reachedEnd: true, scrollRounds: 0, stoppedBecause: "end_marker" });
}

// ── 11. A closet that never stops growing hits the round cap and says so ──
{
  const tiles = [];
  let n = 0;
  const doc = {
    body: {},
    documentElement: {},
    querySelector: (sel) => (sel === "#mine" ? {} : null),
    querySelectorAll: (sel) => (sel === ".tile" ? tiles.slice() : []),
  };
  const win = {
    scrollTo: () => {
      n += 1;
      tiles.push(tile({ url: `https://poshmark.com/listing/G-${String(n).padStart(24, "0")}`, title: "G" + n }));
    },
  };
  const r = runContent({ href: "https://poshmark.com/closet/me", document: doc, window: win, selectors: ADAPTER });
  const out = await r.ask();
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.batch.coverage.stoppedBecause, "round_cap", "a cap is reported as a cap, never as the end");
  assert.strictEqual(out.batch.coverage.reachedEnd, false);
  assert.strictEqual(out.batch.coverage.scrollRounds, 20, "the tuning's maxRounds bounds the drive");
}

// ── 12. The wall-clock cap ends a drive that a slow page would otherwise hold ─
{
  const tiles = [];
  let n = 0;
  const doc = {
    body: {},
    documentElement: {},
    querySelector: (sel) => (sel === "#mine" ? {} : null),
    querySelectorAll: (sel) => (sel === ".tile" ? tiles.slice() : []),
  };
  const win = {
    scrollTo: () => {
      n += 1;
      tiles.push(tile({ url: `https://poshmark.com/listing/S-${String(n).padStart(24, "0")}`, title: "S" + n }));
    },
  };
  const r = runContent({ href: "https://poshmark.com/closet/me", document: doc, window: win, selectors: ADAPTER });
  // Override AFTER load: the reader reads its tuning at load time, so set it
  // on the sandbox before the script ran. runContent does that, so rebuild
  // with a 1ms cap instead.
  const r2 = (() => {
    const sent = [];
    const listeners = [];
    const sandbox = {
      console, setTimeout, clearTimeout, Date, RegExp, Array, Object, Boolean, String, JSON, Number, Set, Promise, Math, URL,
      location: new URL("https://poshmark.com/closet/me"),
      document: doc,
      window: win,
      GT_CLOSET_IMPORT_TUNING: { settleMs: 5, timeCapMs: 1 },
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.chrome = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve({ ok: true }); }, onMessage: { addListener: (fn) => listeners.push(fn) } } };
    vm.createContext(sandbox);
    vm.runInContext(EXTRACT_SRC, sandbox);
    sandbox.GT_CLOSET_IMPORT_SELECTORS = ADAPTER;
    vm.runInContext(CONTENT_SRC, sandbox);
    return new Promise((resolve) => {
      for (const fn of listeners) fn({ type: "GT_CLOSET_IMPORT_READ" }, {}, (out) => resolve(JSON.parse(JSON.stringify(out))));
    });
  })();
  void r;
  const out = await r2;
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.batch.coverage.stoppedBecause, "time_cap");
  assert.strictEqual(out.batch.coverage.reachedEnd, false);
  assert.ok(out.batch.coverage.scrollRounds >= 1 && out.batch.coverage.scrollRounds < 20, "the time cap fired before the round cap");
}

// ── 10. Vinted, against the SHIPPED adapter (US-3460) ─────────────────────
//
// The sections above run a stub adapter, which is right for testing the
// reader's decisions. This one runs the real `vinted` entry out of
// closet-import/selectors.js, because Vinted is the first adapter whose FIELD
// SHAPE is different: its own wardrobe tile prints view and favourite counts
// and nothing else, so the title is read from the overlay link's `title`
// attribute and cut at the first localised ", label: " pair. If that path ever
// stops working the wardrobe reads as titleless, every row is dropped by
// buildListing, and the seller is told "nothing_read" about a wardrobe that is
// plainly full of listings.
{
  const SEL = (function () {
    const src = fs.readFileSync(path.join(dir, "closet-import/selectors.js"), "utf8");
    return new Function("self", `${src}; return self.GT_CLOSET_IMPORT_SELECTORS;`)({});
  })();
  const V = SEL.vinted;
  const f = V.closet.fields;

  const vintedTile = (href, titleAttr, price) =>
    makeDocument({
      [f.listingUrl]: [{ href, getAttribute: (a) => (a === "title" ? titleAttr : null) }],
      [f.title.selector]: [{ href, getAttribute: (a) => (a === "title" ? titleAttr : null) }],
      [f.priceText]: price ? [{ textContent: price }] : [],
    });

  const ALT =
    "Toad&Co Women's Size 10 Gray Corduroy Stretch Pants Low, brand: Toad & co, " +
    "condition: Good, size: M, $28.00";

  // A stranger's wardrobe carries none of the four owner controls.
  {
    const r = runContent({
      href: "https://www.vinted.com/member/3189284341",
      hits: { [V.closet.tile]: [vintedTile("https://www.vinted.com/items/10090867021-x", "Their tee", "$7.00")] },
      selectors: SEL,
    });
    assert.deepStrictEqual(await r.ask(), { ok: false, reason: "not_own_closet" });
  }

  // /member/notifications is a real signed-in path and is NOT a wardrobe.
  {
    const r = runContent({
      href: "https://www.vinted.com/member/notifications",
      hits: { [V.closet.ownClosetTell]: [{}] },
      selectors: SEL,
    });
    assert.strictEqual((await r.ask()).reason, "wrong_page", "/member/<word> must not read as a wardrobe");
  }

  // The seller's own wardrobe: title out of the attribute, price out of the
  // tile, no photo at all.
  {
    const r = runContent({
      href: "https://www.vinted.com/member/3175192152",
      hits: {
        [V.closet.ownClosetTell]: [{}],
        [V.closet.tile]: [
          vintedTile("https://www.vinted.com/items/9967483973-toadco-womens-size-10", ALT, "$28.00"),
        ],
      },
      selectors: SEL,
    });
    const out = await r.ask();
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.batch.platform, "vinted");
    assert.strictEqual(out.batch.listings.length, 1);
    const l = out.batch.listings[0];
    assert.strictEqual(l.platformListingId, "9967483973");
    assert.strictEqual(
      l.title,
      "Toad&Co Women's Size 10 Gray Corduroy Stretch Pants Low",
      "the localised ', brand: ...' tail must be cut off the title attribute",
    );
    assert.strictEqual(l.priceCents, 2800);
    assert.deepStrictEqual(l.photoUrls, [], "the 310x430 tile render is under the server's floor and is not read");
    assert.strictEqual(l.brand, null, "brand is localised on the tile and comes from the item page");
    assert.strictEqual(l.size, null, "size is localised on the tile and comes from the item page");
  }

  // Every locale host is reachable, not just .com.
  {
    const r = runContent({
      href: "https://www.vinted.fr/member/3175192152",
      hits: {
        [V.closet.ownClosetTell]: [{}],
        [V.closet.tile]: [vintedTile("https://www.vinted.fr/items/9967483973-x", "Pantalon, marque: Toad & co, $28.00", "28,00 €")],
      },
      selectors: SEL,
    });
    const out = await r.ask();
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.batch.listings[0].title, "Pantalon", "the cut is on the shape, not on the English label");
  }

  // The seller's own item page: the four owner controls, and photos that are
  // already full size.
  {
    const d = V.detail;
    const r = runContent({
      href: "https://www.vinted.com/items/9967483973-toadco-womens-size-10",
      hits: {
        [d.ownListingTell]: [{}],
        [d.title]: [{ textContent: "Toad&Co Women's Size 10 Gray Corduroy Stretch Pants Low" }],
        [d.description]: [{ textContent: "These grey pinstriped pants..." }],
        [d.priceText]: [{ textContent: "$28.00" }],
        [d.sizeText]: [{ textContent: "M" }],
        [d.brandText]: [{ textContent: "Toad & co" }],
        [d.conditionText]: [{ textContent: "Good" }],
        [d.gallery]: [
          { getAttribute: (a) => (a === "src" ? "https://images1.vinted.net/t/02_01e23_abc/f800/1789153408.webp?s=sig1" : null) },
          { getAttribute: (a) => (a === "src" ? "https://images1.vinted.net/t/06_01fd5_def/f800/1789153408.webp?s=sig2" : null) },
        ],
      },
      selectors: SEL,
    });
    const out = await r.ask();
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.batch.page, "detail");
    const l = out.batch.listings[0];
    assert.strictEqual(l.brand, "Toad & co");
    assert.strictEqual(l.size, "M");
    assert.strictEqual(l.condition, "Good");
    assert.strictEqual(l.photoUrls.length, 2, "two distinct assets under /t/<token>/");
    assert.ok(
      l.photoUrls.every((u) => u.includes("/f800/")),
      "no rewrite happens: Vinted signs the size into the path and a swapped segment 404s",
    );
  }

  // A stranger's item page is refused the same way.
  {
    const r = runContent({
      href: "https://www.vinted.com/items/10090867021-vintage-dickies-pants",
      hits: { [V.detail.title]: [{ textContent: "Vintage Dickies pants" }] },
      selectors: SEL,
    });
    assert.deepStrictEqual(await r.ask(), { ok: false, reason: "not_own_listing" });
  }
}

console.log("closet-import-content.test.cjs: refusals hold, closet and detail reads emit the allowlist, the scroll drive is bounded");

})().catch((e) => {
  console.error(e);
  process.exit(1);
});
