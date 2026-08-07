// US-1872 AC5 — the legacy-extension retirement gate, as a computed value.
//
// WHAT THIS IS FOR.
//
// The unified extension (extension-unified/) supersedes two older folders:
// extension/ ("GradeThread Lister", seller) and extension-condition/
// ("GradeThread Condition Check", buyer). Founder decision 2026-07-09. US-1872
// AC5 owns DELETING those two — "once the unified extension reaches parity".
//
// Until this file existed, that gate lived as PROSE in five places: both legacy
// READMEs, the unified README, the EXTENSIONS comment in
// scripts/package-extensions.mjs, and the header of
// extension-unified/test/legacy-parity.test.cjs. All five stated the same
// condition the same way — "parity is not reached (US-1880/1881/1882/1883 are
// open)" — and all five went stale together the moment US-1883 shipped, then
// again when the Firefox/bridge work (US-1881/1882) landed. Prose has no
// compiler, so nothing went red; the next reader just inherits a gate that
// names four story ids, three of which are done.
//
// Worse, that framing was never the real gate. "Which child stories are open"
// is a proxy. The two things that actually decide whether the folders may be
// deleted are:
//
//   1. CODE PARITY — does the unified extension do everything both legacy
//      folders do? This is a property of the files, so it is COMPUTED here
//      (checkCodeParity) rather than asserted by anyone. A remaining child
//      story that makes the unified extension BETTER than the legacy ones
//      (US-1880 adapter verification, US-1884 overlay richness) is not a parity
//      blocker and never was — it improves a surface both copies share.
//
//   2. DISTRIBUTION RETIREMENT — the unified extension is live on the Chrome
//      Web Store and Firefox AMO, and the two legacy STORE LISTINGS are
//      unpublished. This is the one that genuinely blocks today, and no amount
//      of code closes it: the legacy listings are the only shipped distribution
//      GradeThread has, real users have them installed, and deleting the source
//      folders while those listings are live means we cannot ship those users a
//      fix. That work is US-1757 AC1 and is OPERATOR-GATED (store developer
//      accounts + a browser for screenshots).
//
// So: parity is machine-checked, retirement is a flag an operator flips, and
// extension-unified/test/legacy-retirement-gate.test.cjs fails the build on
// either half being wrong — including the case nobody guards for, which is
// SATISFYING the gate and forgetting to delete.

const fs = require("node:fs");
const path = require("node:path");

// ── The operator half ────────────────────────────────────────────────────────
//
// FLIP THIS TO `true` ONLY WHEN BOTH LEGACY STORE LISTINGS ARE UNPUBLISHED —
// not when the unified extension is submitted, not when it is approved. Until a
// legacy listing is off the store, users are still installing it.
//
// Flipping it is the LAST step of US-1757, and it is deliberately load-bearing:
// the guard requires the two folders to be GONE once this is true, so setting it
// early fails the build rather than quietly stranding installed users.
const LEGACY_STORE_LISTINGS_RETIRED = false;

// ── What "parity" is checked against ─────────────────────────────────────────
//
// The unified extension reorganised the two flat legacy folders into two
// subtrees. `subtree` is where a legacy file's counterpart lives; `rootFiles`
// are the ones that MERGED into a single shared file at the unified root (one
// background service worker, one popup) rather than being duplicated per role —
// which is the whole point of the merge.
const LEGACY_EXTENSIONS = [
  {
    dir: "extension",
    storeName: "GradeThread Lister",
    role: "seller",
    subtree: "lister",
    rootFiles: ["background.js", "popup.html", "popup.css", "popup.js"],
  },
  {
    dir: "extension-condition",
    storeName: "GradeThread Condition Check",
    role: "buyer",
    subtree: "research",
    rootFiles: ["background.js", "popup.html", "popup.css", "popup.js"],
  },
];

const UNIFIED_DIR = "extension-unified";

// Never compared: icons are checked by manifest size key instead of by filename,
// READMEs are prose, and test/ is dev-only (the packager excludes it too).
const IGNORED = (rel) =>
  rel.startsWith("icons/") ||
  rel.startsWith("test/") ||
  rel === "manifest.json" ||
  rel.endsWith(".md");

