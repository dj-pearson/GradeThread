import Foundation

/// US-3454: what this item is doing on one marketplace, on the phone.
///
/// ⚠ **MIRROR. The TypeScript is the source.** `deriveChannelState` in
/// `src/lib/channel-state.ts` decides the word the web shows on the item card,
/// the composer's List on panel and the listings table; this is the same
/// precedence for the push sheet and the item screen. `CHANNEL_STATE_PRECEDENCE`
/// there and `precedence` here are compared by
/// `src/test/ios-channel-state-parity.test.ts`, which parses this file as text,
/// so the order below is the contract, not a comment.
///
/// One difference, stated: the phone's `LocalListing` carries no
/// `platform_fields`, so the web's `unconfirmed` (recorded as listed because a
/// form was filled, never seen live) reads as `live` here. The case exists so a
/// future column lands in one place.
enum ChannelState: String, Sendable {
    case live
    case unconfirmed
    case queued
    case delistQueued = "delist_queued"
    case prefilled
    case failed
    case ended
    case sold
    case none

    /// Most urgent first. Mirrors `CHANNEL_STATE_PRECEDENCE` in channel-state.ts.
    static let precedence: [String] = [
        "delist_queued",
        "queued",
        "live",
        "unconfirmed",
        "failed",
        "sold",
        "ended",
        "prefilled",
        "none",
    ]

    /// The word the seller reads. Mirrors the WORDS tables on the web.
    var word: String {
        switch self {
        case .live: return "Live"
        case .unconfirmed: return "Recorded as listed, not confirmed"
        case .queued: return "Queued for your desktop"
        case .delistQueued: return "Ending from your browser"
        case .prefilled: return "Form filled, not confirmed live"
        case .failed: return "Needs you"
        case .ended: return "Ended"
        case .sold: return "Sold here"
        case .none: return ""
        }
    }

    /// A channel the item is already on, or on its way to, cannot be ticked
    /// again: the server would skip it (US-3367) and the count would lie.
    var blocksPush: Bool {
        switch self {
        case .live, .unconfirmed, .queued, .delistQueued: return true
        case .prefilled, .failed, .ended, .sold, .none: return false
        }
    }
}

/// The columns the derivation reads off a listing row. A structural subset so
/// `LocalListing` and a decoded edge row both fit.
struct ChannelRow: Equatable, Sendable {
    let id: String
    let platform: String
    let status: String
    let url: String?
    let delistRequested: Bool

    init(id: String, platform: String, status: String, url: String?, delistRequested: Bool = false) {
        self.id = id
        self.platform = platform
        self.status = status
        self.url = url
        self.delistRequested = delistRequested
    }
}

struct ChannelStatus: Equatable, Sendable {
    let state: ChannelState
    let rowId: String?
    let url: String?
    let queueItemId: String?
    let queueStatus: String?
}

enum ChannelStateDerivation {

    private static let pending: Set<String> = ["queued", "claimed"]
    private static let failed: Set<String> = ["failed", "expired"]

    /// The same precedence as the web, most urgent first: a delist in flight
    /// beats everything (the garment is gone and the listing may still be
    /// live), then a queued list, then the row's own status, then a failed job.
    static func derive(
        rows: [ChannelRow],
        queue: [ExtensionQueueService.QueueItem],
        platform: String
    ) -> ChannelStatus {
        let row = rows.first { $0.platform == platform }
        let mine = queue.filter { $0.platform == platform }
        let delist = newest(mine.filter { $0.kind == "delist" && pending.contains($0.status) })
        let list = newest(mine.filter { $0.kind == "list" })
        let url = row?.url.flatMap { $0.isEmpty ? nil : $0 }

        func status(_ state: ChannelState, queueItem: ExtensionQueueService.QueueItem? = nil) -> ChannelStatus {
            ChannelStatus(
                state: state,
                rowId: row?.id,
                url: url,
                queueItemId: queueItem?.id,
                queueStatus: queueItem?.status
            )
        }

        if let delist { return status(.delistQueued, queueItem: delist) }
        if let row, row.status == "ended", row.delistRequested { return status(.delistQueued) }
        if let list, pending.contains(list.status) { return status(.queued, queueItem: list) }
        if let row, row.status == "active" || row.status == "relisted" { return status(.live) }
        if let list, failed.contains(list.status) { return status(.failed, queueItem: list) }
        if let row, row.status == "sold" { return status(.sold) }
        if let row, row.status == "ended" { return status(.ended) }
        if let row, row.status == "draft" { return status(.prefilled) }
        return status(.none)
    }

    private static func newest(_ items: [ExtensionQueueService.QueueItem]) -> ExtensionQueueService.QueueItem? {
        items.max { $0.createdAt < $1.createdAt }
    }
}
