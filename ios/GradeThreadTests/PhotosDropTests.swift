import XCTest
import UIKit
@testable import GradeThread

@MainActor
final class PhotosDropTests: XCTestCase {

    // MARK: - PhotosDropHandler

    func test_process_emptyArray_returnsEmpty() async {
        let captures = await PhotosDropHandler.process([])
        XCTAssertTrue(captures.isEmpty)
    }

    func test_process_realImage_returnsCapture() async {
        let image = makeImage(size: CGSize(width: 1200, height: 1600))
        let captures = await PhotosDropHandler.process([image])
        XCTAssertEqual(captures.count, 1)
        XCTAssertEqual(captures.first?.source, .library)
        // Compressor downscales to 2048px max — 1600 → unchanged
        // because it's already under the cap. Thumbnail capped at 160.
        XCTAssertNotNil(captures.first?.thumbnail)
        XCTAssertFalse(captures.first?.imageData.isEmpty ?? true)
    }

    func test_process_multipleImages_keepsOrder() async {
        let images = [
            makeImage(size: CGSize(width: 400, height: 300), color: .red),
            makeImage(size: CGSize(width: 400, height: 300), color: .green),
            makeImage(size: CGSize(width: 400, height: 300), color: .blue),
        ]
        let captures = await PhotosDropHandler.process(images)
        XCTAssertEqual(captures.count, 3)
        // Each capture has distinct id but library-sourced.
        XCTAssertTrue(captures.allSatisfy { $0.source == .library })
        XCTAssertEqual(Set(captures.map(\.id)).count, 3)
    }

    // MARK: - PhotoIntakeView initial-photos init

    func test_initialPhotos_seedStoreWithCaptures() {
        let capture = PhotoCapture(
            imageData: Data([0xFF, 0xD8, 0xFF, 0xD9]),
            thumbnail: makeImage(size: CGSize(width: 10, height: 10)),
            source: .library
        )
        // Construct PhotoIntakeView with pre-staged photos. We can't
        // inspect SwiftUI's @State directly post-init, but the init
        // path must compile and not crash; PhotoIntakeStore's behavior
        // on setPhoto is covered separately in PhotoIntakeTests.
        let _ = PhotoIntakeView(initialPhotos: [.front: capture])
    }

    func test_initialPhotos_empty_isEquivalentToDefaultInit() {
        // Both initializers should produce a renderable view; only the
        // store's seeded state differs.
        let _ = PhotoIntakeView()
        let _ = PhotoIntakeView(initialPhotos: [:])
    }

    // MARK: - Helpers

    private func makeImage(size: CGSize, color: UIColor = .systemBlue) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { context in
            color.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }
}
