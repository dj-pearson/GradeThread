import Foundation
import ImageIO

/// Reads a photo's ORIGINAL capture time out of the file's own EXIF block.
///
/// Why this exists (US-2373): the AutoLister picker is configured WITHOUT a
/// `photoLibrary:` (US-1013 — no permission prompt, no library access), so
/// `PHPickerResult.assetIdentifier` is always nil and the PHAsset creation-date
/// lookup can never fire. Every imported photo therefore fell back to `.now`,
/// which meant the whole batch looked like one instantaneous burst: capture-time
/// grouping had nothing to work with, "Date taken" sorting was meaningless, and
/// auto-group was left guessing from filenames alone.
///
/// The EXIF block travels inside the image bytes we already load, so reading it
/// needs no permission at all — same privacy posture, real capture times.
enum ImageCaptureDate {

    /// The capture time embedded in `data`, or nil when the file carries none
    /// (screenshots, re-encoded exports, most messaging-app downloads).
    static func from(_ data: Data) -> Date? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [String: Any]
        else { return nil }
        return from(properties: properties)
    }

    /// Test seam: the same extraction against an already-read property dict.
    static func from(properties: [String: Any]) -> Date? {
        let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any]
        let tiff = properties[kCGImagePropertyTIFFDictionary as String] as? [String: Any]
        // Preference order mirrors what cameras actually write: the original
        // shutter time first, the digitize time second, and the generic TIFF
        // timestamp (often the last edit) only as a fallback.
        let raw = (exif?[kCGImagePropertyExifDateTimeOriginal as String] as? String)
            ?? (exif?[kCGImagePropertyExifDateTimeDigitized as String] as? String)
            ?? (tiff?[kCGImagePropertyTIFFDateTime as String] as? String)
        guard let raw else { return nil }
        let offset = (exif?[kCGImagePropertyExifOffsetTimeOriginal as String] as? String)
            ?? (exif?[kCGImagePropertyExifOffsetTime as String] as? String)
        return parse(raw, offset: offset)
    }

    /// Parse an EXIF timestamp ("2026:07:31 14:03:22"). EXIF stores wall-clock
    /// time with no zone, so an `OffsetTime` tag is used when the camera wrote
    /// one and the device's own zone otherwise — grouping only ever compares
    /// these to each other, so a consistent zone is what matters.
    static func parse(_ raw: String, offset: String? = nil) -> Date? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // Cameras write all-zero timestamps when the clock was never set.
        guard !trimmed.hasPrefix("0000:00:00") else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        formatter.timeZone = offset.flatMap(timeZone(fromOffset:)) ?? .current
        return formatter.date(from: trimmed)
    }

    /// "+02:00" / "-07:00" → a fixed-offset zone.
    private static func timeZone(fromOffset offset: String) -> TimeZone? {
        let parts = offset.trimmingCharacters(in: .whitespaces).split(separator: ":")
        guard parts.count == 2,
              let hours = Int(parts[0]),
              let minutes = Int(parts[1])
        else { return nil }
        let sign = offset.hasPrefix("-") ? -1 : 1
        return TimeZone(secondsFromGMT: hours * 3600 + sign * minutes * 60)
    }
}
