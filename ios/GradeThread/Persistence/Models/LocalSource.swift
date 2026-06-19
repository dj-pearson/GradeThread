import Foundation
import SwiftData

/// Local mirror of `sources` (where an item was acquired — Goodwill, estate
/// sale, wholesale, etc.).
@Model
final class LocalSource {
    // US-985: `name` backs the `@Query(sort: \LocalSource.name)` the intake +
    // search pickers use. `id` is covered by its `@Attribute(.unique)` constraint.
    #Index<LocalSource>([\.name])

    @Attribute(.unique) var id: String
    var userId: String

    var name: String
    var sourceType: String       // FlipdeskSourceType enum string
    var notes: String?

    var createdAt: Date
    var updatedAt: Date

    init(
        id: String,
        userId: String,
        name: String,
        sourceType: String = "other",
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.userId = userId
        self.name = name
        self.sourceType = sourceType
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
