import SwiftUI

/// eBay returns, cancellations, and payment disputes (US-1043 / US-1049). A
/// segmented picker switches between the three; each item has its decision
/// actions (approve/decline/refund, approve/reject, accept/contest).
struct PostSaleView: View {
    @State private var store = PostSaleStore()
    @State private var tab: Tab = .disputes
    @State private var contesting: EbayPaymentDispute?

    enum Tab: String, CaseIterable, Identifiable {
        case disputes = "Disputes"
        case returns = "Returns"
        case cancellations = "Cancellations"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding()

            switch tab {
            case .disputes: disputesList
            case .returns: returnsList
            case .cancellations: cancellationsList
            }
        }
        .navigationTitle("Returns & disputes")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.loadAll() }
        .sheet(item: $contesting) { dispute in
            ContestSheet(dispute: dispute) { note in
                Task { await store.contestDispute(dispute, note: note) }
            }
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.actionError != nil }, set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(store.actionError ?? "") }
        .overlay(alignment: .bottom) {
            if let banner = store.actionBanner {
                Text(banner)
                    .font(.footnote).padding(10)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 12)
                    .task {
                        try? await Task.sleep(nanoseconds: 2_500_000_000)
                        store.actionBanner = nil
                    }
            }
        }
    }

    // MARK: - Disputes

    @ViewBuilder
    private var disputesList: some View {
        switch store.disputesPhase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView("Couldn't load disputes", systemImage: "exclamationmark.triangle", description: Text(message))
        case .ready:
            if store.disputes.isEmpty {
                ContentUnavailableView("No payment disputes", systemImage: "checkmark.shield", description: Text("Buyer-opened payment disputes will show up here."))
            } else {
                List(store.disputes) { disputeRow($0) }
                    .listStyle(.plain)
                    .refreshable { await store.loadDisputes() }
            }
        }
    }

    @ViewBuilder
    private func disputeRow(_ d: EbayPaymentDispute) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(humanize(d.reason) ?? "Payment dispute").font(.subheadline.weight(.semibold))
                Spacer()
                if let amount = d.amount {
                    Text(amount.formatted(.currency(code: d.currency ?? "USD"))).font(.brandHeadline)
                }
            }
            if let respondBy = displayDate(d.respondByDate) {
                Text("Respond by \(respondBy)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.red)
            }
            if let buyer = d.buyerUsername {
                Text("Order \(d.orderId ?? "—") · \(buyer)").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Button("Contest") { contesting = d }
                    .buttonStyle(.bordered)
                Button("Accept & refund", role: .destructive) { Task { await store.acceptDispute(d) } }
                    .buttonStyle(.borderedProminent)
            }
            .font(.caption.weight(.semibold))
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Returns

    @ViewBuilder
    private var returnsList: some View {
        switch store.returnsPhase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView("Couldn't load returns", systemImage: "exclamationmark.triangle", description: Text(message))
        case .ready:
            if store.returns.isEmpty {
                ContentUnavailableView("No open returns", systemImage: "arrow.uturn.backward", description: Text("Buyer return requests will show up here."))
            } else {
                List(store.returns) { returnRow($0) }
                    .listStyle(.plain)
                    .refreshable { await store.loadReturns() }
            }
        }
    }

    @ViewBuilder
    private func returnRow(_ r: EbayReturn) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(humanize(r.reason) ?? "Return request").font(.subheadline.weight(.semibold))
            if let state = r.state {
                Text(humanize(state) ?? state).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Button("Decline", role: .destructive) { Task { await store.declineReturn(r) } }
                    .buttonStyle(.bordered)
                Button("Approve") { Task { await store.approveReturn(r) } }
                    .buttonStyle(.bordered)
                Button("Refund") { Task { await store.refundReturn(r) } }
                    .buttonStyle(.borderedProminent)
            }
            .font(.caption.weight(.semibold))
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Cancellations

    @ViewBuilder
    private var cancellationsList: some View {
        switch store.cancellationsPhase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView("Couldn't load cancellations", systemImage: "exclamationmark.triangle", description: Text(message))
        case .ready:
            if store.cancellations.isEmpty {
                ContentUnavailableView("No cancellation requests", systemImage: "xmark.bin", description: Text("Buyer cancellation requests will show up here."))
            } else {
                List(store.cancellations) { cancellationRow($0) }
                    .listStyle(.plain)
                    .refreshable { await store.loadCancellations() }
            }
        }
    }

    @ViewBuilder
    private func cancellationRow(_ ca: EbayCancellation) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(humanize(ca.reason) ?? "Cancellation").font(.subheadline.weight(.semibold))
            Text("Order \(ca.orderId ?? "—")\(ca.requestorType.map { " · \($0.lowercased())" } ?? "")")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button("Reject", role: .destructive) { Task { await store.rejectCancellation(ca) } }
                    .buttonStyle(.bordered)
                Button("Approve & cancel") { Task { await store.approveCancellation(ca) } }
                    .buttonStyle(.borderedProminent)
            }
            .font(.caption.weight(.semibold))
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Helpers

    /// Turn an eBay enum-ish token ("ITEM_NOT_RECEIVED") into "Item not received".
    private func humanize(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let words = raw.replacingOccurrences(of: "_", with: " ").lowercased()
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// Parse an ISO8601 string and render a short date, or nil.
    private func displayDate(_ iso: String?) -> String? {
        guard let iso, let date = ISO8601DateFormatter().date(from: iso) else { return nil }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

// MARK: - Contest sheet

private struct ContestSheet: View {
    let dispute: EbayPaymentDispute
    let onSubmit: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Explain to eBay why you're contesting this dispute. You can add evidence on eBay afterwards.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Section("Note (optional)") {
                    TextField("e.g. Tracking shows delivered…", text: $note, axis: .vertical)
                        .lineLimit(3...6)
                }
            }
            .navigationTitle("Contest dispute")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Contest") {
                        onSubmit(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : note)
                        dismiss()
                    }
                }
            }
        }
    }
}