// ── Chrome match-pattern coverage ────────────────────────────────────────────
//
// `covers(a, b)` answers: does unified pattern `a` match every URL that legacy
// pattern `b` matches? Deliberately CONSERVATIVE — when unsure it returns false,
// so the failure mode is reporting a gap that isn't one (loud, fixable) rather
// than certifying coverage that doesn't hold (silent, ships).

/** Split "https://*.ebay.com/itm/*" → {scheme, host, pathname}. */
function parsePattern(p) {
  const m = /^([a-z*]+):\/\/([^/]*)(\/.*)?$/.exec(String(p));
  if (!m) return null;
  return { scheme: m[1], host: m[2], pathname: m[3] || "/*" };
}

function hostCovers(a, b) {
  if (a === "*" || a === b) return true;
  if (!a.startsWith("*.")) return false;
  const base = a.slice(2);
  // Chrome's `*.domain` matches the apex AND any subdomain — and it also covers
  // another pattern that is itself scoped under that domain.
  const bBase = b.startsWith("*.") ? b.slice(2) : b;
  return bBase === base || bBase.endsWith("." + base);
}

function pathCovers(a, b) {
  if (a === b) return true;
  if (!a.endsWith("*")) return false;
  const prefix = a.slice(0, -1);
  // `b` may itself contain a wildcard; only the literal head before it is
  // guaranteed, so that head is what must sit under `a`'s prefix.
  const bHead = b.split("*")[0];
  return bHead.startsWith(prefix);
}

function covers(a, b) {
  const pa = parsePattern(a);
  const pb = parsePattern(b);
  if (!pa || !pb) return false;
  if (pa.scheme !== "*" && pa.scheme !== pb.scheme) return false;
  return hostCovers(pa.host, pb.host) && pathCovers(pa.pathname, pb.pathname);
}

/** Every pattern in `needles` covered by at least one pattern in `haystack`. */
function uncovered(needles, haystack) {
  return (needles || []).filter((n) => !(haystack || []).some((h) => covers(h, n)));
}

// ── The parity computation ───────────────────────────────────────────────────

function readManifest(root, dir) {
  return JSON.parse(fs.readFileSync(path.join(root, dir, "manifest.json"), "utf8"));
}

/** All shipped files of an extension dir, as posix-relative paths. */
function shippedFiles(root, dir) {
  const abs = path.join(root, dir);
  const out = [];
  const walk = (d, prefix) => {
    for (const entry of fs.readdirSync(d).sort()) {
      const p = path.join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (fs.statSync(p).isDirectory()) walk(p, rel);
      else out.push(rel);
    }
  };
  walk(abs, "");
  return out;
}

/** Every js/css file referenced by any content_scripts entry. */
function contentScriptAssets(manifest) {
  const out = new Set();
  for (const cs of manifest.content_scripts || []) {
    for (const j of cs.js || []) out.add(j);
    for (const c of cs.css || []) out.add(c);
  }
  return out;
}

/**
 * Does extension-unified/ do everything the two legacy folders do?
 *
 * @returns {{ok: boolean, gaps: string[]}} — `gaps` names every concrete
 *   capability the legacy folders have and the unified one does not, in a form
 *   you can act on without re-deriving this analysis.
 */
