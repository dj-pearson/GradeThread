#!/usr/bin/env node
// Lister selector verification harness (US-2477..US-2480).
//
// WHAT THIS IS FOR. Enabling a marketplace flow is the one step in
// vault/30-platform/closing-a-coverage-gap.md that a machine cannot do: the sell
// form is behind a login on every channel we support, so "re-verify the
// selectors" means a human with an account loading the real page. This script is
// the two halves of that a machine CAN do.
//
//   1. `--checklist <platform>` prints exactly what to check and where, so the
//      verification is the same every time rather than whatever the person
//      remembered to look at.
//   2. The default run ASSERTS the invariants that make an enable claim
//      trustworthy, and exits non-zero when one breaks. It is wired into
//      scripts/test-extensions.mjs, so a flow cannot be switched on with a
//      missing verification date, an empty host allowlist, or a probe that can
//      never be satisfied.
//
// Zero dependencies, no network, no browser.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELECTORS = resolve(root, "extension-unified/lister/selectors.js");

/** Evaluate the shipped content script and hand back its config object. */
function loadSelectors() {
  const src = readFileSync(SELECTORS, "utf8");
  const scope = {};
  new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)(scope);
  return scope.GT_LISTER_SELECTORS;
}

/**
 * How stale a verification may be before we stop trusting it.
 *
 * Marketplaces change their listing forms without notice — the selectors file
 * says "assume monthly breakage" about Mercari specifically — so a date from a
 * year ago is not evidence, it is a memory. This does not FAIL a run: a stale
 * flow that still works is not a bug, and failing CI on the passage of time
 * trains people to delete the check. It warns, loudly, with the age.
 */
const STALE_DAYS = 120;

const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function daysSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function checkFlow(platform, flow, kind) {
  const where = `${platform}.${kind}`;

  if (!Array.isArray(flow.required) || flow.required.length === 0) {
    fail(`${where}: \`required\` is empty — a probe that checks nothing is a probe that always passes, which is the same as no probe at all.`);
  }

  // The US-1875 bug class, asserted for every flow rather than only the three
  // the legacy-parity guard covers: a control that only exists after a click
  // must not be required by the pre-interaction probe, or the flow is
  // unsatisfiable on every run and blames the marketplace for it.
  if (kind === "delist") {
    if ((flow.required || []).includes("remove")) {
      fail(`${where}: requires "remove", which lives inside the overflow menu and does not exist until \`menu\` is clicked. The probe runs BEFORE that click (US-1875 AC1).`);
    }
    if (!(flow.required || []).includes("menu")) {
      fail(`${where}: must require "menu" — it is the one control that exists pre-interaction, and probing nothing means guessing.`);
    }
  } else if (kind === "engage") {
    for (const key of flow.required || []) {
      if (!flow[key]) {
        fail(`${where}: required selector "${key}" has no definition, so the probe can never satisfy it.`);
      }
    }
  } else {
    for (const key of flow.required || []) {
      const sel = key === "submit" ? flow.submit : (flow.fields || {})[key];
      if (!sel) {
        fail(`${where}: required selector "${key}" has no definition, so the probe can never satisfy it.`);
      }
    }
  }

  if (!flow.version) fail(`${where}: no \`version\` — the fail-loud message names it, so a stale build would be undiagnosable from a screenshot.`);

  if (flow.enabled) {
    if (!flow.lastVerified) {
      fail(`${where}: enabled with \`lastVerified: null\`. Enabling claims a human checked every required selector against the live form; a null date says nobody did.`);
    } else {
      const age = daysSince(flow.lastVerified);
      if (age === null) {
        fail(`${where}: \`lastVerified\` is not a date ("${flow.lastVerified}").`);
      } else if (age < 0) {
        fail(`${where}: \`lastVerified\` is in the future ("${flow.lastVerified}").`);
      } else if (age > STALE_DAYS) {
        warn(`${where}: last verified ${age} days ago (${flow.lastVerified}). Marketplaces move their forms without notice — re-check before trusting this.`);
      }
    }
    if (String(flow.version).includes("draft")) {
      fail(`${where}: enabled while its version is still marked "${flow.version}". Bump the version when you verify.`);
    }
  }
}

