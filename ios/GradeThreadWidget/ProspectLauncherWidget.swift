import SwiftUI
import WidgetKit

/// US-3101 — a Lock Screen button that opens the sourcing camera.
///
/// Every other widget in this bundle reports a NUMBER. This one reports
/// nothing, and that is the point: the moment a reseller needs Prospect is the
/// moment they are standing in a shop holding a garment, deciding in a few
/// seconds whether to buy it. The path to it was unlock, find the app, open it,
/// find the grid icon in the toolbar, tap Prospect. On a Lock Screen it is now
/// one tap from a locked phone.
///
/// **No timeline, no data, no App Group read.** A launcher that had to load a
/// snapshot could render stale, render empty, or fail — three ways for a button
/// to look broken. This one always draws the same thing, which is why its
/// timeline is a single entry with `.never` as its refresh policy.
///
/// Accessory families only. On the Home Screen this would be a large tile that
/// does nothing but launch, next to a tile that shows the day's numbers; the
/// Lock Screen and StandBy are where a one-tap action earns its space.
struct ProspectLauncherWidget: Widget {
    private let kind = "GradeThreadProspectLauncherWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ProspectLauncherProvider()) { _ in
            ProspectLauncherView()
                .containerBackground(.fill.tertiary, for: .widget)
                // The one thing this widget does. `WidgetDeepLink.prospect`
                // is parsed back by the app in `onOpenURL`, and its route
                // persists for the cold-launch case — which is most taps, since
                // the phone was locked a moment ago.
                .widgetURL(WidgetDeepLink.prospect.url)
        }
        .configurationDisplayName("What's it worth?")
        .description("One tap to photograph an item and see what it sells for.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}

struct ProspectLauncherEntry: TimelineEntry {
    let date: Date
}

struct ProspectLauncherProvider: TimelineProvider {
    func placeholder(in context: Context) -> ProspectLauncherEntry {
        ProspectLauncherEntry(date: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (ProspectLauncherEntry) -> Void) {
        completion(ProspectLauncherEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ProspectLauncherEntry>) -> Void) {
        // Never refreshes. There is nothing here that can go out of date, and a
        // launcher that consumed refresh budget would be taking it from the
        // snapshot widget, which genuinely needs it.
        completion(Timeline(entries: [ProspectLauncherEntry(date: .now)], policy: .never))
    }
}

struct ProspectLauncherView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            // A glyph alone. At this size a word is unreadable and a truncated
            // one reads as a rendering bug.
            Image(systemName: "viewfinder.rectangular")
                .font(.title2)
                .widgetAccentable()
        default:
            HStack(spacing: 6) {
                Image(systemName: "viewfinder.rectangular")
                    .font(.headline)
                    .widgetAccentable()
                VStack(alignment: .leading, spacing: 1) {
                    Text("What's it worth?")
                        .font(.headline)
                        .lineLimit(1)
                    Text("Photograph an item")
                        .font(.caption2)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
