// ACC-7: each notification switch saves itself as a single-key merge into the
// row as just read, so a stale tab cannot re-subscribe someone who used a
// one-click unsubscribe elsewhere; a failed write rolls the switch back; and
// with no profile, no switches render at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, flush, type Mounted } from "./profile-settings-harness";
import { mergePreference } from "@/lib/notification-preferences";

const USER = { id: "user-1", email: "me@example.com" };
let profile: Record<string, unknown> | null = null;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: USER, profile, refreshProfile: async () => {} }),
}));

// The row as it is in the database RIGHT NOW. The stale tab below still thinks
// marketing is on; the row says it was turned off by an unsubscribe link.
let storedRow: Record<string, unknown> = {};
let failUpdate = false;
const updates: unknown[] = [];
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { notification_preferences: storedRow }, error: null }),
        }),
      }),
      update: (body: { notification_preferences: unknown }) => ({
        eq: async () => {
          updates.push(body.notification_preferences);
          return failUpdate ? { error: new Error("write refused") } : { error: null };
        },
      }),
    }),
  },
}));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));
vi.mock("@/components/settings/push-notifications-card", () => ({ PushNotificationsCard: () => null }));
vi.mock("@/components/settings/quiet-hours-card", () => ({ QuietHoursCard: () => null }));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }));

import { NotificationsSettingsTab } from "@/components/settings/notifications-settings-tab";

let m: Mounted | null = null;
beforeEach(() => {
  updates.length = 0;
  failUpdate = false;
  toastError.mockClear();
  storedRow = {
    marketing: { email: false },
    grade_complete: { email: true, in_app: true, push: true },
    some_future_key: { email: true },
  };
  profile = {
    id: USER.id,
    // Stale: this tab loaded before the unsubscribe.
    notification_preferences: { marketing: { email: true } },
  };
});
afterEach(() => {
  m?.unmount();
  m = null;
});

const sw = (label: string) =>
  m!.container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);

describe("NotificationsSettingsTab", () => {
  it("renders no switches while the profile is missing", () => {
    profile = null;
    m = mount(<NotificationsSettingsTab />);
    expect(m.container.querySelectorAll('[role="switch"]').length).toBe(0);
    expect(m.container.textContent).toContain("Couldn't load your notification settings");
  });

  it("labels each switch with its category and channel", () => {
    m = mount(<NotificationsSettingsTab />);
    expect(sw("Grading: Push")).not.toBeNull();
    expect(sw("All marketing email: Email")).not.toBeNull();
  });

  it("writes one key merged into the freshly read row, keeping marketing.email=false", async () => {
    m = mount(<NotificationsSettingsTab />);
    await act(async () => {
      sw("Grading: Push")!.click();
    });
    await flush();
    expect(updates).toEqual([
      {
        marketing: { email: false },
        grade_complete: { email: true, in_app: true, push: false },
        some_future_key: { email: true },
      },
    ]);
    // The screen now shows the fresh row, so the umbrella reads off.
    expect(sw("All marketing email: Email")!.getAttribute("aria-checked")).toBe("false");
    expect(sw("Weekly newsletter: Email")!.disabled).toBe(true);
  });

  it("rolls the switch back and toasts when the write fails", async () => {
    failUpdate = true;
    m = mount(<NotificationsSettingsTab />);
    expect(sw("Offers: Email")!.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      sw("Offers: Email")!.click();
    });
    await flush();
    expect(toastError).toHaveBeenCalled();
    expect(sw("Offers: Email")!.getAttribute("aria-checked")).toBe("true");
  });

  it("has no Save Preferences button", () => {
    m = mount(<NotificationsSettingsTab />);
    expect(m.container.textContent).not.toMatch(/save preferences/i);
  });
});

describe("mergePreference", () => {
  it("changes one channel and carries every other key over", () => {
    expect(
      mergePreference({ marketing: { email: false }, offers: { email: true, push: true } }, "offers", "push", false),
    ).toEqual({ marketing: { email: false }, offers: { email: true, push: false } });
    expect(mergePreference(null, "offers", "email", false)).toEqual({ offers: { email: false } });
  });
});
