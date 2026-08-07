#!/usr/bin/env node
// US-1880 — marketplace adapter verification CLI.
//
//   node scripts/adapter-verify.mjs status
//   node scripts/adapter-verify.mjs snippet <adapter> [--out <file>]
//   node scripts/adapter-verify.mjs mark <adapter> [--date YYYY-MM-DD] [--dry] [--unverify]
//
// `snippet` prints a DevTools script to run on a real listing page; `mark`
// records the result by flipping `verified` + `lastVerified` + `version` in BOTH
// config files at once (extension-unified/research/selectors.js and
// public/extension/marketplace-selectors.json), which the config-sync guard test
// requires to stay byte-identical on those fields.
//
// Why a CLI and not a hand edit: the two files are a JS module and a JSON
// document holding the same data, the version bump has an ordering rule
// (US-1879 — a hosted config that sorts below the bundled one is ignored by
// every install), and doing three edits twice by hand is how that goes wrong.
//
// See vault/10-ops/extension-adapter-verification.md for the procedure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildVerifySnippet,
  nextVersion,
  parseBundledConfig,
  readAdapterVerified,
  readTopLevelString,
  setAdapterVerified,
  setTopLevelString,
} from "./lib/adapter-verification.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUNDLED = path.join(root, "extension-unified", "research", "selectors.js");
const HOSTED = path.join(root, "public", "extension", "marketplace-selectors.json");
const IMAGE_UTILS = path.join(root, "extension-unified", "research", "image-utils.js");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function rel(p) {
  return path.relative(root, p).replace(/\\/g, "/");
}

function loadConfig() {
  return parseBundledConfig(read(BUNDLED));
}

function fail(msg) {
  console.error(`adapter-verify: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) flags[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function cmdStatus() {
  const config = loadConfig();
  const keys = Object.keys(config.adapters);
  const rows = keys.map((k) => ({
    adapter: k,
    label: config.adapters[k].label,
    verified: config.adapters[k].verified ? "yes" : "NO",
    hosts: config.adapters[k].hosts.length,
  }));
  console.log(`config v${config.version} · lastVerified ${config.lastVerified}`);
  console.table(rows);
  const unverified = keys.filter((k) => !config.adapters[k].verified);
  if (unverified.length) {
    console.log(
      `\n${unverified.length} adapter(s) NOT verified against a live site: ${unverified.join(", ")}`,
    );
    console.log(`Run:  node scripts/adapter-verify.mjs snippet ${unverified[0]}`);
  } else {
    console.log("\nAll adapters verified.");
  }
}

function cmdSnippet(key, flags) {
  const config = loadConfig();
  const adapter = config.adapters[key];
  if (!adapter) {
    fail(`unknown adapter "${key}". Known: ${Object.keys(config.adapters).join(", ")}`);
  }
  const snippet = buildVerifySnippet({
    adapterKey: key,
    adapter,
    version: config.version,
    imageUtilsSrc: read(IMAGE_UTILS),
  });
  if (typeof flags.out === "string") {
    fs.writeFileSync(path.resolve(root, flags.out), snippet, "utf8");
    console.error(`wrote ${flags.out} (${snippet.split("\n").length} lines)`);
  } else {
    process.stdout.write(snippet);
  }
}

function cmdMark(key, flags) {
  const value = !flags.unverify;
  const date = typeof flags.date === "string" ? flags.date : new Date().toISOString().slice(0, 10);

  let bundledSrc = read(BUNDLED);
  let hostedSrc = read(HOSTED);

  const before = readAdapterVerified(bundledSrc, key, { json: false });
  const hostedBefore = readAdapterVerified(hostedSrc, key, { json: true });
  if (before !== hostedBefore) {
    fail(
      `the two config files disagree on "${key}".verified (${rel(BUNDLED)}=${before}, ` +
        `${rel(HOSTED)}=${hostedBefore}). Fix the drift first — the config-sync test should already be red.`,
    );
  }

  const currentVersion = readTopLevelString(bundledSrc, "version", { json: false });
  const version = nextVersion(currentVersion, date);

  bundledSrc = setAdapterVerified(bundledSrc, key, value, { json: false });
  bundledSrc = setTopLevelString(bundledSrc, "lastVerified", date, { json: false });
  bundledSrc = setTopLevelString(bundledSrc, "version", version, { json: false });

  hostedSrc = setAdapterVerified(hostedSrc, key, value, { json: true });
  hostedSrc = setTopLevelString(hostedSrc, "lastVerified", date, { json: true });
  hostedSrc = setTopLevelString(hostedSrc, "version", version, { json: true });

  // Both files must still parse, and must still agree — otherwise write nothing.
  const nextConfig = parseBundledConfig(bundledSrc);
  const nextHosted = JSON.parse(hostedSrc);
  if (JSON.stringify(nextConfig.adapters) !== JSON.stringify(nextHosted.adapters)) {
    fail("the edit made the two configs disagree — refusing to write. This is a bug in adapter-verify.");
  }

  const summary = [
    `${key}.verified: ${before} -> ${value}`,
    `lastVerified: ${date}`,
    `version: ${currentVersion} -> ${version}`,
    `files: ${rel(BUNDLED)}, ${rel(HOSTED)}`,
  ].join("\n  ");

  if (flags.dry) {
    console.log(`DRY RUN — nothing written.\n  ${summary}`);
    return;
  }
  fs.writeFileSync(BUNDLED, bundledSrc, "utf8");
  fs.writeFileSync(HOSTED, hostedSrc, "utf8");
  console.log(`recorded.\n  ${summary}`);
  console.log("\nNow run:  node scripts/test-extensions.mjs");
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/adapter-verify.mjs status",
      "  node scripts/adapter-verify.mjs snippet <adapter> [--out <file>]",
      "  node scripts/adapter-verify.mjs mark <adapter> [--date YYYY-MM-DD] [--dry] [--unverify]",
      "",
      "Procedure: vault/10-ops/extension-adapter-verification.md",
    ].join("\n"),
  );
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [cmd, key] = positional;

try {
  if (!cmd || cmd === "help" || flags.help) usage();
  else if (cmd === "status") cmdStatus();
  else if (cmd === "snippet") {
    if (!key) fail("snippet needs an adapter key (try: status)");
    cmdSnippet(key, flags);
  } else if (cmd === "mark") {
    if (!key) fail("mark needs an adapter key (try: status)");
    cmdMark(key, flags);
  } else {
    usage();
    fail(`unknown command "${cmd}"`);
  }
} catch (err) {
  fail(err.message);
}
