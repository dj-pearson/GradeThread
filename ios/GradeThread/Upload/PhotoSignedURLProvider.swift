import Foundation

/// Mints + caches short-TTL signed URLs for objects in the PRIVATE
/// `submission-images` bucket so sensitive photos (PII / grading-label
/// close-ups, US-979) can be displayed and read by the edge WITHOUT a
/// permanent public URL.
///
/// Public-bucket photos keep their permanent `photo_url` and never touch this.
/// Private-bucket photos have NO public URL; this calls the Supabase Storage
/// REST sign endpoint (`POST /storage/v1/object/sign/{bucket}/{path}` with
/// `{ expiresIn }`) and caches the result until just before expiry so a
/// scrolling gallery doesn't re-sign every frame.
///
/// Uses a private ephemeral `URLSession` (no cache/cookies) so the bearer
/// token + signed URL stay off the Sentry-swizzled `URLSession.shared` path
/// (same reasoning as `SyncEngine.storageUploadSession`, US-990).
actor PhotoSignedURLProvider {
    static let shared = PhotoSignedURLProvider()

    private struct Entry {
        let url: URL
        let expiresAt: Date
    }

    private var cache: [String: Entry] = [:]

    /// Requested signed-URL lifetime, in seconds. Hard-capped at 15 minutes.
    private let ttl: Int
    /// Re-sign this many seconds BEFORE the real expiry so an in-flight image
    /// load never races the token going stale.
    private let refreshSkew: TimeInterval = 30
    private let session: URLSession
    private let tokenProvider: () async -> String?

    init(
        ttlSeconds: Int = PhotoStorageBucket.signedURLTTLSeconds,
        session: URLSession = PhotoSignedURLProvider.makeSession(),
        tokenProvider: @escaping () async -> String? = { await SupabaseShared.currentAccessToken() }
    ) {
        // Never exceed the 15-minute ceiling, and never go below 1s.
        self.ttl = max(1, min(ttlSeconds, PhotoStorageBucket.signedURLMaxTTLSeconds))
        self.session = session
        self.tokenProvider = tokenProvider
    }

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        // Bounded idle timeout (vs. 60s default) so a stalled sign-URL request
        // fails fast instead of delaying private-bucket thumbnails ~60s.
        config.timeoutIntervalForRequest = 20
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }

    /// The TTL (seconds) this provider requests — exposed for tests asserting
    /// the ≤900s bound (US-979 AC).
    var requestedTTLSeconds: Int { ttl }

    /// Appends a photo's local cache token as an ignored `_cb` query param so an
    /// in-place-rotated private photo busts the client thumbnail caches. The
    /// signed path (and thus the URL, cached ~10 min) is unchanged by a rotate,
    /// so every cache keyed on the URL string would otherwise serve the
    /// pre-rotation pixels. Supabase validates only the `token` JWT (it signs the
    /// path + expiry, not the query string) and ignores `_cb`, so the server
    /// still returns the freshly rotated bytes. No-op at token 0 (never rotated)
    /// or a nil URL. `static` (non-isolated) so display code can call it
    /// synchronously without awaiting the actor.
    static func cacheBusted(_ url: URL?, token: Int) -> URL? {
        guard let url, token != 0 else { return url }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var items = components?.queryItems ?? []
        items.append(URLQueryItem(name: "_cb", value: String(token)))
        components?.queryItems = items
        return components?.url ?? url
    }

    /// A displayable URL for a persisted photo. Public-bucket photos return
    /// their permanent `publicURL`; private-bucket photos resolve a cached
    /// signed URL from `storagePath` (nil if it can't be minted).
    func displayURL(bucket: String, storagePath: String?, publicURL: String) async -> URL? {
        if bucket == PhotoStorageBucket.publicBucket {
            return URL(string: publicURL)
        }
        guard let storagePath, !storagePath.isEmpty else { return nil }
        return await signedURL(bucket: bucket, path: storagePath)
    }

    /// A signed URL for `path` in `bucket`, served from cache while still
    /// comfortably valid. Returns nil on any failure (caller shows a
    /// placeholder / skips the photo).
    func signedURL(bucket: String, path: String) async -> URL? {
        let key = "\(bucket)/\(path)"
        if let hit = cache[key], hit.expiresAt > Date.now.addingTimeInterval(refreshSkew) {
            return hit.url
        }
        guard let url = await mint(bucket: bucket, path: path) else { return nil }
        cache[key] = Entry(url: url, expiresAt: Date.now.addingTimeInterval(TimeInterval(ttl)))
        return url
    }

    /// Builds the `/storage/v1/object/sign` request the Storage REST API
    /// expects. `static` so the request shape (and the TTL bound it encodes)
    /// is unit-testable without a live network.
    static func signRequest(
        base: URL,
        bucket: String,
        path: String,
        token: String?,
        ttl: Int
    ) -> URLRequest? {
        guard let url = StorageURL.sign(base: base, bucket: bucket, path: path) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["expiresIn": ttl])
        return request
    }

    /// Resolves the REST response's relative `signedURL`
    /// (`/object/sign/{bucket}/{path}?token=…`) against the base into a full URL.
    static func resolve(base: URL, signedURL: String) -> URL? {
        URL(string: base.absoluteString + "/storage/v1" + signedURL)
    }

    private func mint(bucket: String, path: String) async -> URL? {
        let token = await tokenProvider()
        guard let request = Self.signRequest(
            base: AppConfig.supabaseURL,
            bucket: bucket,
            path: path,
            token: token,
            ttl: ttl
        ) else { return nil }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else { return nil }
            struct SignResponse: Decodable { let signedURL: String }
            let decoded = try JSONDecoder().decode(SignResponse.self, from: data)
            return Self.resolve(base: AppConfig.supabaseURL, signedURL: decoded.signedURL)
        } catch {
            return nil
        }
    }
}
