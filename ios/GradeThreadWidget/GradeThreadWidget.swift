import SwiftUI
import WidgetKit

// MARK: - Bundle entry point

@main
struct GradeThreadWidgetBundle: WidgetBundle {
    var body: some Widget {
        SnapshotWidget()
        // US-3101: a Lock Screen launcher for the sourcing camera.
        ProspectLauncherWidget()
    }
}

// MARK: - Widget definition

/// Home-screen widget showing today's selling snapshot + pending payout
/// (US-190). Reads the rollup the main app publishes to the shared App
/// Group container — no network, no DB, instant render.
struct SnapshotWidget: Widget {
    private let kind = "GradeThreadSnapshotWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            SnapshotWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Today at a glance")
        .description("Your active listings, what sold today, and payout waiting in the wings.")
        // US-1134: home-screen (.system*) + Lock Screen / StandBy accessory
        // families, all driven by the same App Group rollup.
        .supportedFamilies([
            .systemSmall, .systemMedium,
            .accessoryRectangular, .accessoryInline, .accessoryCircular,
        ])
    }
}

// MARK: - Timeline

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: .now, snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        // US-1410: only the gallery PREVIEW shows the sample `.placeholder` (with
        // its dummy "$312 payout"). A real, non-preview snapshot for a signed-out
        // user (or before the first publish) must fall back to `.signedOut()` —
        // matching `getTimeline` — not the fake financials.
        let snapshot: WidgetSnapshot = context.isPreview
            ? .placeholder
            : (WidgetSnapshotStore.read() ?? .signedOut())
        completion(SnapshotEntry(date: .now, snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let snapshot = WidgetSnapshotStore.read() ?? .signedOut()
        let entry = SnapshotEntry(date: .now, snapshot: snapshot)
        // The app reloads timelines after each sync, so this fallback
        // cadence only matters when the app hasn't run in a while.
        // Half-hour keeps "Updated Xm ago" honest without burning the
        // widget refresh budget.
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: .now) ?? .now
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - Views

struct SnapshotWidgetView: View {
    @Environment(\.widgetFamily) private var family
    // US-1134: StandBy (and the Lock Screen) strip the widget container
    // background; we render a higher-contrast, larger-number small treatment
    // when that's the case so the numbers stay glanceable on a nightstand.
    @Environment(\.showsWidgetContainerBackground) private var showsContainerBackground
    let entry: SnapshotEntry

    var body: some View {
        switch family {
        case .accessoryInline:
            AccessoryInlineView(snapshot: entry.snapshot)
        case .accessoryCircular:
            AccessoryCircularView(snapshot: entry.snapshot)
        case .accessoryRectangular:
            AccessoryRectangularView(snapshot: entry.snapshot)
        default:
            if !entry.snapshot.isSignedIn {
                SignedOutView()
            } else if family == .systemSmall {
                if showsContainerBackground {
                    SmallView(snapshot: entry.snapshot)
                } else {
                    StandByView(snapshot: entry.snapshot)
                }
            } else {
                MediumView(snapshot: entry.snapshot)
            }
        }
    }
}

private struct SignedOutView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            BrandHeader()
            Spacer(minLength: 0)
            Text("Sign in to see today's sales and payout.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
    }
}

/// Small family: the two numbers a seller checks most — sold today +
/// pending payout. Active-listing count rides along as a footnote.
private struct SmallView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            BrandHeader()
            Spacer(minLength: 0)
            Metric(
                label: "Sold today",
                value: "\(snapshot.soldTodayCount)",
                detail: snapshot.soldTodayCount > 0
                    ? CurrencyText.string(snapshot.soldTodayGross, code: snapshot.currencyCode)
                    : nil
            )
            Metric(
                label: "Payout waiting",
                value: CurrencyText.string(snapshot.pendingPayoutNet, code: snapshot.currencyCode),
                detail: snapshot.pendingPayoutCount > 0
                    ? "\(snapshot.pendingPayoutCount) sale\(snapshot.pendingPayoutCount == 1 ? "" : "s")"
                    : nil
            )
            Spacer(minLength: 0)
            UpdatedFootnote(date: snapshot.generatedAt)
        }
        // US-752: the small widget shows the sold-today + payout numbers, so a
        // tap anywhere on it lands on the Money/Sales surface instead of just
        // unlocking the app. systemSmall can carry only one widgetURL.
        .widgetURL(WidgetDeepLink.money.url)
        // US-1222: a single composed VoiceOver summary for the whole tile.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WidgetAccessibility.summary(for: snapshot))
    }
}

