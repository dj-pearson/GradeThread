import Foundation

/// Maps raw `Error`s thrown by Supabase auth / URLSession into friendly,
/// actionable copy for the auth + intake surfaces (US-1025). Keeps the raw
/// technical string (Supabase/GoTrue/URLError) out of the UI while preserving
/// it via ``rawDetail(for:)`` so callers can log the original to Sentry.
///
/// Why string-matching instead of typed `AuthError` cases: GoTrue surfaces the
/// same condition under different shapes across supabase-swift versions (a typed
/// case, an `errorCode`, or just a localized message), and some failures arrive
/// as a bare `URLError`. Matching the flattened message + NSError code is the
/// version-robust common denominator. Pure + `nonisolated` so it's unit-testable
/// off the main actor.
enum FriendlyErrorCopy {
    /// The recognised categories. Drives both the copy and — for `.offline` —
    /// the banner kind on the intake surfaces.
    enum Kind: Equatable {
        case offline
        case invalidCredentials
        case emailNotConfirmed
        /// US-1406: the edge rejected an AUTHENTICATED action because the
        /// account's email isn't confirmed (``EdgeAPIError/emailUnverified``, a
        /// 403). Same recovery as ``emailNotConfirmed`` (the GoTrue sign-in
        /// rejection) — it differs only in origin — but kept a separate case so
        /// the typed edge error is matched directly instead of by string, and so
        /// it gets the actionable "confirm your email" copy on action surfaces
        /// rather than the generic fallback (the relocated Guideline 2.1 reject).
        case emailUnverified
        case rateLimited
        case generic
    }

    /// US-1406: actionable copy shown whenever a feature is blocked because the
    /// account's email isn't confirmed — on auth AND action (save/intake)
    /// surfaces — so the user is told exactly how to recover instead of hitting a
    /// generic "couldn't save / session expired" dead-end. Mirrors
    /// ``EdgeAPIError/emailUnverified``'s description.
    static let confirmEmailMessage =
        "Please confirm your email to use this feature. Check your inbox for the verification link we sent when you signed up."

