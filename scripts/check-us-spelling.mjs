#!/usr/bin/env node
// US-3233 AC2/AC3. Stops NEW British spellings entering copy a user reads.
//
//   node scripts/check-us-spelling.mjs              # report + exit 1 on a hit
//   node scripts/check-us-spelling.mjs --json
//   node scripts/check-us-spelling.mjs --self-check # prove the rule still fires
//
// WHY THIS SCANS COPY POSITIONS AND NOT STRING LITERALS.
//
// A survey of the whole repo on 2026-09-10 found 809 British spellings inside
// string literals. Almost none of them are copy. They are:
//
//   - status VALUES ("cancelled" is a DB enum value, an eBay/Etsy/Depop/Shopify
//     order state, and the `checkout=cancelled` query param Stripe redirects to)
//   - eBay's own aspect names and allowed values ("Colour", "Multi-Colour",
//     "Grey") — rewriting one stops it matching and the listing fails
//   - input vocabularies that deliberately hold BOTH spellings so a seller's or
//     a model's British word still matches (title-tokens.ts, demand-terms.ts,
//     claim-accuracy.ts, complaint-match.ts, ebay-catalog-merge.ts,
//     identification-verify.ts, visual-style-names.ts, ImportField.swift)
//   - brand names. Under Armour is not a misspelling of anything
//   - prompt text sent to a model, which no user reads
//   - developer prose that happens to live in a string rather than a comment:
//     admin-scope-map.ts's `rationale`, the route-exemption notes in
//     ebay-auth.ts, an `EBAY_FEE_SOURCE.sourceNote`
//   - CSS, GLSL and third-party DOM selectors (`button.share-grey`)
//
// A guard over every string literal therefore needs an allowlist of about 150
// files, which is a longer document than the rule and teaches everyone that the
// fix for a red build is another allowlist line. So it scans four positions,
// each one somewhere a person reads the words:
//
//   1. the copy positions check-copy-reading-level.mjs already defines — JSX
//      text, copy-bearing props and keys, toast arguments, SwiftUI Text
//   2. every literal of eight words or more under src/lib/seo/,
//      src/pages/legal/ and src/pages/marketing/, which are published content
//      and nothing else
//   3. the edge's error bodies: `error:`/`description:`/`message:` and the
//      third argument of failSafe/jsonError
//   4. `String(localized:)` on iOS
//
// Positions 2, 3 and 4 were all added after a SABOTAGE run: the first cut caught
// only position 1 and stayed silent when three strings this very story had just
// fixed were changed back. A guard is not written until it has been sabotaged.
//
// That is narrower than "every British spelling in the repo" and it is
// deliberately narrower. It is also immune to the failure that matters most
// here: a comment is not a literal node, so the AST never hands one to this
// scanner and no explanatory paragraph anyone writes can turn the build red.
//
// WHAT IT DOES NOT SEE, stated so nobody mistakes green for complete: Android
// strings, `.html` files in extension-unified/, in-product prose that is not in
// a copy position or a content directory, and copy assembled from variables.
// Those were worked through by hand in US-3233 and have no scanner.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { collect, extractFromTs } from "./check-copy-reading-level.mjs";

const ROOT = process.cwd();
const ARGS = new Set(process.argv.slice(2));
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, "/");

/**
 * British -> US, for words that actually turn up in apparel-reseller copy.
 *
 * NOT here, on purpose: "cancellation" (US English spells it with two Ls too,
 * and an earlier draft of this list reported 86 correct strings), "dialogue",
 * "practice" as a noun, "analysis", "burnt" as an adjective, and "disc".
 */
