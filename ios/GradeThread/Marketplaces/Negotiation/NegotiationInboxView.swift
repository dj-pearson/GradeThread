import SwiftUI

/// Value-based deep-link target for the negotiation inbox (US-999). Carries an
/// optional item id so an offer/message push can filter the inbox to the
/// referenced item. Register with `.navigationDestination(for: NegotiationRoute.self)`.
struct NegotiationRoute: Hashable {
    var filterItemId: String?
}

/// Best offers + buyer messages inbox (US-673). A segmented picker switches
/// between the two; offers can be accepted / declined / countered, messages
/// replied to, and the toolbar sends a discount offer to interested buyers.
struct NegotiationInboxView: View {
    /// When set (via a notification deep link, US-999), the offers and messages
    /// lists are filtered to this inventory item.
    var filterItemId: String? = nil

    @State private var store = NegotiationStore()
    @State private var tab: Tab = .offers
    /// One optional driving ONE `.sheet(item:)`. A view has a single sheet
    /// slot, so two `.sheet` modifiers on it compete for that slot and the
    /// loser presents and is torn down in the same frame - see ``ToolModule``
    /// and `Scripts/check-chained-sheets.py`.
    @State private var sheet: NegotiationSheet?

    /// The sheets the negotiation inbox presents.
    private enum NegotiationSheet: Identifiable {
        /// Counter one buyer's best offer.
        case counter(BestOffer)
        /// Reply to one buyer message.
        case reply(BuyerMessage)
        /// US-1238: send a discount to every eligible watcher at once.
        case sendOffer

        var id: String {
            switch self {
            case .counter(let offer): return "counter-\(offer.id)"
            case .reply(let message): return "reply-\(message.id)"
            case .sendOffer:          return "sendOffer"
            }
        }
    }
    // US-1160: accepting/declining an offer resolves the eBay best offer
    // irreversibly, so it's gated behind a confirmation showing the price.
    @State private var pendingOfferAction: PendingOfferAction?

    /// Accept/decline of a specific best offer, captured for confirmation.
    private enum PendingOfferAction: Identifiable {
        case accept(BestOffer)
        case decline(BestOffer)

        var id: String {
            switch self {
            case .accept(let o): return "accept-\(o.id)"
            case .decline(let o): return "decline-\(o.id)"
            }
        }

        var offer: BestOffer {
            switch self {
            case .accept(let o), .decline(let o): return o
            }
        }

        var isAccept: Bool { if case .accept = self { return true } else { return false } }

        var confirmTitle: String { isAccept ? "Accept offer?" : "Decline offer?" }
        var confirmButton: String { isAccept ? "Accept" : "Decline" }

        var confirmMessage: String {
            let priceText = offer.price.map { $0.formatted(.currency(code: offer.currency)) }
            if isAccept {
                return "This accepts the buyer's offer\(priceText.map { " of \($0)" } ?? "") and commits the sale. This can't be undone."
            }
            return "This declines the buyer's offer\(priceText.map { " of \($0)" } ?? ""). This can't be undone."
        }
    }

    private var visibleOffers: [BestOffer] {
        guard let filterItemId else { return store.offers }
        return store.offers.filter { $0.itemId == filterItemId }
    }

    private var visibleMessages: [BuyerMessage] {
        guard let filterItemId else { return store.messages }
        return store.messages.filter { $0.itemId == filterItemId }
    }

    enum Tab: String, CaseIterable, Identifiable {
        case offers = "Offers"
        case messages = "Messages"
        var id: String { rawValue }
    }

    // US-1166/type-check budget: keep the picker+switch content out of `body` so
    // the Release whole-module build's tighter budget doesn't time out on the
    // modifier chain (the US-1160 confirmationDialog pushed it over).
    private var content: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding()

