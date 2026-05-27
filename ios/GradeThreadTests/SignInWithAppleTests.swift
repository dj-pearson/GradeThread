import XCTest
@testable import GradeThread

final class SignInWithAppleTests: XCTestCase {
    /// SHA-256 of "abc" verified against the well-known test vector. Confirms
    /// our hashed-nonce path matches what Apple expects on the request.
    func test_hashedNonce_matchesKnownVector() {
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        XCTAssertEqual(SignInWithAppleCoordinator.hashedNonce("abc"), expected)
    }

    func test_randomNonce_lengthAndCharset() {
        let nonce = SignInWithAppleCoordinator.randomNonce(length: 64)
        XCTAssertEqual(nonce.count, 64)
        let allowed: Set<Character> = Set(
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._"
        )
        for ch in nonce {
            XCTAssertTrue(allowed.contains(ch), "Unexpected nonce char: \(ch)")
        }
    }

    func test_randomNonce_returnsDistinctValues() {
        let a = SignInWithAppleCoordinator.randomNonce()
        let b = SignInWithAppleCoordinator.randomNonce()
        XCTAssertNotEqual(a, b)
    }
}