    /// True when the failure is a network-reachability problem (offline, DNS,
    /// TLS, timeout) rather than an application-level rejection. Shared by the
    /// auth and intake surfaces so "offline" is classified one way everywhere.
    ///
    /// US-1004: classification is driven by TYPED errors / NSError domain+code,
    /// never by the localized message — so a non-English offline failure is
    /// still queued. URLError codes covered include notConnectedToInternet,
    /// timedOut, networkConnectionLost, cannotFindHost and dnsLookupFailed (all
    /// live in `NSURLErrorDomain`), plus `EdgeAPIError.network`.
    nonisolated static func isOffline(_ error: Error) -> Bool {
        // EdgeAPI surfaces transport failures as a typed `.network` case — a
        // locale-independent signal, so check it directly.
        if let edge = error as? EdgeAPIError, case .network = edge {
            return true
        }
        // The NSError bridge of any URLError lives in NSURLErrorDomain; the code
        // (not the message) identifies the failure, so this holds in every
        // device language.
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return true
        }
        // Some failures wrap a URLError deeper in the chain (supabase-swift,
        // URLSession bridging). Walk it.
        if underlyingURLErrorDomain(nsError) {
            return true
        }
        // LAST RESORT ONLY: a locale-fragile English-substring net for SDKs that
        // surface connectivity errors under their own domain with NO URLError
        // link in the chain. Every typed/domain check above already classifies
        // non-English offline failures, so this is reached only for exotic
        // SDK-domain cases — never the primary path.
        let lower = rawDetail(for: error).lowercased()
        return lower.contains("offline")
            || lower.contains("the internet connection")
            || lower.contains("not connected to the internet")
            || lower.contains("network connection was lost")
            || lower.contains("timed out")
    }

    /// Classifies an error into a known ``Kind``.
    nonisolated static func kind(for error: Error) -> Kind {
        if isOffline(error) {
            return .offline
        }
        // US-1406: match the TYPED edge case directly (like `isOffline` matches
        // `.network`) BEFORE any string-matching. Without this, the
        // `emailUnverified` localizedDescription ("…confirm your email…") was
        // string-matched to `.emailNotConfirmed`, which `actionMessage` then
        // returned as the generic fallback — re-introducing the Guideline 2.1
        // dead-end on the save/intake path.
        if let edge = error as? EdgeAPIError, case .emailUnverified = edge {
            return .emailUnverified
        }
        let lower = rawDetail(for: error).lowercased()
        if lower.contains("invalid login credentials")
            || lower.contains("invalid_credentials")
            || lower.contains("invalid email or password")
            || lower.contains("incorrect email or password") {
            return .invalidCredentials
        }
        if lower.contains("email not confirmed")
            || lower.contains("email_not_confirmed")
            || lower.contains("not confirmed")
            || lower.contains("confirm your email") {
            return .emailNotConfirmed
        }
        if lower.contains("rate limit")
            || lower.contains("rate_limit")
            || lower.contains("too many requests")
            || lower.contains("over_email_send_rate_limit") {
            return .rateLimited
        }
        return .generic
    }

    /// True when the failure is GoTrue's "email not confirmed" rejection on
    /// sign-in (US-810) — the signal ``LoginView`` uses to swap the generic
    /// error line for the dedicated confirm-your-email guidance + a
    /// "Resend confirmation email" action. Delegates to ``kind(for:)`` so the
    /// version-robust string matching lives in one place.
    nonisolated static func isEmailNotConfirmed(_ error: Error) -> Bool {
        // US-1406: the edge's authenticated-action 403 (`.emailUnverified`) also
        // means "confirm your email," so the resend-confirmation card should
        // surface for it too — not just the GoTrue sign-in rejection.
        // (Qualify as `Self.kind` so the call doesn't bind to the local below.)
        let classified = Self.kind(for: error)
        return classified == .emailNotConfirmed || classified == .emailUnverified
    }

    /// Friendly copy for the auth surfaces (login / signup / reset).
    nonisolated static func authMessage(for error: Error) -> String {
        switch kind(for: error) {
        case .offline:
            return "You're offline. Check your connection and try again."
        case .invalidCredentials:
            return "The email or password you entered is incorrect."
        case .emailNotConfirmed:
            return "Please confirm your email first — we sent a link to your inbox."
        case .emailUnverified:
            return Self.confirmEmailMessage
        case .rateLimited:
            return "Too many attempts. Please wait a moment and try again."
        case .generic:
            return "Something went wrong. Please try again."
        }
    }

    /// Friendly copy for a generic save / load action. `fallback` is the
    /// action-specific line shown for unrecognised, non-offline failures
    /// (e.g. "Couldn't save your item. Please try again.").
    nonisolated static func actionMessage(for error: Error, fallback: String) -> String {
        switch kind(for: error) {
        case .offline:
            return "You're offline. We'll keep your work and retry when you reconnect."
        case .rateLimited:
            return "Too many attempts. Please wait a moment and try again."
        case .emailUnverified, .emailNotConfirmed:
            // US-1406: a feature blocked for an unconfirmed email must tell the
            // user how to recover (confirm their email) — NOT fall through to the
            // generic "Couldn't save your item. Please try again." dead-end, which
            // was the relocated Guideline 2.1 rejection on the save/intake path.
            return Self.confirmEmailMessage
        case .invalidCredentials, .generic:
            return fallback
        }
    }

    /// Flattened technical detail for Sentry — never shown to the user. Walks
    /// the NSError chain (domain/code/description per level, following
    /// `NSUnderlyingErrorKey`), bounded so a cyclic/deep chain can't spin.
    nonisolated static func rawDetail(for error: Error) -> String {
        var parts: [String] = []
        var current: NSError? = error as NSError
        var depth = 0
        while let err = current, depth < 5 {
            parts.append("\(err.domain) \(err.code): \(err.localizedDescription)")
            current = err.userInfo[NSUnderlyingErrorKey] as? NSError
            depth += 1
        }
        return parts.joined(separator: " ← ")
    }

    /// Walks the NSError chain looking for a `URLError` / `NSURLErrorDomain`
    /// link beneath the top level.
    private nonisolated static func underlyingURLErrorDomain(_ error: NSError) -> Bool {
        var current: NSError? = error.userInfo[NSUnderlyingErrorKey] as? NSError
        var depth = 0
        while let err = current, depth < 5 {
            if err.domain == NSURLErrorDomain {
                return true
            }
            current = err.userInfo[NSUnderlyingErrorKey] as? NSError
            depth += 1
        }
        return false
    }
}