            switch tab {
            case .offers: offersList
            case .messages: messagesList
            }
        }
    }

    var body: some View {
        content
        .navigationTitle("Offers & messages")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // US-1510/US-1967: hide the send-offer entry when the server says
            // the feature can't work on this connection — resolved by the
            // capability probe in `.task` BEFORE the first render, so there's no
            // window where the button is live but doomed. It stays visible when
            // a reconnect would fix it, so the sheet can offer that fix.
            if tab == .offers && store.showSendOfferEntry {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { sheet = .sendOffer } label: {
                        Label("Send offer", systemImage: "paperplane")
                    }
                }
            }
        }
        .task {
            // US-1967: resolve the send-offer capability BEFORE the toolbar can
            // offer it — otherwise the button renders live on every fresh launch
            // and only reveals itself as dead after the seller taps it.
            await store.loadCapability()
            await store.loadOffers()
            await store.loadMessages()
        }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .counter(let offer):
                // US-1168: the sheet awaits the result and dismisses only on success.
                CounterOfferSheet(offer: offer) { price, message in
                    await store.counter(offer, price: price, message: message)
                }
            case .reply(let message):
                MessageReplySheet(message: message) { body in
                    await store.reply(to: message, body: body)
                }
            case .sendOffer:
                // US-1238: blasting a discount to every interested buyer is an
                // irreversible money action, so the sheet shows the eligible
                // count up front and gates the send behind a confirmation
                // (mirrors US-1160).
                SendOfferSheet(checkEligible: { await store.checkEligible() }) { pct, message in
                    await store.sendOfferToAllEligible(discountPercentage: pct, message: message)
                }
            }
        }
        .confirmationDialog(
            pendingOfferAction?.confirmTitle ?? "",
            isPresented: Binding(
                get: { pendingOfferAction != nil }, set: { if !$0 { pendingOfferAction = nil } }
            ),
            presenting: pendingOfferAction
        ) { action in
            // US-1192: Accept commits the sale and can't be undone, so it — not
            // Decline — gets the weighted (destructive-styled) treatment. A
            // declined offer is recoverable (the buyer can re-offer), so it reads
            // as the plain action.
            Button(action.confirmButton, role: action.isAccept ? .destructive : nil) {
                pendingOfferAction = nil
                Task {
                    if action.isAccept { await store.accept(action.offer) }
                    else { await store.decline(action.offer) }
                }
            }
            Button("Cancel", role: .cancel) { pendingOfferAction = nil }
        } message: { action in
            Text(action.confirmMessage)
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

    // MARK: - Offers

    @ViewBuilder
    private var offersList: some View {
        switch store.offersPhase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ErrorStateView(title: "Couldn't load offers", message: message, retry: { await store.loadOffers() })
        case .ready:
            if visibleOffers.isEmpty {
                // US-1970: now that the composer can enable Best Offer on the
                // phone, say how offers get here — before, a seller who only
                // ever listed from iOS had no way to turn it on, so this state
                // was permanent with nothing to act on.
                ContentUnavailableView(
                    "No active offers",
                    systemImage: "tag",
                    description: Text("Incoming best offers from buyers show up here. Turn on “Accept offers” in the composer when you publish a listing to invite them.")
                )
            } else {
                List(visibleOffers) { offer in
                    offerRow(offer)
                }
                .listStyle(.plain)
                .refreshable { await store.loadOffers() }
            }
        }
    }

    @ViewBuilder
    private func offerRow(_ offer: BestOffer) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(offer.itemTitle ?? "Item \(offer.itemId)").font(.subheadline.weight(.semibold))
            HStack {
                if let price = offer.price {
                    Text(price.formatted(.currency(code: offer.currency))).font(.brandHeadline)
                }
                if let buyer = offer.buyerUsername {
                    Text("from \(buyer)").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let message = offer.message, !message.isEmpty {
                Text(message).font(.caption).foregroundStyle(.secondary).italic()
            }
            HStack(spacing: 10) {
                Button("Accept") { pendingOfferAction = .accept(offer) }
                    .buttonStyle(.borderedProminent).tint(.brandEmerald)
                Button("Counter") { sheet = .counter(offer) }
                    .buttonStyle(.bordered)
                Button("Decline", role: .destructive) { pendingOfferAction = .decline(offer) }
                    .buttonStyle(.bordered)
            }
            .font(.caption.weight(.semibold))
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Messages

    @ViewBuilder
    private var messagesList: some View {
        switch store.messagesPhase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ErrorStateView(title: "Couldn't load messages", message: message, retry: { await store.loadMessages() })
        case .ready:
            if visibleMessages.isEmpty {
                ContentUnavailableView("No messages", systemImage: "bubble.left.and.bubble.right", description: Text("Buyer messages from the last 30 days will show up here."))
            } else {
                List(visibleMessages) { message in
                    // US-1168: only offer a reply when the message can actually be
                    // replied to in-app (has an item + sender) — otherwise show a
                    // non-interactive row, instead of failing after Send.
                    if isReplyable(message) {
                        Button { sheet = .reply(message) } label: { messageRow(message) }
                            .tint(.primary)
                    } else {
                        messageRow(message)
                    }
                }
                .listStyle(.plain)
                .refreshable { await store.loadMessages() }
            }
        }
    }

    @ViewBuilder
    private func messageRow(_ message: BuyerMessage) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(message.senderUsername ?? "Buyer").font(.subheadline.weight(.semibold))
                Spacer()
                if message.answered {
                    Text("Replied").font(.caption2.weight(.semibold)).foregroundStyle(.brandEmerald)
                }
            }
            if let subject = message.subject, !subject.isEmpty {
                Text(subject).font(.caption.weight(.medium))
            }
            if let body = message.body {
                Text(body).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            if !isReplyable(message) {
                Text("Can't reply to this message in-app")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    /// US-1168: a message is replyable only when it carries the item + sender the
    /// eBay reply API needs (mirrors NegotiationStore.reply's guard).
    private func isReplyable(_ message: BuyerMessage) -> Bool {
        message.itemId != nil && message.senderUsername != nil
    }
}

// MARK: - Sheets

private struct CounterOfferSheet: View {
    let offer: BestOffer
    /// US-1168: async + returns success so the sheet stays open (with an error)
    /// on failure and dismisses only when the counter actually sent.
    let onSubmit: (Double, String?) async -> Bool
    /// US-1168: AI counter draft + validation. Injectable so the sheet is testable.
    var drafter: NegotiationDrafting = NegotiationDraftService()
    @Environment(\.dismiss) private var dismiss
    @State private var priceText = ""
    @State private var message = ""
    @State private var isSubmitting = false
    @State private var isDrafting = false
    @State private var draftWarnings: [String] = []
    @State private var errorMessage: String?

    // US-1517: evaluated per keystroke — use the shared formatter, not a fresh
    // 2-NumberFormatter construction each time.
    private var price: Double? { CurrencyFormatter.shared.parse(priceText) }

    /// US-1168: a counter at or below the buyer's own offer makes no sense.
    private var belowOffer: Bool {
        guard let price, let offerPrice = offer.price else { return false }
        return price <= offerPrice
    }

    private var canSend: Bool { (price ?? 0) > 0 && !belowOffer && !isSubmitting }

    var body: some View {
        NavigationStack {
            Form {
                Section("Counter price") {
                    TextField("Amount", text: $priceText).keyboardType(.decimalPad).disabled(isSubmitting)
                    if let offerPrice = offer.price {
                        Text("Buyer offered \(offerPrice.formatted(.currency(code: offer.currency)))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if belowOffer {
                        Text("Counter is at or below the buyer's offer — enter a higher price.")
                            .font(.caption).foregroundStyle(Color.brandRed)
                    }
                    Button {
                        draft()
                    } label: {
                        if isDrafting { ProgressView() }
                        else { Label("Draft with AI", systemImage: "sparkles") }
                    }
                    .disabled(isDrafting || isSubmitting)
                    ForEach(draftWarnings, id: \.self) { warning in
                        Text(warning).font(.caption).foregroundStyle(Color.brandRed)
                    }
                }
                Section("Message (optional)") {
                    TextField("Note to buyer", text: $message, axis: .vertical).lineLimit(2...4).disabled(isSubmitting)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.callout).foregroundStyle(Color.brandRed) }
                }
            }
            .keyboardDoneToolbar()
            .navigationTitle("Counter offer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isSubmitting) }
                ToolbarItem(placement: .confirmationAction) {
                    if isSubmitting { ProgressView() }
                    else { Button("Send") { submit() }.disabled(!canSend) }
                }
            }
        }
        // US-1513: a swipe-down mustn't discard a typed counter (or tear the
        // sheet down mid-send) — Cancel stays the explicit exit. FeedbackSheet
        // pattern.
        .interactiveDismissDisabled(isSubmitting || !priceText.isEmpty || !message.isEmpty)
    }

    private func submit() {
        guard let price, canSend else { return }
        Task {
            isSubmitting = true
            errorMessage = nil
            let ok = await onSubmit(price, message.isEmpty ? nil : message)
            isSubmitting = false
            if ok { dismiss() } else { errorMessage = "Couldn't send your counter. Please try again." }
        }
    }

    /// US-1168: ask the edge for a suggested counter + drafted note, prefilling
    /// the price (only when the seller hasn't typed one) and the message.
    private func draft() {
        Task {
            isDrafting = true
            errorMessage = nil
            draftWarnings = []
            do {
                let result = try await drafter.draft(
                    itemId: offer.itemId, mode: .counter, offerPrice: offer.price,
                    currency: offer.currency, buyerMessage: offer.message,
                    proposedCounter: price
                )
                if priceText.isEmpty, let suggested = result.suggestedCounter {
                    // US-1491: seed with the locale-aware formatter so the seed
                    // format matches `price`'s parser. String(format:) always
                    // uses a "." decimal, which the comma-decimal parser reads as
                    // grouping → a 100× inflated counter-offer.
                    priceText = CurrencyFormatter.shared.formatRaw(suggested)
                }
                if message.isEmpty { message = result.message }
                draftWarnings = result.warnings
            } catch {
                errorMessage = error.localizedDescription
            }
            isDrafting = false
        }
    }
}

