import Foundation
import Observation

/// Loads the caller's support tickets + opens new ones (US-1136). Mirrors the
/// phase + action-error shape of the other FlipDesk stores (``ConsignorStore``).
@MainActor
@Observable
final class SupportTicketsStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: SupportTicketProviding

    var phase: Phase = .loading
    private(set) var tickets: [SupportTicket] = []
    /// Surfaced when create fails; the view shows it in an alert.
    var actionError: String?
    /// Reentrancy guard so pull-to-refresh can't kick off a duplicate fetch
    /// while the initial `.task` load (or another refresh) is still in flight.
    private var isLoading = false

    init(service: SupportTicketProviding = SupportTicketService()) {
        self.service = service
    }

    var isEmpty: Bool { tickets.isEmpty }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        // Keep showing the current list during a refresh; only blank to the
        // spinner on the very first load.
        if tickets.isEmpty { phase = .loading }
        do {
            tickets = try await service.list()
            phase = .ready
        } catch {
            phase = .failed(message: friendlyMessage(error))
        }
    }

    /// Opens a ticket and refreshes the list. Returns the new ticket id so the
    /// caller can navigate straight into the thread, or nil on failure.
    func create(subject: String, body: String) async -> String? {
        let trimmedSubject = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSubject.isEmpty, !trimmedBody.isEmpty else { return nil }
        do {
            let id = try await service.create(subject: trimmedSubject, body: trimmedBody)
            await load()
            return id
        } catch {
            actionError = friendlyMessage(error)
            return nil
        }
    }
}

/// Loads + replies to a single ticket thread (US-1136). Created per thread view.
@MainActor
@Observable
final class SupportThreadStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    let ticketId: String
    private let service: SupportTicketProviding

    var phase: Phase = .loading
    private(set) var ticket: SupportTicket?
    private(set) var messages: [SupportTicketMessage] = []
    var actionError: String?
    private var isLoading = false

    init(ticketId: String, service: SupportTicketProviding = SupportTicketService()) {
        self.ticketId = ticketId
        self.service = service
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        if messages.isEmpty { phase = .loading }
        do {
            let thread = try await service.thread(id: ticketId)
            ticket = thread.ticket
            messages = thread.messages
            phase = .ready
        } catch {
            phase = .failed(message: friendlyMessage(error))
        }
    }

    /// Posts a reply (reopens a resolved/closed ticket server-side) and reloads
    /// the thread so the new message + status land. Returns whether it sent.
    @discardableResult
    func reply(_ body: String) async -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        do {
            try await service.reply(ticketId: ticketId, body: trimmed)
            await load()
            return true
        } catch {
            actionError = friendlyMessage(error)
            return false
        }
    }
}

/// Shared error→copy mapping: prefer the typed ``EdgeAPIError`` description
/// (already user-friendly) over a raw `localizedDescription`.
@MainActor
private func friendlyMessage(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
}