function checkPlatform(platform, cfg) {
  if (!Array.isArray(cfg.hosts) || cfg.hosts.length === 0) {
    fail(`${platform}: \`hosts\` is empty. lister-guard refuses to open any delist URL outside this list, so an empty one silently disables auto-delist for the whole channel — and a sibling that is never delisted after a sale elsewhere is a double sale.`);
  }
  if (!cfg.liveListingUrlPattern) {
    fail(`${platform}: no \`liveListingUrlPattern\`, so a published listing's URL can never be captured and the row stays a draft forever (US-1877).`);
  } else {
    try {
      const re = new RegExp(cfg.liveListingUrlPattern, "i");
      // The create page must not match the live-listing pattern, or we would
      // record the form we opened as the listing the seller published.
      if (cfg.newListingUrl && re.test(cfg.newListingUrl)) {
        fail(`${platform}: \`liveListingUrlPattern\` matches \`newListingUrl\` (${cfg.newListingUrl}) — the create page would be captured as a live listing.`);
      }
    } catch (_e) {
      fail(`${platform}: \`liveListingUrlPattern\` is not a valid regular expression.`);
    }
  }
  if (!cfg.login || !cfg.login.urlPattern) {
    warn(`${platform}: no \`login.urlPattern\`. A logged-out seller is still caught by the password-input check, but the URL signal is the one that works on an SPA that renders login in place.`);
  }

  // US-2479: a locale map must cover only hosts the delist guard also accepts,
  // or a seller can list somewhere we can never end the listing.
  if (cfg.locales) {
    for (const key of Object.keys(cfg.locales)) {
      if (!cfg.hosts.includes(key)) {
        fail(`${platform}: locale "${key}" is listable but is not in \`hosts\`, so its listings could never be auto-delisted.`);
      }
      if (!/^https:\/\//.test(cfg.locales[key])) {
        fail(`${platform}: locale "${key}" has a non-https new-listing URL.`);
      }
    }
  }

  checkFlow(platform, cfg, "list");
  if (cfg.delist) checkFlow(platform, cfg.delist, "delist");

  // US-2482: the engagement flow gets the same enable discipline as listing —
  // and one extra rule. Sharing runs thousands of times against a live closet,
  // so a stale selector here does not fail once, it fails in a loop, and a loop
  // of failed clicks is the single behaviour most likely to get an account
  // flagged. The caps and consent gate live in lister/engagement.js and are held
  // by test/engagement.test.cjs; this only checks the DOM contract.
  if (cfg.engage) {
    checkFlow(platform, cfg.engage, "engage");
    if (!cfg.engage.humanCheck) {
      fail(`${platform}.engage: no \`humanCheck\` selector. The run is supposed to PAUSE when the marketplace asks for a human — without a detector it keeps clicking into the wall instead, and GradeThread never answers one (US-2482 AC2).`);
    }
    if (!cfg.engage.actionConfirmed) {
      fail(`${platform}.engage: no \`actionConfirmed\` selector. Without positive confirmation the run counts actions it never performed, and the meter tells the seller they are safe while the real total runs ahead.`);
    }
  }
}

