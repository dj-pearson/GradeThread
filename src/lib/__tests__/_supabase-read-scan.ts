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
