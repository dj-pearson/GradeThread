import Foundation

/// Native support-ticket inbox models (US-1136). Mirror the web
/// `support-tickets.tsx` shapes served by the authed `/api/support-tickets`
/// edge endpoints. The ``EdgeAPI`` decoder applies `.convertFromSnakeCase`, so
/// these use camelCase property names; timestamp columns stay `String` and are
/// parsed at the display boundary (the edge emits fractional seconds, which the
/// default `.iso8601` date strategy rejects — same gotcha as the rest of iOS).

/// A ticket summary row (list) — also the per-thread ticket header.
struct SupportTicket: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let subject: String
    let status: String
    let priority: String?
    let lastMessageAt: String?
    let resolvedAt: String?
    let createdAt: String?

    /// Normalized status (unknown server values fall back to `.open` so a new
    /// status never renders blank).
    var displayStatus: SupportTicketStatus { SupportTicketStatus(raw: status) }
}

/// One message in a thread. Authorship is reduced server-side to you/support —
/// operator internal notes are never returned, so there's no admin identity to
/// decode here.
struct SupportTicketMessage: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let author: String
    let body: String
    let createdAt: String?
    /// US-2561. OPTIONAL rather than defaulted-empty because a missing key is a
    /// decode FAILURE in Swift, not a zero value - and this whole thread view
    /// would go blank against an edge build that predates attachments, which is
    /// a worse outcome than a message with no images.
    let attachments: [SupportAttachmentView]?

    var isFromUser: Bool { author == "you" }

    var files: [SupportAttachmentView] { attachments ?? [] }
}

/// `GET /api/support-tickets/:id` payload.
struct SupportTicketThread: Decodable, Sendable {
    let ticket: SupportTicket
    let messages: [SupportTicketMessage]
}

/// The four lifecycle states the web inbox renders. Decoded leniently so an
/// unrecognized server status degrades gracefully instead of failing.
enum SupportTicketStatus: String, CaseIterable, Sendable {
    case open
    case pending
    case resolved
    case closed

    init(raw: String) {
        self = SupportTicketStatus(rawValue: raw.lowercased()) ?? .open
    }

    var label: String { rawValue.capitalized }
}

/// Pure formatting helpers (no SwiftUI / network) so they unit-test trivially.
enum SupportTicketFormat {
    private static let isoFull: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    static func parseDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return isoFull.date(from: s) ?? isoPlain.date(from: s)
    }

    /// Short relative phrase ("just now", "5m ago", "3d ago") for a timestamp,
    /// mirroring the web inbox's `relativeTime`. Empty when unparseable.
    static func relative(_ iso: String?, now: Date = .now) -> String {
        guard let date = parseDate(iso) else { return "" }
        let diff = now.timeIntervalSince(date)
        let minutes = Int(diff / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        return "\(days)d ago"
    }
}
