// US-1561: print the canonical cron table (paste between the
// cron-registry markers in COOLIFY.md + LAUNCH_CHECKLIST.md).
//   deno run --allow-env --allow-net --allow-read scripts/render-cron-docs.ts
import { renderCronDocs } from "../src/lib/cron-runs.ts";
console.log(renderCronDocs());
