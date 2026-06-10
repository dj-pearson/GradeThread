import CoreGraphics
import Foundation
import ImageIO
import UIKit

/// JPEG compression pipeline shared by the camera flow (US-173) and the
/// library-import flow (US-174). Target: 2048px max long edge, JPEG
/// quality 0.8, EXIF stripped except orientation — matches what the web
/// PhotoUploader does on the client.
public enum PhotoCompressor {

    public struct Output {
        public let imageData: Data       // Compressed JPEG, ready for upload
        public let thumbnail: UIImage    // Small UIImage for slot strip preview
    }

    /// Default compression budget. Tweak via the explicit params on
    /// ``compress(_:maxLongEdge:quality:)`` for one-off needs.
    public static let defaultMaxLongEdge: CGFloat = 2048
    public static let defaultJPEGQuality: CGFloat = 0.8
    public static let defaultThumbnailLongEdge: CGFloat = 160

    /// Resize + JPEG-encode `image` per the project's defaults. Returns
    /// nil only when the underlying CGImage backing is missing (image
    /// constructed from a CIImage with no rendered output, etc.).
    public static func compress(
        _ image: UIImage,
        maxLongEdge: CGFloat = defaultMaxLongEdge,
        quality: CGFloat = defaultJPEGQuality
    ) -> Output? {
        // Bake orientation to `.up` BEFORE encoding so the stored pixels are
        // upright. Camera/library UIImages carry an `imageOrientation` flag with
        // pixels in the sensor's native orientation; consumers that ignore EXIF
        // (eBay's image pipeline does) then render them sideways/upside-down.
        let upright = normalizedUp(image)
        let resized = resize(upright, maxLongEdge: maxLongEdge)
        guard let data = resized.jpegData(compressionQuality: quality) else { return nil }
        let thumb = resize(upright, maxLongEdge: defaultThumbnailLongEdge)
        return Output(imageData: data, thumbnail: thumb)
    }

    /// Off-main single compress (US-636). Runs the resize + JPEG encode on a
    /// background task so `@MainActor` callers (capture, library import, snap)
    /// never block the UI on a full-resolution encode.
    public static func compressOffMain(
        _ image: UIImage,
        maxLongEdge: CGFloat = defaultMaxLongEdge,
        quality: CGFloat = defaultJPEGQuality
    ) async -> Output? {
        await Task.detached(priority: .userInitiated) {
            autoreleasepool { compress(image, maxLongEdge: maxLongEdge, quality: quality) }
        }.value
    }

    /// Batched off-main compression with bounded concurrency (US-636). Resizes
    /// at most `maxConcurrent` images at a time, each inside its own
    /// `autoreleasepool`, so only a few full-resolution `UIImage`s are resident
    /// at once — a 30-image drop won't spike memory into a jetsam kill. Output
    /// order matches the input; failures are `nil`.
    public static func compressBatch(
        _ images: [UIImage],
        maxConcurrent: Int = 3,
        maxLongEdge: CGFloat = defaultMaxLongEdge,
        quality: CGFloat = defaultJPEGQuality
    ) async -> [Output?] {
        guard !images.isEmpty else { return [] }
        var results = [Output?](repeating: nil, count: images.count)
        var next = 0
        while next < images.count {
            let upper = min(next + max(maxConcurrent, 1), images.count)
            await withTaskGroup(of: (Int, Output?).self) { group in
                for index in next..<upper {
                    let image = images[index]
                    group.addTask(priority: .userInitiated) {
                        autoreleasepool {
                            (index, compress(image, maxLongEdge: maxLongEdge, quality: quality))
                        }
                    }
                }
                for await (index, output) in group {
                    results[index] = output
                }
            }
            next = upper
        }
        return results
    }

    /// Flattens the image's orientation into its pixels so the result is `.up`.
    /// Idempotent — returns the input untouched when it's already upright, so
    /// the common camera case (AVFoundation often delivers `.up`) costs nothing.
    /// Redrawing rasterizes the oriented pixels once; the subsequent JPEG encode
    /// is the only lossy step, so no extra quality is lost versus encoding the
    /// raw image.
    public static func normalizedUp(_ image: UIImage) -> UIImage {
        guard image.imageOrientation != .up else { return image }
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }

    /// Aspect-preserving resize. If the input is already within the budget
    /// we return it unchanged — re-encoding a smaller-than-budget image
    /// would just lose quality for no size win.
    public static func resize(_ image: UIImage, maxLongEdge: CGFloat) -> UIImage {
        let longEdge = max(image.size.width, image.size.height)
        guard longEdge > maxLongEdge else { return image }
        let scale = maxLongEdge / longEdge
        let targetSize = CGSize(
            width: floor(image.size.width * scale),
            height: floor(image.size.height * scale)
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1            // We want target pixels, not @2x
        format.opaque = true        // JPEG anyway; faster blit
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
    }

    /// Strip EXIF from a JPEG payload while preserving orientation. Used by
    /// the library-import path where the source JPEG already exists; the
    /// camera capture path goes through ``compress(_:)`` instead.
    public static func stripExifPreservingOrientation(_ jpegData: Data) -> Data {
        guard
            let source = CGImageSourceCreateWithData(jpegData as CFData, nil),
            let type = CGImageSourceGetType(source),
            let mutableData = CFDataCreateMutable(nil, 0),
            let destination = CGImageDestinationCreateWithData(mutableData, type, 1, nil),
            let originalMeta = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [String: Any]
        else {
            return jpegData
        }

        // Whitelist: only carry orientation forward so EXIF's GPS, device
        // serial, and capture-time fields don't leak into the upload.
        var sanitized: [String: Any] = [:]
        if let orientation = originalMeta[kCGImagePropertyOrientation as String] {
            sanitized[kCGImagePropertyOrientation as String] = orientation
        }
        if let tiffOrientation = (originalMeta[kCGImagePropertyTIFFDictionary as String]
            as? [String: Any])?[kCGImagePropertyTIFFOrientation as String] {
            sanitized[kCGImagePropertyTIFFDictionary as String] = [
                kCGImagePropertyTIFFOrientation as String: tiffOrientation
            ]
        }
        CGImageDestinationAddImageFromSource(destination, source, 0, sanitized as CFDictionary)

        guard CGImageDestinationFinalize(destination) else {
            return jpegData
        }
        return mutableData as Data
    }
}
