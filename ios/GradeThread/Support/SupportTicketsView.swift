import SwiftUI

/// Native support inbox (US-1136): a ticket list + threaded reply view backed by
/// the authed `/api/support-tickets` endpoints. Presented as a sheet from
/// Settings, from the FeedbackSheet escalation, and from a deep link (a
/// `support.reply` push). Owns its own ``NavigationStack`` so it works the same
/// in every presentation context.
struct SupportTicketsView: View {
    /// Deep-link target: open straight into this ticket's thread.
    var initialTicketId: String?
    /// FeedbackSheet escalation: open the composer pre-filled with this body.
    var initialDraftBody: String?

    @Environment(\.dismiss) private var dismiss
    @State private var store = SupportTicketsStore()
    @State private var path: [String] = []
    @State private var composing = false
    @State private var composeDraft: String?
    @State private var didApplyInitial = false

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Support")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            composeDraft = nil
                            composing = true
                        } label: {
                            Label("New ticket", systemImage: "square.and.pencil")
                        }
                        .accessibilityLabel("New ticket")
                    }
                }
                .navigationDestination(for: String.self) { ticketId in
                    SupportTicketThreadView(ticketId: ticketId)
                }
        }
        .task { await applyInitialIfNeeded() }
        .sheet(isPresented: $composing) {
            SupportTicketComposer(store: store, prefillBody: composeDraft) { newId in
                composeDraft = nil
                path = [newId]
            }
        }
        .alert(
            "Couldn't open ticket",
            isPresented: Binding(
                get: { store.actionError != nil },
                set: { if !$0 { store.actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading where store.isEmpty:
            ProgressView("Loading…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(uiColor: .systemGroupedBackground))
        case .failed(let message) where store.isEmpty:
            ErrorStateView(message: message, retry: { await store.load() })
                .background(Color(uiColor: .systemGroupedBackground))
        default:
            ticketList
        }
    }

    @ViewBuilder
    private var ticketList: some View {
        if store.isEmpty {
            ContentUnavailableView {
                Label("No tickets yet", systemImage: "bubble.left.and.bubble.right")
            } description: {
                Text("Open a request and we'll reply right here in the app — no email needed.")
            } actions: {
                Button {
                    composeDraft = nil
                    composing = true
                } label: {
                    Label("Contact support", systemImage: "square.and.pencil")
                        .frame(minWidth: 160)
                }
                .buttonStyle(.brandSecondary)
            }
            .background(Color(uiColor: .systemGroupedBackground))
        } else {
            List {
                ForEach(store.tickets) { ticket in
                    NavigationLink(value: ticket.id) {
                        ticketRow(ticket)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await store.load() }
        }
    }

    @ViewBuilder
    private func ticketRow(_ ticket: SupportTicket) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(ticket.subject)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 8)
                SupportStatusBadge(status: ticket.displayStatus)
            }
            let updated = SupportTicketFormat.relative(ticket.lastMessageAt)
            if !updated.isEmpty {
                Text("Updated \(updated)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func applyInitialIfNeeded() async {
        if !didApplyInitial {
            didApplyInitial = true
            // A non-nil draft means the user escalated from the FeedbackSheet —
            // open the composer (prefilled only when they'd typed something).
            if let body = initialDraftBody {
                let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
                composeDraft = trimmed.isEmpty ? nil : trimmed
                composing = true
            } else if let id = initialTicketId {
                path = [id]
            }
        }
        await store.load()
    }
}

/// Small status pill mirroring the web inbox's colored badge.
private struct SupportStatusBadge: View {
    let status: SupportTicketStatus

    var body: some View {
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
    }

    private var tint: Color {
        switch status {
        case .open:     return .brandNavy
        case .pending:  return .orange
        case .resolved: return .brandEmerald
        case .closed:   return .secondary
        }
    }
}

// MARK: - Composer

/// Opens a new ticket (subject + first message). Pre-fills the body when the
/// user escalated from the FeedbackSheet.
private struct SupportTicketComposer: View {
    let store: SupportTicketsStore
    var prefillBody: String?
    let onOpened: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var subject = ""
    @State private var messageBody = ""
    @State private var isSending = false

    private static let maxSubject = 200
    private static let maxBody = 4000

    private var canSubmit: Bool {
        !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !messageBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSending
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Subject") {
                    TextField("Briefly, what do you need help with?", text: $subject)
                        .disabled(isSending)
                        .onChange(of: subject) { _, new in
                            if new.count > Self.maxSubject {
                                subject = String(new.prefix(Self.maxSubject))
                            }
                        }
                }
                Section {
                    TextField(
                        "Share as much detail as you can…",
                        text: $messageBody,
                        axis: .vertical
                    )
                    .lineLimit(5...12)
                    .disabled(isSending)
                    .onChange(of: messageBody) { _, new in
                        if new.count > Self.maxBody {
                            messageBody = String(new.prefix(Self.maxBody))
                        }
                    }
                } header: {
                    Text("Message")
                } footer: {
                    Text("Goes to the Pearson Media team. We'll reply right here in the app.")
                }
            }
            .navigationTitle("Contact support")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submit() }
                    } label: {
                        if isSending { ProgressView() } else { Text("Send") }
                    }
                    .disabled(!canSubmit)
                }
            }
            .onAppear {
                if let prefillBody, messageBody.isEmpty { messageBody = prefillBody }
            }
        }
        .interactiveDismissDisabled(isSending)
    }

    private func submit() async {
        isSending = true
        defer { isSending = false }
        if let id = await store.create(subject: subject, body: messageBody) {
            HapticFeedback.success()
            dismiss()
            onOpened(id)
        } else {
            HapticFeedback.error()
            // store.actionError is surfaced by the parent's alert.
            dismiss()
        }
    }
}

