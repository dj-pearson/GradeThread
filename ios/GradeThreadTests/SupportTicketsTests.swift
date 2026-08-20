import XCTest
@testable import GradeThread

/// US-1136: native support inbox — pure helpers + store load/create/reply flows
/// against an in-memory service.
@MainActor
final class SupportTicketsTests: XCTestCase {

    // MARK: - Pure helpers

    func test_status_mapsKnownAndFallsBackToOpen() {
        XCTAssertEqual(SupportTicketStatus(raw: "resolved"), .resolved)
        XCTAssertEqual(SupportTicketStatus(raw: "CLOSED"), .closed)
        XCTAssertEqual(SupportTicketStatus(raw: "something-new"), .open)
        XCTAssertEqual(SupportTicketStatus.pending.label, "Pending")
    }

    func test_relative_phrasing() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let iso = ISO8601DateFormatter()
        XCTAssertEqual(SupportTicketFormat.relative(iso.string(from: now.addingTimeInterval(-30)), now: now), "just now")
        XCTAssertEqual(SupportTicketFormat.relative(iso.string(from: now.addingTimeInterval(-300)), now: now), "5m ago")
        XCTAssertEqual(SupportTicketFormat.relative(iso.string(from: now.addingTimeInterval(-7200)), now: now), "2h ago")
        XCTAssertEqual(SupportTicketFormat.relative(iso.string(from: now.addingTimeInterval(-3 * 86_400)), now: now), "3d ago")
        XCTAssertEqual(SupportTicketFormat.relative(nil, now: now), "")
    }

    // MARK: - List store

    func test_load_setsReadyAndTickets() async {
        let store = SupportTicketsStore(service: FakeSupportService(tickets: [Self.ticket(id: "a")]))
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.tickets.map(\.id), ["a"])
    }

    func test_load_failureSurfacesPhase() async {
        let store = SupportTicketsStore(service: FakeSupportService(listError: EdgeAPIError.network("offline")))
        await store.load()
        if case .failed = store.phase {} else { XCTFail("expected .failed") }
    }

    func test_create_returnsIdAndReloads() async {
        let fake = FakeSupportService(tickets: [])
        fake.newTicketId = "new-1"
        fake.ticketsAfterCreate = [Self.ticket(id: "new-1")]
        let store = SupportTicketsStore(service: fake)
        let id = await store.create(subject: "Help", body: "It broke")
        XCTAssertEqual(id, "new-1")
        XCTAssertEqual(store.tickets.map(\.id), ["new-1"])
        XCTAssertEqual(fake.createCalls, 1)
    }

    func test_create_blankInputIsRejectedWithoutCall() async {
        let fake = FakeSupportService(tickets: [])
        let store = SupportTicketsStore(service: fake)
        let id = await store.create(subject: "   ", body: "")
        XCTAssertNil(id)
        XCTAssertEqual(fake.createCalls, 0)
    }

    func test_create_failureSurfacesActionError() async {
        let fake = FakeSupportService(tickets: [])
        fake.createError = EdgeAPIError.badRequest(detail: "A subject is required.")
        let store = SupportTicketsStore(service: fake)
        let id = await store.create(subject: "Hi", body: "There")
        XCTAssertNil(id)
        XCTAssertNotNil(store.actionError)
    }

    // MARK: - Thread store

    func test_thread_loadAndReplyReloads() async {
        let fake = FakeSupportService(tickets: [Self.ticket(id: "t1")])
        fake.thread = SupportTicketThread(
            ticket: Self.ticket(id: "t1"),
            messages: [Self.message(id: "m1", author: "you")]
        )
        let store = SupportThreadStore(ticketId: "t1", service: fake)
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.messages.count, 1)

        fake.thread = SupportTicketThread(
            ticket: Self.ticket(id: "t1"),
            messages: [Self.message(id: "m1", author: "you"), Self.message(id: "m2", author: "support")]
        )
        let ok = await store.reply("any update?")
        XCTAssertTrue(ok)
        XCTAssertEqual(store.messages.count, 2)
        XCTAssertEqual(fake.replyCalls, 1)
    }

    func test_thread_blankReplyDoesNotSend() async {
        let fake = FakeSupportService(tickets: [])
        let store = SupportThreadStore(ticketId: "t1", service: fake)
        let ok = await store.reply("   ")
        XCTAssertFalse(ok)
        XCTAssertEqual(fake.replyCalls, 0)
    }

    // MARK: - Attachments + close (US-2561)

    func test_create_passesAttachmentsThrough() async {
        let fake = FakeSupportService(tickets: [])
        let store = SupportTicketsStore(service: fake)
        let upload = SupportAttachmentUpload(
            dataURL: "data:image/jpeg;base64,AAA", name: "shot.jpg"
        )
        _ = await store.create(subject: "S", body: "B", attachments: [upload])
        XCTAssertEqual(fake.lastCreateAttachments, [upload])
    }

    func test_reply_passesAttachmentsThrough() async {
        let fake = FakeSupportService(tickets: [])
        let store = SupportThreadStore(ticketId: "t1", service: fake)
        let upload = SupportAttachmentUpload(
            dataURL: "data:image/jpeg;base64,BBB", name: "b.jpg"
        )
        _ = await store.reply("hello", attachments: [upload])
        XCTAssertEqual(fake.lastReplyAttachments, [upload])
    }

    func test_reply_withNoTextIsRefusedBeforeTheUpload() async {
        // The route trims the body and 400s on an empty one BEFORE it looks at
        // the attachments, so sending would mean waiting through the upload to
        // be told no.
        let fake = FakeSupportService(tickets: [])
        let store = SupportThreadStore(ticketId: "t1", service: fake)
        let sent = await store.reply(
            "   ",
            attachments: [SupportAttachmentUpload(dataURL: "data:image/jpeg;base64,C", name: "c.jpg")]
        )
        XCTAssertFalse(sent)
        XCTAssertEqual(fake.replyCalls, 0)
    }

    func test_close_callsTheEndpointAndReloads() async {
        let fake = FakeSupportService(tickets: [])
        let store = SupportThreadStore(ticketId: "t1", service: fake)
        let ok = await store.close()
        XCTAssertTrue(ok)
        XCTAssertEqual(fake.closeCalls, 1)
        // Reloaded rather than flipping the status locally: closing is
        // idempotent and a reply reopens it, so the server's row is the only
        // thing that knows the answer after either action.
        XCTAssertNotNil(store.ticket)
    }

    func test_close_surfacesAnError() async {
        let fake = FakeSupportService(tickets: [])
        fake.closeError = EdgeAPIError.network("offline")
        let store = SupportThreadStore(ticketId: "t1", service: fake)
        let ok = await store.close()
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.actionError)
    }

    func test_threadLoad_stampsFetchedAt() async {
        // Without this the attachment expiry rule has nothing to measure
        // against and every signed URL looks fresh forever.
        let fake = FakeSupportService(tickets: [])
        let store = SupportThreadStore(ticketId: "t1", service: fake)
        let before = Date()
        await store.load()
        XCTAssertGreaterThanOrEqual(store.fetchedAt, before)
    }

    // MARK: - Fixtures

    private static func ticket(id: String) -> SupportTicket {
        SupportTicket(
            id: id, subject: "Subject \(id)", status: "open", priority: "normal",
            lastMessageAt: nil, resolvedAt: nil, createdAt: nil
        )
    }

    private static func message(id: String, author: String) -> SupportTicketMessage {
        SupportTicketMessage(
            id: id, author: author, body: "Body \(id)", createdAt: nil, attachments: nil
        )
    }
}

