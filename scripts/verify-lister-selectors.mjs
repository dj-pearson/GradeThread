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
const SYNC_SELECTORS = resolve(root, "extension-unified/sync/selectors.js");

/** Evaluate the shipped content script and hand back its config object. */
function loadSelectors() {
  const src = readFileSync(SELECTORS, "utf8");
  const scope = {};
  new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)(scope);
  return scope.GT_LISTER_SELECTORS;
}

/** US-2698: the sold-sync selectors, which describe the seller's OWN pages. */
function loadSyncSelectors() {
  const src = readFileSync(SYNC_SELECTORS, "utf8");
  const scope = {};
  new Function("self", `${src}; return self.GT_SYNC_SELECTORS;`)(scope);
  return scope.GT_SYNC_SELECTORS;
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

/**
 * The prose above a platform's config must not contradict the config.
 *
 * TWICE NOW, in the same file. Mercari's heading said "not yet enabled" for a
 * day after the flip; Grailed's said it for ten days, directly above
 * `enabled: true`, while sellers were listing to the channel. Both were caught
 * by somebody reading the file rather than by anything that runs.
 *
 * It matters more than a tidy comment: this file's headings are what a reader
 * consults to decide whether a flow is safe to touch, and a heading claiming a
 * channel is off is exactly the licence somebody needs to change it carelessly.
 *
 * Deliberately narrow. It looks for a CLAIM OF BEING OFF - the words a stale
 * heading actually uses - and only when the flow is on. Prose that discusses
 * `enabled: false` for the DELIST half (Grailed's does, correctly, at length)
 * is not a claim about the list flow, so the phrases are anchored to the words
 * that only ever mean the whole channel.
 */
const DISABLED_CLAIMS = [
  /not yet enabled/i,
  /still\s+`?enabled:\s*false`?/i,
  /\bis not enabled\b/i,
  /\bstays? (?:off|disabled)\b/i,
];

function checkHeadingHonesty(platform, cfg, source) {
  if (!cfg.enabled) return;
  // The comment block that introduces this platform: everything between the
  // previous platform's config and this one's opening line.
  const at = source.indexOf(`
  ${platform}: {`);
  if (at === -1) return;
  const before = source.slice(0, at);
  const start = before.lastIndexOf("// ──");
  if (start === -1) return;
  const heading = before.slice(start);
  // The delist half is allowed to say it is off, because it IS off and saying
  // so is the honest disclosure. Only the lines before that discussion count.
  const delistAt = heading.search(/delist[.\s]/i);
  let listProse = delistAt === -1 ? heading : heading.slice(0, delistAt);

  // A correction QUOTES the wording it is correcting, and both existing
  // corrections in this file do exactly that. The first run of this check
  // failed Mercari on its own note explaining that the stale heading had been
  // fixed — the guard firing on the record of the fix. Quoted text is a report
  // about what the file used to say, never a claim about what it says now, so
  // it comes out before the match.
  listProse = listProse.replace(/"[^"]*"/g, " ").replace(/`[^`]*`/g, " ");

  for (const claim of DISABLED_CLAIMS) {
    if (claim.test(listProse)) {
      fail(
        `${platform}: the comment block above \`enabled: true\` still says the ` +
        `flow is off (matched ${claim}). This has happened twice in this file. ` +
        `A heading that contradicts the line it introduces is what a reader ` +
        `trusts when deciding whether a channel is safe to change.`,
      );
      return;
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
    // 2026-08-11: `shareToFollowers` resolved `ok` on a closet at rest, with no
    // modal open anywhere — `a[href*="followers"]` was matching the closet's own
    // Followers TAB. shareOne waits for that selector and CLICKS it, so the run
    // would have navigated away on its first iteration, found no tiles, and kept
    // reporting honest zeroes while the seller wondered why nothing shared.
    //
    // Every control that only exists inside a modal must SAY so in its selector.
    // A click target that can match a page at rest is not a weak selector, it is
    // a different feature.
    const MODAL_SCOPED = ["shareToFollowers", "offerPriceInput", "offerSubmit"];
    for (const key of MODAL_SCOPED) {
      const sel = cfg.engage[key];
      if (!sel) continue;
      const scoped = String(sel)
        .split(",")
        .every((part) => /\[data-test[^\]]*modal|\.modal|\[role="?dialog/i.test(part));
      if (!scoped) {
        fail(`${platform}.engage.${key}: at least one alternative is not scoped to a modal. This control only exists inside one, and shareOne CLICKS it — an unscoped alternative can match the page at rest and navigate the run away from the closet.`);
      }
    }

    if (!cfg.engage.actionConfirmed) {
      fail(`${platform}.engage: no \`actionConfirmed\` selector. Without positive confirmation the run counts actions it never performed, and the meter tells the seller they are safe while the real total runs ahead.`);
    }
  }
}

/**
 * US-2698: the same enable discipline for the sold-sync reads.
 *
 * The stakes differ from the lister's. A broken sell-form selector fails loudly
 * and the seller lists manually. A broken CLOSET selector returns an empty
 * closet, which looks exactly like a seller who sold out — so the invariants
 * here are mostly about making sure a read cannot silently claim to have seen
 * everything.
 */
function checkSyncPlatform(platform, cfg) {
  const where = `sync.${platform}`;

  if (!Array.isArray(cfg.hosts) || cfg.hosts.length === 0) {
    fail(`${where}: \`hosts\` is empty. A read with no host allowlist would accept observations from any page that happens to match a selector.`);
  }
  if (!cfg.login || !cfg.login.urlPattern) {
    fail(`${where}: no \`login.urlPattern\`. A logged-out read must report not-signed-in; without this it reports an EMPTY CLOSET, which the server treats as a selector failure at best and a sell-out at worst.`);
  }
  if (!cfg.humanCheck) {
    fail(`${where}: no \`humanCheck\` selector. The read is supposed to stop and hand the tab back when the marketplace asks for a human, exactly as the engagement runner does.`);
  }

  for (const kind of ["sold", "closet"]) {
    const flow = cfg[kind];
    if (!flow) {
      fail(`${where}: no \`${kind}\` flow. Both halves are needed — sold rows alone cannot detect a listing that vanished, and a closet alone cannot detect a sale.`);
      continue;
    }
    const w = `${where}.${kind}`;
    if (!flow.urlPattern) {
      fail(`${w}: no \`urlPattern\`, so the observer cannot tell it is on the right page and would read whatever it landed on.`);
    } else {
      try { new RegExp(flow.urlPattern, "i"); }
      catch (_e) { fail(`${w}: \`urlPattern\` is not a valid regular expression.`); }
    }
    if (!Array.isArray(flow.required) || flow.required.length === 0) {
      fail(`${w}: \`required\` is empty — a probe that checks nothing always passes, which is the same as no probe.`);
    } else {
      for (const key of flow.required) {
        if (!flow[key]) {
          fail(`${w}: required selector "${key}" has no definition, so the probe can never be satisfied.`);
        }
      }
    }
    if (!flow.pagination) {
      fail(`${w}: no \`pagination\` block. Coverage is what makes an absence evidence; a flow that cannot tell whether it reached the end must not report that it did.`);
    }

    // The privacy rule as an invariant rather than a comment: naming a buyer
    // field here is the first half of someone emitting it.
    const banned = /buyer|recipient|address|street|postcode|zip|phone|email/i;
    for (const key of Object.keys(flow.fields || {})) {
      if (banned.test(key)) {
        fail(`${w}.fields.${key}: names buyer identity. The observer's ALLOWED_SOLD_FIELDS cannot emit it, and a selector for it should not exist either.`);
      }
    }
  }

  if (!cfg.version) fail(`${where}: no \`version\`.`);
  if (cfg.enabled) {
    if (!cfg.lastVerified) {
      fail(`${where}: enabled with \`lastVerified: null\`. Enabling claims a human loaded their own Sold page and closet; a null date says nobody did.`);
    } else {
      const age = daysSince(cfg.lastVerified);
      if (age === null) fail(`${where}: \`lastVerified\` is not a date ("${cfg.lastVerified}").`);
      else if (age < 0) fail(`${where}: \`lastVerified\` is in the future ("${cfg.lastVerified}").`);
      else if (age > STALE_DAYS) warn(`${where}: last verified ${age} days ago (${cfg.lastVerified}).`);
    }
    if (String(cfg.version).includes("draft")) {
      fail(`${where}: enabled while its version is still marked "${cfg.version}". Bump the version when you verify.`);
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
  line(`  EACH FLOW HAS ITS OWN PAGE, and a report from the wrong one proves`);
  line(`  nothing — every selector misses and the channel reads dead:`);
  line(`     list    → the sell form`);
  line(`     delist  → one of YOUR OWN live listings`);
  if (cfg.engage) line(`     engage  → YOUR OWN closet`);
  line(`  So a report from the sell form verifies \`list\` ONLY. Run it again on`);
  line(`  a live listing before trusting the delist half.`);
  line();
  line(`  FASTEST PATH (US-2484) — you probably do not need this checklist:`);
  line(`    1. Open the sell form below in a browser with the extension installed.`);
  line(`    2. Open the GradeThread popup and click "Check selectors".`);
  line(`    3. Paste the report. It runs every selector below and names the`);
  line(`       misses, and it contains no page content.`);
  line();
  line(`    For a control that only appears AFTER a click — the delist menu's`);
  line(`    Delete, a success toast — open it first, then tick "I have already`);
  line(`    opened the menu" before checking. Without that box the report says`);
  line(`    only "missing, as expected" and tells you nothing about the control`);
  line(`    you are looking straight at.`);
  line();
  line(`  The manual checklist follows, for when the popup cannot reach the page`);
  line(`  (a tab loaded before the extension was installed) or you want to see`);
  line(`  exactly what is being asked for.`);
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

const SELECTOR_SOURCE = readFileSync(SELECTORS, "utf8");
for (const [platform, cfg] of Object.entries(selectors)) {
  checkPlatform(platform, cfg);
  checkHeadingHonesty(platform, cfg, SELECTOR_SOURCE);
}
const syncSelectors = loadSyncSelectors();
for (const [platform, cfg] of Object.entries(syncSelectors)) checkSyncPlatform(platform, cfg);

for (const w of warnings) console.warn(`  ! ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(`\nverify-lister-selectors: ${errors.length} problem(s).`);
  process.exit(1);
}

const platforms = Object.entries(selectors);
const live = platforms.filter(([, c]) => c.enabled).map(([p]) => p);
const pending = platforms.filter(([, c]) => !c.enabled).map(([p]) => p);
const syncPlatforms = Object.entries(syncSelectors);
const syncLive = syncPlatforms.filter(([, c]) => c.enabled).map(([p]) => p);
const syncPending = syncPlatforms.filter(([, c]) => !c.enabled).map(([p]) => p);
console.log(
  `✓ verify-lister-selectors: ${platforms.length} platforms — ` +
    `enabled: ${live.join(", ") || "none"}; ` +
    `awaiting live verification: ${pending.join(", ") || "none"}` +
    (warnings.length ? ` (${warnings.length} warning(s))` : ""),
);
console.log(
  `✓ verify-lister-selectors: sold-sync ${syncPlatforms.length} platform(s) — ` +
    `enabled: ${syncLive.join(", ") || "none"}; ` +
    `awaiting live verification: ${syncPending.join(", ") || "none"}`,
);
