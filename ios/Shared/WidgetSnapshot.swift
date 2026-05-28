import Foundation

/// Cross-target snapshot the main app publishes + the widget extension
/// reads (US-190). Widgets run in their own process and can't touch the
/// app's SwiftData store, so the main app computes a tiny rollup after
/// each sync and writes it to the shared App Group container as JSON.
/// The widget's TimelineProvider reads it back — no DB access, no
/// network, instant render.
///
/// Both targets compile this file (project.yml lists Shared/ under both
/// sources). Reuses the same App Group as ``IntakeInbox``.
public struct WidgetSnapshot: Codable, Equatable {
    /// When the main app computed this rollup. The widget shows a
    /// relative "Updated 5m ago" so a stale snapshot is obvious rather
    /// than silently wrong.
    public let generatedAt: Date

    /// False when no one's signed in — the widget swaps to a
    /// "Sign in to see your stats" prompt instead of showing zeros that
    /// look like a dead business.
    public let isSignedIn: Bool

    /// Listings currently in the `active` state across all platforms.
    public let activeListings: Int

    /// Sales whose saleDate falls on the current local day.
    public let soldTodayCount: Int
    /// Gross sale price summed across today's sales (before fees).
    public let soldTodayGross: Double

    /// Sales that have sold but don't yet carry a payout reference —
    /// money earned but not yet in the bank.
    public let pendingPayoutCount: Int
    /// Net of those pending sales: sale price minus platform fees.
    public let pendingPayoutNet: Double

    public init(
        generatedAt: Date,
        isSignedIn: Bool,
        activeListings: Int,
        soldTodayCount: Int,
        soldTodayGross: Double,
        pendingPayoutCount: Int,
        pendingPayoutNet: Double
    ) {
        self.generatedAt = generatedAt
        self.isSignedIn = isSignedIn
        self.activeListings = activeListings
        self.soldTodayCount = soldTodayCount
        self.soldTodayGross = soldTodayGross
        self.pendingPayoutCount = pendingPayoutCount
        self.pendingPayoutNet = pendingPayoutNet
    }

    /// Signed-out placeholder. Distinct from an all-zero signed-in
    /// snapshot (a real seller with no sales today) so the widget can
    /// branch its copy.
    public static func signedOut(generatedAt: Date = .now) -> WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: generatedAt,
            isSignedIn: false,
            activeListings: 0,
            soldTodayCount: 0,
            soldTodayGross: 0,
            pendingPayoutCount: 0,
            pendingPayoutNet: 0
        )
    }

    /// Placeholder for the widget gallery + the brief window before the
    /// app has published its first real snapshot.
    public static let placeholder = WidgetSnapshot(
        generatedAt: .now,
        isSignedIn: true,
        activeListings: 12,
        soldTodayCount: 3,
        soldTodayGross: 184.0,
        pendingPayoutCount: 5,
        pendingPayoutNet: 312.55
    )
}

/// File-based store for the snapshot in the App Group container. Mirrors
/// ``IntakeInbox``'s container conventions so both features share one
/// group entitlement.
public enum WidgetSnapshotStore {
    public static let appGroupIdentifier = "group.com.gradethread.app"
    private static let filename = "widget-snapshot.json"

    public static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
    }

    public static var fileURL: URL? {
        containerURL?.appendingPathComponent(filename)
    }

    /// Writes the snapshot atomically. No-op (returns false) when the
    /// App Group container isn't available — e.g. unit tests without the
    /// entitlement; callers don't treat that as an error.
    @discardableResult
    public static func write(_ snapshot: WidgetSnapshot) -> Bool {
        guard let url = fileURL else { return false }
        do {
            let data = try encoder.encode(snapshot)
            try data.write(to: url, options: [.atomic])
            return true
        } catch {
            return false
        }
    }

    /// Reads the last published snapshot, or nil when nothing's been
    /// written yet / the file is unreadable.
    public static func read() -> WidgetSnapshot? {
        guard let url = fileURL,
              let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
