import XCTest
import SwiftData
@testable import GradeThread

/// US-987: a corrupt SwiftData store must recover (delete + recreate, then fall
/// back to in-memory) instead of `fatalError`-ing the app into a permanent
/// relaunch loop. These tests exercise `ModelStoreProvider.load` against a
/// throwaway store URL.
final class ModelStoreRecoveryTests: XCTestCase {

    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appending(path: "ModelStoreRecoveryTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir, withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    private func storeURL() -> URL {
        tempDir.appending(path: "GradeThread.store")
    }

    // MARK: - AC #4: normal launch is unaffected

    func test_normalLaunch_loadsOnDisk_noReset() throws {
        let outcome = ModelStoreProvider.load(storeURL: storeURL())

        XCTAssertFalse(outcome.didResetStore)
        XCTAssertFalse(outcome.isInMemoryFallback)
        // The container is usable: a freshly inserted row reads back.
        try assertContainerUsable(outcome.container)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: storeURL().path),
            "a normal launch should create the on-disk store"
        )
    }

    // MARK: - AC #1 + #3: corrupt store recovers into an empty cache, not a crash

    func test_corruptStore_recoversToEmptyOnDiskCache() throws {
        // Write garbage to the store path so SwiftData can't open it.
        let url = storeURL()
        try Data("this is not a sqlite database".utf8).write(to: url)

        let outcome = ModelStoreProvider.load(storeURL: url)

        // Recovered, did not crash, and stayed on disk (in-memory fallback not
        // needed — the directory is writable).
        XCTAssertTrue(outcome.didResetStore, "a corrupt store should report a reset")
        XCTAssertFalse(outcome.isInMemoryFallback)
        // The recovered cache is empty + usable; a sync would repopulate it.
        try XCTAssertEqual(rowCount(outcome.container), 0)
        try assertContainerUsable(outcome.container)
    }

    // MARK: - destroyStoreFiles clears the sidecar files too

    func test_destroyStoreFiles_removesStoreAndSidecars() throws {
        let url = storeURL()
        let name = url.lastPathComponent
        let siblings = ["", "-wal", "-shm"].map {
            tempDir.appending(path: name + $0)
        }
        for sibling in siblings {
            try Data("x".utf8).write(to: sibling)
            XCTAssertTrue(FileManager.default.fileExists(atPath: sibling.path))
        }

        ModelStoreProvider.destroyStoreFiles(at: url)

        for sibling in siblings {
            XCTAssertFalse(
                FileManager.default.fileExists(atPath: sibling.path),
                "\(sibling.lastPathComponent) should be deleted"
            )
        }
    }

    // MARK: - Helpers

    /// Inserts a row and reads it back so a recovered/normal container is proven
    /// to actually accept writes.
    private func assertContainerUsable(
        _ container: ModelContainer,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let context = ModelContext(container)
        context.insert(LocalSource(id: UUID().uuidString, userId: "u1", name: "Goodwill"))
        try context.save()
        let count = try context.fetchCount(FetchDescriptor<LocalSource>())
        XCTAssertGreaterThanOrEqual(count, 1, file: file, line: line)
    }

    private func rowCount(_ container: ModelContainer) throws -> Int {
        let context = ModelContext(container)
        return try context.fetchCount(FetchDescriptor<LocalSource>())
    }
}
