import SwiftUI
import WidgetKit

// MARK: - Bundle entry point

@main
struct GradeThreadWidgetBundle: WidgetBundle {
    var body: some Widget {
        SnapshotWidget()
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
        .supportedFamilies([.systemSmall, .systemMedium])
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
        let snapshot = context.isPreview
            ? .placeholder
            : (WidgetSnapshotStore.read() ?? .placeholder)
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
    let entry: SnapshotEntry

    var body: some View {
        if !entry.snapshot.isSignedIn {
            SignedOutView()
        } else {
            switch family {
            case .systemSmall: SmallView(snapshot: entry.snapshot)
            default:           MediumView(snapshot: entry.snapshot)
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
                    ? CurrencyText.string(snapshot.soldTodayGross)
                    : nil
            )
            Metric(
                label: "Payout waiting",
                value: CurrencyText.string(snapshot.pendingPayoutNet),
                detail: snapshot.pendingPayoutCount > 0
                    ? "\(snapshot.pendingPayoutCount) sale\(snapshot.pendingPayoutCount == 1 ? "" : "s")"
                    : nil
            )
            Spacer(minLength: 0)
            UpdatedFootnote(date: snapshot.generatedAt)
        }
    }
}

/// Medium family: same metrics in a row, plus active listings.
private struct MediumView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            BrandHeader()
            HStack(alignment: .top, spacing: 16) {
                Metric(
                    label: "Active",
                    value: "\(snapshot.activeListings)",
                    detail: "listings"
                )
                Divider()
                Metric(
                    label: "Sold today",
                    value: "\(snapshot.soldTodayCount)",
                    detail: snapshot.soldTodayCount > 0
                        ? CurrencyText.string(snapshot.soldTodayGross)
                        : "—"
                )
                Divider()
                Metric(
                    label: "Payout",
                    value: CurrencyText.string(snapshot.pendingPayoutNet),
                    detail: "\(snapshot.pendingPayoutCount) waiting"
                )
            }
            Spacer(minLength: 0)
            UpdatedFootnote(date: snapshot.generatedAt)
        }
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
    static func string(_ amount: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = amount.truncatingRemainder(dividingBy: 1) == 0 ? 0 : 2
        return formatter.string(from: NSNumber(value: amount)) ?? "$\(Int(amount))"
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