function checkCodeParity(root) {
  const gaps = [];
  const unifiedPresent = fs.existsSync(path.join(root, UNIFIED_DIR, "manifest.json"));
  if (!unifiedPresent) {
    return { ok: false, gaps: [`${UNIFIED_DIR}/manifest.json is missing`] };
  }
  const unified = readManifest(root, UNIFIED_DIR);
  const unifiedFiles = new Set(shippedFiles(root, UNIFIED_DIR));
  const unifiedAssets = contentScriptAssets(unified);
  const unifiedCsMatches = (unified.content_scripts || []).flatMap((cs) => cs.matches || []);

  for (const legacy of LEGACY_EXTENSIONS) {
    if (!fs.existsSync(path.join(root, legacy.dir, "manifest.json"))) continue; // already deleted
    const m = readManifest(root, legacy.dir);
    const tag = `${legacy.dir} (${legacy.storeName})`;

    // 1. Permissions the legacy install has and the unified one does not.
    for (const p of m.permissions || []) {
      if (!(unified.permissions || []).includes(p)) {
        gaps.push(`${tag}: permission "${p}" is not requested by the unified manifest`);
      }
    }

    // 2. Host permissions.
    for (const h of uncovered(m.host_permissions, unified.host_permissions)) {
      gaps.push(`${tag}: host_permission ${h} is not covered by the unified manifest`);
    }

    // 3. externally_connectable — the seller bridge's trust list.
    for (const h of uncovered(
      m.externally_connectable?.matches,
      unified.externally_connectable?.matches,
    )) {
      gaps.push(`${tag}: externally_connectable ${h} is not covered by the unified manifest`);
    }

    // 4. Content-script REACH. A page the legacy extension runs on and the
    //    unified one does not is a user-visible regression on install day.
    for (const cs of m.content_scripts || []) {
      for (const h of uncovered(cs.matches, unifiedCsMatches)) {
        gaps.push(`${tag}: no unified content script runs on ${h}`);
      }
    }

    // 5. Icon sizes — a size the legacy manifest declares and the unified one
    //    omits downgrades how the entry renders in the browser UI.
    for (const size of Object.keys(m.icons || {})) {
      if (!(unified.icons || {})[size]) {
        gaps.push(`${tag}: icon size ${size} is not declared by the unified manifest`);
      }
    }

    // 6. Every shipped source file has a counterpart, and the counterpart is
    //    actually WIRED (referenced by a content script) when the legacy one was.
    const legacyAssets = contentScriptAssets(m);
    for (const rel of shippedFiles(root, legacy.dir)) {
      if (IGNORED(rel)) continue;
      const base = rel.split("/").pop();
      const counterpart = legacy.rootFiles.includes(base)
        ? base
        : `${legacy.subtree}/${base}`;
      if (!unifiedFiles.has(counterpart)) {
        gaps.push(`${tag}: ${rel} has no counterpart at ${UNIFIED_DIR}/${counterpart}`);
        continue;
      }
      if (legacyAssets.has(rel) && !unifiedAssets.has(counterpart)) {
        gaps.push(
          `${tag}: ${rel} is a content script there, but ${counterpart} is not ` +
            `referenced by any unified content_scripts entry (present but unwired)`,
        );
      }
    }
  }

  return { ok: gaps.length === 0, gaps };
}

/**
 * The whole gate. `satisfied` true means extension/ and extension-condition/
 * MUST be deleted — the guard enforces that, so this can never sit true with the
 * folders still on disk.
 */
function retirementGate(root) {
  const parity = checkCodeParity(root);
  const blockers = [];
  if (!parity.ok) {
    blockers.push({
      id: "code-parity",
      why: "the unified extension does not yet do everything the legacy folders do",
      detail: parity.gaps,
      operatorGated: false,
    });
  }
  if (!LEGACY_STORE_LISTINGS_RETIRED) {
    blockers.push({
      id: "US-1757",
      why:
        "the unified extension is not published and the two legacy store listings are " +
        "still live — deleting the folders would strand every installed user with no " +
        "way to ship them a fix",
      detail: [
        "An operator must: publish extension-unified to the Chrome Web Store and " +
          "Firefox AMO (zips from `node scripts/package-extensions.mjs`, kit in " +
          "extension-unified/SUBMISSION.md), unpublish the two legacy listings, then " +
          "set LEGACY_STORE_LISTINGS_RETIRED = true in this file.",
      ],
      operatorGated: true,
    });
  }
  return { satisfied: blockers.length === 0, blockers, parity };
}

module.exports = {
  LEGACY_EXTENSIONS,
  LEGACY_STORE_LISTINGS_RETIRED,
  UNIFIED_DIR,
  checkCodeParity,
  covers,
  retirementGate,
};
