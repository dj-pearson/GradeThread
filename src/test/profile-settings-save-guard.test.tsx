// ACC-6: Profile and Business saves must never write blank or loading state
// over stored data, and a refetch must not wipe typing in progress.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, typeInto, buttonByText, flush, type Mounted } from "./profile-settings-harness";

const USER = { id: "user-1", email: "me@example.com" };
let profile: Record<string, unknown> | null = null;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: USER, profile, refreshProfile: async () => {} }),
}));
const update = vi.fn<(...a: unknown[]) => unknown>(() => ({ eq: async () => ({ error: null }) }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => ({ update: (...a: unknown[]) => update(...a) }), storage: { from: () => ({}) } },
}));

type Resolver = (v: unknown) => void;
let pending: { resolve: Resolver; reject: (e: unknown) => void } | null = null;
const fetchShippingProfile = vi.fn(
  () =>
    new Promise((resolve, reject) => {
      pending = { resolve, reject };
    }),
);
const saveShippingProfile = vi.fn(async (body: unknown) => body);
vi.mock("@/lib/shipping-profile", () => ({
  SHIPPING_PROFILE_QUERY_KEY: ["account", "shipping-profile"],
  fetchShippingProfile: () => fetchShippingProfile(),
  saveShippingProfile: (b: unknown) => saveShippingProfile(b),
}));
vi.mock("@/lib/image-utils", () => ({ compressImage: vi.fn() }));
vi.mock("@/lib/media-intake", () => ({ isHeicFile: () => false, normalizeToImageFile: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProfileSettingsTab } from "@/components/settings/profile-settings-tab";

const STORED = {
  business_name: "Thrift Co",
  business_phone: "555",
  ship_from_address: { line1: "1 Main", line2: null, city: "Town", state: "CA", postal_code: "90210", country: "US" },
};

let m: Mounted | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  pending = null;
  profile = {
    id: USER.id,
    full_name: "Pat",
    avatar_url: null,
    updated_at: "2026-09-01T00:00:00Z",
    created_at: "2025-01-01T00:00:00Z",
  };
});
afterEach(() => {
  m?.unmount();
  m = null;
});

const q = (id: string) => m!.container.querySelector<HTMLInputElement>(`#${id}`);

describe("Profile save guard", () => {
  it("with profile null, Save is disabled and a retry notice shows", () => {
    vi.useFakeTimers();
    try {
      profile = null;
      m = mount(<ProfileSettingsTab />);
      // Loading first: right after sign-in a null profile is still loading,
      // and a red "Couldn't load" there was a false alarm.
      expect(m.container.textContent).toContain("Loading your profile");
      expect(m.container.textContent).not.toContain("Couldn't load your profile");
      expect(buttonByText(m.container, /save profile/i).disabled).toBe(true);
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(m.container.textContent).toContain("Couldn't load your profile");
      expect(buttonByText(m.container, /save profile/i).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds the name when the profile arrives late, and only sends full_name", async () => {
    const late = profile;
    profile = null;
    m = mount(<ProfileSettingsTab />);
    profile = late;
    m.rerender(<ProfileSettingsTab />);
    expect(q("fullName")!.value).toBe("Pat");
    const save = buttonByText(m.container, /save profile/i);
    expect(save.disabled).toBe(true); // clean form
    typeInto(q("fullName")!, "Pat Doe");
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
    });
    expect(update).toHaveBeenCalledWith({ full_name: "Pat Doe" });
  });
});

describe("Business save guard", () => {
  it("is disabled while the shipping read is pending and after it fails", async () => {
    m = mount(<ProfileSettingsTab />);
    expect(buttonByText(m.container, /save business details/i).disabled).toBe(true);
    expect(q("businessName")).toBeNull(); // skeletons, not blank boxes
    await act(async () => {
      pending!.reject(new Error("edge down"));
    });
    await flush();
    expect(m.container.textContent).toContain("Couldn't load your saved business details");
    expect(buttonByText(m.container, /save business details/i).disabled).toBe(true);
    expect(q("businessName")!.disabled).toBe(true);
    expect(saveShippingProfile).not.toHaveBeenCalled();
  });

  it("a refetch while the form is dirty keeps the typed values", async () => {
    m = mount(<ProfileSettingsTab />);
    await act(async () => {
      pending!.resolve(STORED);
    });
    await flush();
    expect(q("businessName")!.value).toBe("Thrift Co");
    typeInto(q("businessName")!, "Typed Name");
    await act(async () => {
      void m!.client.invalidateQueries();
    });
    await act(async () => {
      pending!.resolve({ ...STORED, business_name: "Server Name" });
    });
    await flush();
    expect(fetchShippingProfile).toHaveBeenCalledTimes(2);
    expect(q("businessName")!.value).toBe("Typed Name");
  });

  it("a name-only save does not store a country-only address", async () => {
    m = mount(<ProfileSettingsTab />);
    await act(async () => {
      pending!.resolve({ business_name: null, business_phone: null, ship_from_address: null });
    });
    await flush();
    typeInto(q("businessName")!, "Just A Name");
    await act(async () => {
      buttonByText(m!.container, /save business details/i).click();
    });
    expect(saveShippingProfile).toHaveBeenCalledWith({
      business_name: "Just A Name",
      business_phone: null,
      ship_from_address: null,
    });
  });
});
