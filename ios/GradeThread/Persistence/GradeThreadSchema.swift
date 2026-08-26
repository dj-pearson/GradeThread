import Foundation
import SwiftData

/// Versioned schema for the offline cache (US-1143).
///
/// Before this, `ModelStoreProvider` opened a single, unversioned `Schema`. The
/// moment a shipped `@Model` gained, dropped, or renamed a property, the next
/// launch would hit SwiftData's implicit lightweight migration with no plan —
/// and any change it can't infer (a rename, a type change, a new uniqueness
/// constraint) throws from `ModelContainer(for:)`, which our recovery then
/// "heals" by *deleting the user's cache*. That's data loss dressed up as
/// resilience.
///
/// A `VersionedSchema` + `SchemaMigrationPlan` make migrations explicit and
/// reviewable. Today there is exactly one version; the value is the scaffold:
/// the NEXT model change adds `GradeThreadSchemaV2` and a `MigrationStage` here.
///
/// ⚠️ DUPLICATE-CHECKSUM TRAP — read before adding a version (US-1249 regression):
/// A `VersionedSchema`'s `models` list resolves to the *live* `@Model` classes.
/// If you add `GradeThreadSchemaV2` whose `models` reference the SAME live
/// classes as V1 (i.e. you changed a model in place and just listed it again),
/// V1 and V2 hash to the IDENTICAL NSManagedObjectModel checksum, and SwiftData
/// aborts launch on EVERY device with:
///     *** NSInvalidArgumentException: 'Duplicate version checksums detected.'
/// (US-1249 did exactly this — added `hasLocalChanges` to the live LocalListing/
/// LocalSale and declared a V2 that re-listed the same classes → launch crash.)
///
/// To add a REAL new version you must capture the OLD shape as a distinct
/// snapshot so the two versions have different checksums:
///   1. Snapshot the prior shape: copy the changed `@Model` types into the V1
///      `VersionedSchema` enum as nested types frozen at their old fields (only
///      the models that actually changed need snapshotting). The CURRENT version
///      keeps referencing the live classes.
///   2. Append a `MigrationStage` (`.lightweight` for additive/optional changes,
///      `.custom` for renames/transforms) to `GradeThreadMigrationPlan.stages`.
///   3. Point `GradeThreadSchema.current` at the new version.
///   4. Update `SchemaVersioningTests` (the guard test flags the drift).
/// Pre-production there are no deployed stores, so a model change can also just
/// ride the single current version (a fresh install creates it directly); only
/// once builds are in the wild does a version bump + snapshot earn its keep.

/// The current shipped schema. The model types live in `Persistence/Models/`; a
/// `VersionedSchema` only needs to *reference* them, not nest them. This single
/// version describes the cache's CURRENT shape (including US-1249's additive
/// `hasLocalChanges` flags on LocalListing/LocalSale). It is intentionally the
/// ONLY version: V1 and a would-be V2 referencing these same live classes hash
/// identically and crash launch with "Duplicate version checksums" (see the trap
/// note above), and pre-production there is no deployed store to migrate from.
enum GradeThreadSchemaV1: VersionedSchema {
    static var versionIdentifier = Schema.Version(1, 0, 0)

    static var models: [any PersistentModel.Type] {
        [
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalExpense.self,
            LocalSource.self,
            LocalSourcer.self,
            LocalPendingMutation.self,
        ]
    }
}

/// Ordered migration plan. Each schema version after the first appends one stage
/// describing how to get there from the prior version. With a single version
/// there are zero stages — the initial state, and what shipped green before the
/// US-1249 duplicate-checksum regression.
enum GradeThreadMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] {
        [GradeThreadSchemaV1.self]
    }

    static var stages: [MigrationStage] {
        []
    }
}

enum GradeThreadSchema {
    /// The version the app currently opens. Bump this (and add a migration
    /// stage + an OLD-shape snapshot — see the duplicate-checksum trap above)
    /// when introducing a new `GradeThreadSchemaVN`.
    static let current: any VersionedSchema.Type = GradeThreadSchemaV1.self
}
