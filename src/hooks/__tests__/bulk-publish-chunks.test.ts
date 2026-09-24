// AL-06: Publish ready used to send up to 500 drafts in one batch; the edge
// refuses over 300, and the page then toasted success anyway.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { chunkItems, MAX_PUBLISH_BATCH_ITEMS } from "../use-autolister";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("bulk publish chunking (AL-06)", () => {
  it("350 ready drafts go out as 300 then 50", () => {
    const items = Array.from({ length: 350 }, (_, i) => i);
    const chunks = chunkItems(items, MAX_PUBLISH_BATCH_ITEMS);
    expect(chunks.map((c) => c.length)).toEqual([300, 50]);
    expect(chunks.flat()).toEqual(items);
  });

  it("the client cap matches the edge route's cap", () => {
    const edge = read("services/edge-functions/src/routes/flipdesk-autolister.ts");
    const m = edge.match(/export const MAX_PUBLISH_BATCH_ITEMS = (\d+);/);
    expect(Number(m?.[1])).toBe(MAX_PUBLISH_BATCH_ITEMS);
  });

  it("the Drafts page no longer toasts success on top of the hook", () => {
    const page = read("src/pages/flipdesk/autolister-drafts.tsx");
    expect(page).not.toContain("Publish finished — see per-row status.");
  });

  it("Generate failures toast once: the start-batch hook has no onError", () => {
    const hook = read("src/hooks/use-autolister.ts");
    const start = hook.indexOf("export function useStartAutolisterBatch");
    const body = hook.slice(start, hook.indexOf("\n}\n", start));
    expect(body).not.toMatch(/onError:/);
  });
});
