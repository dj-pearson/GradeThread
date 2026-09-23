// Web-growth action 6: SettingsPage is now only the tab strip and the ?tab=
// deep link, with each tab's cards in src/components/settings/. The deep link is
// what unsubscribe emails (?tab=notifications) and in-app links depend on, and
// until this file nothing rendered the page to check it. The sections are
// stubbed so the page renders without auth, Supabase or the edge.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { SettingsPage } from "@/pages/settings";

vi.mock("@/components/settings/profile-settings-tab", () => ({
  ProfileSettingsTab: () => <p>section:profile</p>,
}));
vi.mock("@/components/settings/security-settings-tab", () => ({
  SecuritySettingsTab: () => <p>section:security</p>,
}));
vi.mock("@/components/settings/notifications-settings-tab", () => ({
  NotificationsSettingsTab: () => <p>section:notifications</p>,
}));
vi.mock("@/components/settings/ai-settings-tab", () => ({
  AiSettingsTab: () => <p>section:ai</p>,
}));
vi.mock("@/components/settings/flipdesk-settings-tab", () => ({
  FlipdeskSettingsTab: () => <p>section:flipdesk</p>,
}));
vi.mock("@/components/settings/data-settings-tab", () => ({
  DataSettingsTab: () => <p>section:data</p>,
}));
vi.mock("@/components/settings/photo-archive-card", () => ({
  PhotoArchiveCard: () => <p>section:storage</p>,
}));
vi.mock("@/components/settings/danger-zone-card", () => ({
  DangerZoneCard: () => <p>section:danger</p>,
}));

function render(url: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

/** The sections actually rendered. Radix renders only the active TabsContent. */
function sections(html: string): string[] {
  return [...html.matchAll(/section:(\w+)/g)].map((m) => m[1]!);
}

describe("settings ?tab= deep link", () => {
  it("?tab=security opens the Security tab", () => {
    expect(sections(render("/dashboard/settings?tab=security"))).toEqual([
      "security",
    ]);
  });

  it("?tab=notifications opens the tab the unsubscribe email promises", () => {
    expect(sections(render("/dashboard/settings?tab=notifications"))).toEqual([
      "notifications",
    ]);
  });

  it("an unknown tab falls back to Profile", () => {
    expect(sections(render("/dashboard/settings?tab=nope"))).toEqual([
      "profile",
    ]);
  });

  it("no tab at all opens Profile", () => {
    expect(sections(render("/dashboard/settings"))).toEqual(["profile"]);
  });

  it("every tab value reaches its own section", () => {
    for (const tab of [
      "profile",
      "security",
      "notifications",
      "ai",
      "flipdesk",
      "data",
      "storage",
      "danger",
    ]) {
      expect(sections(render(`/dashboard/settings?tab=${tab}`)), tab).toEqual([
        tab,
      ]);
    }
  });
});
