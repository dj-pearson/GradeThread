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
        let resized = resize(image, maxLongEdge: maxLongEdge)
        guard let data = resized.jpegData(compressionQuality: quality) else { return nil }
        let thumb = resize(image, maxLongEdge: defaultThumbnailLongEdge)
        return Output(imageData: data, thumbnail: thumb)
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
