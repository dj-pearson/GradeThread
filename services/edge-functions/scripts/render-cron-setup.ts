// Print the copy-paste Coolify setup blocks (paste between the cron-setup markers
// in CRON_SETUP.md). Single source of truth = CRON_REGISTRY.
//   deno run --allow-env --allow-net --allow-read scripts/render-cron-setup.ts
import { renderCronSetupGuide } from "../src/lib/cron-runs.ts";
console.log(renderCronSetupGuide());