function printChecklist(platform, cfg) {
  const line = (s = "") => console.log(s);
  line();
  line(`  Verification checklist — ${platform} (selector v${cfg.version})`);
  line(`  ${"─".repeat(60)}`);
  line();
  line(`  You need a logged-in ${platform} account. This cannot be done from CI.`);
  line();
  line(`  1. Open the sell form:`);
  if (cfg.locales) {
    line(`       ${Object.keys(cfg.locales).length} locales covered. Check the one your account is on:`);
    for (const [host, url] of Object.entries(cfg.locales)) line(`       ${host.padEnd(16)} ${url}`);
  } else {
    line(`       ${cfg.newListingUrl}`);
  }
  line();
  line(`  2. In devtools, run document.querySelector(...) for each REQUIRED`);
  line(`     selector below. Every one must return an element.`);
  line();
  for (const key of cfg.required || []) {
    const sel = key === "submit" ? cfg.submit : (cfg.fields || {})[key];
    line(`       [${key}]`);
    line(`       ${sel}`);
    line();
  }
  const optional = Object.keys(cfg.fields || {}).filter((k) => !(cfg.required || []).includes(k));
  if (optional.length) {
    line(`     Optional (a miss degrades that one field, it does not abort):`);
    for (const key of optional) line(`       [${key}] ${cfg.fields[key]}`);
    line();
  }
  if (cfg.engage) {
    line(`  ENGAGEMENT (US-2482) — check on your own closet page:`);
    line(`       [shareButton]      ${cfg.engage.shareButton}`);
    line(`       [shareToFollowers] ${cfg.engage.shareToFollowers}   (inside the share modal)`);
    line(`       [followButton]     ${cfg.engage.followButton}`);
    line(`       [offerButton]      ${cfg.engage.offerButton}`);
    line(`       [actionConfirmed]  ${cfg.engage.actionConfirmed}    (after ONE manual share)`);
    line();
    line(`     Share ONE listing by hand and confirm [actionConfirmed] appears.`);
    line(`     If it does not, the run counts actions it never performed and the`);
    line(`     meter under-reports — which is worse than no meter at all.`);
    line();
  }
  if (cfg.delist) {
    line(`  3. Open one of YOUR OWN live listings and check the delist controls.`);
    line(`     Only \`menu\` is checked before any click; the rest are checked`);
    line(`     at the point they should appear, so walk the flow in order.`);
    line();
    line(`       [menu]    ${cfg.delist.menu}`);
    line(`       [remove]  ${cfg.delist.remove}      (after clicking menu)`);
    line(`       [confirm] ${cfg.delist.confirm}     (after clicking remove)`);
    line();
    line(`     DO NOT actually confirm the delete unless the listing is expendable.`);
    line();
  }
  line(`  4. Fix anything that moved, then in ONE commit:`);
  line(`       • bump \`version\` (drop the "-draft" suffix)`);
  line(`       • set \`lastVerified\` to today`);
  line(`       • set \`enabled: true\``);
  line(`       • set MARKETPLACE_EXTENSION_FLOW.${platform} = "live" in src/lib/constants.ts`);
  line(`       • mirror the change into extension/selectors.js if the platform`);
  line(`         exists there (the legacy-parity guard fails otherwise)`);
  line();
  line(`  Then run: node scripts/verify-lister-selectors.mjs`);
  line();
}

// ── main ──────────────────────────────────────────────────────────────────
const selectors = loadSelectors();
const args = process.argv.slice(2);
const checklistIdx = args.indexOf("--checklist");

if (checklistIdx !== -1) {
  const platform = args[checklistIdx + 1];
  const cfg = selectors[platform];
  if (!cfg) {
    console.error(`Unknown platform "${platform}". Known: ${Object.keys(selectors).join(", ")}`);
    process.exit(2);
  }
  printChecklist(platform, cfg);
  process.exit(0);
}

for (const [platform, cfg] of Object.entries(selectors)) checkPlatform(platform, cfg);

for (const w of warnings) console.warn(`  ! ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(`\nverify-lister-selectors: ${errors.length} problem(s).`);
  process.exit(1);
}

const platforms = Object.entries(selectors);
const live = platforms.filter(([, c]) => c.enabled).map(([p]) => p);
const pending = platforms.filter(([, c]) => !c.enabled).map(([p]) => p);
console.log(
  `✓ verify-lister-selectors: ${platforms.length} platforms — ` +
    `enabled: ${live.join(", ") || "none"}; ` +
    `awaiting live verification: ${pending.join(", ") || "none"}` +
    (warnings.length ? ` (${warnings.length} warning(s))` : ""),
);
