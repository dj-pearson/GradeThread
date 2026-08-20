import Foundation

/// One place that builds a `data:image/jpeg;base64,...` string.
///
/// Extracted 2026-08-19 when the dispute sheet needed the same string the
/// support composer already built. Two copies of this would be two chances to
/// get the header wrong, and the edge decoders reject a malformed one with
/// "not an image" — a message about the bytes when the fault is the prefix.
///
/// JPEG only, because ``PhotoCompressor`` emits JPEG and nothing else in the app
/// produces upload bytes. A second media type belongs here as a second function
/// with its own name, not as a parameter nobody sets.
enum ImageDataURL {
    static func jpeg(_ data: Data) -> String {
        "data:image/jpeg;base64," + data.base64EncodedString()
    }
}