export const BRITISH = {
  colour: "color", colours: "colors", coloured: "colored", colouring: "coloring",
  colourway: "colorway", colourways: "colorways",
  grey: "gray", greys: "grays", greyed: "grayed",
  catalogue: "catalog", catalogues: "catalogs", catalogued: "cataloged",
  fibre: "fiber", fibres: "fibers",
  odour: "odor", odours: "odors",
  mould: "mold", moulded: "molded", mouldy: "moldy",
  jewellery: "jewelry", aluminium: "aluminum", woollen: "woolen",
  centre: "center", centres: "centers", centred: "centered",
  metre: "meter", metres: "meters", litre: "liter", litres: "liters",
  cancelled: "canceled", cancelling: "canceling",
  labelled: "labeled", labelling: "labeling",
  modelled: "modeled", modelling: "modeling",
  travelled: "traveled", travelling: "traveling", traveller: "traveler",
  levelled: "leveled", fuelled: "fueled",
  enrolment: "enrollment", instalment: "installment", instalments: "installments",
  fulfil: "fulfill", fulfils: "fulfills", fulfilment: "fulfillment",
  skilful: "skillful", wilful: "willful",
  defence: "defense", offence: "offense", licence: "license", pretence: "pretense",
  programme: "program", programmes: "programs",
  honour: "honor", honours: "honors", honoured: "honored",
  favour: "favor", favours: "favors", favourite: "favorite", favourites: "favorites",
  behaviour: "behavior", behaviours: "behaviors", behavioural: "behavioral",
  labour: "labor", neighbour: "neighbor", neighbours: "neighbors",
  humour: "humor", rumour: "rumor", vapour: "vapor", armour: "armor",
  flavour: "flavor", flavours: "flavors", endeavour: "endeavor",
  savour: "savor", parlour: "parlor", splendour: "splendor",
  organise: "organize", organised: "organized", organising: "organizing",
  organisation: "organization", organisations: "organizations",
  normalise: "normalize", normalised: "normalized", normalisation: "normalization",
  realise: "realize", realised: "realized", realising: "realizing",
  recognise: "recognize", recognised: "recognized", recognising: "recognizing",
  customise: "customize", customised: "customized", customisation: "customization",
  personalise: "personalize", personalised: "personalized",
  optimise: "optimize", optimised: "optimized", optimisation: "optimization",
  prioritise: "prioritize", prioritised: "prioritized",
  summarise: "summarize", summarised: "summarized",
  apologise: "apologize", minimise: "minimize", maximise: "maximize",
  utilise: "utilize", authorise: "authorize", authorised: "authorized",
  authorisation: "authorization",
  analyse: "analyze", analysed: "analyzed", analysing: "analyzing",
  synchronise: "synchronize", synchronised: "synchronized",
  categorise: "categorize", categorised: "categorized",
  itemise: "itemize", itemised: "itemized",
  standardise: "standardize", standardised: "standardized",
  finalise: "finalize", finalised: "finalized",
  initialise: "initialize", initialised: "initialized",
  sanitise: "sanitize", sanitised: "sanitized",
  monetise: "monetize", monetised: "monetized",
  specialise: "specialize", specialised: "specialized",
  emphasise: "emphasize", emphasised: "emphasized",
  penalise: "penalize", penalised: "penalized",
  capitalise: "capitalize", capitalised: "capitalized",
  stabilise: "stabilize", stabilised: "stabilized",
  visualise: "visualize", centralise: "centralize",
  judgement: "judgment", acknowledgement: "acknowledgment",
  enquiry: "inquiry", enquiries: "inquiries", enquire: "inquire",
  speciality: "specialty", specialities: "specialties",
  ageing: "aging", sceptical: "skeptical", cosy: "cozy",
  manoeuvre: "maneuver", moustache: "mustache", pyjamas: "pajamas",
  whilst: "while", amongst: "among", orientated: "oriented",
  learnt: "learned", spelt: "spelled", storey: "story",
  tyre: "tire", tyres: "tires", kerb: "curb", cheque: "check",
};

const WORD_RE = new RegExp(`\\b(${Object.keys(BRITISH).join("|")})\\b`, "gi");