/// Medium family: same metrics in a row, plus active listings.
private struct MediumView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            BrandHeader()
            HStack(alignment: .top, spacing: 16) {
                // US-752: the medium widget can host per-region links, so the
                // Active-listings metric drills into the Marketplaces hub while
                // the rest of the widget (sold/payout) falls through to the
                // container widgetURL → Money/Sales.
                Link(destination: WidgetDeepLink.marketplaces.url) {
                    Metric(
                        label: "Active",
                        value: "\(snapshot.activeListings)",
                        detail: "listings"
                    )
                }
                Divider()
                Metric(
                    label: "Sold today",
                    value: "\(snapshot.soldTodayCount)",
                    detail: snapshot.soldTodayCount > 0
                        ? CurrencyText.string(snapshot.soldTodayGross, code: snapshot.currencyCode)
                        : "—"
                )
                Divider()
                Metric(
                    label: "Payout",
                    value: CurrencyText.string(snapshot.pendingPayoutNet, code: snapshot.currencyCode),
                    detail: "\(snapshot.pendingPayoutCount) waiting"
                )
            }
            Spacer(minLength: 0)
            UpdatedFootnote(date: snapshot.generatedAt)
        }
        // Sold-today + payout (and any non-Active tap) → Money/Sales.
        .widgetURL(WidgetDeepLink.money.url)
        // US-1222: combine the three metric columns into one spoken summary,
        // including the active-listing count the small view omits.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WidgetAccessibility.summary(for: snapshot, includeActive: true))
    }
}

/// StandBy / Lock Screen full-bleed small treatment (US-1134). No container
/// background, so we lean on big rounded numerals for nightstand legibility and
/// drop the "Updated Xm ago" footnote that's invisible at standby distance.
private struct StandByView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            BrandHeader()
            Spacer(minLength: 0)
            Text("\(snapshot.soldTodayCount)")
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .foregroundStyle(Color.brandNavyLiteral)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text(snapshot.soldTodayCount == 1 ? "sale today" : "sales today")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text("\(CurrencyText.string(snapshot.pendingPayoutNet, code: snapshot.currencyCode)) payout waiting")
                .font(.footnote.weight(.medium))
                .foregroundStyle(Color.brandNavyLiteral)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(WidgetDeepLink.money.url)
        // US-1222: the big rounded numerals read as bare numbers to VoiceOver;
        // compose them into the same natural-language summary.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WidgetAccessibility.summary(for: snapshot))
    }
}

// MARK: - Lock Screen accessory families (US-1134)

/// Lock Screen inline (the line above the clock). One Label only — the OS
/// renders it monochrome, tinted to the user's Lock Screen color.
private struct AccessoryInlineView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        if snapshot.isSignedIn {
            Label(
                "\(snapshot.soldTodayCount) sold · \(CurrencyText.string(snapshot.pendingPayoutNet, code: snapshot.currencyCode)) payout",
                systemImage: "shippingbox.fill"
            )
            // US-1222: the "·" separator reads awkwardly; speak a clean summary.
            .accessibilityLabel(WidgetAccessibility.summary(for: snapshot))
        } else {
            Label("Sign in to GradeThread", systemImage: "shippingbox.fill")
                .accessibilityLabel(WidgetAccessibility.summary(for: snapshot))
        }
    }
}

/// Lock Screen circular complication. Shows the single most glanceable number —
/// items sold today — over the system accessory background.
private struct AccessoryCircularView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "shippingbox.fill")
                    .font(.system(size: 11))
                Text("\(snapshot.isSignedIn ? snapshot.soldTodayCount : 0)")
                    .font(.title2.weight(.bold))
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Text("sold")
                    .font(.system(size: 9))
            }
        }
        .widgetAccentable()
        .widgetURL(WidgetDeepLink.money.url)
        // US-1222: without this VoiceOver reads just the bare numeral ("3").
        // Compose the count into a sentence so the complication is meaningful.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WidgetAccessibility.circularLabel(for: snapshot))
    }
}

/// Lock Screen rectangular complication. Two compact lines: today's sales and
/// the payout waiting.
private struct AccessoryRectangularView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("GradeThread", systemImage: "shippingbox.fill")
                .font(.caption2.weight(.bold))
                .widgetAccentable()
            if snapshot.isSignedIn {
                Text(soldLine)
                    .font(.caption2)
                Text("\(CurrencyText.string(snapshot.pendingPayoutNet, code: snapshot.currencyCode)) payout waiting")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text("Sign in to see today's sales.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(WidgetDeepLink.money.url)
        // US-1222: merge the two stacked lines into one spoken summary.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WidgetAccessibility.summary(for: snapshot))
    }

    private var soldLine: String {
        if snapshot.soldTodayCount > 0 {
            return "\(snapshot.soldTodayCount) sold today · \(CurrencyText.string(snapshot.soldTodayGross, code: snapshot.currencyCode))"
        }
        return "Nothing sold yet today"
    }
}

// MARK: - Shared bits

private struct BrandHeader: View {
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "shippingbox.fill")
                .font(.caption2)
                .foregroundStyle(Color.brandRedLiteral)
            Text("GradeThread")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.brandNavyLiteral)
        }
    }
}

