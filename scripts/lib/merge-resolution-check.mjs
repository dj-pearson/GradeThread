// US-3408: the gate between "conflict markers removed" and "this compiles".
//
// 40e95fadc resolved src/components/flipdesk/record-sale-dialog.tsx by
// interleaving both sides of the conflict instead of choosing one. The result
// kept one side's function bodies and the other side's imports, so every
// declaration those bodies read was gone and `Select` was imported twice. git
// reported the conflict and then reported the resolution as clean, because git
// checks for markers and nothing else. `tsc -b` reported 11 errors; the push
// used --no-verify and origin/main was un-buildable for about forty minutes.
//
// WHY THIS IS NOT JUST `tsc -b`. Measured on the session box 2026-09-18:
// `npx tsc -b --force` is 64s and `npx tsc -b tsconfig.app.json --force` is 65s,
// and touching two files and re-running incremental is still 61s, because tsc
// re-checks the whole program whenever any input moves. A sixty-second gate is
// exactly the gate that gets bypassed, which is the habit this story is about.
//
// So this checks ONE FILE AT A TIME with the real TypeScript checker and stubs
// every module it imports. Each import still BINDS its names (the stub is
// `export = any`), so a name that came from an import is declared and a name
// whose declaration the merge dropped is not. That makes exactly the errors a
// half-resolved file produces visible, without loading the import graph:
//
//   TS2300 duplicate identifier      — `Select` imported by both sides
//   TS2304 cannot find name          — bodies kept, declarations dropped
//   TS2440 import conflicts with local declaration
//   TS2451 cannot redeclare block-scoped variable
//
// Everything a stub CANNOT answer (wrong argument types, missing exports,
// TS2305, TS2339) is deliberately not reported, because a stub would report it
// on correct code too. This gate answers one question — is this file's own
// scope intact — and `npm run verify` still answers the rest.
//
// Measured 2026-09-18: 1.8s for four files cold, and the whole 40e95fadc merge
// (14 files) in under six seconds. AC2's budget is a minute.

import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/** The diagnostics a stubbed single-file program can report honestly. */
export const REPORTED_CODES = new Map([
  [2300, "duplicate identifier"],
  [2304, "cannot find name"],
  [2440, "import conflicts with a local declaration"],
  [2451, "cannot redeclare block-scoped variable"],
]);

const TS_EXT = /\.(m|c)?tsx?$/;

/** An import whose names bind to `any`, so a bound name is never "not found". */
const STUB_TEXT = "declare const __merge_gate_any: any;\nexport = __merge_gate_any;\n";

const PROJECT_CONFIGS = [
  "tsconfig.app.json",
  "tsconfig.functions.json",
  "tsconfig.node.json",
  "tsconfig.e2e.json",
];

// The edge service is a Deno program and answers to `deno check`, not to any
// tsconfig in this tree — services/edge-functions/deno.json carries
// `{ "strict": true }` and nothing else. Left out, 39 of the 64 TypeScript files
// merge 40e95fadc touched were skipped silently, which is the same defect one
// level up: a gate that reports "clean" for files it never looked at.
//
// The Deno globals are declared as ambient `any` rather than pulled from Deno's
// own lib, because this gate only decides whether a NAME is declared — it never
// reads a type — and shipping a lib.deno.d.ts copy here would rot.
const EDGE_ROOT = "services/edge-functions/";
const EDGE_PROJECT = {
  name: "services/edge-functions/deno.json",
  options: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
    strict: true,
    allowImportingTsExtensions: true,
  },
  ambient:
    "declare const Deno: any;\n" +
    "declare namespace Deno { type Kv = any; type KvKey = any; }\n",
};

function loadProjects(root) {
  const projects = [];
  for (const name of PROJECT_CONFIGS) {
    const configPath = path.join(root, name);
    if (!existsSync(configPath)) continue;
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (raw.error) continue;
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root, undefined, configPath);
    const owned = new Set(parsed.fileNames.map((f) => path.resolve(f)));
    projects.push({ name, options: { ...parsed.options }, owned });
  }
  return projects;
}

function projectFor(projects, absFile) {
  return projects.find((p) => p.owned.has(absFile));
}

/**
 * Leftover conflict markers. Cheap, and it is the only half-resolution shape
 * that the compiler reports as a wall of syntax errors rather than as one
 * readable line.
 */
function conflictMarkers(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^(<{7}|={7}|>{7})(\s|$)/.test(line)) {
      out.push({ line: i + 1, code: 0, message: `leftover conflict marker: ${line.slice(0, 40)}` });
    }
  });
  return out;
}

function programOptions(projectOptions) {
  // Drop everything about emit, project references and module resolution: the
  // single-file program resolves nothing and emits nothing. Keep target, lib,
  // jsx, types and strictness, because those decide which globals exist and
  // therefore which TS2304s are real.
  const o = { ...projectOptions };
  delete o.composite;
  delete o.incremental;
  delete o.tsBuildInfoFile;
  delete o.outDir;
  delete o.declarationDir;
  delete o.paths;
  delete o.baseUrl;
  o.noEmit = true;
  o.skipLibCheck = true;
  o.skipDefaultLibCheck = true;
  o.noResolve = false;
  return o;
}

