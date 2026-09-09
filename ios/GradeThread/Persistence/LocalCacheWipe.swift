import Foundation
import SwiftData

/// US-3224 — the one list of what a sign-out and a workspace switch erase from
/// this device, and the one way to erase it.
///
/// Both wipes used to be a straight-line `do { try ctx.delete(model: A.self);
/// try ctx.delete(model: B.self); ... try ctx.save() } catch { }` with an empty
/// catch. Three things were wrong with that:
///
///  1. **One throw skipped the rest.** A failure deleting the fourth model meant
///     the fifth through tenth were never even attempted. On sign-out that
///     leaves the previous account's rows on the device.
///  2. **The catch was silent**, and its comment said the next pull corrects
///     the view. That was true when every model was synced. `LocalProspectResult`
///     (US-3100) and `LocalMileageTrip` (US-3014) are local-only — nothing
///     re-pulls them, so nothing corrects them. A failed wipe hands the next
///     account someone else's sourcing log and business drives, silently.
///  3. **The list was hand-maintained** next to a schema that already had one.
///     US-3100 is what that costs: `LocalSourcer` was registered in the schema
///     and wiped by neither path, so a workspace switch left the previous
///     workspace's roster of sourcers readable.
///
/// The deleters below are checked against `GradeThreadSchemaV1.models` by
/// `ios/Scripts/check-cache-wipe.py`, so a new `@Model` cannot be added to the
/// cache without also being added here.
enum LocalCacheWipe {

    /// Every model in the cache, newest-registered last. Each entry is named so
    /// a partial failure can say WHICH model survived.
    ///
    /// Kept as closures rather than a `[any PersistentModel.Type]` on purpose:
    /// `ctx.delete(model:)` is generic over the concrete type, and spelling each
    /// call out is what lets the guard script match this list to the schema's by
    /// name.
    private static let deleters: [(name: String, delete: (ModelContext) throws -> Void)] = [
        ("LocalInventoryItem", { try $0.delete(model: LocalInventoryItem.self) }),
        ("LocalItemPhoto", { try $0.delete(model: LocalItemPhoto.self) }),
        ("LocalListing", { try $0.delete(model: LocalListing.self) }),
        ("LocalSale", { try $0.delete(model: LocalSale.self) }),
        ("LocalExpense", { try $0.delete(model: LocalExpense.self) }),
        ("LocalSource", { try $0.delete(model: LocalSource.self) }),
        ("LocalSourcer", { try $0.delete(model: LocalSourcer.self) }),
        ("LocalPendingMutation", { try $0.delete(model: LocalPendingMutation.self) }),
        ("LocalProspectResult", { try $0.delete(model: LocalProspectResult.self) }),
        ("LocalMileageTrip", { try $0.delete(model: LocalMileageTrip.self) }),
    ]

    /// Kept when the SAME owner moves between their own workspaces. The queue
    /// holds their unsent edits; dropping it would discard work they made
    /// offline. Sign-out clears it, because the next account must not be able to
    /// flush the previous one's writes.
    private static let keptOnWorkspaceSwitch: Set<String> = ["LocalPendingMutation"]

    /// Models with no server copy. Nothing re-pulls these, so a failure to
    /// delete one is not self-healing and is reported louder than the rest.
    private static let localOnly: Set<String> = ["LocalProspectResult", "LocalMileageTrip"]

    /// Sign-out: everything, queue included.
    @discardableResult
    static func signOut(from context: ModelContext) -> Bool {
        perform(deleters, in: context, operation: "clearAllLocalDataOnSignOut")
    }

    /// Workspace switch: everything the new workspace must not see, keeping the
    /// owner's own unsent edits.
    @discardableResult
    static func workspaceSwitch(from context: ModelContext) -> Bool {
        perform(
            deleters.filter { !keptOnWorkspaceSwitch.contains($0.name) },
            in: context,
            operation: "clearLocalTenantCache"
        )
    }

    /// Deletes each model INDEPENDENTLY so one failure can't skip the models
    /// after it, then saves. Returns whether everything went. Failures are
    /// recorded through ``PersistenceHealth`` — the same channel every other
    /// local write failure uses (US-1142) — rather than swallowed.
    private static func perform(
        _ models: [(name: String, delete: (ModelContext) throws -> Void)],
        in context: ModelContext,
        operation: String
    ) -> Bool {
        var survivors: [String] = []
        for model in models {
            do {
                try model.delete(context)
            } catch {
                survivors.append(model.name)
                PersistenceHealth.recordSaveFailure(
                    operation: "\(operation)/\(model.name)",
                    error: error
                )
            }
        }
        let saved = context.saveOrLog(operation)

        // A local-only model that survived is data with no server copy and no
        // correcting pull: it stays on the device, visible to whoever signs in
        // next. Worth its own breadcrumb, separate from the delete that failed.
        let strandedLocalOnly = survivors.filter { localOnly.contains($0) }
        if !strandedLocalOnly.isEmpty || (!saved && models.contains { localOnly.contains($0.name) }) {
            Telemetry.backgroundBreadcrumb(
                "local-only rows survived \(operation): \(strandedLocalOnly.isEmpty ? "save failed" : strandedLocalOnly.joined(separator: ", "))",
                category: "persistence"
            )
        }
        return survivors.isEmpty && saved
    }
}
