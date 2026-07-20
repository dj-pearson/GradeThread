// US-1881 follow-up — every Firefox-targeted extension declares a version floor.
//
// THE BUG THIS CLOSES. Firefox gained MV3 in 109. An MV3 add-on shipped without
// `browser_specific_settings.gecko.strict_min_version` installs happily on
// older Firefox, where the APIs it is built on do not exist — so it lands, does
// nothing, and reads to the user as our software being broken rather than as an
// unsupported browser.
//
// It had already happened once and was written down: the firefoxManifest()
// comment in scripts/package-extensions.mjs lists "a wholesale overwrite of
// browser_specific_settings that dropped strict_min_version" as one of three
// drift breakages that shipped. It then recurred by a different route —
// extension-condition declared no `browser_specific_settings` at all, so the
// packager's config fallback supplied a gecko id and NOTHING constrained the
// version. The Condition Check Firefox zip shipped with no floor.
//
// WHY A TEST AND NOT JUST THE PACKAGER GUARD. The packager now throws, which
// catches it at upload time. This catches it at commit time, and — more usefully
// — it checks the MANIFESTS IN THE REPO, which is where the value has to be
// declared. The packager can only see what it is handed; a guard that runs on
// the repo tells you which file to edit before you are mid-release.
//
// Deliberately NOT asserting a specific version beyond the MV3 floor: bumping
// the minimum higher is a legitimate product decision, and a test that pins an
// exact string would fight it. What is never legitimate is having no floor.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

// Extensions the packager emits a Firefox build for. Derived from the packager's
// own config rather than hardcoded, so a newly Firefox-enabled extension is
// covered the day it is enabled, not the day someone remembers this file.
const packagerSrc = fs.readFileSync(
  path.join(root, "scripts", "package-extensions.mjs"),
  "utf8",
);

/** Extension dirs configured with a geckoId and not blocked from Firefox. */
function firefoxTargets() {
  const out = [];
  // Each EXTENSIONS entry is `{ dir: "...", ... firefox: {...} }`.
  const entryRe = /\{\s*(?:\/\/[^\n]*\n\s*)*dir:\s*"([^"]+)"([\s\S]*?)\n  \},/g;
  for (const m of packagerSrc.matchAll(entryRe)) {
    const [, dir, body] = m;
    if (/firefox:\s*\{[\s\S]*?blocked:/.test(body)) continue; // Firefox zip skipped
    if (/geckoId:/.test(body)) out.push(dir);
  }
  return out;
}

const targets = firefoxTargets();

// MV3 landed in Firefox 109. Anything below cannot run these extensions at all.
const MV3_FLOOR = 109;

function parseMajor(v) {
  const m = /^(\d+)/.exec(String(v ?? ""));
  return m ? Number(m[1]) : NaN;
}

const testName =
  "every Firefox-targeted extension declares gecko.strict_min_version >= 109";

if (targets.length === 0) {
  throw new Error(
    "firefox-version-floor: found NO Firefox-targeted extensions in " +
      "package-extensions.mjs. That is almost certainly this test's parser " +
      "breaking rather than the config genuinely being empty — a guard that " +
      "silently checks nothing is the failure mode it exists to prevent.",
  );
}

for (const dir of targets) {
  const manifestPath = path.join(root, dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const gecko = manifest.browser_specific_settings?.gecko;
  assert.ok(
    gecko,
    `${dir}/manifest.json has no browser_specific_settings.gecko, but the ` +
      `packager builds a Firefox zip for it. The packager's firefox.geckoId ` +
      `fallback supplies an id and NOTHING ELSE — so the shipped add-on would ` +
      `have no version floor. Declare the block in the manifest.`,
  );

  const major = parseMajor(gecko.strict_min_version);
  assert.ok(
    !Number.isNaN(major),
    `${dir}: gecko.strict_min_version is missing or unparseable ` +
      `(${JSON.stringify(gecko.strict_min_version)}). Without it the MV3 add-on ` +
      `installs on pre-109 Firefox and silently does nothing.`,
  );
  assert.ok(
    major >= MV3_FLOOR,
    `${dir}: gecko.strict_min_version is ${gecko.strict_min_version}, below the ` +
      `Firefox MV3 floor of ${MV3_FLOOR}. The add-on would install where its own ` +
      `APIs do not exist.`,
  );

  // The id must be declared too — the packager treats its config value as a
  // gap-filler, and an id that lives only in the packager can disagree with the
  // repo manifest (the third drift breakage its comment records).
  assert.ok(
    typeof gecko.id === "string" && gecko.id.length > 0,
    `${dir}: gecko.id must be declared in the manifest, not left to the ` +
      `packager fallback — a dev-loaded add-on and the shipped one would ` +
      `otherwise have different identities.`,
  );
}

console.log(
  `✓ firefox-version-floor: ${targets.length} Firefox target(s) (${targets.join(", ")}) ` +
    `each declare gecko.id + strict_min_version >= ${MV3_FLOOR}`,
);
console.log(`  (${testName})`);