// MARK: - Thread

/// One ticket's thread + a reply composer. Pushed onto the inbox's stack.
private struct SupportTicketThreadView: View {
    let ticketId: String

    @State private var store: SupportThreadStore
    @State private var reply = ""
    @State private var isSending = false

    init(ticketId: String) {
        self.ticketId = ticketId
        _store = State(initialValue: SupportThreadStore(ticketId: ticketId))
    }

    var body: some View {
        Group {
            switch store.phase {
            case .loading where store.messages.isEmpty:
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message) where store.messages.isEmpty:
                ErrorStateView(message: message, retry: { await store.load() })
            default:
                thread
            }
        }
        .navigationTitle(store.ticket?.subject ?? "Ticket")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load() }
        .alert(
            "Couldn't send reply",
            isPresented: Binding(
                get: { store.actionError != nil },
                set: { if !$0 { store.actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
    }

    private var thread: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let status = store.ticket?.displayStatus {
                        HStack {
                            SupportStatusBadge(status: status)
                            Spacer()
                        }
                    }
                    ForEach(store.messages) { message in
                        messageBubble(message)
                    }
                    if store.messages.isEmpty {
                        Text("No messages yet.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                    }
                }
                .padding(16)
            }
            .refreshable { await store.load() }

            replyBar
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    @ViewBuilder
    private func messageBubble(_ message: SupportTicketMessage) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(message.isFromUser ? "You" : "Support")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                let when = SupportTicketFormat.relative(message.createdAt)
                if !when.isEmpty {
                    Text(when)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Text(message.body)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .background(
            (message.isFromUser ? Color(uiColor: .secondarySystemBackground)
                                : Color.brandNavy.opacity(0.08)),
            in: RoundedRectangle(cornerRadius: 12)
        )
    }

    private var replyBar: some View {
        VStack(spacing: 8) {
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Add a reply…", text: $reply, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isSending)
                Button {
                    Task { await send() }
                } label: {
                    if isSending {
                        ProgressView()
                    } else {
                        Image(systemName: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.brandNavy)
                .disabled(isSending || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send reply")
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
        .background(.bar)
    }

    private func send() async {
        isSending = true
        defer { isSending = false }
        let sent = await store.reply(reply)
        if sent {
            reply = ""
            HapticFeedback.success()
        } else {
            HapticFeedback.error()
        }
    }
}
