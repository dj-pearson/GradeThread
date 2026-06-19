import Foundation

/// Builds Supabase Storage object URLs from a base URL + bucket + path WITHOUT
/// force-unwrapping (US-993). A missing/malformed base URL — e.g. a
/// misconfigured deployment — yields `nil` so callers can route a typed,
/// recoverable error (`.failed` / `SyncReplayError` / `RotateError`) instead of
/// trapping at runtime.
///
/// `AppConfig.supabaseURL` already fatal-errors on a non-https/missing base at
/// launch, so in a shipped build these never return nil; this is defense in
/// depth that keeps the upload/storage paths crash-free regardless.
enum StorageURL {
    /// Authenticated object endpoint: `/storage/v1/object/{bucket}/{path}`.
    static func object(base: URL?, bucket: String, path: String) -> URL? {
        url(base: base, path: "/storage/v1/object/\(bucket)/\(path)")
    }

    /// Public object endpoint: `/storage/v1/object/public/{bucket}/{path}`.
    static func publicObject(base: URL?, bucket: String, path: String) -> URL? {
        url(base: base, path: "/storage/v1/object/public/\(bucket)/\(path)")
    }

    /// Signed-URL minting endpoint: `/storage/v1/object/sign/{bucket}/{path}`
    /// (US-979). POST `{ "expiresIn": <seconds> }` here to mint a short-TTL
    /// signed URL for an object in a PRIVATE bucket.
    static func sign(base: URL?, bucket: String, path: String) -> URL? {
        url(base: base, path: "/storage/v1/object/sign/\(bucket)/\(path)")
    }

    private static func url(base: URL?, path: String) -> URL? {
        guard let base,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { return nil }
        components.path = path
        return components.url
    }
}