private final class FakeSupportService: SupportTicketProviding, @unchecked Sendable {
    var tickets: [SupportTicket]
    var ticketsAfterCreate: [SupportTicket]?
    var thread: SupportTicketThread?
    var newTicketId = "ticket-id"
    var listError: Error?
    var createError: Error?
    var replyError: Error?
    private(set) var createCalls = 0
    private(set) var replyCalls = 0
    // US-2561: what the store actually handed down. A fake that only widened its
    // signatures would compile and prove nothing about the attachments arriving.
    private(set) var lastCreateAttachments: [SupportAttachmentUpload] = []
    private(set) var lastReplyAttachments: [SupportAttachmentUpload] = []
    private(set) var closeCalls = 0
    var closeError: Error?

    init(tickets: [SupportTicket] = [], listError: Error? = nil) {
        self.tickets = tickets
        self.listError = listError
    }

    func list() async throws -> [SupportTicket] {
        if let listError { throw listError }
        return tickets
    }

    func thread(id: String) async throws -> SupportTicketThread {
        if let thread { return thread }
        return SupportTicketThread(
            ticket: SupportTicket(id: id, subject: "S", status: "open", priority: nil,
                                  lastMessageAt: nil, resolvedAt: nil, createdAt: nil),
            messages: []
        )
    }

    func create(
        subject: String,
        body: String,
        attachments: [SupportAttachmentUpload]
    ) async throws -> String {
        createCalls += 1
        lastCreateAttachments = attachments
        if let createError { throw createError }
        if let after = ticketsAfterCreate { tickets = after }
        return newTicketId
    }

    func reply(
        ticketId: String,
        body: String,
        attachments: [SupportAttachmentUpload]
    ) async throws {
        replyCalls += 1
        lastReplyAttachments = attachments
        if let replyError { throw replyError }
    }

    func close(ticketId: String) async throws {
        closeCalls += 1
        if let closeError { throw closeError }
    }
}
