import { AppDownloadList } from "@/components/get-the-apps";

// US-3110: the download row on the widget board.
//
// The frame draws the card and the heading, so this renders bare rows — see the
// note on AppDownloadList about why it must not draw a card of its own.
//
// No `omitWhen`. The board can tell whether our browser extension is installed
// (the bridge marker, src/lib/lister-extension.ts) but it cannot tell whether
// the iOS app is, and hiding all three on the strength of one would take the
// App Store link away from the seller most likely to want it — the one already
// running the extension on their laptop.

export function GradingGetAppsWidget() {
  return <AppDownloadList surface="dashboard-widget" />;
}
