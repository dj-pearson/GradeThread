// US-1555: PreToolUse write-guard — prose rules become hard stops.
//
// Blocks Edit/Write/NotebookEdit against:
//   • src/components/ui/**  — shadcn-generated components ("DO NOT hand-edit";
//     re-generate via `npx shadcn@latest add <component>` instead), and
//   • prd.archive.json      — the completed-story archive is append-via-script
//     only (the Ralph archive step); a full rewrite by an agent has destroyed
//     it before.
//
// Reads the hook JSON from stdin; exit 2 blocks the call and surfaces stderr
// to the agent. Reads are unaffected (matcher covers write tools only), and
// unmatched paths exit 0 immediately.
import { readFileSync } from "node:fs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // never break tooling on malformed hook input
}

const toolInput = input.tool_input ?? {};
const raw = toolInput.file_path ?? toolInput.notebook_path ?? "";
if (typeof raw !== "string" || raw === "") process.exit(0);

const path = raw.replaceAll("\\", "/");

if (/\/src\/components\/ui\//.test(path) || /^src\/components\/ui\//.test(path)) {
  console.error(
    "BLOCKED: src/components/ui/** is shadcn-generated — do not hand-edit. " +
      "Re-generate with `npx shadcn@latest add <component> -y`, or wrap the " +
      "component in your own file instead.",
  );
  process.exit(2);
}

if (path.endsWith("/prd.archive.json") || path === "prd.archive.json") {
  console.error(
    "BLOCKED: prd.archive.json is append-only via the archive script (stop " +
      "the Ralph loop first, then move passes:true stories with a script). " +
      "Never rewrite it with Write/Edit.",
  );
  process.exit(2);
}

process.exit(0);