/**
 * Paths this rule never applies to, each with the reason it is load-bearing.
 *
 * MEASURED 2026-09-10: the copy-position extractor reaches NONE of these today.
 * eBay's value tables are object keys, `ebay-prefill.ts`'s British words are
 * map keys, and the five-place fibre string sits in a `hint`, which is not a
 * copy prop. So every entry here is a path-level declaration rather than a live
 * suppression, and that is the point: AC3 asks for these paths exempt BY PATH,
 * so that widening the extractor later cannot turn an eBay allowed value into a
 * build failure somebody fixes by "correcting" the spelling. Rewriting an eBay
 * allowed value is a listing failure, not a typo fix.
 *
 * SHRINK-ONLY, and checked against something real rather than against this
 * scanner's reach: `verifyAllow()` fails the run if a listed file has stopped
 * carrying the word it excuses, because then the reason is gone and so is the
 * entry. `src/lib/chart-of-accounts.ts` was in this list until that check was
 * written and came straight back out — the code there already says "Labor" and
 * only the seeded DB row is British, which is US-3256's problem, not a spelling
 * exemption.
 */
export const ALLOW = [
  {
    path: "src/lib/aspect-normalize.ts",
    words: ["colour", "grey"],
    why:
      "eBay's OWN allowed aspect values. 'Colour', 'Multi-Colour' and 'Grey' " +
      "are the strings eBay accepts on an offer; a value we spell differently " +
      "is rejected at publish. AC3 names this file by path for that reason.",
  },
  {
    path: "services/edge-functions/src/lib/aspect-normalize.ts",
    words: ["colour", "grey"],
    why: "The edge copy of the same eBay value table. Same reason, same risk.",
  },
  {
    path: "src/lib/ebay-prefill.ts",
    words: ["colour", "grey", "jewellery", "catalogue"],
    why:
      "This module IS the UK-to-US normalizer. Its left-hand sides are " +
      "British on purpose: rewriting them deletes the mapping that catches a " +
      "British input in the first place. AC3 names this file by path too.",
  },
  {
    path: "src/lib/photo-roles.ts",
    words: ["fibre"],
    why:
      "'The care label with the fibre content' is ONE string in five places " +
      "(web, the edge copy, PhotoProfile.swift, PhotoProfile.kt) and Android's " +
      "detekt baseline pins the exact line text. Changing it needs an iOS and " +
      "an Android build in the same commit, so it is not a spelling tidy. " +
      "Tracked separately.",
  },
  {
    path: "src/lib/photo-profiles.ts",
    words: ["fibre"],
    why: "The second web copy of that same five-place string.",
  },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", ".git"]);

function walk(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => p.endsWith(x)) && !/\.test\.[tj]sx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * A word the copy is QUOTING rather than using.
 *
 * API docs and MCP tool descriptions have to name `cancelled`, because that is
 * the status value the API accepts; a US spelling there would document a value
 * that does not exist. The fix is not an allowlist entry per file — it is to
 * make the copy say it is quoting, which reads better anyway. A word in
 * backticks, in nested quotes, or straight after `=` is a value citation.
 */
function isQuotedValue(text, index, word) {
  const before = text.slice(Math.max(0, index - 2), index);
  const after = text.slice(index + word.length, index + word.length + 1);
  if (/[=_]$/.test(before)) return true;
  if (/[`'"]$/.test(before) && /[`'"]/.test(after)) return true;
  return false;
}

/** Every British word in one string, as [found, shouldBe] pairs. */
export function britishWordsIn(text) {
  WORD_RE.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = WORD_RE.exec(text))) {
    const fix = BRITISH[m[0].toLowerCase()];
    if (!fix) continue;
    if (isQuotedValue(text, m.index, m[0])) continue;
    hits.push([m[0], fix]);
  }
  return hits;
}

/**
 * The edge's copy position.
 *
 * The edge has no JSX and no toast. What it does have is
 * `c.json({ error: "..." }, 400)` and the two helpers in http-errors.ts, which
 * are the sentence a user sees when something goes wrong. Only multi-word
 * values count: `error: "not_found"` is a code, not a sentence.
 *
 * `failSafe` was added after a sabotage run: the guard's first cut read only the
 * `error:` PROPERTY, and the flipdesk-logistics message fixed in this same story
 * is a positional argument, so the guard was silent on a string it had just been
 * used to correct. Both helpers put the user's sentence at argument index 2.
 */
const EDGE_ERROR_CALLS = new Set(["failSafe", "jsonError"]);

/**
 * `description` is here because the OAuth consent failure fixed in this story
 * puts its sentence there — `error:` next to it holds the OAuth error CODE
 * ("invalid_client"), which is why the three-word floor matters. It also picks
 * up openapi-spec.ts, whose descriptions are the public API docs.
 */
const EDGE_ERROR_PROPS = new Set(["error", "description", "message"]);

/**
 * A module that exports a prompt version is a module whose prose is the prompt.
 *
 * `description:` in ai-listing.ts is a field description inside the JSON schema
 * handed to the model, and ai-listing.ts exports LISTING_GEN_PROMPT_VERSION.
 * Editing prompt text under an unchanged version name silently redefines what
 * every eval attributed to that version measured, which is a prompt-lifecycle
 * change and not a copy fix. So this is structural rather than a file list:
 * anywhere a `*_PROMPT_VERSION` is declared, the `description`/`message` prose
 * belongs to the model. `error:` and the two http-errors helpers still count
 * there, because an error body is never prompt text.
 */
const VERSIONED_PROMPT = /\b[A-Z0-9_]*_PROMPT_VERSION\b/;

export function extractEdgeErrors(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const modelFacing = VERSIONED_PROMPT.test(source);
  const found = [];
  // A `+` chain of string literals is one sentence wrapped for line length, and
  // this repo wraps almost every long message that way. Reading only a bare
  // StringLiteral made the guard silent on openapi-spec.ts's "Honour
  // Retry-After.", found by sabotage.
  const literal = (n) => {
    if (!n) return null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      return { text: n.text };
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = literal(n.left);
      const r = literal(n.right);
      return l && r ? { text: l.text + r.text } : null;
    }
    return null;
  };
  const push = (node, text, kind) => {
    const t = text.trim();
    if (t.split(/\s+/).length < 3) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ text: t, line: line + 1, kind });
  };
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      EDGE_ERROR_PROPS.has(node.name.text) &&
      !(modelFacing && node.name.text !== "error")
    ) {
      const lit = literal(node.initializer);
      if (lit) push(node, lit.text, `edge:${node.name.text}`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        EDGE_ERROR_CALLS.has(node.expression.text)) {
      const lit = literal(node.arguments[2]);
      if (lit) push(node, lit.text, `edge:${node.expression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * iOS copy the shared Swift extractor misses.
 *
 * check-copy-reading-level.mjs matches `Text("…")`, and the localized form is
 * `Text(String(localized: "…"))`, which its pattern does not reach. Found the
 * same way as the failSafe gap: by sabotaging a string this story had fixed and
 * watching the guard stay quiet.
 */
const SWIFT_LOCALIZED = /String\(\s*localized:\s*"([^"\\]{2,})"/g;

export function extractSwiftLocalized(source) {
  const found = [];
  source.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    SWIFT_LOCALIZED.lastIndex = 0;
    let m;
    while ((m = SWIFT_LOCALIZED.exec(line))) {
      found.push({ text: m[1].trim(), line: i + 1, kind: "ios:localized" });
    }
  });
  return found;
}

/**
 * Directories that are nothing but published prose.
 *
 * FOUND BY SABOTAGE, not by review. The first cut of this guard scanned only
 * check-copy-reading-level.mjs's copy positions, and changing
 * `cardBlurb: "Every eBay fee on one sale, itemized"` back to "itemised" left it
 * silent — `cardBlurb` is not one of that script's COPY_PROPS, and neither are
 * the `q`/`a`/`definition`/`body` keys the SEO content modules are built from.
 * 140 of US-3233's 187 fixes were in those files, so the guard was blind to
 * exactly the corpus it was written for.
 *
 * A longer key list would go stale the first time somebody invents a key, so
 * the rule is positional instead: everything under these directories is
 * published content, so any literal of eight or more words in one is prose. An
 * eBay aspect value, a status and a class name are never eight-word sentences.
 */
const PROSE_DIRS = ["src/lib/seo/", "src/pages/legal/", "src/pages/marketing/"];
const PROSE_MIN_WORDS = 8;

/** Every prose literal in a content-only module, with its line. */
export function extractProse(file, source) {
  const isTsx = /\.tsx$/.test(file);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    isTsx ? ts.ScriptKind.TSX : undefined);
  const found = [];
  const push = (raw, node) => {
    const text = String(raw).replace(/\s+/g, " ").trim();
    if (text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length < PROSE_MIN_WORDS) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ text, line: line + 1, kind: "prose" });
  };
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ||
        ts.isJsxText(n)) {
      push(n.text, n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Every copy string this guard can see, across web, iOS and the edge. */
export function collectCopy() {
  const rows = collect().map((r) => ({
    file: r.file, line: r.line, text: r.text, kind: r.kind,
  }));
  for (const dir of PROSE_DIRS) {
    for (const abs of walk(resolve(ROOT, dir), [".ts", ".tsx"])) {
      const rel = relative(ROOT, abs).replace(/\\/g, "/");
      for (const s of extractProse(abs, readFileSync(abs, "utf8"))) {
        rows.push({ ...s, file: rel });
      }
    }
  }

  const edgeDir = resolve(ROOT, "services/edge-functions/src");
  for (const abs of walk(edgeDir, [".ts"])) {
    const rel = relative(ROOT, abs).replace(/\\/g, "/");
    if (rel.includes("/tests/")) continue;
    for (const s of extractEdgeErrors(abs, readFileSync(abs, "utf8"))) {
      rows.push({ ...s, file: rel });
    }
  }
  for (const abs of walk(resolve(ROOT, "ios/GradeThread"), [".swift"])) {
    const rel = relative(ROOT, abs).replace(/\\/g, "/");
    for (const s of extractSwiftLocalized(readFileSync(abs, "utf8"))) {
      rows.push({ ...s, file: rel });
    }
  }

  return rows.filter((r) => r.file !== SELF);
}

/**
 * Is every allow entry still excusing something?
 *
 * Deliberately NOT "did the scanner suppress a finding there" — the scanner
 * reaches none of them, so that test would report all six as stale and the fix
 * would be to delete the exemptions AC3 asks for. The checkable claim is the
 * one the entry actually makes: this file still contains this British word for
 * this reason. When it stops, the entry is dead and has to go.
 */
export function verifyAllow() {
  const problems = [];
  for (const a of ALLOW) {
    let src;
    try {
      src = readFileSync(resolve(ROOT, a.path), "utf8");
    } catch {
      problems.push(`${a.path} no longer exists — delete its allow entry.`);
      continue;
    }
    const present = a.words.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(src));
    if (!present.length) {
      problems.push(
        `${a.path} no longer contains any of [${a.words.join(", ")}] — the ` +
          `reason for its allow entry is gone, so delete the entry.`,
      );
    }
  }
  return problems;
}

export function run() {
  const rows = collectCopy();
  const findings = [];

  for (const r of rows) {
    const hits = britishWordsIn(r.text);
    if (!hits.length) continue;
    const rule = ALLOW.find(
      (a) => a.path === r.file && hits.some(([w]) => a.words.includes(w.toLowerCase())),
    );
    if (rule) continue;
    findings.push({ ...r, hits });
  }

  return { scanned: rows.length, findings, stale: verifyAllow() };
}

// ---------------------------------------------------------------------------
// Self-check. A spelling rule that stops firing reads exactly like clean copy,
// which is the whole failure mode this repo keeps hitting, so the rule is run
// against code that must trip it before a quiet result is believed.
// ---------------------------------------------------------------------------

const FIXTURE_TSX = `
// A comment about a colour. This MUST NOT fire: nobody reads a comment.
/* And a block comment about the grey fibre content. Also must not fire. */
export function Example() {
  const catalogue = 1; // an identifier, not copy
  return (
    <div className="border-grey-500">
      <Card title="Colour and fibre" />
      <p>Your item was cancelled.</p>
      <SEO title="colour guide" />
    </div>
  );
}
`;

export function selfCheckProblems() {
  const rows = extractFromTs("fixture.tsx", FIXTURE_TSX);
  const hit = (kind) =>
    rows.filter((r) => r.kind.startsWith(kind) && britishWordsIn(r.text).length);
  const problems = [];

  if (!hit("prop:title").length) problems.push("a copy prop stopped firing");
  if (!hit("jsx").length) problems.push("JSX text stopped firing");

  const all = rows.flatMap((r) => britishWordsIn(r.text).map(([w]) => w.toLowerCase()));
  // Comments and identifiers must contribute nothing. The fixture's comments
  // carry "colour", "grey" and "fibre"; its identifier carries "catalogue";
  // its className carries "grey". None may reach the scanner.
  if (all.includes("catalogue")) problems.push("an identifier reached the scanner");
  const greyRows = rows.filter((r) => /grey/i.test(r.text));
  if (greyRows.length) {
    problems.push(`a className or comment reached the scanner: ${greyRows[0].file ?? ""} ${greyRows[0].text}`);
  }
  if (britishWordsIn("cancellation").length) {
    problems.push("'cancellation' is being reported; it is correct US English");
  }
  if (!britishWordsIn("a cancelled order").length) {
    problems.push("'cancelled' stopped being reported");
  }
  return problems;
}

function main() {
  if (ARGS.has("--self-check")) {
    const problems = selfCheckProblems();
    for (const p of problems) console.error(`[us-spelling] SELF-CHECK: ${p}`);
    console.log(
      problems.length
        ? `[us-spelling] self-check FAILED (${problems.length})`
        : "[us-spelling] self-check ok",
    );
    process.exit(problems.length ? 1 : 0);
  }

  const { scanned, findings, stale } = run();
  if (ARGS.has("--json")) {
    console.log(JSON.stringify({ scanned, findings, stale }, null, 2));
    process.exit(findings.length || stale.length ? 1 : 0);
  }

  console.log(`[us-spelling] ${scanned} copy strings scanned (web copy positions, published prose, iOS, edge error bodies).`);
  for (const f of findings) {
    const pairs = f.hits.map(([w, fix]) => `${w} -> ${fix}`).join(", ");
    console.log(`  ${f.file}:${f.line} [${f.kind}] ${pairs}`);
    console.log(`      ${JSON.stringify(f.text).slice(0, 160)}`);
  }
  for (const p of stale) console.log(`  STALE ALLOW ENTRY: ${p}`);
  console.log(
    findings.length || stale.length
      ? `[us-spelling] ${findings.length} British spelling(s) in user-facing copy, ${stale.length} stale allow entr(ies).`
      : `[us-spelling] clean. ${ALLOW.length} allow entries, all still load-bearing.`,
  );
  process.exit(findings.length || stale.length ? 1 : 0);
}

// fileURLToPath, not string surgery on import.meta.url: `file://${argv[1]}` is
// one slash short on Windows, so the comparison is always false and the script
// exits 0 having run nothing. check-copy-reading-level.mjs still has that bug.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
