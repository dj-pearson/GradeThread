import Foundation

/// US-2481: queue extension work from the phone, run it on the desktop.
///
/// Poshmark, Mercari, Grailed, Vinted and Facebook Marketplace have no write
/// API, so GradeThread reaches them from the seller's own logged-in browser —
/// see `vault/60-decisions/adr-no-server-side-marketplace-automation.md`. The
/// cost that decision accepts is that a seller sourcing at a thrift store with
/// only a phone cannot cross-list, and a delist waits for the laptop.
///
/// This is the part that softens it without paying the price the ADR refuses.
/// The phone records an INSTRUCTION — an item id, a platform, a locale — and
/// the desktop extension drains it the next time it opens. What the server
/// never records is a way in: no password, no session cookie. The edge rejects
/// a payload carrying one, and so does a CHECK constraint on the table.
///
/// THE ONE RULE FOR ANY UI BUILT ON THIS. A queued job is not a done job.
/// ``ExtensionQueueService/queuedNotice`` is the sentence to show, and it must
/// not be softened into something that reads like completion. For a delist in
/// particular, a seller who believes it was handled is a seller heading for a
/// double sale: a second buyer pays for an item they have already shipped.
@MainActor
public final class ExtensionQueueService {

    public static let shared = ExtensionQueueService()

    private let api: EdgeAPI

    public init(api: EdgeAPI = .shared) {
        self.api = api
    }

    /// The wording every client shows for queued work. Mirrors `QUEUED_NOTICE`
    /// in `src/hooks/use-extension-queue.ts` and `QUEUED_NOTICE` in the edge's
    /// `lib/extension-queue.ts` — one sentence, three surfaces, so no platform
    /// can invent a cheerier version of it.
    public static let queuedNotice =
        "This runs the next time you open your desktop browser with the "
        + "GradeThread extension installed. Nothing happens on the marketplace "
        + "until then."

    /// What the desktop extension can actually drain.
    ///
    /// `share` was here until US-2497 and is gone because nothing could ever run
    /// it: the Poshmark engagement pass needs a human at the browser to take the
    /// tab back when Poshmark asks for a check, which is the fourth thing its
    /// clickwrap promises. A phone cannot stand in for that. `QueueItem.kind`
    /// stays a `String` so a historical row still decodes.
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case list
        case delist
        /// US-9202 / US-3105: carry a FlipDesk edit to a listing already live on
        /// an extension channel. The values are read off the listing row at
        /// apply time, not sent from here, so a second edit before the first
        /// drains never delivers a stale number — the phone names WHICH fields
        /// changed and nothing else.
        case revise
        /// US-9203 / US-3105: copy a live extension-channel listing into a fresh
        /// one and end the old once the copy is up.
        case relist
    }

    public struct QueueItem: Codable, Identifiable, Sendable {
        public let id: String
        public let kind: String
        public let platform: String
        public let status: String
        public let source: String
        public let createdAt: String
        public let expiresAt: String
        public let result: QueueResult?

        enum CodingKeys: String, CodingKey {
            case id, kind, platform, status, source, result
            case createdAt = "created_at"
            case expiresAt = "expires_at"
        }
    }

    public struct QueueResult: Codable, Sendable {
        public let error: String?
        public let manual: Bool?
        public let expired: Bool?
    }

    public struct QueueSnapshot: Codable, Sendable {
        public let pending: [QueueItem]
        /// Work that expired undrained or failed when it ran. Separate from
        /// `pending` on purpose — rendering it as "still coming" is the silence
        /// this queue would otherwise reintroduce (US-2481 AC6).
        public let needsAttention: [QueueItem]
    }

    /// Thrown before a request that could only be refused.
    public enum ExtensionQueueError: LocalizedError, Equatable {
        case nothingToRevise

        public var errorDescription: String? {
            switch self {
            case .nothingToRevise:
                return String(localized: "Nothing has changed on this listing since it went live.")
            }
        }
    }

    private struct ReviseBody: Encodable {
        let kind: String
        let platform: String
        let listing_id: String
        let fields: [String]
        let source: String
    }

    private struct EnqueueBody: Encodable {
        let kind: String
        let platform: String
        let inventory_item_id: String?
        let listing_id: String?
        let payload: [String: String]
        let source: String
    }

    private struct EnqueueResponse: Decodable {
        let queued: QueueItem
        let notice: String?
    }

    private struct CancelResponse: Decodable {
        let cancelled: String
    }

    /// Queue one piece of extension work. The desktop does not have to be awake.
    ///
    /// `payload` is a plain string map by design: an instruction is an item id,
    /// a platform and at most a locale key. Widening it to `Any` is how a future
    /// caller ends up stuffing something in here that the edge then has to
    /// refuse.
    @discardableResult
    public func enqueue(
        kind: Kind,
        platform: String,
        inventoryItemId: String? = nil,
        listingId: String? = nil,
        payload: [String: String] = [:]
    ) async throws -> QueueItem {
        let body = EnqueueBody(
            kind: kind.rawValue,
            platform: platform,
            inventory_item_id: inventoryItemId,
            listing_id: listingId,
            payload: payload,
            source: "ios"
        )
        let response: EnqueueResponse = try await api.postJSON(
            "/api/flipdesk/extension-queue",
            body: body
        )
        return response.queued
    }

    /// What is still waiting, and what never ran.
    public func snapshot() async throws -> QueueSnapshot {
        try await api.getJSON("/api/flipdesk/extension-queue")
    }

    // ── US-3105: the two kinds the phone could not queue ────────────────────
    //
    // The server has accepted all four since US-9202/US-9203 and the extension
    // has run all four since then too. The phone's enum stopped at two, so a
    // seller who dropped a price in a shop had no way to get that price onto
    // their Poshmark listing until they were back at a desk — and the listing
    // sat there advertising the old one.

    /// Queue a field edit for a listing that is already live on an extension
    /// channel.
    ///
    /// `fields` names what changed. The route validates it against
    /// REVISABLE_FIELDS and refuses an empty list, so a caller with nothing to
    /// report must not call this rather than sending an empty array.
    @discardableResult
    public func enqueueRevise(
        listingId: String,
        platform: String,
        fields: [ReviseField]
    ) async throws -> QueueItem {
        guard !fields.isEmpty else {
            throw ExtensionQueueError.nothingToRevise
        }
        let body = ReviseBody(
            kind: Kind.revise.rawValue,
            platform: platform,
            listing_id: listingId,
            fields: fields.map(\.rawValue),
            source: "ios"
        )
        let response: EnqueueResponse = try await api.postJSON(
            "/api/flipdesk/extension-queue",
            body: body
        )
        return response.queued
    }

    /// Queue a relist: the server creates the copy's draft row now, and the
    /// desktop opens the old listing and follows its copy control.
    @discardableResult
    public func enqueueRelist(
        listingId: String,
        platform: String
    ) async throws -> QueueItem {
        try await enqueue(kind: .relist, platform: platform, listingId: listingId)
    }

    /// The fields a revise can name. Mirrors REVISABLE_FIELDS in
    /// `services/edge-functions/src/lib/pending-revises.ts`.
    public enum ReviseField: String, CaseIterable, Sendable {
        case price, title, description, photos
    }

    /// Remove a job the seller no longer wants run.
    public func cancel(id: String) async throws {
        let _: CancelResponse = try await api.deleteJSON(
            "/api/flipdesk/extension-queue/\(id)"
        )
    }
}
