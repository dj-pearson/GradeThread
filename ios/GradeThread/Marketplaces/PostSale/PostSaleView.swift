import PhotosUI
import SwiftUI
import UIKit

/// eBay returns, cancellations, and payment disputes (US-1043 / US-1049). A
/// segmented picker switches between the three; each item has its decision
/// actions (approve/decline/refund, approve/reject, accept/contest).
struct PostSaleView: View {
    @State private var store = PostSaleStore()
    // US-1178: Returns are far more common than Disputes — open there, and
    // after load jump to whichever tab actually has items so the screen isn't
    // empty on arrival.
    @State private var tab: Tab = .returns
    /// One optional driving ONE `.sheet(item:)`. A view has a single sheet
    /// slot, so two `.sheet` modifiers on it compete for that slot and the
    /// loser presents and is torn down in the same frame — see ``ToolModule``
    /// and `Scripts/check-chained-sheets.py`.
    @State private var sheet: PostSaleSheet?

    /// The sheets the post-sale screen presents.
    private enum PostSaleSheet: Identifiable {
        /// Contest a payment dispute.
        case contest(EbayPaymentDispute)
        /// Pick a photo to attach as evidence.
        case evidencePicker

        var id: String {
            switch self {
            case .contest(let dispute): return "contest-\(dispute.id)"
            case .evidencePicker:       return "evidencePicker"
            }
        }
    }
    @State private var evidenceTarget: EbayPaymentDispute?
    // US-1160: irreversible, money-moving actions are gated behind a single
    // confirmation dialog so a mis-tap can't refund/decline/cancel an order.
    @State private var pendingAction: PendingAction?

    enum Tab: String, CaseIterable, Identifiable {
        case disputes = "Disputes"
        case returns = "Returns"
        case cancellations = "Cancellations"
        var id: String { rawValue }
    }

    /// One of the irreversible buyer-facing actions, captured so it can be
    /// confirmed before it runs. The associated value carries the target row.
    private enum PendingAction: Identifiable {
        case acceptDispute(EbayPaymentDispute)
        // US-1497: Approve now routes through the same confirmation dialog as the
        // other irreversible return decisions (it was fire-and-forget before).
        case approveReturn(EbayReturn)
        case declineReturn(EbayReturn)
        case refundReturn(EbayReturn)
        case approveCancellation(EbayCancellation)
        case rejectCancellation(EbayCancellation)

        var id: String {
            switch self {
            case .acceptDispute(let d): return "acceptDispute-\(d.id)"
            case .approveReturn(let r): return "approveReturn-\(r.id)"
            case .declineReturn(let r): return "declineReturn-\(r.id)"
            case .refundReturn(let r): return "refundReturn-\(r.id)"
            case .approveCancellation(let c): return "approveCancellation-\(c.id)"
            case .rejectCancellation(let c): return "rejectCancellation-\(c.id)"
            }
        }

        var confirmTitle: String {
            switch self {
            case .acceptDispute: return "Accept & refund?"
            case .approveReturn: return "Approve return?"
            case .declineReturn: return "Decline return?"
            case .refundReturn: return "Refund buyer?"
            case .approveCancellation: return "Approve & cancel order?"
            case .rejectCancellation: return "Reject cancellation?"
            }
        }

        var confirmButton: String {
            switch self {
            case .acceptDispute: return "Accept & refund"
            case .approveReturn: return "Approve"
            case .declineReturn: return "Decline"
            case .refundReturn: return "Refund"
            case .approveCancellation: return "Approve & cancel"
            case .rejectCancellation: return "Reject"
            }
        }

        var confirmMessage: String {
            switch self {
            case .acceptDispute(let d):
                let amount = d.amount?.formatted(.currency(code: d.currency ?? "USD"))
                return "This refunds the buyer\(amount.map { " \($0)" } ?? "") and closes the dispute. This can't be undone."
            case .approveReturn:
                return "This approves the buyer's return request. This can't be undone."
            case .declineReturn:
                return "This declines the buyer's return request. This can't be undone."
            case .refundReturn:
                return "This issues a refund to the buyer. This can't be undone."
            case .approveCancellation:
                return "This cancels the order and refunds the buyer. This can't be undone."
            case .rejectCancellation:
                return "This rejects the buyer's cancellation request. This can't be undone."
            }
        }
    }

