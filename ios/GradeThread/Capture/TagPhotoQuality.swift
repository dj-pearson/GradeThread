import UIKit

/// On-device pre-flight check for the brand/care tag photo, so we can nudge the
/// user to retake an unreadable shot BEFORE spending an AI action on it (and
/// before they end up with a missing/garbled brand + size).
///
/// Uses on-device OCR — the same recognizer as the Live Text fallback — as a
/// proxy for "can text actually be read off this tag", plus a hard resolution
/// floor. Intentionally LENIENT: Claude Vision reads tags better than on-device
/// OCR, so we only flag a photo when it's genuinely too small or yields
/// essentially no readable text (blur / glare / too far / poor light). A photo
/// the recognizer can read at all is left alone.
enum TagPhotoQuality {
    enum Reason: Equatable {
        case lowResolution
        case unreadable
    }

    enum Assessment: Equatable {
        case ok
        case poor(Reason)
    }

    /// Long-edge pixel floor below which a tag is too small to read reliably.
    /// Captures are encoded at up to 1600px (PhotoCompressor.defaultMaxLongEdge)
    /// but never upscaled, so a far-away / heavily-cropped tag can land well
    /// under this.
    static let minLongEdgePixels: CGFloat = 700

    /// Minimum total recognized characters for the tag to count as "readable".
    static let minReadableChars = 4

    static func assess(_ capture: PhotoCapture) async -> Assessment {
        // Decode failures are OUR problem, not the user's — never block on them.
        guard let image = UIImage(data: capture.imageData) else { return .ok }

        let longEdge = max(image.size.width, image.size.height) * image.scale
        if longEdge < minLongEdgePixels { return .poor(.lowResolution) }

        let recognizer = TagTextRecognizer()
        let lines = (try? await recognizer.recognize(image)) ?? []
        let chars = lines.reduce(0) {
            $0 + $1.text.trimmingCharacters(in: .whitespacesAndNewlines).count
        }
        if lines.isEmpty || chars < minReadableChars { return .poor(.unreadable) }
        return .ok
    }

    /// User-facing nudge copy for the retake prompt.
    static func message(for reason: Reason) -> String {
        switch reason {
        case .lowResolution:
            return "The tag photo looks low-resolution. Move closer and fill the frame with the tag so AI can read the brand and size."
        case .unreadable:
            return "AI may not be able to read this tag — it looks blurry or has glare. Retake it close-up in good light for a better brand and size match."
        }
    }
}