private struct MessageReplySheet: View {
    let message: BuyerMessage
    let onSubmit: (String) async -> Bool // US-1168: async + success
    /// US-1168: AI reply draft. Injectable so the sheet is testable.
    var drafter: NegotiationDrafting = NegotiationDraftService()
    @Environment(\.dismiss) private var dismiss
    @State private var replyText = ""
    @State private var isSubmitting = false
    @State private var isDrafting = false
    @State private var errorMessage: String?

    private var canSend: Bool {
        !replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
    }

    var body: some View {
        NavigationStack {
            Form {
                if let original = message.body {
                    Section("Buyer wrote") { Text(original).font(.callout) }
                }
                Section("Your reply") {
                    TextField("Reply…", text: $replyText, axis: .vertical).lineLimit(3...8).disabled(isSubmitting)
                    Button {
                        draft()
                    } label: {
                        if isDrafting { ProgressView() }
                        else { Label("Draft with AI", systemImage: "sparkles") }
                    }
                    .disabled(isDrafting || isSubmitting)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.callout).foregroundStyle(Color.brandRed) }
                }
            }
            .navigationTitle("Reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isSubmitting) }
                ToolbarItem(placement: .confirmationAction) {
                    if isSubmitting { ProgressView() }
                    else { Button("Send") { submit() }.disabled(!canSend) }
                }
            }
        }
        // US-1513: don't let a swipe-down discard a typed reply / interrupt a send.
        .interactiveDismissDisabled(isSubmitting || !replyText.isEmpty)
    }

    private func submit() {
        guard canSend else { return }
        Task {
            isSubmitting = true
            errorMessage = nil
            let ok = await onSubmit(replyText)
            isSubmitting = false
            if ok { dismiss() } else { errorMessage = "Couldn't send your reply. Please try again." }
        }
    }

    /// US-1168: ask the edge for a drafted reply to the buyer's message,
    /// prefilling the reply field only when the seller hasn't typed anything.
    private func draft() {
        guard let itemId = message.itemId else { return }
        Task {
            isDrafting = true
            errorMessage = nil
            do {
                let result = try await drafter.draft(
                    itemId: itemId, mode: .reply, offerPrice: nil,
                    currency: "USD", buyerMessage: message.body,
                    proposedCounter: nil
                )
                if replyText.isEmpty { replyText = result.message }
            } catch {
                errorMessage = error.localizedDescription
            }
            isDrafting = false
        }
    }
}

