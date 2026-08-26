import Foundation
import SwiftData

/// Local mirror of `sourcers` (US-2886): the workspace roster of PEOPLE who
/// source inventory.
///
/// `inventory_items.sourced_by` is still a NAME string on every platform — this
/// table only decides which names the picker is allowed to offer. The workspace
/// owner and every workspace member are added to it by the 00672 triggers, so
/// the roster fills itself; everyone else (a spouse, a picker, "Joint") is added
/// by hand from the picker or from the web Sources page.
@Model
final class LocalSourcer {
    /// `name` backs the `@Query(sort: \LocalSourcer.name)` the pickers use.
    /// `id` is covered by its `@Attribute(.unique)` constraint.
    #Index<LocalSourcer>([\.name])

    @Attribute(.unique) var id: String
    var userId: String

    var name: String

    /// The workspace user this entry IS, when it is one. `nil` for a person who
    /// is not a user of the workspace.
    var memberUserId: String?

    /// When set, the entry is archived — hidden from the pickers while every
    /// historical `sourced_by` string stays exactly as it was. `nil` = active.
    var archivedAt: Date?

    var createdAt: Date
    var updatedAt: Date

    init(
        id: String,
        userId: String,
        name: String,
        memberUserId: String? = nil,
        archivedAt: Date? = nil,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.userId = userId
        self.name = name
        self.memberUserId = memberUserId
        self.archivedAt = archivedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Convenience flag for the picker filters.
    var isArchived: Bool { archivedAt != nil }
}
