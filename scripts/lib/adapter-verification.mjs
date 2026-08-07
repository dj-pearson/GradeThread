// US-1880 — marketplace adapter verification mechanism.
//
// The story's AC1 ("each adapter verified against the live site … verified:true
// in BOTH config files") is the one criterion no agent can satisfy: it needs a
// real listing page rendered in a real browser. What an agent CAN do — and what
// was missing for two passes — is make that human step mechanical instead of
// undefined. This module is that mechanism, in two halves:
//
//   1. buildVerifySnippet() — a paste-into-DevTools script that runs the SHIPPED
//      selectors against the page the operator is looking at and prints a
//      pass/fail table. It INLINES extension-unified/research/image-utils.js
//      verbatim, so the snippet cannot drift from what the extension actually
//      does: it is the same applyUrlUpgrade / pickImageUrl / srcsetLargest /
//      dedupeUrls the content script calls.
//   2. setAdapterVerified() / setTopLevelString() / nextVersion() — the exact
//      three-field edit (verified, lastVerified, version) applied identically to
//      BOTH config files, because doing it by hand is how the two drift and the
//      US-1879 downgrade gate breaks.
//
// Pure text transforms, no fs — the CLI (scripts/adapter-verify.mjs) does the
// I/O and the test (scripts/adapter-verification.test.mjs) exercises these
// directly.
//
// The edits are deliberately INDENT-ANCHORED (4 spaces = an adapter block,
// 6 = a field inside one, 2 = a top-level field). Both config files are written
// that way, and an anchored match that stops matching fails loudly rather than
// quietly editing a nested `detect`/`search` block that happens to share a key
// name.

const ADAPTER_INDENT = "    "; // 4 — an adapter block inside `adapters`
const FIELD_INDENT = "      "; // 6 — a field inside an adapter
const TOP_INDENT = "  "; //     2 — a top-level config field

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keyPattern(key, json) {
  const k = json ? `"${escapeRe(key)}"` : escapeRe(key);
  return new RegExp(`^${ADAPTER_INDENT}${k}\\s*:\\s*\\{`, "m");
}

// Any adapter-level block, used to bound one adapter's slice of the file.
function anyAdapterPattern(json) {
  const k = json ? `"[A-Za-z_][\\w-]*"` : `[A-Za-z_]\\w*`;
  return new RegExp(`^${ADAPTER_INDENT}${k}\\s*:\\s*\\{`, "m");
}

// The text of exactly one adapter block: from its `key: {` line to the start of
// the next adapter block (or end of file). Returns { start, end } offsets into
// `src`, where `start` is the index just past the opening `{`.
export function adapterSlice(src, key, { json = false } = {}) {
  const m = keyPattern(key, json).exec(src);
  if (!m) throw new Error(`adapter "${key}" not found (expected a 4-space-indented "${key}: {" line)`);
  const start = m.index + m[0].length;
  const rest = src.slice(start);
  const next = anyAdapterPattern(json).exec(rest);
  return { start, end: next ? start + next.index : src.length };
}

// Flip one adapter's `verified` flag. Returns the new source; throws if the flag
// is absent from that adapter's block, or already holds the requested value
// (so a no-op mark can't be mistaken for a successful one).
export function setAdapterVerified(src, key, value, { json = false } = {}) {
  const { start, end } = adapterSlice(src, key, { json });
  const block = src.slice(start, end);
  const field = json ? `"verified"` : `verified`;
  const re = new RegExp(`^(${FIELD_INDENT}${field}\\s*:\\s*)(true|false)`, "m");
  const m = re.exec(block);
  if (!m) throw new Error(`adapter "${key}" has no 6-space-indented "verified" field`);
  if (m[2] === String(value)) {
    throw new Error(`adapter "${key}" is already verified:${value} — nothing to do`);
  }
  const patched = block.slice(0, m.index) + m[1] + String(value) + block.slice(m.index + m[0].length);
  return src.slice(0, start) + patched + src.slice(end);
}

// Read one adapter's `verified` flag without evaluating the file.
export function readAdapterVerified(src, key, { json = false } = {}) {
  const { start, end } = adapterSlice(src, key, { json });
  const field = json ? `"verified"` : `verified`;
  const re = new RegExp(`^${FIELD_INDENT}${field}\\s*:\\s*(true|false)`, "m");
  const m = re.exec(src.slice(start, end));
  if (!m) throw new Error(`adapter "${key}" has no "verified" field`);
  return m[1] === "true";
}

