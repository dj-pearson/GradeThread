// ACC-9: the unsubscribe email links to ?tab=notifications#email-preferences.
// The card mounts after the browser's native hash jump, so SettingsPage has to
// find it and scroll there itself once it exists.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The notifications section mounts a few frames late, like a lazy chunk would.
vi.mock("@/components/settings/notifications-settings-tab", () => ({
  NotificationsSettingsTab: function Late() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const t = setTimeout(() => setReady(true), 30);
      return () => clearTimeout(t);
    }, []);
    return ready ? <div id="email-preferences">prefs</div> : null;
  },
}));
for (const [mod, name] of [
  ["@/components/settings/profile-settings-tab", "ProfileSettingsTab"],
  ["@/components/settings/security-settings-tab", "SecuritySettingsTab"],
  ["@/components/settings/ai-settings-tab", "AiSettingsTab"],
  ["@/components/settings/flipdesk-settings-tab", "FlipdeskSettingsTab"],
  ["@/components/settings/data-settings-tab", "DataSettingsTab"],
  ["@/components/settings/photo-archive-card", "PhotoArchiveCard"],
  ["@/components/settings/danger-zone-card", "DangerZoneCard"],
] as const) {
  vi.doMock(mod, () => ({ [name]: () => null }));
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("useHashScroll on SettingsPage", () => {
  it("scrolls to #email-preferences once it mounts, and focuses it", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { SettingsPage } = await import("@/pages/settings");
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container!);
      root.render(
        <MemoryRouter initialEntries={["/dashboard/settings?tab=notifications#email-preferences"]}>
          <SettingsPage />
        </MemoryRouter>,
      );
    });
    expect(document.getElementById("email-preferences")).toBeNull();
    // act() holds renders until it returns, so let the late section mount
    // inside it, then give the frame loop time to find it outside.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    await new Promise((r) => setTimeout(r, 100));
    const el = document.getElementById("email-preferences")!;
    expect(el).not.toBeNull();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(el);
    expect(document.activeElement).toBe(el);
  });
});
