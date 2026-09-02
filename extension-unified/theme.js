// GradeThread unified extension — the theme preference (US-3055).
//
// Three values: absent (follow the OS), "light", "dark". Stored as `theme` in
// storage.local; System is the ABSENT key, so a fresh install and "System"
// are the same stored state and a later default change strands nobody.
//
// Applied as data-theme on <html>. The stylesheets keep their one OS-driven
// media block; the generated *-theme.css sheets carry the same rules under
// [data-theme="dark"] and the light values under [data-theme="light"], so the
// attribute wins over the OS either way. The overlay reads the same key
// through GT_CC_GET_SETTINGS and sets the attribute on its own card.
//
// Classic script: sets self.GT_THEME for the popup, the three pages and the
// worker; loadable in node with an injected `self` for the guard.
(function (root) {
  "use strict";

  var KEY = "theme";
  var VALUES = ["light", "dark"];

  /** "light" | "dark" | null. Anything else reads as System. */
  function normalize(raw) {
    return VALUES.indexOf(raw) >= 0 ? raw : null;
  }

  /** Put the preference on a document. null removes the attribute (System). */
  function applyTo(doc, theme) {
    var el = doc && doc.documentElement;
    if (!el) return;
    var t = normalize(theme);
    if (t) el.setAttribute("data-theme", t);
    else el.removeAttribute("data-theme");
  }

  /** Read once, apply, and follow changes made on another page. */
  async function init(ext, doc) {
    if (!ext || !ext.storage || !ext.storage.local) return null;
    var theme = null;
    try {
      var out = await ext.storage.local.get(KEY);
      theme = normalize(out && out[KEY]);
    } catch (_e) { theme = null; }
    applyTo(doc, theme);
    if (ext.storage.onChanged && ext.storage.onChanged.addListener) {
      ext.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local" || !changes || !changes[KEY]) return;
        applyTo(doc, normalize(changes[KEY].newValue));
      });
    }
    return theme;
  }

  /** Store a preference. null (System) REMOVES the key. */
  async function save(ext, theme) {
    var t = normalize(theme);
    if (t) await ext.storage.local.set({ theme: t });
    else await ext.storage.local.remove(KEY);
    return t;
  }

  root.GT_THEME = { KEY: KEY, VALUES: VALUES, normalize: normalize, applyTo: applyTo, init: init, save: save };
})(typeof self !== "undefined" ? self : globalThis);
