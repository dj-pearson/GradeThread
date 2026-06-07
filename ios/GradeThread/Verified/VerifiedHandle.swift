import Foundation

/// Client-side handle validation, mirroring the edge `parseHandle` rules in
/// `routes/verified.ts` (DB CHECK constraint, migration 00057). Used for instant
/// feedback before hitting `/handle-available`; the server remains authoritative.
enum VerifiedHandle {
    /// 3–30 chars, lowercase alnum + hyphen, no leading/trailing hyphen.
    static let pattern = "^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$"

    /// Handles reserved by the platform (collide with routes / impersonation).
    static let reserved: Set<String> = [
        "admin", "api", "app", "auth", "billing", "blog", "cert", "dashboard",
        "gradethread", "flipdesk", "help", "login", "logout", "og", "pricing",
        "settings", "signup", "support", "verified", "www",
    ]

    /// Trim + lowercase, matching the server's normalization.
    static func normalize(_ raw: String) -> String {
        raw.trimmed.lowercased()
    }

    /// Returns a human-readable error for the normalized handle, or `nil` if it
    /// passes local validation.
    static func validationError(_ raw: String) -> String? {
        let handle = normalize(raw)
        if handle.count < 3 || handle.count > 30 {
            return "Handle must be 3–30 characters."
        }
        if handle.range(of: pattern, options: .regularExpression) == nil {
            return "Use lowercase letters, numbers and hyphens only (no leading/trailing hyphen)."
        }
        if reserved.contains(handle) {
            return "That handle is reserved. Try another."
        }
        return nil
    }

    static func isValid(_ raw: String) -> Bool { validationError(raw) == nil }
}
