import XCTest
@testable import GradeThreadCore

/// US-1995 AC3: the Swift port asserted against the SHARED behavioural fixture,
/// so it cannot drift from the two JS copies.
///
/// The fixture is read from its ONE location in the repo,
/// `src/test/fixtures/title-sync-cases.json`, via `#filePath`. It is deliberately
/// NOT copied into the iOS tree: a second copy is exactly the drift this fixture
/// exists to prevent, and a copy would go stale silently while every suite stayed
/// green. The reverse hop already exists in this repo - the edge's
/// `flipdesk-reconciliation-shape_test.ts` reads
/// `ios/GradeThreadTests/Fixtures/reconciliation_queue.json` the same way.
///
/// This works because `swift test` compiles and runs in the same checkout, and
/// `actions/checkout@v4` gives the Linux job the whole repo, not just `ios/`.
final class TitleSyncFixtureTests: XCTestCase {

    // MARK: - Fixture shape

    private struct FixtureChange: Decodable {
        let field: String?
        let from: String?
        let to: String?

        var asFieldChange: TitleSync.FieldChange {
            TitleSync.FieldChange(field: field, from: from, to: to)
        }
    }

    private struct SyncCase: Decodable {
        let name: String
        let title: String
        let changes: [FixtureChange]
        let expected: String
    }

    private struct DiffCase: Decodable {
        let name: String
        let before: [String: String]
        let after: [String: String]
        let expected: [FixtureChange]
    }

    private struct Fixture: Decodable {
        let syncTitle: [SyncCase]
        let idempotent: [SyncCase]
        let changesFromItemDiff: [DiffCase]
    }

    /// `<repo>/src/test/fixtures/title-sync-cases.json`, walked up from
    /// `<repo>/ios/Packages/GradeThreadCore/Tests/GradeThreadCoreTests/<this file>`.
    private static var fixtureURL: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url = url.deletingLastPathComponent() }
        return url
            .appendingPathComponent("src")
            .appendingPathComponent("test")
            .appendingPathComponent("fixtures")
            .appendingPathComponent("title-sync-cases.json")
    }

    private func loadFixture() throws -> Fixture {
        let url = Self.fixtureURL
        // Fail loudly rather than skipping. A test that silently stops asserting
        // when the file moves is worse than no test: the port would be free to
        // drift with CI still green.
        guard FileManager.default.fileExists(atPath: url.path) else {
            XCTFail(
                "Shared title-sync fixture not found at \(url.path). "
                + "It must stay at src/test/fixtures/title-sync-cases.json - "
                + "do NOT copy it into ios/; fix this path instead."
            )
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    // MARK: - Cases

    func test_syncTitle_matchesSharedFixture() throws {
        let fixture = try loadFixture()
        XCTAssertFalse(fixture.syncTitle.isEmpty, "fixture carries no syncTitle cases")
        for testCase in fixture.syncTitle {
            let changes = testCase.changes.map { $0.asFieldChange }
            XCTAssertEqual(
                TitleSync.syncTitle(testCase.title, changes: changes),
                testCase.expected,
                "fixture case: \(testCase.name)"
            )
        }
    }

    /// Asserted by applying the changes TWICE, because that is the shape the bug
    /// takes in production: `changes` comes from a captured before-map, so a
    /// retried write or a stale local mirror replays the same {from, to} against a
    /// title that already holds the new value. A bare replace re-expands whenever
    /// the new value contains the old one - "L" -> "L/XL" becomes "L/XL/XL".
    func test_syncTitle_isIdempotent() throws {
        let fixture = try loadFixture()
        XCTAssertFalse(fixture.idempotent.isEmpty, "fixture carries no idempotent cases")
        for testCase in fixture.idempotent {
            let changes = testCase.changes.map { $0.asFieldChange }
            let once = TitleSync.syncTitle(testCase.title, changes: changes)
            XCTAssertEqual(once, testCase.expected, "fixture case: \(testCase.name) (first pass)")
            XCTAssertEqual(
                TitleSync.syncTitle(once, changes: changes),
                testCase.expected,
                "fixture case: \(testCase.name) (second pass)"
            )
        }
    }

    func test_changesFromItemDiff_matchesSharedFixture() throws {
        let fixture = try loadFixture()
        XCTAssertFalse(fixture.changesFromItemDiff.isEmpty, "fixture carries no diff cases")
        for testCase in fixture.changesFromItemDiff {
            let got = TitleSync.changesFromItemDiff(
                before: testCase.before.mapValues { Optional($0) },
                after: testCase.after.mapValues { Optional($0) }
            )
            XCTAssertEqual(
                got,
                testCase.expected.map { $0.asFieldChange },
                "fixture case: \(testCase.name)"
            )
        }
    }

    // MARK: - Port-local behaviour the fixture does not carry
    //
    // These mirror the hand-written halves of src/lib/__tests__/title-sync.test.ts
    // and services/edge-functions/src/tests/title-sync_test.ts. They stay here (not
    // in the shared fixture) for the same reason the JS suites keep them local:
    // they exercise the helpers directly rather than the syncTitle entry point.

    func test_substitution_boundariesAndCase() {
        XCTAssertEqual(
            TitleSync.applyTitleSubstitution("Nike Air Max L", from: "Nike", to: "Adidas"),
            "Adidas Air Max L"
        )
        XCTAssertEqual(
            TitleSync.applyTitleSubstitution("NIKE tee", from: "Nike", to: "Adidas"),
            "ADIDAS tee"
        )
        // Never inside another word.
        XCTAssertEqual(
            TitleSync.applyTitleSubstitution("Nikeish tee", from: "Nike", to: "Adidas"),
            "Nikeish tee"
        )
        XCTAssertEqual(
            TitleSync.applyTitleSubstitution("Hoodie XL", from: "L", to: "M"),
            "Hoodie XL"
        )
        XCTAssertEqual(
            TitleSync.applyTitleSubstitution("Dress Sz L", from: "L", to: "M"),
            "Dress Sz M"
        )
        // Empty / identical changes are no-ops, never a blanked title.
        XCTAssertEqual(
            TitleSync.applyTitleSubstitution("Nike Tee", from: "Nike", to: "nike"),
            "Nike Tee"
        )
        XCTAssertEqual(
            TitleSync.applyTitleSubstitution("Nike Tee", from: "", to: "Puma"),
            "Nike Tee"
        )
    }

    func test_trim_isWordBoundedAndDropsDanglingSeparators() {
        XCTAssertEqual(TitleSync.trimTitleToLimit("short title", limit: 80), "short title")
        XCTAssertEqual(
            TitleSync.trimTitleToLimit(String(repeating: "a", count: 40) + " bb", limit: 40),
            String(repeating: "a", count: 40)
        )
        // Whitespace runs collapse before measuring.
        XCTAssertEqual(TitleSync.trimTitleToLimit("  Nike   Tee  ", limit: 80), "Nike Tee")
        // A trailing separator left by the dropped word is stripped.
        XCTAssertEqual(TitleSync.trimTitleToLimit("Nike Tee - Blue", limit: 12), "Nike Tee")
    }

    func test_titleNeedsSync_detectsRealChangesOnly() {
        XCTAssertTrue(
            TitleSync.titleNeedsSync("Nike Tee M", changes: [.init(from: "Nike", to: "Adidas")])
        )
        XCTAssertFalse(
            TitleSync.titleNeedsSync("Nike Tee M", changes: [.init(from: "Puma", to: "Adidas")])
        )
    }
}
