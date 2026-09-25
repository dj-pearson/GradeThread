import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: (...a: unknown[]) => edgeFetch(...a) }));

import {
  TemplateApiError,
  createTemplate,
  saveErrorNextStep,
} from "@/lib/flipdesk-templates";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("a failed save carries the edge's code", () => {
  beforeEach(() => edgeFetch.mockReset());

  it("a name clash says to rename", async () => {
    edgeFetch.mockResolvedValueOnce(
      reply(409, { error: "A template with that name already exists", code: "template_name_taken" }),
    );
    const err = await createTemplate({ name: "Denim" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateApiError);
    expect((err as TemplateApiError).code).toBe("template_name_taken");
    expect(saveErrorNextStep(err)).toMatch(/different one/);
  });

  it("a default clash says to reload, not to rename", async () => {
    edgeFetch.mockResolvedValueOnce(
      reply(409, {
        error: "Another template just became your default. Reload and try again.",
        code: "template_default_conflict",
      }),
    );
    const err = await createTemplate({ name: "Denim" }).catch((e: unknown) => e);
    expect((err as TemplateApiError).code).toBe("template_default_conflict");
    expect(saveErrorNextStep(err)).toMatch(/Reload/);
    expect(saveErrorNextStep(err)).not.toMatch(/name/i);
  });

  it("a plain 500 gets no name advice", async () => {
    edgeFetch.mockResolvedValueOnce(reply(500, { error: "Could not create template" }));
    const err = await createTemplate({ name: "Denim" }).catch((e: unknown) => e);
    expect((err as TemplateApiError).status).toBe(500);
    expect((err as TemplateApiError).code).toBeNull();
    expect(saveErrorNextStep(err)).toBeUndefined();
  });
});
