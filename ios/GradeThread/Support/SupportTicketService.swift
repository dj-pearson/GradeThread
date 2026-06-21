import Foundation

/// Data layer for the native support inbox (US-1136). Every call goes through
/// ``EdgeAPI/shared`` (which auto-attaches the Supabase JWT + workspace scope),
/// hitting the authed `/api/support-tickets` endpoints that tenant-scope to the
/// caller. Behind a protocol so the stores are unit-testable with a fake.
protocol SupportTicketProviding: Sendable {
    func list() async throws -> [SupportTicket]
    func thread(id: String) async throws -> SupportTicketThread
    /// Opens a ticket (subject + first message); returns the new ticket id.
    func create(subject: String, body: String) async throws -> String
    func reply(ticketId: String, body: String) async throws
}

enum SupportTicketError: LocalizedError {
    case missingTicketId
    var errorDescription: String? {
        "We couldn't open that ticket. Please try again."
    }
}

struct SupportTicketService: SupportTicketProviding {
    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) { self.api = api }

    private struct ListResponse: Decodable { let tickets: [SupportTicket] }
    private struct CreateBody: Encodable { let subject: String; let body: String }
    private struct CreateResponse: Decodable { let ticketId: String? } // ticket_id
    private struct ReplyBody: Encodable { let body: String }
    /// The reply/ack response (`{ ok, status }`) carries nothing the caller
    /// needs — an empty Decodable ignores the extra keys.
    private struct Ack: Decodable {}

    func list() async throws -> [SupportTicket] {
        let response: ListResponse = try await api.getJSON("/api/support-tickets")
        return response.tickets
    }

    func thread(id: String) async throws -> SupportTicketThread {
        try await api.getJSON("/api/support-tickets/\(id)")
    }

    func create(subject: String, body: String) async throws -> String {
        let response: CreateResponse = try await api.postJSON(
            "/api/support-tickets",
            body: CreateBody(subject: subject, body: body)
        )
        guard let id = response.ticketId else { throw SupportTicketError.missingTicketId }
        return id
    }

    func reply(ticketId: String, body: String) async throws {
        let _: Ack = try await api.postJSON(
            "/api/support-tickets/\(ticketId)/messages",
            body: ReplyBody(body: body)
        )
    }
}
