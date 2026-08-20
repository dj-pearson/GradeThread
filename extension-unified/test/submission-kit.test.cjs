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

// ── the sold-sync content script must be DISCLOSED ─────────────────────────
// US-2699. The second genuinely-new access after the bridge, and the more
// sensitive one: it runs on a page that prints the BUYER's name and shipping
// address. A reviewer reading only "reads listing pages" would not know we are
// on the seller's order history, and a store that finds that out by itself
// finds it out as an undisclosed collection.
const syncCs = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("sync/content.js"),
);
if (syncCs) {
  assert.ok(
    /sold-order|order\/sales|sold-sync/i.test(doc),
    "sync/content.js is injected into the seller's own Poshmark order pages, but " +
      "SUBMISSION.md never discloses it. That page carries buyer identity, so an " +
      "undisclosed content script on it is the worst omission in this kit.",
  );
  assert.ok(
    /buyer'?s? name/i.test(doc) && /shipping address/i.test(doc),
    "SUBMISSION.md discloses the sold-sync content script but does not state that " +
      "the buyer's name and shipping address are NOT read. Stating what is collected " +
      "without stating what is deliberately not collected leaves a reviewer to assume " +
      "the worst about a page they can see has both.",
  );
  // US-2729: the disclosure must name every marketplace sold-sync can read, in
  // the sold-sync disclosure itself.
  //
  // The host loop below is satisfied by the bare domain appearing ANYWHERE in the
  // document, and every sold-sync host is already there for the Lister. So adding
  // the Mercari adapter (US-2700) widened what this script reads while the
  // disclosure still said "Poshmark", and nothing failed. A reviewer comparing the
  // manifest to the copy would have found it; that is the wrong person to find it.
  {
    const selSrc = fs.readFileSync(path.join(dir, "sync/selectors.js"), "utf8");
    const scope = {};
    const SEL = new Function("self", `${selSrc}; return self.GT_SYNC_SELECTORS;`)(scope);
    const start = doc.search(/sold-sync, on the seller/i);
    assert.ok(start !== -1, "SUBMISSION.md has no sold-sync bullet to check");
    const bullet = doc.slice(start, start + 3000);
    for (const platform of Object.keys(SEL)) {
      assert.ok(
        new RegExp(platform, "i").test(bullet),
        `sync/selectors.js ships a ${platform} adapter but the sold-sync disclosure ` +
          `never names it. The host loop below passes anyway, because ${platform} is ` +
          `already justified for the Lister — so a widened read looks disclosed when ` +
          `it is not.`,
      );
    }
  }

  // US-2729: if the scheduled poll ships, the disclosure must say so.
  //
  // US-2699 wrote "there is no scheduled read and it never opens or navigates a
  // tab", which was true that day. US-2701 then shipped an alarm that opens a
  // background tab on the seller's marketplace, and the sentence stayed. The
  // extension's OWN clickwrap said the opposite, in the same package.
  {
    const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
    if (/SYNC_POLL_ALARM/.test(bg)) {
      assert.ok(
        /schedule/i.test(doc) && /unfocused tab|background tab/i.test(doc),
        "background.js ships the scheduled sold-sync poll, which opens a tab on the " +
          "seller's marketplace, but SUBMISSION.md never discloses a scheduled read.",
      );
      assert.ok(
        !/there is no scheduled read/i.test(doc),
        "SUBMISSION.md still claims sold-sync has no scheduled read while " +
          "background.js ships the alarm that performs one.",
      );
      assert.ok(
        /human check/i.test(doc),
        "the poll stops permanently on a human check and never answers one. That is " +
          "the promise a store reviewer most needs stated, and it is asserted in the " +
          "extension's own clickwrap — the submission must not be quieter than the " +
          "consent screen.",
      );
    }
  }

  // Every path the script can reach must be justified by host, same rule the
  // host_permissions loop applies above.
  for (const m of syncCs.matches || []) {
    const bare = String(m)
      .replace(/^https:\/\//, "")
      .replace(/^\*\./, "")
      .replace(/\/.*$/, "");
    assert.ok(
      doc.includes(bare),
      `sold-sync content script matches ${m} but ${bare} is never justified in SUBMISSION.md.`,
    );
  }
}

console.log(
  `submission-kit.test.cjs: SUBMISSION.md matches manifest v${version} — ` +
    `${(manifest.permissions || []).length} permissions + ` +
    `${(manifest.host_permissions || []).length} hosts justified, bridge disclosed`,
);