// Replace a top-level string field (`version`, `lastVerified`) in either file.
export function setTopLevelString(src, field, value, { json = false } = {}) {
  const f = json ? `"${escapeRe(field)}"` : escapeRe(field);
  const re = new RegExp(`^(${TOP_INDENT}${f}\\s*:\\s*")([^"]*)(")`, "m");
  const m = re.exec(src);
  if (!m) throw new Error(`top-level "${field}" not found (expected a 2-space-indented line)`);
  return src.slice(0, m.index) + m[1] + value + m[3] + src.slice(m.index + m[0].length);
}

export function readTopLevelString(src, field, { json = false } = {}) {
  const f = json ? `"${escapeRe(field)}"` : escapeRe(field);
  const re = new RegExp(`^${TOP_INDENT}${f}\\s*:\\s*"([^"]*)"`, "m");
  const m = re.exec(src);
  if (!m) throw new Error(`top-level "${field}" not found`);
  return m[1];
}

function versionParts(v) {
  return String(v ?? "")
    .trim()
    .split(".")
    .map((x) => {
      const n = parseInt(x, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

function versionGreater(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// The next config version for an edit made on `dateIso` (YYYY-MM-DD). The scheme
// is YYYY.MM.N: a new month restarts at .1, the same month increments.
//
// The result is ALWAYS strictly greater than `current`. That is not cosmetic —
// US-1879 makes the extension ignore a hosted config whose version is lower than
// the bundled one, so a backdated clock (or editing in a month earlier than the
// last bump) would otherwise publish a config that every install silently
// refuses. When the date-derived version would not be greater, the last
// component of the CURRENT version is incremented instead.
export function nextVersion(current, dateIso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateIso ?? ""));
  if (!m) throw new Error(`date must be YYYY-MM-DD, got "${dateIso}"`);
  const parts = versionParts(current);
  const [year, month] = [m[1], m[2]];
  const sameMonth = parts[0] === Number(year) && parts[1] === Number(month);
  const candidate = sameMonth
    ? `${year}.${month}.${(parts[2] || 0) + 1}`
    : `${year}.${month}.1`;
  if (versionGreater(candidate, current)) return candidate;
  // Keep the current version's own components verbatim (so "2026.07" does not
  // lose its zero padding) and increment only the last one.
  const literal = String(current).trim().split(".");
  literal[literal.length - 1] = String((parts[parts.length - 1] || 0) + 1);
  return literal.join(".");
}

// Evaluate the bundled JS config (a classic script that assigns self.GT_CC_CONFIG).
export function parseBundledConfig(src) {
  const selfObj = {};
  new Function("self", src)(selfObj);
  if (!selfObj.GT_CC_CONFIG) throw new Error("research/selectors.js did not assign self.GT_CC_CONFIG");
  return selfObj.GT_CC_CONFIG;
}

// ── the DevTools snippet ────────────────────────────────────────────────────
//
// Everything below builds ONE self-contained async IIFE the operator pastes into
// the console on a real listing page. Design constraints that matter:
//
//  * It embeds the adapter as data and the shipped helpers as SOURCE, so what it
//    measures is what the extension does. No second implementation to keep true.
//  * It reproduces marketplace.js's extractImageUrls()/firstText() step for step
//    — same attribute order, same first-selector-wins, same dedupe.
//  * It PROBES the upgraded URLs (naturalWidth) rather than trusting that a
//    rewritten URL is bigger. A URL-upgrade rule that silently matches nothing
//    is exactly the defect this story exists to fix, and only a measured pixel
//    width distinguishes "upgraded" from "the same thumbnail with a new name".

// Wrap image-utils.js so its UMD publishes into a LOCAL `self` and never takes
// the node branch. `var module;` leaves typeof module === "undefined".
function embedImageUtils(imageUtilsSrc) {
  return [
    "  const IMG = (function () {",
    "    var module;      // keep the UMD off its node branch",
    "    var self = {};   // and its export local to this snippet",
    imageUtilsSrc
      .split("\n")
      .map((l) => (l ? "    " + l : l))
      .join("\n"),
    "    return self.GT_CC_IMG;",
    "  })();",
  ].join("\n");
}

const SNIPPET_BODY = String.raw`
  const OK = "PASS", NO = "FAIL", MEH = "WARN";
  const out = [];
  function line(status, label, detail) {
    out.push({ status, check: label, detail: detail == null ? "" : String(detail) });
  }

  // 1. Is this page one this adapter claims?
  const matched = IMG.resolveAdapter({ [KEY]: ADAPTER }, location.host);
  line(matched ? OK : NO, "host matches adapter", location.host);
  const detail = IMG.isDetailPage(ADAPTER, location.pathname);
  line(detail ? OK : NO, "detected as a listing page", location.pathname);

  // 2. Gallery — first selector that matches any element wins, exactly as
  //    marketplace.js does it.
  let galleryEls = [], gallerySel = null;
  for (const sel of ADAPTER.gallery || []) {
    let found;
    try { found = document.querySelectorAll(sel); } catch (_e) { continue; }
    if (found && found.length) { galleryEls = Array.from(found); gallerySel = sel; break; }
  }
  line(gallerySel ? OK : NO, "gallery selector matched",
    gallerySel ? gallerySel + "  (" + galleryEls.length + " elements)" : "no gallery selector matched any element");

  // 3. Attribute -> URL -> upgrade, keeping the pre-upgrade URL so the upgrade
  //    rule itself can be judged rather than assumed.
  const attrs = ADAPTER.imageAttrs || ["src"];
  const pairs = [];
  for (const el of galleryEls) {
    const candidates = attrs.map(function (a) {
      const raw = el.getAttribute(a);
      if (!raw) return null;
      return a === "srcset" ? IMG.srcsetLargest(raw) : raw;
    });
    const chosen = IMG.pickImageUrl(candidates);
    if (chosen) pairs.push({ original: chosen, upgraded: IMG.applyUrlUpgrade(chosen, ADAPTER.urlUpgrade) });
  }
  line(pairs.length ? OK : NO, "gallery elements yielded URLs",
    pairs.length ? pairs.length + " of " + galleryEls.length + " elements"
                 : "elements matched but no usable URL — check imageAttrs / urlUpgrade");

  const cap = Number(ADAPTER.maxImages) || 4;
  const finalUrls = IMG.dedupeUrls(pairs.map(function (p) { return p.upgraded; }), cap, ADAPTER.assetIdPattern);
  line(finalUrls.length ? OK : NO, "URLs after dedupe + cap", finalUrls.length + " (cap " + cap + ")");

  // 4. Did the upgrade rule actually fire? A configured rule that rewrote
  //    nothing is the dead-regex bug (US-1880) in its natural habitat.
  if (ADAPTER.urlUpgrade) {
    const changed = pairs.filter(function (p) { return p.upgraded !== p.original; }).length;
    line(changed ? OK : NO, "urlUpgrade rewrote URLs",
      changed ? changed + " of " + pairs.length + " rewritten"
              : "rule is configured but matched NOTHING — thumbnails would be graded");
  } else {
    line(MEH, "urlUpgrade rewrote URLs", "no rule configured for this adapter");
  }

  // 5. Measure the delivered pixels. This is the AC's "full-res images on a real
  //    listing", and it is the only check here that cannot be faked by reading
  //    the config.
  async function probe(url) {
    return new Promise(function (resolve) {
      if (typeof Image !== "function") { resolve(null); return; }
      const img = new Image();
      let settled = false;
      const done = function (v) { if (!settled) { settled = true; resolve(v); } };
      img.onload = function () { done({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 10000);
      img.src = url;
    });
  }

  const probes = [];
  for (const p of pairs.slice(0, cap)) {
    const [before, after] = await Promise.all([probe(p.original), probe(p.upgraded)]);
    probes.push({ original: p.original, upgraded: p.upgraded, before: before, after: after });
  }

  let fullRes = 0, loadFailures = 0, shrunk = 0;
  for (const r of probes) {
    if (!r.after) { loadFailures++; continue; }
    if (Math.max(r.after.w, r.after.h) >= FULL_RES_MIN) fullRes++;
    if (r.before && r.after.w < r.before.w) shrunk++;
  }
  if (probes.length) {
    line(loadFailures ? NO : OK, "upgraded URLs load",
      (probes.length - loadFailures) + " of " + probes.length + " loaded");
    line(fullRes === probes.length ? OK : (fullRes ? MEH : NO), "images are full-res (>= " + FULL_RES_MIN + "px)",
      fullRes + " of " + probes.length);
    if (shrunk) line(NO, "upgrade made an image SMALLER", shrunk + " of " + probes.length);
  }

  // 6. Text fields. The title is required; the rest degrade to "" by design, so
  //    a miss is a WARN, not a failure.
  function firstText(selectors) {
    for (const sel of selectors || []) {
      let el;
      try { el = document.querySelector(sel); } catch (_e) { continue; }
      const txt = el && el.textContent && el.textContent.trim();
      if (txt) return { sel: sel, text: txt };
    }
    return null;
  }
  const TEXT_FIELDS = [
    ["title", ADAPTER.title, true],
    ["brandSelectors", ADAPTER.brandSelectors, false],
    ["sellerSelectors", ADAPTER.sellerSelectors, false],
    ["condition", ADAPTER.condition, false],
    ["price", ADAPTER.price, false],
  ];
  for (const [name, sels, required] of TEXT_FIELDS) {
    if (!sels || !sels.length) continue;
    const hit = firstText(sels);
    line(hit ? OK : (required ? NO : MEH), name,
      hit ? hit.text.slice(0, 60).replace(/\s+/g, " ") + "   [" + hit.sel + "]" : "no selector matched");
  }

  // ── report ────────────────────────────────────────────────────────────────
  const fails = out.filter(function (r) { return r.status === NO; }).length;
  const warns = out.filter(function (r) { return r.status === MEH; }).length;
  console.log("%cGradeThread adapter check — " + KEY + " (config v" + CONFIG_VERSION + ")",
    "font-weight:bold;font-size:13px");
  console.table(out);
  if (probes.length) {
    console.table(probes.map(function (r) {
      return {
        original: r.before ? r.before.w + "x" + r.before.h : "load failed",
        upgraded: r.after ? r.after.w + "x" + r.after.h : "load failed",
        url: r.upgraded,
      };
    }));
  }
  const verdict = fails ? "FAIL" : (warns ? "PASS (with warnings)" : "PASS");
  console.log("%cVERDICT: " + verdict + "  —  " + fails + " failing, " + warns + " warning",
    "font-weight:bold;font-size:13px;color:" + (fails ? "#E94560" : "#0F3460"));
  console.log(
    "Paste this line back into the story/runbook:\n" +
    "  " + KEY + " | " + location.host + " | " + new Date().toISOString().slice(0, 10) +
    " | config v" + CONFIG_VERSION + " | " + verdict);
  if (!fails) {
    console.log("Then record it:  node scripts/adapter-verify.mjs mark " + KEY);
  }
  return { adapter: KEY, verdict: verdict, fails: fails, warns: warns, rows: out, probes: probes };
`;

// The snippet's payload as a bare `async function () {...}` expression.
//
// Exported as its own seam so the test can `new Function(…)` it with a stub
// document/location/Image and assert on the VERDICT — running the same source
// the operator pastes, rather than a re-implementation of it. A snippet that is
// only ever eyeballed is a snippet nobody knows is broken.
export function buildVerifyFunctionSource({ adapterKey, adapter, version, imageUtilsSrc, fullResMin = 800 }) {
  if (!adapter) throw new Error(`no adapter config supplied for "${adapterKey}"`);
  if (typeof imageUtilsSrc !== "string" || !imageUtilsSrc.includes("srcsetLargest")) {
    throw new Error("imageUtilsSrc must be the real extension-unified/research/image-utils.js source");
  }
  return [
    `async function () {`,
    `  const KEY = ${JSON.stringify(adapterKey)};`,
    `  const CONFIG_VERSION = ${JSON.stringify(String(version))};`,
    `  const FULL_RES_MIN = ${Number(fullResMin)};`,
    `  const ADAPTER = ${JSON.stringify(adapter, null, 2).split("\n").map((l, i) => (i === 0 ? l : "  " + l)).join("\n")};`,
    ``,
    embedImageUtils(imageUtilsSrc),
    SNIPPET_BODY,
    `}`,
  ].join("\n");
}

// Build the paste-ready snippet for one adapter.
export function buildVerifySnippet(opts) {
  const { adapterKey, version } = opts;
  const header = [
    `// GradeThread — live-site verification for the "${adapterKey}" adapter (config v${version}).`,
    `//`,
    `// Open a REAL listing page on this marketplace, open DevTools, paste this whole`,
    `// script into the Console and press Enter. It runs the shipped selectors and`,
    `// helpers (image-utils.js is inlined below verbatim) against the page you are`,
    `// looking at, then prints a pass/fail table and a one-line result to record.`,
    `//`,
    `// Generated by: node scripts/adapter-verify.mjs snippet ${adapterKey}`,
    `// Do not edit this text — regenerate it, or it stops describing the shipped adapter.`,
    ``,
  ].join("\n");

  return [header, `(${buildVerifyFunctionSource(opts)})();`, ``].join("\n");
}
