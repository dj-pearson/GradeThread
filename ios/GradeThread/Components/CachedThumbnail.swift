import SwiftUI
import ImageIO
import UIKit

/// US-635 — reusable, cached, downsampling async image used everywhere the app
/// shows a remote photo in a small frame (inventory rows, item-canvas strip,
/// grade report, photo manager, scout candidates). Replaces raw `AsyncImage`,
/// which (1) re-decoded the full-resolution JPEG into a 56pt cell and (2)
/// re-fetched on every cell reuse / scroll-back with no cache.
///
/// - Images are **downsampled at decode time** to the target point size via
///   `CGImageSourceCreateThumbnailAtIndex`, so a 4000px listing photo never
///   decodes full-res into a thumbnail.
/// - Results are **cached twice**: the decoded `UIImage` in an in-memory
///   `NSCache` (keyed by url+pixel size) so scroll-back is instant, and the raw
///   bytes in a disk-backed `URLCache` so a cold cell doesn't re-download.
/// - On failure it shows the caller's placeholder with a **tap-to-retry**
///   affordance instead of a permanently blank box.
struct CachedThumbnail<Placeholder: View>: View {
    let url: URL?
    /// Largest point dimension the image is displayed at; the loader targets
    /// `maxDimension * displayScale` pixels.
    var maxDimension: CGFloat
    var contentMode: ContentMode = .fill
    @ViewBuilder var placeholder: () -> Placeholder

    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var didFail = false
    /// Bumped by the retry button to re-run the load `.task`.
    @State private var retryToken = 0

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
                    .overlay {
                        if didFail {
                            Button {
                                didFail = false
                                retryToken += 1
                            } label: {
                                Image(systemName: "arrow.clockwise.circle.fill")
                                    .font(.title3)
                                    .foregroundStyle(.secondary)
                                    .padding(6)
                            }
                            .accessibilityLabel("Retry loading image")
                        }
                    }
            }
        }
        .task(id: taskKey) { await load() }
    }

    /// Re-runs the load when the URL or retry token changes.
    private var taskKey: String { "\(url?.absoluteString ?? "—")|\(retryToken)" }

    private func load() async {
        guard let url else {
            image = nil
            didFail = false
            return
        }
        let maxPixel = max(maxDimension, 1) * displayScale
        // Synchronous cache hit → no flash of placeholder on scroll-back.
        if let hit = ThumbnailLoader.shared.cached(url: url, maxPixel: maxPixel) {
            image = hit
            didFail = false
            return
        }
        do {
            let loaded = try await ThumbnailLoader.shared.image(for: url, maxPixel: maxPixel)
            // Guard against a recycled cell whose URL changed mid-load.
            guard !Task.isCancelled else { return }
            image = loaded
            didFail = false
        } catch {
            guard !Task.isCancelled else { return }
            didFail = true
        }
    }
}

/// Backing loader: in-memory decoded-image cache + disk-backed byte cache +
/// ImageIO downsampling.
final class ThumbnailLoader {
    static let shared = ThumbnailLoader()

    private let cache = NSCache<NSString, UIImage>()
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.urlCache = URLCache(
            memoryCapacity: 16 * 1024 * 1024,
            diskCapacity: 128 * 1024 * 1024
        )
        session = URLSession(configuration: config)
        cache.countLimit = 400
    }

    private func key(_ url: URL, _ maxPixel: CGFloat) -> NSString {
        "\(url.absoluteString)|\(Int(maxPixel))" as NSString
    }

    /// Synchronous lookup of an already-decoded image (NSCache is thread-safe).
    func cached(url: URL, maxPixel: CGFloat) -> UIImage? {
        cache.object(forKey: key(url, maxPixel))
    }

    func image(for url: URL, maxPixel: CGFloat) async throws -> UIImage {
        let cacheKey = key(url, maxPixel)
        if let hit = cache.object(forKey: cacheKey) { return hit }

        let (data, _) = try await session.data(from: url)
        // Downsample off the cooperative pool — never on the calling actor.
        let image = await Task.detached(priority: .utility) {
            ThumbnailLoader.downsample(data: data, maxPixel: maxPixel)
        }.value
        guard let image else { throw ThumbnailError.decodeFailed }
        cache.setObject(image, forKey: cacheKey)
        return image
    }

    /// Decodes only a thumbnail of `data` no larger than `maxPixel` on its
    /// longest edge — never the full-resolution bitmap.
    static func downsample(data: Data, maxPixel: CGFloat) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            return nil
        }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(maxPixel, 1),
        ] as CFDictionary
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }
}

enum ThumbnailError: Error {
    case decodeFailed
}