private struct Metric: View {
    let label: String
    let value: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(Color.brandNavyLiteral)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if let detail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        // US-1222: VoiceOver would otherwise read the three stacked Texts as
        // three separate elements ("Sold today", "3", "$184"). Merge them into
        // one element with a natural-language label so the swipe reads a whole
        // metric at once.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(detail.map { "\(label): \(value), \($0)" } ?? "\(label): \(value)")
    }
}

private struct UpdatedFootnote: View {
    let date: Date
    var body: some View {
        Text("Updated \(date, style: .relative) ago")
            .font(.system(size: 9))
            .foregroundStyle(.tertiary)
    }
}

/// Compact currency formatter shared by the widget views. Whole-dollar
/// when there are no cents so "$184" reads cleaner than "$184.00" at
/// widget sizes.
private enum CurrencyText {
    // US-1161: format in the snapshot's currency (the user's override) when set;
    // otherwise follow the device locale rather than forcing USD.
    static func string(_ amount: Double, code: String? = nil) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        if let code { formatter.currencyCode = code }
        formatter.maximumFractionDigits = amount.truncatingRemainder(dividingBy: 1) == 0 ? 0 : 2
        return formatter.string(from: NSNumber(value: amount)) ?? "\(formatter.currencySymbol ?? "$")\(Int(amount))"
    }
}

// US-1222: composed VoiceOver summaries shared across the widget families.
// The visual layouts stack bare numbers/labels as separate Texts, which read
// as disconnected fragments (or just "3") to VoiceOver. These build a single
// natural-language sentence from the snapshot fields so every family — home
// screen, StandBy, and the three Lock Screen accessories — speaks the same
// glanceable summary.
private enum WidgetAccessibility {
    /// Full summary: sold today (+ gross), payout waiting, optionally the
    /// active-listing count (medium family). Falls back to a sign-in prompt.
    static func summary(for snapshot: WidgetSnapshot, includeActive: Bool = false) -> String {
        guard snapshot.isSignedIn else {
            return "Sign in to GradeThread to see today's sales and payout."
        }
        var parts: [String] = []
        if includeActive {
            parts.append("\(snapshot.activeListings) active \(snapshot.activeListings == 1 ? "listing" : "listings")")
        }
        parts.append(soldClause(for: snapshot))
        parts.append(payoutClause(for: snapshot))
        return parts.joined(separator: ". ") + "."
    }

    /// Circular complication: the count alone is meaningless to VoiceOver, so
    /// speak it as a sentence ("3 items sold today").
    static func circularLabel(for snapshot: WidgetSnapshot) -> String {
        guard snapshot.isSignedIn else {
            return "Sign in to GradeThread."
        }
        let count = snapshot.soldTodayCount
        return "\(count) \(count == 1 ? "item" : "items") sold today."
    }

    private static func soldClause(for snapshot: WidgetSnapshot) -> String {
        let count = snapshot.soldTodayCount
        guard count > 0 else { return "Nothing sold yet today" }
        let gross = CurrencyText.string(snapshot.soldTodayGross, code: snapshot.currencyCode)
        return "\(count) \(count == 1 ? "item" : "items") sold today, \(gross) gross"
    }

    private static func payoutClause(for snapshot: WidgetSnapshot) -> String {
        let net = CurrencyText.string(snapshot.pendingPayoutNet, code: snapshot.currencyCode)
        guard snapshot.pendingPayoutCount > 0 else {
            return "No payout waiting"
        }
        let count = snapshot.pendingPayoutCount
        return "\(net) payout waiting across \(count) \(count == 1 ? "sale" : "sales")"
    }
}

// US-657: the widget appex now bundles the brand asset catalog (project.yml
// widget resources), so we reference the shared colorsets — Obsidian Navy
// (#0C1E36) and brand red (#F03D5F) — which carry proper light/dark + high-
// contrast variants, instead of the old hardcoded #0F3460 / #E94560 literals.
private extension Color {
    static let brandNavyLiteral = Color("BrandNavy")
    static let brandRedLiteral = Color("BrandRed")
}

// MARK: - Previews

#Preview("Small", as: .systemSmall) {
    SnapshotWidget()
} timeline: {
    SnapshotEntry(date: .now, snapshot: .placeholder)
}

#Preview("Medium", as: .systemMedium) {
    SnapshotWidget()
} timeline: {
    SnapshotEntry(date: .now, snapshot: .placeholder)
    SnapshotEntry(date: .now, snapshot: .signedOut())
}

#Preview("Lock — Rectangular", as: .accessoryRectangular) {
    SnapshotWidget()
} timeline: {
    SnapshotEntry(date: .now, snapshot: .placeholder)
}

#Preview("Lock — Inline", as: .accessoryInline) {
    SnapshotWidget()
} timeline: {
    SnapshotEntry(date: .now, snapshot: .placeholder)
}

#Preview("Lock — Circular", as: .accessoryCircular) {
    SnapshotWidget()
} timeline: {
    SnapshotEntry(date: .now, snapshot: .placeholder)
}