    // US-1166/type-check budget: the picker+switch content lives in its own
    // property so `body` only type-checks the modifier chain against an opaque
    // view — the Release (whole-module) build's tighter budget otherwise timed
    // out on this body after the US-1160 confirmationDialog was added.
    private var content: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                ForEach(Tab.allCases) { Text(tabLabel($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding()

            switch tab {
            case .disputes: disputesList
            case .returns: returnsList
            case .cancellations: cancellationsList
            }
        }
    }

    var body: some View {
        content
        .navigationTitle("Returns & disputes")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.loadAll()
            // Land on a tab that has items (returns first, then cancellations,
            // then disputes) so the user doesn't arrive on an empty section.
            if store.returns.isEmpty {
                if !store.cancellations.isEmpty { tab = .cancellations }
                else if !store.disputes.isEmpty { tab = .disputes }
            }
        }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .contest(let dispute):
                ContestSheet(dispute: dispute) { note in
                    // US-1192: await the result; the sheet only dismisses on success.
                    await store.contestDispute(dispute, note: note)
                }
            case .evidencePicker:
                PhotoLibraryPicker(selectionLimit: 1) { results in
                    handleEvidencePick(results)
                }
            }
        }
        .confirmationDialog(
            pendingAction?.confirmTitle ?? "",
            isPresented: Binding(
                get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } }
            ),
            presenting: pendingAction
        ) { action in
            Button(action.confirmButton, role: .destructive) {
                pendingAction = nil
                Task { await perform(action) }
            }
            Button("Cancel", role: .cancel) { pendingAction = nil }
        } message: { action in
            Text(action.confirmMessage)
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.actionError != nil }, set: { if !$0 { store.actionError = nil } }
        )) {
            // US-1146: a failed (non-idempotent) evidence upload offers an
            // explicit Retry instead of being lost when the toast is dismissed.
            if store.pendingEvidenceRetry != nil {
                Button("Retry") { Task { await store.retryEvidenceUpload() } }
                Button("Cancel", role: .cancel) { store.pendingEvidenceRetry = nil }
            } else {
                Button("OK", role: .cancel) {}
            }
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
            ErrorStateView(title: "Couldn't load disputes", message: message, retry: { await store.loadDisputes() })
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
            // US-1178: show an inline progress row while an evidence upload is
            // in flight (the picker is already dismissed, so it'd look frozen).
            if store.evidenceUploadingId == d.paymentDisputeId {
                HStack(spacing: 6) {
                    ProgressView()
                    Text("Uploading evidence…").font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 10) {
                Button("Evidence") {
                    evidenceTarget = d
                    sheet = .evidencePicker
                }
                .buttonStyle(.bordered)
                .disabled(store.evidenceUploadingId == d.paymentDisputeId)
                Button("Contest") { sheet = .contest(d) }
                    .buttonStyle(.bordered)
                Button("Accept & refund", role: .destructive) { pendingAction = .acceptDispute(d) }
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
            ErrorStateView(title: "Couldn't load returns", message: message, retry: { await store.loadReturns() })
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
                Button("Decline", role: .destructive) { pendingAction = .declineReturn(r) }
                    .buttonStyle(.bordered)
                Button("Approve") { pendingAction = .approveReturn(r) }
                    .buttonStyle(.bordered)
                Button("Refund") { pendingAction = .refundReturn(r) }
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
            ErrorStateView(title: "Couldn't load cancellations", message: message, retry: { await store.loadCancellations() })
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
                Button("Reject", role: .destructive) { pendingAction = .rejectCancellation(ca) }
                    .buttonStyle(.bordered)
                Button("Approve & cancel") { pendingAction = .approveCancellation(ca) }
                    .buttonStyle(.borderedProminent)
            }
            .font(.caption.weight(.semibold))
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    /// US-1178: segment label with a non-zero count so open work is visible.
    private func tabLabel(_ tab: Tab) -> String {
        let count: Int
        switch tab {
        case .disputes: count = store.disputes.count
        case .returns: count = store.returns.count
        case .cancellations: count = store.cancellations.count
        }
        return count > 0 ? "\(tab.rawValue) (\(count))" : tab.rawValue
    }

    /// Runs the confirmed irreversible action against the store.
    private func perform(_ action: PendingAction) async {
        switch action {
        case .acceptDispute(let d): await store.acceptDispute(d)
        case .approveReturn(let r): await store.approveReturn(r)
        case .declineReturn(let r): await store.declineReturn(r)
        case .refundReturn(let r): await store.refundReturn(r)
        case .approveCancellation(let c): await store.approveCancellation(c)
        case .rejectCancellation(let c): await store.rejectCancellation(c)
        }
    }

    // MARK: - Evidence

    /// Loads the picked photo, re-encodes as JPEG, and uploads it to eBay as
    /// dispute evidence. The contest action is separate — evidence can be
    /// attached first, then the dispute contested.
    private func handleEvidencePick(_ results: [PHPickerResult]) {
        sheet = nil
        guard let target = evidenceTarget, let result = results.first else { return }
        Task {
            // Route through PhotoCompressor rather than encoding here. Its own
            // header explains why this matters for THIS destination: camera and
            // library UIImages carry orientation as a flag with pixels in the
            // sensor's native rotation, and "consumers that ignore EXIF (eBay's
            // image pipeline does) then render them sideways/upside-down". This
            // path uploads straight to eBay as dispute evidence, so a bare
            // jpegData() encode could submit rotated evidence at the single
            // highest-stakes moment a seller has — contesting a case.
            //
            // It also gets the 1600px/0.75 downscale (full-res originals are
            // 3-10 MB) and moves the encode off the MainActor, which this
            // Task inherits from the enclosing View.
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(image) else {
                store.actionError = "Couldn't read the selected photo."
                return
            }
            await store.uploadDisputeEvidence(target, imageData: output.imageData)
            evidenceTarget = nil
        }
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
    /// US-1192: async + returns success so the sheet stays open (keeping the
    /// typed note) when a deadline-bound contest fails, mirroring the
    /// CounterOffer / MessageReply sheets.
    let onSubmit: (String?) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var submitting = false

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
                        .disabled(submitting)
                }
            }
            .navigationTitle("Contest dispute")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(submitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(submitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if submitting {
                        ProgressView()
                    } else {
                        Button("Contest") {
                            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                            submitting = true
                            Task {
                                let ok = await onSubmit(trimmed.isEmpty ? nil : trimmed)
                                submitting = false
                                if ok { dismiss() }
                            }
                        }
                    }
                }
            }
        }
    }
}
