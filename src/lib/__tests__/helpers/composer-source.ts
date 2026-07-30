// US-2263: the composer is a DIRECTORY now, not a file.
//
// Several composer guards assert against source text, because what they protect
// is wiring that fails silently: a deep-link anchor whose element moved, a lock
// applied to an input but not to the buttons that write the same field, an order
// invariant nothing else enforces. Mounting the real page to check those would
// need Supabase, eBay taxonomy, seven hooks and a query client — so the repo's
// convention (see photo-manager-seams.test.ts) is to read the source.
//
// The split moved most markup out of the page and into section components. These
// helpers name WHICH source a given assertion is about, so the split repoints
// them instead of weakening them:
//
//   composerPage  — the orchestrator. Card ORDER lives here (the call sites are
//                   ordered in its JSX), as do the save paths and the state.
//   composerAll   — page + every section component. Use for "does the composer
//                   render/lock/label X", which no longer cares which file X
//                   ended up in — and stays correct when a section moves again.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PAGE = "src/pages/flipdesk/composer.tsx";
const SECTIONS = "src/components/flipdesk/composer";

/** The composer page alone — layout, order, state and the save paths. */
export const composerPage = readFileSync(join(process.cwd(), PAGE), "utf8");

/** Every section component, keyed by filename. */
export const composerSections: Record<string, string> = Object.fromEntries(
  readdirSync(join(process.cwd(), SECTIONS))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => [f, readFileSync(join(process.cwd(), SECTIONS, f), "utf8")]),
);

/**
 * The page plus every section, concatenated. File boundaries are marked so a
 * failure message still says where to look.
 */
export const composerAll = [
  `/* ${PAGE} */\n${composerPage}`,
  ...Object.entries(composerSections).map(
    ([f, src]) => `/* ${SECTIONS}/${f} */\n${src}`,
  ),
].join("\n\n");
