import XCTest
import SwiftData
@testable import GradeThread

/// US-1143: guards the offline-cache schema against silent, unversioned model
/// changes. SwiftData's `ModelContainer(for:)` throws on a migration it can't
/// infer, and our recovery "heals" that by deleting the user's cache — so a
/// model change that ships without a migration plan is data loss. These tests
/// force a conscious version-bump decision.
final class SchemaVersioningTests: XCTestCase {

    /// The set of `@Model` types in the current schema. Adding or removing a
    /// model is the highest-impact schema change; if this fails, you changed the
    /// model set without updating the version plan. Fix:
    ///   1. add `GradeThreadSchemaVN` + a `MigrationStage`,
    ///   2. repoint `GradeThreadSchema.current`,
    ///   3. update this expected set.
    func test_schemaEntities_matchExpectedModelSet() {
        let expected: Set<String> = [
            "LocalInventoryItem",
            "LocalItemPhoto",
            "LocalListing",
            "LocalSale",
            "LocalExpense",
            "LocalSource",
            "LocalSourcer",
            "LocalPendingMutation",
        ]
        let actual = Set(ModelStoreProvider.schema.entities.map(\.name))
        XCTAssertEqual(
            actual, expected,
            "Offline-cache model set changed. If intentional, bump the schema "
                + "version (add GradeThreadSchemaVN + a MigrationStage, repoint "
                + "GradeThreadSchema.current) and update this expected set."
        )
    }

    /// The migration plan must terminate at the version the app actually opens,
    /// so a new version can't be added without also appending it to the plan.
    func test_migrationPlan_endsAtCurrentVersion() {
        let planTail = GradeThreadMigrationPlan.schemas.last
        XCTAssertNotNil(planTail)
        XCTAssertEqual(
            planTail.map { ObjectIdentifier($0) },
            ObjectIdentifier(GradeThreadSchema.current),
            "GradeThreadSchema.current must be the last entry in "
                + "GradeThreadMigrationPlan.schemas — add the new version to the plan."
        )
    }

    /// With N versions there must be N-1 migration stages (one per hop). At V1
    /// that's zero; this turns into a real guard the moment a V2 is added.
    func test_migrationStages_matchVersionCount() {
        XCTAssertEqual(
            GradeThreadMigrationPlan.stages.count,
            GradeThreadMigrationPlan.schemas.count - 1,
            "Each schema version after the first needs exactly one MigrationStage."
        )
    }

    /// A fresh container built through the migration plan opens and round-trips a
    /// row — proves the plan is wired into `ModelStoreProvider` without crashing.
    func test_containerWithMigrationPlan_buildsAndRoundTrips() throws {
        let config = ModelConfiguration(
            schema: ModelStoreProvider.schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        let container = try ModelContainer(
            for: ModelStoreProvider.schema,
            migrationPlan: GradeThreadMigrationPlan.self,
            configurations: config
        )
        let context = ModelContext(container)
        context.insert(LocalSource(id: "s1", userId: "u1", name: "Goodwill"))
        try context.save()
        let rows = try ModelContext(container).fetch(FetchDescriptor<LocalSource>())
        XCTAssertEqual(rows.count, 1)
    }
}
