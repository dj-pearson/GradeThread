// US-3062 AC1: each zip carries exactly ONE of the two side-panel keys.
//
// Chromium reads `side_panel.default_path` plus a `sidePanel` permission.
// Firefox reads `sidebar_action` and has no such permission. The two are not
// interchangeable and neither browser ignores the other's key quietly:
// `background.scripts` in a Chrome build is a load warning on every unpacked
// load, and an unknown permission is exactly what the AMO linter rejects a
// submission for. The same shape as the service_worker / scripts split that
// chromeManifest() and firefoxManifest() already handle.
//
// Asserted against the ACTUAL OUTPUT of the two transforms, not against a
// re-description of what they should produce. A guard that restates the
// expected values has the same blind spot as the bug it is guarding against —
// package-extensions.mjs exports both functions for this reason.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(ROOT, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"),
);

async function transforms() {
  const mod = await import(
    pathToFileURL(path.join(REPO, "scripts", "package-extensions.mjs")).href
  );
  return { firefox: mod.firefoxManifest, chrome: mod.chromeManifest };
}

const FIREFOX_CFG = {
  geckoId: "unified@gradethread.com",
  dataCollection: { required: ["websiteContent"] },
};

(async () => {
  const { firefox, chrome } = await transforms();
  const ff = firefox(manifest, FIREFOX_CFG);
  const cr = chrome(manifest);

  // ── the source manifest declares the Chromium half ────────────────────────
  assert.ok(
    manifest.side_panel && manifest.side_panel.default_path,
    "manifest.json must declare side_panel.default_path",
  );
  assert.ok(
    manifest.permissions.includes("sidePanel"),
    "manifest.json must request the sidePanel permission",
  );
  assert.ok(
    !manifest.sidebar_action,
    "the SOURCE manifest must not carry sidebar_action; firefoxManifest() derives it",
  );

  // ── Chrome keeps side_panel and the permission, and gains no sidebar ───────
  assert.strictEqual(
    cr.side_panel.default_path,
    manifest.side_panel.default_path,
    "the Chrome build must keep side_panel.default_path",
  );
  assert.ok(
    cr.permissions.includes("sidePanel"),
    "the Chrome build must keep the sidePanel permission",
  );
  assert.ok(
    !cr.sidebar_action,
    "the Chrome build must not carry sidebar_action",
  );

  // ── Firefox gets sidebar_action and loses both Chromium keys ──────────────
  assert.ok(
    ff.sidebar_action,
    "the Firefox build must carry sidebar_action",
  );
  assert.ok(
    !ff.side_panel,
    "the Firefox build must not carry side_panel — Firefox does not read it",
  );
  assert.ok(
    !ff.permissions.includes("sidePanel"),
    "sidePanel is not a Firefox permission; the AMO linter rejects unknown ones",
  );

  // The panel path is DERIVED, so a rename cannot leave Firefox pointing at a
  // file that no longer exists. This is the assertion that catches that.
  assert.strictEqual(
    ff.sidebar_action.default_panel,
    manifest.side_panel.default_path,
    "sidebar_action.default_panel must be the same file as side_panel.default_path",
  );
  assert.ok(
    ff.sidebar_action.default_title,
    "sidebar_action needs a title — Firefox shows it in the sidebar switcher",
  );
  assert.ok(
    ff.sidebar_action.default_icon,
    "sidebar_action needs an icon — Firefox draws it in the browser chrome",
  );

  // ── and the file it names actually ships ──────────────────────────────────
  const panel = path.join(ROOT, manifest.side_panel.default_path);
  assert.ok(
    fs.existsSync(panel),
    `${manifest.side_panel.default_path} is declared in the manifest but does ` +
      `not exist. Both stores accept a manifest pointing at a missing file and ` +
      `the panel simply never opens.`,
  );

  // ── the other transform is unchanged by this ─────────────────────────────
  // Cheap re-assertion of the split this one is modelled on, so a change to
  // firefoxManifest that breaks the background halves fails here too.
  assert.ok(!cr.background.scripts, "the Chrome build keeps no background.scripts");
  assert.ok(!ff.background.service_worker, "the Firefox build keeps no service_worker");

  console.log("✓ firefox-manifest: exactly one side-panel key per browser");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
