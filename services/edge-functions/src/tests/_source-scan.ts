// The primitives every structural guard in this repo needs, in one place.
//
// This repo guards Stripe-heavy and template-heavy code by READING SOURCE,
// because those paths mix service-role writes and third-party SDK calls and
// cannot be invoked in isolation. The idiom is sound. The primitives were the
// problem: four files had hand-rolled copies of the same three helpers, written
// independently, each subtly different, and three of them wrong in ways that
// made a guard pass over the exact defect it existed to catch.
//
// A structural guard that is too loose does not merely fail to help. Its
// greenness is what stops anyone looking — which is why every one of the seven
// failures behind US-2454 was found by sabotage and none by review.
//
// ⚠ These are lexical, not a parser. They are good enough for "is the gate
// before the mutation" and wrong for anything needing real scope analysis. If a
// guard needs more than this, it probably wants a unit test on an extracted
// pure function instead.

/**
 * Source with WHOLE-LINE comments removed.
 *
 * The trap: a header explaining a rule contains every identifier the rule is
 * about, so a scan of raw source lets PROSE satisfy an assertion about CODE.
 * That happened six times on 2026-08-10, most sharply where a comment reading
 * "there is no buyer_pause_until" satisfied a check for a buyer pause column.
 *
 * Only whole lines are stripped, deliberately. A trailing `// …` could be
 * removed too, but `https://` inside a template string would go with it, and
 * these guards assert on URLs.
 */
export function code(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");
}

/**
 * The BODY of a function, brace-matched, excluding its signature.
 *
 * `declaration` is matched literally — e.g. "async function handleX" or
 * "export async function sendY".
 *
 * The trap: taking the first `{` after the name. For a function whose parameter
 * is an inline object TYPE — `user: { id: string; … }` — that brace opens the
 * annotation, and the match closes at the end of it. The returned "body" is
 * then the parameter list, and every assertion about the function fails as
 * though the code were missing. This walks the parameter parens first.
 */
export function fnBody(src: string, declaration: string): string {
  const at = src.indexOf(declaration);
  if (at === -1) throw new Error(`fnBody: ${declaration} not found — renamed?`);
  let parens = 0;
  let i = src.indexOf("(", at);
  if (i === -1) throw new Error(`fnBody: ${declaration} has no parameter list`);
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }
  const open = src.indexOf("{", i);
  if (open === -1) throw new Error(`fnBody: ${declaration} has no body`);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(open, j);
  }
  throw new Error(`fnBody: unbalanced braces in ${declaration}`);
}

/**
 * The ARGUMENTS of a named call, paren-matched.
 *
 * The trap this exists for: asserting a value inside a call by searching the
 * whole enclosing function. The same expression usually appears nearby — in a
 * response payload, in an audit row, in a sibling call — so the assertion holds
 * while the call itself is wrong. Twice on 2026-08-10 that let a buyer-facing
 * record be switched to the seller's plan with every test green.
 *
 * `from` scopes the search, so a file with several call sites can be checked
 * one branch at a time.
 */
export function callArgs(src: string, callee: string, from = 0): string {
  const at = src.indexOf(`${callee}(`, from);
  if (at === -1) throw new Error(`callArgs: no call to ${callee}`);
  const open = at + callee.length;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`callArgs: unbalanced parens in ${callee}(`);
}

/**
 * Every call to `callee` in `src`, as argument strings.
 *
 * For the common "one caller per product, each naming its own" assertion — the
 * shape that catches a buyer path passing the seller's value, which type
 * checking cannot see because both are the same type.
 */
export function allCallArgs(src: string, callee: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(`${callee}(`, from);
    if (at === -1) return out;
    const args = callArgs(src, callee, at);
    out.push(args);
    from = at + callee.length + args.length;
  }
}
