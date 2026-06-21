import Foundation

/// US-1127 — native parity for the web Scheduled Drops feature
/// (`src/pages/flipdesk/scheduled-drops.tsx`). Resellers schedule a draft
/// listing to publish at a peak buying time (the classic eBay peak is Sunday
/// evening); the 5-minute `publish-due` cron publishes any draft whose
/// `scheduled_publish_at` is in the past. This layer mirrors the web's
/// timezone-aware presets (`src/lib/scheduling.ts`) so a "next Sunday 7 PM"
/// preset resolves to the correct UTC instant in the seller's chosen zone,
/// DST included.

/// A scheduled drop = a `draft` listing with a non-null `scheduled_publish_at`.
/// Mirrors the web `ScheduledDropRow` plus the item-title fallback.
struct ScheduledDrop: Identifiable, Equatable {
    let id: String
    let inventoryItemId: String
    let title: String
    /// Listing price in dollars (nil when unset).
    let priceDollars: Double?
    let scheduledPublishAt: Date
    /// True when a Promoted-Listings boost rides along on go-live.
    let isPromoted: Bool
    let promoRatePct: Double?

    /// Build a drop from a decoded wire row, applying the title fallback
    /// (listing title → item title → placeholder) and the promoted derivation.
    init?(row: ScheduledDropRow) {
        guard let date = ScheduledDropScheduling.parseTimestamp(row.scheduled_publish_at) else {
            return nil
        }
        id = row.id
        inventoryItemId = row.inventory_item_id
        let listingTitle = row.listing_title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let itemTitle = row.inventory_items?.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        title = [listingTitle, itemTitle]
            .compactMap { $0 }
            .first(where: { !$0.isEmpty }) ?? "Untitled draft"
        priceDollars = row.listing_price
        promoRatePct = row.promo_rate_pct
        isPromoted = !(row.promo_opt_out ?? false) && (row.promo_rate_pct ?? 0) > 0
        scheduledPublishAt = date
    }

    /// Test/preview seam — construct directly.
    init(
        id: String,
        inventoryItemId: String,
        title: String,
        priceDollars: Double?,
        scheduledPublishAt: Date,
        isPromoted: Bool,
        promoRatePct: Double?
    ) {
        self.id = id
        self.inventoryItemId = inventoryItemId
        self.title = title
        self.priceDollars = priceDollars
        self.scheduledPublishAt = scheduledPublishAt
        self.isPromoted = isPromoted
        self.promoRatePct = promoRatePct
    }

    /// A copy with a new scheduled instant (used after an optimistic reschedule).
    func withScheduledDate(_ date: Date) -> ScheduledDrop {
        ScheduledDrop(
            id: id,
            inventoryItemId: inventoryItemId,
            title: title,
            priceDollars: priceDollars,
            scheduledPublishAt: date,
            isPromoted: isPromoted,
            promoRatePct: promoRatePct
        )
    }
}

/// Wire shape for a `listings` row + the embedded `inventory_items(title)`
/// relation. supabase-swift decodes raw column names (no snake_case strip), so
/// the fields match the DB exactly.
struct ScheduledDropRow: Decodable {
    let id: String
    let inventory_item_id: String
    let listing_title: String?
    let listing_price: Double?
    let scheduled_publish_at: String
    let promo_opt_out: Bool?
    let promo_rate_pct: Double?
    let inventory_items: ItemTitle?

    struct ItemTitle: Decodable { let title: String? }
}

/// A peak-visibility preset, mirroring `DROP_PRESETS` in `src/lib/scheduling.ts`.
struct DropPreset: Identifiable, Equatable {
    let id: String
    let label: String
    /// 0 = Sunday … 6 = Saturday. nil = "next occurrence of this time on any day".
    let weekday: Int?
    let hour: Int
    let minute: Int
    let hint: String
}

