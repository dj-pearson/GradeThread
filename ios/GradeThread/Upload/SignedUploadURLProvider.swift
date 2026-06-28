import Foundation

/// Mints short-lived Supabase Storage **signed upload URLs** so the background
/// photo upload (US-175) can PUT bytes WITHOUT carrying a long-lived bearer JWT.
///
/// US-1219: the background `URLSession` serializes the full request — headers
/// included — to the system background-transfer DB on disk (outside the
/// Keychain). Putting `Authorization: Bearer <user-jwt>` on that request leaks a
/// long-lived credential to disk and, worse, a queued request built with a
/// now-expired token 401s on resume with no refresh path. Instead we mint a
/// signed upload URL up front (authenticated, over an ephemeral session whose
/// request is never persisted) and hand the background session a URL whose
/// single-object, short-TTL token lives only in the query string.
///
/// Mirrors the `POST /object/upload/sign/{bucket}/{path}` →
/// `PUT …?token=…` shape supabase-js uses for `createSignedUploadUrl` /
/// `uploadToSignedUrl`. The ephemeral session keeps the mint off the
/// Sentry-swizzled `URLSession.shared` path (same reasoning as
/// ``PhotoSignedURLProvider``).
actor SignedUploadURLProvider {
    static let shared = SignedUploadURLProvider()

    private let session: URLSession
    private let tokenProvider: () async -> String?

    init(
        session: URLSession = SignedUploadURLProvider.makeSession(),
        tokenProvider: @escaping () async -> String? = { await SupabaseShared.currentAccessToken() }
    ) {
        self.session = session
        self.tokenProvider = tokenProvider
    }

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }

    /// Builds the `POST /object/upload/sign` request that mints the token. POST
    /// is authenticated (this request is sent over the ephemeral session and is
    /// never persisted to disk). `x-upsert` so a re-upload of the same path
    /// overwrites instead of 409-ing, matching the prior direct-upload behavior.
    ///
    /// Sends an empty-JSON-object body (`{}`), exactly as supabase-js's
    /// `createSignedUploadUrl` does. This is load-bearing: the request declares
    /// `Content-Type: application/json`, and storage-api (Fastify) rejects a POST
    /// that has that content-type with a ZERO-length body
    /// (`FST_ERR_CTP_EMPTY_JSON_BODY` → **HTTP 400**). A 400 here makes the mint
    /// return nil → every photo upload fails before any byte reaches storage → the
    /// AI-extract run bails with "couldn't process your photos" and NOTHING shows
    /// in the edge logs (the mint/PUT/insert all hit Supabase/Kong, not the edge).
    static func mintRequest(base: URL?, bucket: String, path: String, token: String?) -> URLRequest? {
        guard let url = StorageURL.uploadSign(base: base, bucket: bucket, path: path) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("true", forHTTPHeaderField: "x-upsert")
        // Non-empty body required for the application/json content-type (above).
        request.httpBody = Data("{}".utf8)
        return request
    }

    /// Resolves the REST response's relative `url`
    /// (`/object/upload/sign/{bucket}/{path}?token=…`) against the base.
    static func resolve(base: URL, signedURL: String) -> URL? {
        URL(string: base.absoluteString + "/storage/v1" + signedURL)
    }

    /// Mints a signed upload URL for `path` in `bucket`, or nil on any failure
    /// (caller routes a `.failed` + queues a pending mutation so the next sync
    /// re-mints — no silent loss).
    func signedUploadURL(bucket: String, path: String) async -> URL? {
        let token = await tokenProvider()
        guard let request = Self.mintRequest(
            base: AppConfig.supabaseURL, bucket: bucket, path: path, token: token
        ) else { return nil }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else { return nil }
            struct MintResponse: Decodable { let url: String }
            let decoded = try JSONDecoder().decode(MintResponse.self, from: data)
            return Self.resolve(base: AppConfig.supabaseURL, signedURL: decoded.url)
        } catch {
            return nil
        }
    }
}