private struct SendOfferSheet: View {
    /// US-1238: count eligible listings up front so the seller sees how many
    /// buyers this blast reaches before confirming. US-1510: the probe result
    /// distinguishes feature-unavailable (send is a guaranteed failure — gate
    /// it) from a transient count failure (degrade to generic confirmation).
    let checkEligible: () async -> NegotiationStore.EligibleCheck
    let onSubmit: (String, String?) async -> Bool // US-1168: async + success
    @Environment(\.dismiss) private var dismiss
    @State private var discount: Double = 10
    @State private var message = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    // US-1238: eligible-count load + send confirmation.
    @State private var eligibleCheck: NegotiationStore.EligibleCheck?
    @State private var isLoadingCount = true
    @State private var showConfirm = false

    private var eligibleCount: Int? {
        if case .count(let n) = eligibleCheck { return n }
        return nil
    }

    /// US-1510: the server said send-offer can't work on this connection.
    private var isUnavailable: Bool {
        if case .unavailable = eligibleCheck { return true }
        return false
    }

    /// US-1421: the server's gate copy (reconnect vs not-available-yet).
    private var unavailableDetail: String? {
        if case .unavailable(let detail) = eligibleCheck { return detail }
        return nil
    }

    private func listingLabel(_ count: Int) -> String {
        "\(count) listing\(count == 1 ? "" : "s")"
    }

