import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { usePageHost } from "@/hooks/use-page-host";
import { useHashScroll } from "@/hooks/use-hash-scroll";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { SettingsDirtyContext } from "@/hooks/use-settings-dirty";
import { UnsavedChangesDialog } from "@/components/unsaved-changes-dialog";
import { cn } from "@/lib/utils";
import { ProfileSettingsTab } from "@/components/settings/profile-settings-tab";
import { SecuritySettingsTab } from "@/components/settings/security-settings-tab";
import { NotificationsSettingsTab } from "@/components/settings/notifications-settings-tab";
import { AiSettingsTab } from "@/components/settings/ai-settings-tab";
import { FlipdeskSettingsTab } from "@/components/settings/flipdesk-settings-tab";
import { DataSettingsTab } from "@/components/settings/data-settings-tab";
import { PhotoArchiveCard } from "@/components/settings/photo-archive-card";
import { DangerZoneCard } from "@/components/settings/danger-zone-card";
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  SETTINGS_TAB_VALUES,
  type SettingsTab,
} from "@/lib/settings-tabs";

// Web-growth action 6: each tab's cards, state and save handlers live in their
// own component under src/components/settings/. This page owns the tab strip,
// the ?tab= deep link and the unsaved-changes guard. Radix unmounts an
// inactive TabsContent, so a tab's unsaved typing would be dropped when you
// switch away from it; sections with a text form report their dirty state
// (useReportSettingsDirty) and any navigation is held behind a dialog while
// one is dirty. Tab changes go through setSearchParams, so the same blocker
// catches inner tabs, outer hub tabs and sidebar links.
export function SettingsPage() {
  const { embedded } = usePageHost();
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep-linkable section: ?tab=security, etc. Unknown/missing → Profile.
  const tabParam = searchParams.get("tab");
  const activeTab: SettingsTab = SETTINGS_TAB_VALUES.includes(
    tabParam as SettingsTab
  )
    ? (tabParam as SettingsTab)
    : DEFAULT_SETTINGS_TAB;

  // ?tab=notifications#email-preferences (the unsubscribe email) has to land
  // on the card, which mounts after the browser's own hash jump has fired.
  useHashScroll(activeTab);

  const [dirtySections, setDirtySections] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const setDirty = useCallback((section: string, dirty: boolean) => {
    setDirtySections((prev) => {
      if (prev.has(section) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(section);
      else next.delete(section);
      return next;
    });
  }, []);
  const guard = useNavigationGuard(dirtySections.size > 0);

  function handleTabChange(next: string) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        return params;
      },
      { replace: true }
    );
  }

  return (
    <SettingsDirtyContext.Provider value={setDirty}>
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Manage your account settings."
      />

      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="space-y-6"
      >
        {/* US-1441: inside the Account hub, the hub's tab strip sits directly
            above these. Rendering both as identical pill strips reads as two
            stacked tab bars, so switch these to an underline sub-nav that's
            clearly secondary to (not a sibling of) the hub tabs. */}
        {/* One row that scrolls sideways on a phone. It used to flex-wrap,
            but the list's h-9 variant wins over h-auto, so wrapped rows
            spilled out of the 36px box and the border cut through them. */}
        <TabsList
          className={cn(
            "w-full max-w-full justify-start overflow-x-auto",
            embedded &&
              "gap-1 rounded-none border-b bg-transparent p-0",
          )}
        >
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className={cn(
                "shrink-0",
                embedded &&
                  "rounded-none border-b-2 border-transparent bg-transparent px-3 pb-2 shadow-none data-[state=active]:border-brand-navy data-[state=active]:bg-transparent data-[state=active]:shadow-none",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
          <ProfileSettingsTab />
        </TabsContent>

        <TabsContent value="notifications" className="space-y-6">
          <NotificationsSettingsTab />
        </TabsContent>

        <TabsContent value="ai" className="space-y-6">
          <AiSettingsTab />
        </TabsContent>

        <TabsContent value="flipdesk" className="space-y-6">
          <FlipdeskSettingsTab />
        </TabsContent>

        <TabsContent value="data" className="space-y-6">
          <DataSettingsTab />
        </TabsContent>

        <TabsContent value="security" className="space-y-6">
          <SecuritySettingsTab />
        </TabsContent>

        <TabsContent value="storage" className="space-y-6">
          <PhotoArchiveCard />
        </TabsContent>

        <TabsContent value="danger" className="space-y-6">
          <DangerZoneCard />
        </TabsContent>
      </Tabs>
      <UnsavedChangesDialog guard={guard} noun="change" />
    </div>
    </SettingsDirtyContext.Provider>
  );
}
