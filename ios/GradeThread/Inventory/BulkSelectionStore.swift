import Foundation
import Observation

/// Multi-select state for the inventory list. `isEditing` flips on a
/// per-row checkbox column; `selected` holds the inventory_item ids the
/// user has ticked. Both are reset when editing turns off so a stray
/// long-press doesn't leak selection into the next session.
@MainActor
@Observable
public final class BulkSelectionStore {
    public var isEditing: Bool = false
    public var selected: Set<String> = []

    public init() {}

    public func toggleEditing() {
        isEditing.toggle()
        if !isEditing { selected.removeAll() }
    }

    public func clear() {
        selected.removeAll()
    }

    public var count: Int { selected.count }
    public var isEmpty: Bool { selected.isEmpty }

    public func contains(_ id: String) -> Bool {
        selected.contains(id)
    }

    public func toggle(_ id: String) {
        if selected.contains(id) {
            selected.remove(id)
        } else {
            selected.insert(id)
        }
    }
}
