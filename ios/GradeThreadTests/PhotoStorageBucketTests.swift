import XCTest
@testable import GradeThread

/// US-979: sensitive photos (PII / grading-label close-ups) must never land in
/// the PUBLIC `item-photos` bucket, and signed URLs for the private bucket must
/// expire within 15 minutes.
final class PhotoStorageBucketTests: XCTestCase {

    /// The slots whose imagery can carry PII or grading-label content. Declared
    /// here independently of the production set so a regression that drops one
    /// from `PhotoStorageBucket.sensitiveServerTypes` is caught.
    private let sensitiveSlots: Set<PhotoSlotType> = [.tag, .tag2, .certificate]

    // MARK: - AC3: each PhotoSlotType maps to its expected bucket

    func test_everySlot_mapsToExpectedBucket_andSensitiveNeverPublic() {
        for slot in PhotoSlotType.allCases {
            let bucket = slot.storageBucket
            if sensitiveSlots.contains(slot) {
                XCTAssertTrue(
                    slot.isSensitive,
                    "\(slot) carries PII/grading-label content and must be flagged sensitive"
                )
                XCTAssertEqual(
                    bucket,
                    PhotoStorageBucket.privateBucket,
                    "\(slot) is sensitive and must upload to the PRIVATE bucket"
                )
                XCTAssertNotEqual(
                    bucket,
                    PhotoStorageBucket.publicBucket,
                    "\(slot) is sensitive and must NEVER map to the public bucket"
                )
            } else {
                XCTAssertFalse(slot.isSensitive, "\(slot) should not be flagged sensitive")
                XCTAssertEqual(
                    bucket,
                    PhotoStorageBucket.publicBucket,
                    "\(slot) is listing imagery and should use the public bucket"
                )
            }
        }
    }

    func test_noSensitiveServerType_resolvesToPublicBucket() {
        for serverType in PhotoStorageBucket.sensitiveServerTypes {
            XCTAssertTrue(PhotoStorageBucket.isSensitive(serverType: serverType))
            XCTAssertEqual(
                PhotoStorageBucket.bucket(forServerType: serverType),
                PhotoStorageBucket.privateBucket,
                "\(serverType) is sensitive and must resolve to the private bucket"
            )
        }
    }

    func test_serverTypeMapping_matchesSlotSensitivity() {
        // The slot-level and server-string-level views of sensitivity must agree.
        for slot in PhotoSlotType.allCases {
            XCTAssertEqual(
                slot.isSensitive,
                PhotoStorageBucket.isSensitive(serverType: slot.serverPhotoType),
                "slot \(slot) and server type \(slot.serverPhotoType) disagree on sensitivity"
            )
        }
    }

    func test_buckets_areDistinctAndNamed() {
        XCTAssertEqual(PhotoStorageBucket.publicBucket, "item-photos")
        XCTAssertEqual(PhotoStorageBucket.privateBucket, "submission-images")
        XCTAssertNotEqual(PhotoStorageBucket.publicBucket, PhotoStorageBucket.privateBucket)
    }

    // MARK: - AC4: signed URLs expire within 15 minutes

    func test_defaultTTL_isWithinFifteenMinutes() async {
        let provider = PhotoSignedURLProvider()
        let ttl = await provider.requestedTTLSeconds
        XCTAssertEqual(ttl, PhotoStorageBucket.signedURLTTLSeconds)
        XCTAssertLessThanOrEqual(ttl, 900, "signed URLs must expire within 15 minutes")
    }

    func test_ttl_isHardCappedAtFifteenMinutes() async {
        // Even if a caller asks for an hour, the provider clamps to ≤ 900s.
        let provider = PhotoSignedURLProvider(ttlSeconds: 3600)
        let ttl = await provider.requestedTTLSeconds
        XCTAssertEqual(ttl, 900)
        XCTAssertLessThanOrEqual(ttl, 900)
    }

    func test_signRequest_buildsSignEndpoint_andEncodesBoundedTTL() throws {
        let base = URL(string: "https://api.gradethread.com")!
        let request = try XCTUnwrap(
            PhotoSignedURLProvider.signRequest(
                base: base,
                bucket: PhotoStorageBucket.privateBucket,
                path: "user/item/tag_123.jpg",
                token: "tok-abc",
                ttl: PhotoStorageBucket.signedURLTTLSeconds
            )
        )
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://api.gradethread.com/storage/v1/object/sign/submission-images/user/item/tag_123.jpg"
        )
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-abc")

        let body = try XCTUnwrap(request.httpBody)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        let expiresIn = try XCTUnwrap(json?["expiresIn"] as? Int)
        XCTAssertEqual(expiresIn, PhotoStorageBucket.signedURLTTLSeconds)
        XCTAssertLessThanOrEqual(expiresIn, 900)
    }

    func test_resolve_buildsFullSignedURLFromRelativePath() {
        let base = URL(string: "https://api.gradethread.com")!
        let resolved = PhotoSignedURLProvider.resolve(
            base: base,
            signedURL: "/object/sign/submission-images/u/i/tag_1.jpg?token=ey.signed"
        )
        XCTAssertEqual(
            resolved?.absoluteString,
            "https://api.gradethread.com/storage/v1/object/sign/submission-images/u/i/tag_1.jpg?token=ey.signed"
        )
    }
}
