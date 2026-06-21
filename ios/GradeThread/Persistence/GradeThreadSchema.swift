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
/// the NEXT model change adds `GradeThreadSchemaV2` and a `MigrationStage`
/// (lightweight or custom) here, so destructive recovery stays the genuine last
/// resort instead of the default path.
///
/// ⚠️ When you change ANY `@Model` in `Persistence/Models/`:
///   1. Add a new `GradeThreadSchemaVN` capturing the new shape.
///   2. Append a `MigrationStage` (`.lightweight` for additive/optional changes,
///      `.custom` for renames/transforms) to `GradeThreadMigrationPlan.stages`.
///   3. Point `GradeThreadSchema.current` at the new version.
///   4. Update the recorded fingerprint in `SchemaVersioningTests` (the guard
///      test fails until you do — that failure is the reminder to do 1–3).

/// The initial shipped schema. The model types live in `Persistence/Models/`;
/// a `VersionedSchema` only needs to *reference* them, not nest them.
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
            LocalPendingMutation.self,
        ]
    }
}

/// Ordered migration plan. With a single version the stage list is empty; each
/// future schema version appends one stage describing how to get there from the
/// prior version.
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
    /// stage) when introducing a new `GradeThreadSchemaVN`.
    static let current: any VersionedSchema.Type = GradeThreadSchemaV1.self
}
