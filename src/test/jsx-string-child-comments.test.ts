// US-3353: a `// ...` line sitting as a direct child of a JSX element is NOT a
// comment. It is a text child. `src/routes/admin-routes.tsx` carried fifteen of
// them across eight blocks, and they were invisible to everything: `tsc` accepts
// a string child, eslint's config here accepts a string child, and React
// Router's `createRoutesFromChildren` drops non-elements, so nothing rendered.
// The moment that subtree is used somewhere React does not filter children, the
// explanations start rendering as page copy.
//
// The scan is the deliverable, not the eight fixes. It is deliberately built on
// the TypeScript parser rather than a regex, because the thing being looked for
// is a two-character token that appears constantly in legitimate code:
//
//   - `https://…` inside a string or an attribute value
//   - `//` inside a regex literal or a template literal
//   - a real `{/* … */}` JSX comment
//   - an ordinary `// …` statement comment anywhere outside JSX children
//
// Every one of those is a DIFFERENT node kind from `JsxText`. A `JsxText` node
// is, by definition, the raw character data between JSX tags — the parser has
// already decided it is a child and not a string, an attribute, a regex or
// trivia. So the separation is structural, not heuristic: find `JsxText`, then
// look at the lines inside it. The false-positive cases above are proved to stay
// quiet by the fixtures below rather than argued for here.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC_ROOT = path.resolve(__dirname, "..");

interface Finding {
  file: string;
  line: number;
  text: string;
}

/**
 * Parse one TSX source and return every line of raw JSX character data that
 * starts with `//`. `fileName` is only used for reporting.
 */
function findJsxCommentChildren(fileName: string, source: string): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const start = node.getStart(sf);
      const raw = source.slice(start, node.getEnd());
      let offset = 0;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//")) {
          const { line: lineIndex } = sf.getLineAndCharacterOfPosition(start + offset);
          found.push({ file: fileName, line: lineIndex + 1, text: trimmed });
        }
        offset += line.length + 1;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

function collectTsxFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (entry.name.endsWith(".tsx")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe("JSX children that look like comments but are text (US-3353)", () => {
  const files = collectTsxFiles(SRC_ROOT);

  // FAIL-CLOSED. A scan for a two-character token that walks zero files reports
  // "clean" and is indistinguishable from a scan that works. If a refactor moves
  // the tree, renames the extension or breaks the walk, this is the assertion
  // that says so instead of quietly passing forever. 816 .tsx files under src/
  // when this was written (2026-09-11); the floor is set well under that so
  // ordinary deletions do not trip it.
  it("walks a real corpus of .tsx files", () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it("finds no `//` line sitting as a JSX text child anywhere in src/", () => {
    const findings: Finding[] = [];
    for (const file of files) {
      findings.push(...findJsxCommentChildren(file, readFileSync(file, "utf8")));
    }

    const report = findings
      .map(f => `${path.relative(SRC_ROOT, f.file)}:${f.line}: ${f.text}`)
      .join("\n");

    expect(
      findings,
      `These lines are JSX TEXT CHILDREN, not comments. React drops them today, ` +
        `but they render as page copy anywhere children are not filtered. ` +
        `Convert each to {/* ... */} — do not delete them.\n${report}`,
    ).toEqual([]);
  });

  // The scan has to be proved to fire, because "no findings" is the same output
  // whether the corpus is clean or the detector is broken. These fixtures are
  // the sabotage, run on every invocation rather than by hand once.
  describe("the detector itself", () => {
    it("catches a planted `//` child, single line and multi line", () => {
      const planted = `
        export function Bad() {
          return (
            <Routes>
              // US-000 a planted single-line explanation.
              <Route path="a" element={<A />} />
              // US-001 a planted explanation
              // that wraps onto a second line.
              <Route path="b" element={<B />} />
            </Routes>
          );
        }
      `;
      const hits = findJsxCommentChildren("planted.tsx", planted);
      expect(hits.map(h => h.text)).toEqual([
        "// US-000 a planted single-line explanation.",
        "// US-001 a planted explanation",
        "// that wraps onto a second line.",
      ]);
    });

    it("catches a `//` child of an ordinary element, not just <Routes>", () => {
      const planted = `export const X = () => <div>\n  // planted\n  <span>hi</span>\n</div>;`;
      expect(findJsxCommentChildren("planted.tsx", planted)).toHaveLength(1);
    });

    // Everything below is a `//` the scan must NOT report. Each is a different
    // node kind: none of them is JsxText.
    it("ignores a real {/* */} JSX comment", () => {
      const ok = `export const X = () => (
        <Routes>
          {/* US-2559 AC5: a genuine comment, in the correct form. */}
          {/* // even one whose body starts with a slash-slash */}
          <Route path="a" element={<A />} />
        </Routes>
      );`;
      expect(findJsxCommentChildren("ok.tsx", ok)).toEqual([]);
    });

    it("ignores a URL in a string, an attribute value and JSX text", () => {
      const ok = `const home = "https://gradethread.com";
      export const X = () => (
        <div title="see https://gradethread.com/docs">
          <a href="https://functions.gradethread.com/api/grade">{home}</a>
          Read more at https://gradethread.com for the full standard.
        </div>
      );`;
      expect(findJsxCommentChildren("ok.tsx", ok)).toEqual([]);
    });

    it("ignores a regex literal and a template literal containing //", () => {
      const ok = `const proto = /^\\/\\//;
      const t = \`// not a comment, just text
      // and a second line of it\`;
      export const X = () => <div>{t.replace(proto, "")}</div>;`;
      expect(findJsxCommentChildren("ok.tsx", ok)).toEqual([]);
    });

    it("ignores ordinary statement comments, including inside a component body", () => {
      const ok = `// a file-header comment
      export function X() {
        // a statement comment
        const n = 1; // a trailing comment
        return (
          <div>
            {/* fine */}
            {n}
          </div>
        );
      }`;
      expect(findJsxCommentChildren("ok.tsx", ok)).toEqual([]);
    });

    it("ignores a comment inside a JSX expression container", () => {
      const ok = `export const X = () => (
        <div>
          {
            // a real comment, inside an expression container
            42
          }
        </div>
      );`;
      expect(findJsxCommentChildren("ok.tsx", ok)).toEqual([]);
    });
  });
});