    private var confirmMessage: String {
        if let eligibleCount {
            return "This sends a \(Int(discount))% offer to interested buyers on \(listingLabel(eligibleCount)). This can't be undone."
        }
        return "This sends a \(Int(discount))% offer to interested buyers on all eligible listings. This can't be undone."
    }

    private var confirmButtonLabel: String {
        if let eligibleCount, eligibleCount > 0 { return "Send to \(listingLabel(eligibleCount))" }
        return "Send offer"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading) {
                        Text("Discount: \(Int(discount))%")
                        Slider(value: $discount, in: 5...50, step: 5).disabled(isSubmitting)
                    }
                } header: {
                    Text("Offer to interested buyers")
                } footer: {
                    Text("Sends a limited-time offer to buyers who've shown interest (watchers / cart) on all eligible listings.")
                }
                Section("Eligible listings") {
                    if isLoadingCount {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Checking eligible listings…").foregroundStyle(.secondary)
                        }
                    } else if isUnavailable {
                        // US-1510: sending is a guaranteed failure here — say so
                        // calmly instead of the old "you can still send" (which
                        // walked the user into "eBay rejected the offer.").
                        // US-1421: prefer the server's own copy — the
                        // reconnect_required variant tells the seller the fix
                        // (reconnect) instead of an indefinite wait.
                        Label(
                            unavailableDetail
                                ?? "Sending offers to interested buyers isn't available yet. It switches on automatically once eBay enables it for GradeThread.",
                            systemImage: "hourglass"
                        )
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    } else if let eligibleCount {
                        Text(eligibleCount == 0
                            ? "No listings are currently eligible for an offer."
                            : "\(listingLabel(eligibleCount)) will receive this offer.")
                            .font(.callout)
                            .foregroundStyle(eligibleCount == 0 ? .secondary : .primary)
                    } else {
                        Text("Couldn't check eligible listings — you can still send.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                Section("Message (optional)") {
                    TextField("Note to buyers", text: $message, axis: .vertical).lineLimit(2...4).disabled(isSubmitting)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.callout).foregroundStyle(Color.brandRed) }
                }
            }
            .navigationTitle("Send offer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isSubmitting) }
                ToolbarItem(placement: .confirmationAction) {
                    if isSubmitting { ProgressView() }
                    // US-1238: require confirmation; disable when nothing is
                    // eligible. US-1510: also when the feature is unavailable.
                    else {
                        Button("Send") { showConfirm = true }
                            .disabled(eligibleCount == 0 || isUnavailable)
                    }
                }
            }
            .task {
                isLoadingCount = true
                eligibleCheck = await checkEligible()
                isLoadingCount = false
            }
            .confirmationDialog(
                "Send \(Int(discount))% offer?",
                isPresented: $showConfirm,
                titleVisibility: .visible
            ) {
                Button(confirmButtonLabel) { submit() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(confirmMessage)
            }
        }
        // US-1513: a swipe-down mustn't discard a typed buyer note or interrupt
        // an in-flight send — Cancel stays the explicit exit.
        .interactiveDismissDisabled(isSubmitting || !message.isEmpty)
    }

    private func submit() {
        Task {
            isSubmitting = true
            errorMessage = nil
            let ok = await onSubmit(String(Int(discount)), message.isEmpty ? nil : message)
            isSubmitting = false
            if ok { dismiss() } else { errorMessage = "Couldn't send the offer. Please try again." }
        }
    }
}
