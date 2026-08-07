#!/usr/bin/env node
// US-1882 — web↔extension transport verification CLI.
//
//   node scripts/transport-verify.mjs snippet [--platform poshmark] [--out <file>]
//
// Prints the DevTools script the operator pastes into the Console on
// gradethread.com before running a seller flow. It observes which transport the
// shipped page code actually used — externally_connectable on Chromium, the
// gradethread.com postMessage bridge on Firefox — and prints a pass/fail table
// plus a one-line result to record against AC4.
//
// The procedure (which browser, which steps, what a pass looks like) is
// extension-unified/TESTING.md §5c.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTransportSnippet } from "./lib/transport-verification.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(root, "extension-unified", "gt-bridge.js");

function fail(msg) {
  console.error(`transport-verify: ${msg}`);
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

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/transport-verify.mjs snippet [--platform poshmark] [--out <file>]",
      "",
      "Procedure: extension-unified/TESTING.md §5c",
    ].join("\n"),
  );
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [cmd] = positional;

try {
  if (!cmd || cmd === "help" || flags.help) {
    usage();
  } else if (cmd === "snippet") {
    const snippet = buildTransportSnippet({
      expectPlatform: typeof flags.platform === "string" ? flags.platform : "poshmark",
      bridgeSrc: fs.readFileSync(BRIDGE, "utf8"),
    });
    if (typeof flags.out === "string") {
      fs.writeFileSync(path.resolve(root, flags.out), snippet, "utf8");
      console.error(`wrote ${flags.out} (${snippet.split("\n").length} lines)`);
    } else {
      process.stdout.write(snippet);
    }
  } else {
    usage();
    fail(`unknown command "${cmd}"`);
  }
} catch (err) {
  fail(err.message);
}
