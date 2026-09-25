// ACC-4 / ACC-5: the avatars bucket is public, so the uploaded object must be
// the canvas re-encoded blob (no EXIF/GPS), never the picked File; a failed
// re-encode must block the upload; and a swap must delete the previous photo
// from the user's own folder only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, buttonByText, flush, type Mounted } from "./profile-settings-harness";
import { ownAvatarPath } from "@/lib/avatar-path";

const USER = { id: "user-1", email: "me@example.com" };
const BASE = "https://api.example.test/storage/v1/object/public/avatars/";
let profile: Record<string, unknown> | null = null;
const refreshProfile = vi.fn(async () => {});
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: USER, profile, refreshProfile }),
}));

const upload = vi.fn<(...a: unknown[]) => Promise<{ error: null }>>(async () => ({ error: null }));
const remove = vi.fn<(...a: unknown[]) => Promise<{ error: null }>>(async () => ({ error: null }));
const updateEq = vi.fn<(...a: unknown[]) => Promise<{ error: null }>>(async () => ({ error: null }));
const update = vi.fn<(...a: unknown[]) => { eq: typeof updateEq }>(() => ({ eq: updateEq }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: (...a: unknown[]) => upload(...a),
        remove: (...a: unknown[]) => remove(...a),
        getPublicUrl: (path: string) => ({ data: { publicUrl: BASE + path } }),
      }),
    },
    from: () => ({ update: (...a: unknown[]) => update(...a) }),
  },
}));
vi.mock("@/lib/shipping-profile", () => ({
  SHIPPING_PROFILE_QUERY_KEY: ["account", "shipping-profile"],
  fetchShippingProfile: vi.fn(async () => ({
    business_name: null,
    business_phone: null,
    ship_from_address: null,
  })),
  saveShippingProfile: vi.fn(),
}));
const encoded = new Blob(["re-encoded"], { type: "image/webp" });
const compressImage = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  blob: encoded,
  width: 512,
  height: 512,
  phash: "",
}));
vi.mock("@/lib/image-utils", () => ({
  compressImage: (...a: unknown[]) => compressImage(...a),
}));
vi.mock("@/lib/media-intake", () => ({
  isHeicFile: (f: File) => f.type === "image/heic",
  normalizeToImageFile: async (f: File) => f,
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));

import { ProfileSettingsTab } from "@/components/settings/profile-settings-tab";

let m: Mounted | null = null;

beforeEach(() => {
  profile = {
    id: USER.id,
    full_name: "Pat",
    avatar_url: `${BASE}${USER.id}/avatar_1.webp`,
    updated_at: "2026-09-01T00:00:00Z",
    created_at: "2025-01-01T00:00:00Z",
  };
  vi.clearAllMocks();
});
afterEach(() => {
  m?.unmount();
  m = null;
});

async function pick(file: File) {
  const input = m!.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  return input;
}

describe("avatar upload", () => {
  it("uploads the re-encoded blob with its own content type, never the original File", async () => {
    m = mount(<ProfileSettingsTab />);
    const original = new File(["raw-with-gps"], "selfie.PNG", { type: "image/jpeg" });
    const input = await pick(original);

    expect(compressImage).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    const [path, body, opts] = upload.mock.calls[0] as [string, Blob, { contentType: string }];
    expect(body).toBe(encoded);
    expect(body).not.toBe(original);
    expect(opts.contentType).toBe("image/webp");
    expect(path).toMatch(/^user-1\/avatar_\d+\.webp$/);
    // The input is reset so the same file can be picked again.
    expect(input.value).toBe("");
    // The previous photo in the user's folder is removed after the swap.
    expect(remove).toHaveBeenCalledWith(["user-1/avatar_1.webp"]);
  });

  it("does not upload when re-encoding fails", async () => {
    compressImage.mockRejectedValueOnce(new Error("decode failed"));
    m = mount(<ProfileSettingsTab />);
    await pick(new File(["x"], "a.jpg", { type: "image/jpeg" }));
    expect(upload).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/couldn't process/i));
  });

  it("rejects an SVG before doing anything", async () => {
    m = mount(<ProfileSettingsTab />);
    await pick(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }));
    expect(compressImage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("never removes an old avatar outside the user's folder", async () => {
    profile = { ...profile!, avatar_url: `${BASE}someone-else/avatar_1.webp` };
    m = mount(<ProfileSettingsTab />);
    await pick(new File(["x"], "a.jpg", { type: "image/jpeg" }));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("Remove photo clears avatar_url and deletes the object", async () => {
    m = mount(<ProfileSettingsTab />);
    await act(async () => {
      buttonByText(m!.container, /remove photo/i).click();
    });
    await flush();
    expect(update).toHaveBeenCalledWith({ avatar_url: null });
    expect(remove).toHaveBeenCalledWith(["user-1/avatar_1.webp"]);
  });
});

describe("ownAvatarPath", () => {
  it("accepts only a file directly in the user's folder", () => {
    expect(ownAvatarPath(`${BASE}user-1/avatar_2.jpg?v=1`, "user-1")).toBe(
      "user-1/avatar_2.jpg",
    );
    expect(ownAvatarPath(`${BASE}user-2/avatar_2.jpg`, "user-1")).toBeNull();
    expect(ownAvatarPath(`${BASE}user-1/../user-2/a.jpg`, "user-1")).toBeNull();
    expect(ownAvatarPath(`${BASE}user-1%2F..%2Fuser-2%2Fa.jpg`, "user-1")).toBeNull();
    expect(ownAvatarPath("https://gravatar.example/x.png", "user-1")).toBeNull();
    expect(ownAvatarPath(null, "user-1")).toBeNull();
  });
});
