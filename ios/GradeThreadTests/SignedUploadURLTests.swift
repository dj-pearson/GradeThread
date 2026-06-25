import XCTest
@testable import GradeThread

/// US-1219: the background photo upload must NOT persist a long-lived bearer JWT
/// into the background-session task DB on disk. It mints a short-TTL signed
/// upload URL (authenticated, over an ephemeral session) and hands the
/// background session a request whose token lives only in the query string.
final class SignedUploadURLTests: XCTestCase {

    // MARK: - StorageURL endpoint shape

    func test_uploadSign_buildsUploadSignEndpoint() {
        let base = URL(string: "https://api.gradethread.com")!
        let url = StorageURL.uploadSign(base: base, bucket: "item-photos", path: "u/i/front_1.jpg")
        XCTAssertEqual(
            url?.absoluteString,
            "https://api.gradethread.com/storage/v1/object/upload/sign/item-photos/u/i/front_1.jpg"
        )
    }

    func test_uploadSign_nilBase_returnsNil() {
        XCTAssertNil(StorageURL.uploadSign(base: nil, bucket: "item-photos", path: "x"))
    }

    // MARK: - Mint request (the only place a bearer token appears)

    func test_mintRequest_postsToUploadSign_withBearerOnTheMintOnly() throws {
        let base = URL(string: "https://api.gradethread.com")!
        let request = try XCTUnwrap(
            SignedUploadURLProvider.mintRequest(
                base: base, bucket: "item-photos", path: "u/i/front_1.jpg", token: "tok-abc"
            )
        )
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://api.gradethread.com/storage/v1/object/upload/sign/item-photos/u/i/front_1.jpg"
        )
        XCTAssertEqual(request.httpMethod, "POST")
        // The mint is sent over an ephemeral session that is never persisted, so
        // a bearer here is fine — that's the whole point of moving it off the
        // background request.
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-abc")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-upsert"), "true")
        // No image bytes ride along on the mint.
        XCTAssertNil(request.httpBody)
    }

    func test_resolve_buildsFullUploadURLFromRelativePath() {
        let base = URL(string: "https://api.gradethread.com")!
        let resolved = SignedUploadURLProvider.resolve(
            base: base,
            signedURL: "/object/upload/sign/item-photos/u/i/front_1.jpg?token=ey.signed"
        )
        XCTAssertEqual(
            resolved?.absoluteString,
            "https://api.gradethread.com/storage/v1/object/upload/sign/item-photos/u/i/front_1.jpg?token=ey.signed"
        )
    }

    // MARK: - Background request carries NO long-lived credential (the invariant)

    func test_backgroundUploadRequest_hasNoAuthorizationHeader() {
        let signed = URL(string: "https://api.gradethread.com/storage/v1/object/upload/sign/item-photos/u/i/front_1.jpg?token=ey.signed")!
        let request = PhotoUploadService.backgroundUploadRequest(signedURL: signed)
        // The whole point of US-1219: nothing here is serialized to the
        // background-transfer DB except a single-object, short-TTL token in the
        // URL itself.
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-upsert"), "true")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
        // The authorizing token rides in the query string, not a persisted header.
        XCTAssertTrue(request.url?.query?.contains("token=") ?? false)
    }
}
