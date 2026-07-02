import Foundation
import SwiftData

/// Queued offline write. The SyncEngine drains the queue on connectivity
/// restoration and on every foreground sync pass.
///
/// `kind` is the discriminator; `payload` is the JSON-encoded body for that
/// kind. We store it as `Data` rather than `Codable` so SwiftData doesn't
/// have to model every payload shape — the typed roundtrip happens in the
/// concrete `MutationPayload` value the engine constructs from each kind.
@Model
final class LocalPendingMutation {
    // US-985: `createdAt` backs the FIFO drain order
    // (`sortBy: [SortDescriptor(\.createdAt)]` in SyncEngine.snapshotMutations).
    // `id` is covered by its `@Attribute(.unique)` constraint.
    #Index<LocalPendingMutation>([\.createdAt])

    @Attribute(.unique) var id: String

    /// One of ``MutationKind``'s raw values. String-backed to keep the
    /// SwiftData model storage stable across enum additions.
    var kind: String

    /// JSON-encoded payload specific to `kind`.
    var payload: Data

    /// Server-side row ID this mutation targets, when applicable. Lets us
    /// dedupe an edit on top of an in-flight create.
    var targetId: String?

    var retryCount: Int
    var lastError: String?
    var lastAttemptAt: Date?
    var createdAt: Date

    init(
        id: String = UUID().uuidString,
        kind: MutationKind,
        payload: Data,
        targetId: String? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.kind = kind.rawValue
        self.payload = payload
        self.targetId = targetId
        self.retryCount = 0
        self.createdAt = createdAt
    }

    var kindEnum: MutationKind? {
        MutationKind(rawValue: kind)
    }
}

/// The set of mutations the offline queue understands. Adding a new kind
/// is a forward-compatible change as long as the JSON payload is
/// versionable.
enum MutationKind: String, Codable, CaseIterable {
    case createInventoryItem
    case updateInventoryItem
    case deleteInventoryItem
    case uploadPhoto
    case deletePhoto
    case createListing
    case createSale
    // US-982: operating expenses (`flipdesk_expenses`) join the offline queue.
    case createExpense
    case deleteExpense
    // US-1508: a Save & Sync eBay revise that couldn't run offline — queued so the
    // reconnect flush re-pushes it to the live listing (after the item update lands).
    case reviseListing
}