/// Timezone-aware scheduling helpers — the Swift port of `src/lib/scheduling.ts`.
/// Uses `Calendar` configured with the target `TimeZone`, which resolves
/// wall-clock components to the correct UTC instant across DST boundaries.
enum ScheduledDropScheduling {
    /// Peak-buying presets tuned for resale marketplaces (parity with web).
    static let presets: [DropPreset] = [
        DropPreset(id: "sun-7pm", label: "Sunday 7 PM", weekday: 0, hour: 19, minute: 0, hint: "Peak eBay browsing"),
        DropPreset(id: "sun-8pm", label: "Sunday 8 PM", weekday: 0, hour: 20, minute: 0, hint: "Late-evening scrollers"),
        DropPreset(id: "thu-8pm", label: "Thursday 8 PM", weekday: 4, hour: 20, minute: 0, hint: "Weekend warm-up"),
        DropPreset(id: "mon-7pm", label: "Monday 7 PM", weekday: 1, hour: 19, minute: 0, hint: "Start-of-week deal hunters"),
        DropPreset(id: "sat-10am", label: "Saturday 10 AM", weekday: 6, hour: 10, minute: 0, hint: "Weekend morning"),
        DropPreset(id: "tonight-7pm", label: "Tonight / next 7 PM", weekday: nil, hour: 19, minute: 0, hint: "Soonest evening slot"),
    ]

    /// A short curated timezone list so the picker isn't a 400-entry dump. The
    /// detected zone is merged in at render time if it isn't already here.
    static let commonTimezones: [(id: String, label: String)] = [
        ("America/New_York", "Eastern (New York)"),
        ("America/Chicago", "Central (Chicago)"),
        ("America/Denver", "Mountain (Denver)"),
        ("America/Phoenix", "Mountain — no DST (Phoenix)"),
        ("America/Los_Angeles", "Pacific (Los Angeles)"),
        ("America/Anchorage", "Alaska (Anchorage)"),
        ("Pacific/Honolulu", "Hawaii (Honolulu)"),
        ("America/Toronto", "Eastern — Canada (Toronto)"),
        ("Europe/London", "UK (London)"),
        ("Europe/Paris", "Central Europe (Paris)"),
        ("Australia/Sydney", "Australia (Sydney)"),
        ("UTC", "UTC"),
    ]

    /// The viewer's IANA timezone (e.g. "America/Chicago"), with a UTC fallback.
    static func detectTimezone() -> String {
        TimeZone.current.identifier
    }

    private static func zone(_ identifier: String) -> TimeZone {
        TimeZone(identifier: identifier) ?? TimeZone(identifier: "UTC")!
    }

    /// Parse a `timestamptz` string (the edge emits fractional seconds, which the
    /// default `.iso8601` strategy rejects — so try fractional first).
    static func parseTimestamp(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        return ISO8601DateFormatter().date(from: raw)
    }

    /// The UTC ISO instant the DB stores for a scheduled drop.
    static func isoString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    /// The next UTC instant for a preset, evaluated in `timeZoneIdentifier`.
    /// Returns the soonest future occurrence (strictly after `from`). Weekday
    /// presets scan up to two weeks ahead; a day-agnostic preset picks today if
    /// the slot is still future, else tomorrow. Mirrors `nextPresetUtc`.
    static func nextPresetDate(
        _ preset: DropPreset,
        timeZoneIdentifier: String,
        from: Date = .now
    ) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone(timeZoneIdentifier)
        for offset in 0..<14 {
            guard let dayAnchor = cal.date(byAdding: .day, value: offset, to: from) else { continue }
            if let weekday = preset.weekday {
                // Calendar weekday: 1 = Sunday … 7 = Saturday; preset is 0-based Sun.
                if cal.component(.weekday, from: dayAnchor) != weekday + 1 { continue }
            }
            var components = cal.dateComponents([.year, .month, .day], from: dayAnchor)
            components.hour = preset.hour
            components.minute = preset.minute
            components.second = 0
            if let candidate = cal.date(from: components), candidate > from {
                return candidate
            }
        }
        // Unreachable for sane presets; keep a safe one-week fallback.
        return from.addingTimeInterval(7 * 24 * 60 * 60)
    }

    /// Friendly long form for a given zone, e.g. "Sun, Jun 14, 7:00 PM CDT".
    static func formatInZone(_ date: Date, timeZoneIdentifier: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = zone(timeZoneIdentifier)
        formatter.dateFormat = "EEE, MMM d, h:mm a zzz"
        return formatter.string(from: date)
    }
}
