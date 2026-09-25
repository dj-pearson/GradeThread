import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/image-utils", () => ({
  compressImage: vi.fn(async (file: File, opts: unknown) => {
    if (file.name === "broken.jpg") throw new Error("decode failed");
    expect(opts).toEqual({ maxEdge: 1024, quality: 0.8, outputType: "image/jpeg" });
    return { blob: new Blob(["abc"], { type: "image/jpeg" }), width: 1, height: 1 };
  }),
}));

const { orderForAi, stagedPhotosForAi } = await import("@/lib/ai-photo-payload");

const f = (name: string) => new File(["x"], name, { type: "image/jpeg" });

describe("stagedPhotosForAi", () => {
  it("puts the tag first", () => {
    expect(
      orderForAi([{ photoType: "front" as const }, { photoType: "tag" as const }]).map((p) => p.photoType),
    ).toEqual(["tag", "front"]);
  });

  it("downscales to 1024px JPEG, base64 without the data: prefix, and skips a photo it cannot read", async () => {
    const out = await stagedPhotosForAi([
      { file: f("front.jpg"), photoType: "front" },
      { file: f("broken.jpg"), photoType: "back" },
      { file: f("tag.jpg"), photoType: "tag", photoRole: "brand" },
    ]);
    expect(out.map((p) => p.type)).toEqual(["tag", "front"]);
    expect(out[0]).toMatchObject({ data: btoa("abc"), media_type: "image/jpeg", role: "brand" });
  });
});
