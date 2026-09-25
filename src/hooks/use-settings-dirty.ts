import { createContext, useContext, useEffect } from "react";

// Which Settings sections hold unsaved typing. SettingsPage owns the state
// and guards navigation while any section is dirty; each section reports its
// own flag. Outside SettingsPage the default is a no-op, so a section renders
// the same anywhere.
export type SetSettingsDirty = (section: string, dirty: boolean) => void;

export const SettingsDirtyContext = createContext<SetSettingsDirty>(() => {});

/** Report one section's dirty flag; cleared when the section unmounts. */
export function useReportSettingsDirty(section: string, dirty: boolean): void {
  const setDirty = useContext(SettingsDirtyContext);
  useEffect(() => {
    setDirty(section, dirty);
  }, [setDirty, section, dirty]);
  useEffect(() => () => setDirty(section, false), [setDirty, section]);
}
