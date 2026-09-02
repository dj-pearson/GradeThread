// US-3055: the theme preference — generated forced-theme sheets, the switch
// itself, and the wiring on every surface. Zero dependencies.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const repo = path.resolve(dir, "..");
const T = require(path.join(repo, "scripts", "lib", "theme-css.cjs"));

// ── 1. the derivation: dark rules re-scoped, light values put back ──────────
{
  const css = `
:root { --fg: #111; --bg: #fff; }
body { color: var(--fg); background: #fff; }
.pill.on { background: #e6f4ea; color: #157a46; }
.pill.on, .pill.off { padding: 2px; }
@keyframes spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .x { animation: none; } }
@media (prefers-color-scheme: dark) {
  :root { --fg: #eee; --bg: #101; }
  body { background: #101; }
  .pill.on { background: #17301f; color: #7fd39b; }
  .never-in-base { border: 0; }
}`;
  const p = T.parse(css);
  assert.strictEqual(p.darkBlocks, 1);
  assert.strictEqual(p.dark.length, 4);
  assert.strictEqual(T.baseValue(p.base, ".pill.on", "background"), "#e6f4ea");
  assert.strictEqual(T.baseValue(p.base, ".pill.on", "padding"), "2px", "a value declared in a selector LIST is found");
  assert.strictEqual(T.baseValue(p.base, ".never-in-base", "border"), null);

  const out = T.forcedThemeCss(css, T.pageScope);
  assert.ok(out.includes('html[data-theme="dark"] {\n  --fg: #eee;\n  --bg: #101;\n}'), ":root becomes html[data-theme=dark]");
  assert.ok(out.includes('html[data-theme="dark"] body {\n  background: #101;\n}'));
  assert.ok(out.includes('html[data-theme="dark"] .pill.on {\n  background: #17301f;\n  color: #7fd39b;\n}'));
  assert.ok(out.includes('html[data-theme="light"] {\n  --fg: #111;\n  --bg: #fff;\n}'), "forced light restores the base tokens");
  assert.ok(out.includes('html[data-theme="light"] .pill.on {\n  background: #e6f4ea;\n  color: #157a46;\n}'), "forced light restores the pill's light ink");
  assert.ok(out.includes('html[data-theme="light"] .never-in-base {\n  border: unset;\n}'), "a property the base never set is unset, not invented");
  assert.ok(!/spin|animation: none/.test(out), "keyframes and reduced-motion blocks carry no theme");

  // the overlay scope: the attribute rides the card or the badge row
  assert.strictEqual(T.overlayScope("#gt-cc-overlay.gt-cc-root", "dark"), '#gt-cc-overlay.gt-cc-root[data-theme="dark"]');
  assert.strictEqual(T.overlayScope("#gt-cc-overlay .gt-cc-body", "dark"), '#gt-cc-overlay[data-theme="dark"] .gt-cc-body');
  assert.strictEqual(T.overlayScope(".gt-cc-badge-row .gt-cc-b-good", "light"), '.gt-cc-badge-row[data-theme="light"] .gt-cc-b-good');
  assert.strictEqual(T.overlayScope(".gt-cc-disc-bad", "dark"), '#gt-cc-overlay[data-theme="dark"] .gt-cc-disc-bad', "a bare body class is scoped under the card");

  // a value with a semicolon-free function and a quoted string survives the split
  assert.deepStrictEqual(T.splitDecls('background: conic-gradient(var(--c) calc(var(--p) * 1%), var(--line) 0); content: ";"'), [
    { prop: "background", value: "conic-gradient(var(--c) calc(var(--p) * 1%), var(--line) 0)" },
    { prop: "content", value: '";"' },
  ]);
}

