// ACC-14: the AI tab reads usage from the server's billing summary (which
// rolls over each month) instead of the profile counter, prints the reset
// date in UTC, and says what a typed cap will actually do.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, typeInto, flush, type Mounted } from "./profile-settings-harness";
import { aiCapHint, nextAiResetLabel } from "@/lib/ai-limit";

const USER = { id: "user-1" };
let profile: Record<string, unknown> = {};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: USER, profile, refreshProfile: async () => {} }),
}));
let isPersonal = true;
vi.mock("@/hooks/use-workspace", () => ({ useWorkspace: () => ({ isPersonal }) }));
let usageError = false;
vi.mock("@/hooks/use-plan-usage", () => ({
  usePlanUsage: () =>
    usageError
      ? {
          // What usePlanUsage hands back when the summary read fails.
          plan: "free",
          aiActions: { used: 0, limit: 0, pct: 0, unlimited: false },
          isLoading: false,
          isError: true,
        }
      : {
          plan: "starter",
          aiActions: { used: 3, limit: 200, pct: 2, unlimited: false },
          isLoading: false,
          isError: false,
        },
}));
const updates: unknown[] = [];
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      update: (body: unknown) => ({
        eq: async () => {
          updates.push(body);
          return { error: null };
        },
      }),
    }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AiSettingsTab } from "@/components/settings/ai-settings-tab";

let m: Mounted | null = null;
beforeEach(() => {
  updates.length = 0;
  isPersonal = true;
  usageError = false;
  // The stale profile counter says 180; the server says 3 after rollover.
  profile = { id: "user-1", ai_actions_used_this_month: 180, ai_action_limit: null, ai_enrichment_enabled: true, flipdesk_plan: "starter" };
});
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("AiSettingsTab", () => {
  it("shows the server's used count, not the profile's", () => {
    m = mount(<AiSettingsTab />);
    expect(m.container.textContent).toContain("3 / 200 actions");
    expect(m.container.textContent).not.toContain("180");
  });

  it("hints 'no effect' for a cap above the plan and saves on blur", async () => {
    m = mount(<AiSettingsTab />);
    const input = m.container.querySelector<HTMLInputElement>("#ai-limit")!;
    typeInto(input, "500");
    expect(m.container.querySelector("#ai-limit-hint")!.textContent).toMatch(/no effect/i);
    expect(m.container.textContent).not.toMatch(/save ai settings/i);
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    expect(updates).toEqual([{ ai_action_limit: 500 }]);
  });

  it("the switch saves on change", async () => {
    m = mount(<AiSettingsTab />);
    const sw = m.container.querySelector<HTMLButtonElement>('[aria-label="Enable AI enrichment"]')!;
    await act(async () => {
      sw.click();
    });
    await flush();
    expect(updates).toEqual([{ ai_enrichment_enabled: false }]);
  });

  it("does not present a failed usage read as 0 / 0 on the free plan", () => {
    usageError = true;
    m = mount(<AiSettingsTab />);
    expect(m.container.textContent).toContain("Couldn't load usage");
    expect(m.container.textContent).not.toContain("0 / 0");
    const input = m.container.querySelector<HTMLInputElement>("#ai-limit")!;
    typeInto(input, "500");
    expect(m.container.querySelector("#ai-limit-hint")!.textContent).not.toMatch(/no effect/i);
  });

  it("is read-only inside someone else's workspace", () => {
    isPersonal = false;
    m = mount(<AiSettingsTab />);
    expect(m.container.textContent).toContain("AI allowance belongs to the workspace owner");
    expect(m.container.querySelector<HTMLInputElement>("#ai-limit")!.disabled).toBe(true);
  });
});

describe("aiCapHint", () => {
  it("names the three effects", () => {
    expect(aiCapHint("500", 200)).toMatch(/no effect/i);
    expect(aiCapHint("50", 200)).toMatch(/stops at 50.*action credits won't be used/i);
    expect(aiCapHint("0", 200)).toMatch(/turns ai off/i);
    expect(aiCapHint("", 200)).toMatch(/200/);
    expect(aiCapHint("abc", 200)).toMatch(/whole number/i);
    expect(aiCapHint("5000", -1)).toMatch(/stops at 5000/i);
  });
});

describe("nextAiResetLabel", () => {
  it("is the 1st of next month in UTC", () => {
    // 23:30 on Sep 30 in UTC-7 is already Oct 1 06:30 UTC: next reset is Nov 1.
    expect(nextAiResetLabel(new Date("2026-10-01T06:30:00Z"))).toBe("November 1");
    expect(nextAiResetLabel(new Date("2026-12-31T23:59:00Z"))).toBe("January 1");
  });
});