function checkGroup(files, projectOptions, contents, ambient) {
  const options = programOptions(projectOptions);
  const base = ts.createCompilerHost(options, true);
  const stubs = new Map();
  const texts = new Map(files.map((f) => [f, contents.get(f) ?? readFileSync(f, "utf8")]));

  const stubFor = (specifier) => {
    const file = `/__merge_gate_stub__/${Buffer.from(specifier).toString("hex")}.d.ts`;
    if (!stubs.has(file)) {
      stubs.set(file, ts.createSourceFile(file, STUB_TEXT, ts.ScriptTarget.Latest, true));
    }
    return file;
  };

  const host = {
    ...base,
    getSourceFile(name, languageVersion, onError, shouldCreate) {
      if (texts.has(name)) {
        return ts.createSourceFile(
          name,
          texts.get(name),
          languageVersion,
          true,
          name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
      }
      if (stubs.has(name)) return stubs.get(name);
      return base.getSourceFile(name, languageVersion, onError, shouldCreate);
    },
    resolveModuleNameLiterals(literals) {
      return literals.map((l) => ({
        resolvedModule: {
          resolvedFileName: stubFor(l.text),
          extension: ts.Extension.Dts,
          isExternalLibraryImport: true,
        },
      }));
    },
    fileExists: (n) => (n.startsWith("/__merge_gate_stub__/") ? true : base.fileExists(n)),
    readFile: (n) => (n.startsWith("/__merge_gate_stub__/") ? STUB_TEXT : base.readFile(n)),
  };

  const AMBIENT = "/__merge_gate_ambient__.d.ts";
  if (ambient) {
    stubs.set(AMBIENT, ts.createSourceFile(AMBIENT, ambient, ts.ScriptTarget.Latest, true));
  }
  const program = ts.createProgram(ambient ? [AMBIENT, ...files] : files, options, host);
  const byFile = new Map(files.map((f) => [f, []]));
  for (const file of files) {
    const src = program.getSourceFile(file);
    if (!src) continue;
    const diags = [
      ...program.getSyntacticDiagnostics(src),
      ...program.getSemanticDiagnostics(src),
    ].filter((d) => REPORTED_CODES.has(d.code));
    for (const d of diags) {
      const { line } = src.getLineAndCharacterOfPosition(d.start ?? 0);
      byFile.get(file).push({
        line: line + 1,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, " "),
      });
    }
  }
  return byFile;
}

/**
 * @param {string[]} files  paths, absolute or relative to `root`
 * @param {{root?: string, projectName?: string, contents?: Map<string,string>}} [opts]  projectName forces
 *        which tsconfig's compiler options apply, for checking a file that is
 *        deliberately outside the tree (the US-3408 fixture lives as .tsx.txt
 *        so `tsc -b` never compiles it). `contents` supplies a file's text
 *        instead of reading it from disk, so a past commit's blob can be
 *        checked without a worktree.
 * @returns {{checked: string[], skipped: {file: string, reason: string}[],
 *            findings: {file: string, line: number, code: number, message: string}[]}}
 */
export function checkFiles(files, opts = {}) {
  const root = path.resolve(opts.root ?? process.cwd());
  const projects = loadProjects(root);
  const forced = opts.projectName
    ? projects.find((p) => p.name === opts.projectName)
    : undefined;
  if (opts.projectName && !forced) {
    throw new Error(`no such project: ${opts.projectName}`);
  }
  const checked = [];
  const skipped = [];
  const findings = [];
  /** @type {Map<string, {options: object, files: string[]}>} */
  const groups = new Map();
  const supplied = opts.contents ?? new Map();
  /** absolute path -> text, for the group builder */
  const byAbs = new Map();

  for (const raw of files) {
    const abs = path.resolve(root, raw);
    if (!TS_EXT.test(abs)) {
      skipped.push({ file: raw, reason: "not a TypeScript source file" });
      continue;
    }
    const text = supplied.has(raw) ? supplied.get(raw) : undefined;
    if (text === undefined && !existsSync(abs)) {
      skipped.push({ file: raw, reason: "deleted by this change" });
      continue;
    }
    if (text !== undefined) byAbs.set(abs, text);
    for (const m of conflictMarkers(text ?? readFileSync(abs, "utf8"))) {
      findings.push({ file: raw, ...m });
    }
    const relForEdge = path.relative(root, abs).split(path.sep).join("/");
    const project =
      forced ??
      (relForEdge.startsWith(EDGE_ROOT) ? EDGE_PROJECT : undefined) ??
      projectFor(projects, abs);
    if (!project) {
      // A .ts file in no project is its own defect and US-2629 / US-2401 closed
      // the known ones. Say so rather than reporting the file as clean.
      skipped.push({ file: raw, reason: "in no tsconfig project" });
      continue;
    }
    if (!groups.has(project.name)) {
      groups.set(project.name, {
        options: project.options,
        ambient: project.ambient,
        files: [],
      });
    }
    groups.get(project.name).files.push(abs);
    checked.push(raw);
  }

  for (const { options, ambient, files: group } of groups.values()) {
    const byFile = checkGroup(group, options, byAbs, ambient);
    for (const [abs, list] of byFile) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      for (const f of list) findings.push({ file: rel, ...f });
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { checked, skipped, findings };
}

export function formatFindings(findings) {
  return findings
    .map((f) =>
      f.code === 0
        ? `${f.file}:${f.line}  ${f.message}`
        : `${f.file}:${f.line}  TS${f.code} ${f.message}`,
    )
    .join("\n");
}
