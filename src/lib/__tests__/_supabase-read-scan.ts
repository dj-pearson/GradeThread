import ts from "typescript";

export function uncheckedReads(text: string, file = "source.tsx") {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: Array<{ line: number; table: string; binding: string; start: number; end: number }> = [];
  function check(binding: ts.BindingName, expression: ts.Expression, node: ts.VariableDeclaration) {
    if (!ts.isObjectBindingPattern(binding)) return;
    const query = expression.getText(source);
    const table = query.match(/\.(?:from|rpc)\(\s*["']([^"']+)["']/)?.[1];
    const names = binding.elements.map(e => (e.propertyName ?? e.name).getText(source));
    if (table && /\bsupabase\b/.test(query) && !/supabase\.(?:auth|storage)\b/.test(query) &&
        !/\.throwOnError\(/.test(query) && !names.includes("error") &&
        (names.includes("data") || names.includes("count"))) {
      findings.push({
        line: source.getLineAndCharacterOfPosition(binding.getStart(source)).line + 1,
        table,
        binding: binding.getText(source),
        start: node.getStart(source),
        end: node.parent.parent.end,
      });
    }
  }
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) &&
        node.initializer && ts.isAwaitExpression(node.initializer)) {
      const expression = node.initializer.expression;
      check(node.name, expression, node);
      if (ts.isArrayBindingPattern(node.name) && ts.isCallExpression(expression) &&
          expression.expression.getText(source) === "Promise.all" && expression.arguments[0] &&
          ts.isArrayLiteralExpression(expression.arguments[0])) {
        const queries = expression.arguments[0].elements;
        node.name.elements.forEach((binding, index) => {
          const query = queries[index];
          if (ts.isBindingElement(binding) && query) check(binding.name, query, node);
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

/**
 * The same question asked of `supabase.auth.*` instead of a table.
 *
 * US-3260: `uncheckedReads` above deliberately skips `supabase.auth` and
 * `supabase.storage`, which is right for a guard about DATABASE reads and is
 * not the same as those calls being safe. A discarded `mfa.listFactors` error
 * put an admin who already had an authenticator on the enrol screen.
 *
 * It was nearly left uncovered on the reasoning that scanning auth reads would
 * flag every optional Authorization-header read in the app. MEASURED 2026-09-18:
 * SIXTEEN in src/, and fifteen of those are exactly that read. So the caution
 * was right about the shape and the story's first count of five was wrong -- a
 * hand-rolled regex wanting `{ data }` or `{ data: x }` and nothing else missed
 * every `{ data, session }`. The AST is what got the real number. How the test
 * handles the split is in src/test/unchecked-read-contract.test.ts; this
 * function stays complete and reports all sixteen, because a scanner that
 * decides policy is a scanner nobody can re-aim.
 */
export function uncheckedAuthReads(text: string, file = "source.tsx") {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: Array<{ line: number; call: string; binding: string }> = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isAwaitExpression(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const query = node.initializer.expression.getText(source);
      // `supabase.auth.getSession()`, `supabase.auth.mfa.listFactors()`, and so
      // on. The captured group is what the entry is keyed on, so a file with two
      // different auth reads stays two entries.
      const call = query.match(/\bsupabase\.auth\.([A-Za-z.]*[A-Za-z])\s*\(/)?.[1];
      const names = node.name.elements.map((e) =>
        (e.propertyName ?? e.name).getText(source),
      );
      if (
        call &&
        !/\.throwOnError\(/.test(query) &&
        !names.includes("error") &&
        names.includes("data")
      ) {
        findings.push({
          line: source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1,
          call,
          binding: node.name.getText(source),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}
