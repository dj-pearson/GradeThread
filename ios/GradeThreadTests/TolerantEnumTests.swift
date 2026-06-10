import XCTest
@testable import GradeThread

/// US-793: `Tolerant<T>` decodes a known enum case or degrades to `.unknown`
/// instead of failing the whole decode — so a server-introduced value never
/// breaks an old app build.
final class TolerantEnumTests: XCTestCase {

    enum Sample: String, Codable, Equatable {
        case alpha
        case beta
    }

    struct Wrapper: Codable, Equatable {
        let status: Tolerant<Sample>
    }

    private func decode(_ json: String) throws -> Wrapper {
        try JSONDecoder().decode(Wrapper.self, from: Data(json.utf8))
    }

    func test_known_decodesToTypedCase() throws {
        let w = try decode(#"{"status":"alpha"}"#)
        XCTAssertEqual(w.status, .known(.alpha))
        XCTAssertEqual(w.status.value, .alpha)
        XCTAssertTrue(w.status == .alpha) // convenience equality
        XCTAssertEqual(w.status.rawValue, "alpha")
    }

    func test_unknown_degradesInsteadOfThrowing() throws {
        // A value this build doesn't know must NOT fail the decode.
        let w = try decode(#"{"status":"gamma_new_server_value"}"#)
        XCTAssertEqual(w.status, .unknown("gamma_new_server_value"))
        XCTAssertNil(w.status.value)
        XCTAssertEqual(w.status.rawValue, "gamma_new_server_value")
        XCTAssertFalse(w.status == .alpha)
    }

    func test_roundTrips_throughEncode() throws {
        for raw in ["beta", "totally_unknown"] {
            let w = try decode("{\"status\":\"\(raw)\"}")
            let data = try JSONEncoder().encode(w)
            let again = try JSONDecoder().decode(Wrapper.self, from: data)
            XCTAssertEqual(w, again)
            XCTAssertEqual(w.status.rawValue, raw)
        }
    }
}
