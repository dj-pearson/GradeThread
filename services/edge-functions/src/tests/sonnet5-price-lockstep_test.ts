// US-3527: the edge's cost_usd price for Sonnet 5 and the latest migration that
// seeds system_settings.ai_model_prices for it must agree, or AI Spend and the
// budget job disagree with the ledger.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { MODEL_PRICES } from "../lib/ai-usage.ts";
import { MODEL_IDS } from "../lib/ai-model-registry.ts";

Deno.test("US-3527: the newest ai_model_prices seed for claude-sonnet-5 matches MODEL_PRICES", async () => {
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.name.endsWith(".sql")) files.push(e.name);
  }
  files.sort();
  let latest: { file: string; input: number; output: number } | null = null;
  for (const f of files) {
    const sql = await Deno.readTextFile(new URL(f, dir));
    if (!sql.includes("ai_model_prices")) continue;
    const m = sql.match(
      /'claude-sonnet-5',\s*jsonb_build_object\('input',\s*([\d.]+),\s*'output',\s*([\d.]+)/,
    );
    if (m) latest = { file: f, input: Number(m[1]), output: Number(m[2]) };
  }
  assert(latest, "no migration seeds claude-sonnet-5");
  const p = MODEL_PRICES[MODEL_IDS.sonnet5]!;
  assertEquals(
    [latest.input, latest.output],
    [p.inputPerMTok, p.outputPerMTok],
    latest.file,
  );
});
