import XCTest
@testable import GradeThread

/// US-694 — financial/account exports must be written with file protection into
/// a swept subdirectory and deleted after sharing. File protection itself isn't
/// enforced/queryable on the Simulator, so we assert the configured writing
/// options request the protected class and that the write/delete/sweep
/// lifecycle behaves.
final class SecureTempFileTests: XCTestCase {

    override func setUp() {
        super.setUp()
        SecureTempFile.sweep()
    }

    override func tearDown() {
        SecureTempFile.sweep()
        super.tearDown()
    }

    func test_writingOptions_requestProtectedClass() {
        XCTAssertTrue(
            SecureTempFile.writingOptions.contains(.completeFileProtectionUntilFirstUserAuthentication),
            "Exports must request file protection at rest")
        XCTAssertTrue(SecureTempFile.writingOptions.contains(.atomic))
    }

    func test_write_putsFileUnderExportsDir_andReadsBack() throws {
        let payload = Data("Date,Net\n2026-01-01,12.50".utf8)
        let url = try SecureTempFile.write(payload, filename: "report.csv")

        XCTAssertEqual(url.deletingLastPathComponent().lastPathComponent, "Exports")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual(try Data(contentsOf: url), payload)
    }

    func test_delete_removesTheFile() throws {
        let url = try SecureTempFile.write(Data("x".utf8), filename: "a.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        SecureTempFile.delete(url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func test_sweep_clearsAllExports() throws {
        _ = try SecureTempFile.write(Data("1".utf8), filename: "one.csv")
        _ = try SecureTempFile.write(Data("2".utf8), filename: "two.json")
        SecureTempFile.sweep()
        let remaining = try FileManager.default.contentsOfDirectory(
            at: SecureTempFile.directory, includingPropertiesForKeys: nil)
        XCTAssertTrue(remaining.isEmpty)
    }
}