// ── 2. the generated sheets are in sync, and popup.css still has ONE dark block ─
{
  const stale = T.drift(repo);
  assert.deepStrictEqual(stale, [], "popup-theme.css / compare-theme.css are stale. Run: node scripts/gen-extension-theme-css.mjs");
  const popupCss = fs.readFileSync(path.join(dir, "popup.css"), "utf8");
  assert.strictEqual(T.parse(popupCss).darkBlocks, 1, "popup.css keeps exactly one prefers-color-scheme:dark block (popup-theme.test.ts)");
  const themed = fs.readFileSync(path.join(dir, "popup-theme.css"), "utf8");
  assert.ok(!/@media/.test(themed), "the generated sheet adds no media block");
  assert.ok(/html\[data-theme="light"\] \.pop-status\.on \{/.test(themed), "forced light re-inks the pills");
  assert.ok(/html\[data-theme="dark"\] \.pop-status\.on \{/.test(themed), "forced dark re-inks the pills");
  // the overlay string carries its forced rules too
  // The shipped module is a JSON-quoted line array, so a double quote reads as \".
  const overlay = fs.readFileSync(path.join(dir, "research", "overlay-css.js"), "utf8");
  assert.ok(overlay.includes('#gt-cc-overlay.gt-cc-root[data-theme=\\"dark\\"]'), "overlay-css.js carries forced dark for the card");
  assert.ok(overlay.includes('#gt-cc-overlay.gt-cc-root[data-theme=\\"light\\"]'), "overlay-css.js carries forced light for the card");
  assert.ok(overlay.includes('.gt-cc-badge-row[data-theme=\\"dark\\"] .gt-cc-b-good'), "the badge rows follow the same attribute");
}

// ── 3. the switch: theme.js ─────────────────────────────────────────────────
{
  const selfObj = {};
  new Function("self", fs.readFileSync(path.join(dir, "theme.js"), "utf8"))(selfObj);
  const TH = selfObj.GT_THEME;
  assert.ok(TH, "theme.js must assign self.GT_THEME");
  assert.strictEqual(TH.normalize("dark"), "dark");
  assert.strictEqual(TH.normalize("light"), "light");
  assert.strictEqual(TH.normalize("system"), null, "anything but light/dark is System");
  assert.strictEqual(TH.normalize(undefined), null);
  const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const doc = { documentElement: el };
  TH.applyTo(doc, "dark");
  assert.strictEqual(el.attrs["data-theme"], "dark");
  TH.applyTo(doc, null);
  assert.ok(!("data-theme" in el.attrs), "System removes the attribute");
  // save: System REMOVES the key rather than storing "system"
  const store = { set: [], removed: [] };
  const ext = { storage: { local: { set: async (o) => store.set.push(o), remove: async (k) => store.removed.push(k) } } };
  return (async () => {
    await TH.save(ext, "dark");
    await TH.save(ext, null);
    assert.deepStrictEqual(store.set, [{ theme: "dark" }]);
    assert.deepStrictEqual(store.removed, ["theme"]);
  })().then(() => wiring()).catch((e) => { console.error(e); process.exit(1); });
}

// ── 4. every surface applies it ─────────────────────────────────────────────
function wiring() {
  for (const page of ["popup.html", "compare.html", "options.html", "onboarding.html"]) {
    const html = fs.readFileSync(path.join(dir, page), "utf8");
    assert.ok(/<script src="theme\.js"><\/script>/.test(html), page + " must load theme.js");
    const themeAt = html.indexOf('src="theme.js"');
    const main = page === "popup.html" ? 'src="popup.js"' : page === "compare.html" ? 'src="compare.js"' : page === "options.html" ? 'src="options.js"' : 'src="onboarding.js"';
    assert.ok(themeAt < html.indexOf(main), page + ": theme.js must load before the page script");
    const sheet = page === "popup.html" ? "popup-theme.css" : "compare-theme.css";
    assert.ok(html.includes('href="' + sheet + '"'), page + " must link " + sheet);
    assert.ok(html.indexOf('href="' + sheet + '"') > html.indexOf('href="' + (page === "popup.html" ? "popup.css" : "compare.css") + '"'), page + ": the theme sheet loads AFTER its source");
  }
  for (const [file, fn] of [["popup.js", "GT_THEME.init(ext, document)"], ["compare.js", "GT_THEME.init(ext, document)"], ["options.js", "GT_THEME.init(ext, document)"], ["onboarding.js", "GT_THEME.init("]]) {
    assert.ok(fs.readFileSync(path.join(dir, file), "utf8").includes(fn), file + " must apply the theme at boot");
  }
  const opt = fs.readFileSync(path.join(dir, "options.html"), "utf8");
  assert.ok(/<select id="theme">/.test(opt) && /<option value="">System<\/option>/.test(opt), "options.html carries the Theme control with System as the empty value");
  const optJs = fs.readFileSync(path.join(dir, "options.js"), "utf8");
  assert.ok(/GT_THEME\.save\(ext, sel\.value \|\| null\)/.test(optJs), "options.js saves System as null (the absent key)");
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  assert.ok(/theme: out\.theme === "light" \|\| out\.theme === "dark" \? out\.theme : null/.test(bg), "GT_CC_GET_SETTINGS carries the preference, normalised");
  const mp = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");
  assert.ok(/mounted\.root\.setAttribute\("data-theme", themePref\)/.test(mp), "the overlay card carries data-theme");
  assert.ok(/wrap\.setAttribute\("data-theme", themePref\)/.test(mp), "every badge row carries data-theme");
  console.log("theme-css.test.cjs: forced sheets derived and in sync, one dark block kept, theme.js normalises/saves/applies, every surface wired");
}
