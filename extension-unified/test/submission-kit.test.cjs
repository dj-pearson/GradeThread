// GradeThread unified extension — store-kit ⇄ manifest guard (US-1872 AC4).
//
// SUBMISSION.md is the copy-paste source for the Chrome Web Store and AMO
// listings: the artifact filenames to upload, the permission justifications, and
// the privacy narrative. It is only useful if it describes the extension that
// actually ships.
//
// It had drifted on both counts:
//   • VERSION — it named v0.3.0 artifacts while the manifest said 0.3.5, and
//     package-extensions.mjs derives the zip name FROM the manifest. So it told you
//     to upload files the packager had never produced.
//   • PERMISSIONS — every requested permission needs a justification, and a missing
//     one is a store rejection. That is not hypothetical: `alarms` was added for
//     US-1874 and shipped unjustified until US-1878 caught it by hand.
//
// Both are invisible to every other test here, and both surface only at submission
// time — the worst moment. Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const doc = fs.readFileSync(path.join(dir, "SUBMISSION.md"), "utf8");

// ── version ────────────────────────────────────────────────────────────────
const version = manifest.version;
assert.ok(
  doc.includes(`v${version}`),
  `SUBMISSION.md does not mention v${version}. package-extensions.mjs names its ` +
    `zips from the manifest version, so the kit is telling you to upload artifacts ` +
    `that do not exist.`,
);
// And it must not still be advertising an older one alongside.
const versionsMentioned = Array.from(
  new Set(Array.from(doc.matchAll(/v(\d+\.\d+\.\d+)/g)).map((m) => m[1])),
);
assert.deepStrictEqual(
  versionsMentioned,
  [version],
  `SUBMISSION.md mentions ${JSON.stringify(versionsMentioned)} but the manifest is ` +
    `${version} — a stale version here means uploading the wrong build.`,
);

// ── every requested permission is justified ────────────────────────────────
for (const perm of manifest.permissions || []) {
  assert.ok(
    new RegExp("`" + perm + "`").test(doc),
    `permission "${perm}" is requested in manifest.json but has NO justification in ` +
      `SUBMISSION.md. Chrome's Privacy practices tab requires one per permission, and ` +
      `an unjustified permission is a review rejection (US-1874 shipped \`alarms\` ` +
      `unjustified exactly this way).`,
  );
}

// ── every host permission is justified ─────────────────────────────────────
// Checked by HOST rather than by literal pattern: the doc reasonably writes the
// pattern in prose, but it must not simply omit a host the extension asks for.
for (const host of manifest.host_permissions || []) {
  const bare = host.replace(/^https:\/\//, "").replace(/^\*\./, "").replace(/\/\*$/, "");
  assert.ok(
    doc.includes(bare),
    `host permission "${host}" is requested but ${bare} is never justified in ` +
      `SUBMISSION.md.`,
  );
}

// ── the gradethread.com content script must be DISCLOSED ───────────────────
// US-1872 AC4: merging the two extensions added a content script on gradethread.com
// — the deliberate privacy-posture trade the epic exists to document. The old
// "not host-permitted on gradethread.com" claim died with the merge, and the
// justification must say what replaced it: a relay that reads nothing. Silence on
// the one genuinely new access is the gap.
const bridge = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("gt-bridge.js"),
);
if (bridge) {
  assert.ok(
    /content script/i.test(doc) && /relay/i.test(doc),
    "gt-bridge.js is injected into gradethread.com pages, but SUBMISSION.md never " +
      "discloses that a content script runs there. US-1872 AC4 requires the merged " +
      "permission set's privacy posture to be documented — a reviewer reading only " +
      '"call our API" would not know a script is injected into every page of our site.',
  );
}

console.log(
  `submission-kit.test.cjs: SUBMISSION.md matches manifest v${version} — ` +
    `${(manifest.permissions || []).length} permissions + ` +
    `${(manifest.host_permissions || []).length} hosts justified, bridge disclosed`,
);
