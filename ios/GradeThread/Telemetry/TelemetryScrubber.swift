import Foundation

/// US-662 — redacts PII / secrets from any string before it leaves the device
/// in a crash report or breadcrumb: emails, `Bearer` tokens, apikey /
/// access_token / refresh_token values, and signed Storage object URLs.
///
/// Pure + synchronous so it's cheap to run inside Sentry's `beforeSend` /
/// `beforeBreadcrumb` hooks and easy to unit-test.
enum TelemetryScrubber {

    static func redact(_ text: String) -> String {
        var result = text
        for rule in rules {
            result = replace(result, pattern: rule.pattern, template: rule.template)
        }
        return result
    }

    private struct Rule { let pattern: String; let template: String }

    private static let rules: [Rule] = [
        // Emails.
        Rule(pattern: #"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"#,
             template: "[redacted-email]"),
        // Bearer tokens.
        Rule(pattern: #"(?i)bearer\s+[A-Za-z0-9._\-]+"#,
             template: "Bearer [redacted]"),
        // apikey / access_token / refresh_token = value  (or : value).
        Rule(pattern: #"(?i)(apikey|api_key|access_token|refresh_token)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-]+"#,
             template: "$1$2[redacted]"),
        // Signed Supabase Storage object URLs (carry a token query + the path).
        Rule(pattern: #"https?://[^\s"']*?/storage/v1/object/[^\s"']+"#,
             template: "[redacted-storage-url]"),
    ]

    private static func replace(_ string: String, pattern: String, template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return string }
        let range = NSRange(string.startIndex..., in: string)
        return regex.stringByReplacingMatches(in: string, options: [], range: range, withTemplate: template)
    }
}
