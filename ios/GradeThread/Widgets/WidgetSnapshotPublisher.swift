import Foundation
import GradeThreadCore
import SwiftData
import WidgetKit

/// Computes a ``WidgetSnapshot`` from the local SwiftData cache + writes
/// it to the shared App Group container, then nudges WidgetKit to reload
/// (US-190). Called after each successful sync pass + on sign-out.
///
/// The pure rollup math lives in ``compute(listings:sales:now:isSignedIn:)``
/// so it's unit-testable without a ModelContainer; ``publish`` is the
/// thin SwiftData + WidgetKit wrapper around it.
enum WidgetSnapshotPublisher {

    /// Fetches listings + sales off the container, computes the rollup,
    /// writes it, and reloads timelines. Safe to call from any actor —
    /// the SwiftData fetch hops to the main actor internally.
    @MainActor
    static func publish(container: ModelContainer, isSignedIn: Bool) {
        let context = ModelContext(container)
        let listings = (try? context.fetch(FetchDescriptor<LocalListing>())) ?? []
        let sales = (try? context.fetch(FetchDescriptor<LocalSale>())) ?? []
        let snapshot = compute(
            listings: listings,
            sales: sales,
            now: .now,
            isSignedIn: isSignedIn
        )
        WidgetSnapshotStore.write(snapshot)
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Last time we asked WidgetKit to reload. Coalesces bursts of distinct
    /// snapshots so a flurry of syncs doesn't hammer the timeline.
    private static var lastReloadAt: Date = .distantPast

    /// US-637: publish only when the rolled-up numbers actually changed, and
    /// coalesce the WidgetKit reload. The caller computes `snapshot` off the
    /// main thread (``SyncMergeActor.widgetSnapshot``); this just diffs against
    /// the last-written snapshot and reloads at most once per `minReloadInterval`.
    @MainActor
    static func publishIfChanged(
        _ snapshot: WidgetSnapshot,
        now: Date = .now,
        minReloadInterval: TimeInterval = 30
    ) {
        if let previous = WidgetSnapshotStore.read(), previous.hasSameRollup(as: snapshot) {
            return  // numbers unchanged → no write, no reload
        }
        WidgetSnapshotStore.write(snapshot)
        guard now.timeIntervalSince(lastReloadAt) >= minReloadInterval else { return }
        lastReloadAt = now
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Writes the signed-out placeholder + reloads. Called on sign-out so
    /// the widget stops showing the previous user's numbers immediately.
    @MainActor
    static func publishSignedOut() {
        WidgetSnapshotStore.write(.signedOut())
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Pure rollup. `listings`/`sales` are the full local mirror; we
    /// filter here so the caller doesn't have to pre-shape the data.
    ///
    /// - "Sold today" buckets by the sale's `saleDate` against the start
    ///   of `now`'s local day.
    /// - "Pending payout" is every sale missing a `payoutReference`,
    ///   netting platform fees out of the sale price (never below zero —
    ///   a fee greater than the sale price is bad data, not a negative
    ///   payout).
    static func compute(
        listings: [LocalListing],
        sales: [LocalSale],
        now: Date,
        isSignedIn: Bool,
        calendar: Calendar = .current
    ) -> WidgetSnapshot {
        guard isSignedIn else { return .signedOut(generatedAt: now) }

        // US-1258: count every LIVE listing (active + relisted), case-insensitive,
        // via the canonical set — a brittle literal "active" silently zeroed the
        // tile on any casing/status drift and missed relisted (still-live) rows.
        let activeListings = listings.filter {
            SyncEngine.liveListingStatuses.contains($0.listingStatus.lowercased())
        }.count

        // Only completed sales count — cancelled/refunded orders are excluded
        // (00111).
        let completedSales = sales.filter { SalePnL.isCompleted($0) }
        let startOfToday = calendar.startOfDay(for: now)
        let todaysSales = completedSales.filter { $0.saleDate >= startOfToday }
        let soldTodayGross = Money.sum(todaysSales) { $0.salePrice }

        let pending = completedSales.filter { ($0.payoutReference ?? "").isEmpty }
        let pendingNet = Money.sum(pending) { max(0, $0.salePrice - $0.platformFees) }

        return WidgetSnapshot(
            generatedAt: now,
            isSignedIn: true,
            activeListings: activeListings,
            soldTodayCount: todaysSales.count,
            soldTodayGross: soldTodayGross,
            pendingPayoutCount: pending.count,
            pendingPayoutNet: pendingNet,
            currencyCode: AppPreferences.currencyCode
        )
    }
}
