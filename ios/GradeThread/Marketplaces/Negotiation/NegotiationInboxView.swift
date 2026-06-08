import SwiftUI

/// Best offers + buyer messages inbox (US-673). A segmented picker switches
/// between the two; offers can be accepted / declined / countered, messages
/// replied to, and the toolbar sends a discount offer to interested buyers.
struct NegotiationInboxView: View {
    @State private var store = NegotiationStore()
    @State private var tab: Tab = .offers
    @State private var countering: BestOffer?
    @State private var replying: BuyerMessage?
    @State private var showSendOffer = false

    enum Tab: String, CaseIterable, Identifiable {
        case offers = "Offers"
        case messages = "Messages"
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
            case .offers: offersList
            case .messages: messagesList
            }
        }
        .navigationTitle("Offers & messages")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if tab == .offers {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSendOffer = true } label: {
                        Label("Send offer", systemImage: "paperplane")
                    }
                }
            }
        }
        .task {
            await store.loadOffers()
            await store.loadMessages()
        }
        .sheet(item: $countering) { offer in
            CounterOfferSheet(offer: offer) { price, message in
                Task { await store.counter(offer, price: price, message: message) }
            }
        }
        .sheet(item: $replying) { message in
            MessageReplySheet(message: message) { body in
                Task { _ = await store.reply(to: message, body: body) }
            }
        }
        .sheet(isPresented: $showSendOffer) {
            SendOfferSheet { pct, message in
                Task { await store.sendOfferToAllEligible(discountPercentage: pct, message: message) }
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

    // MARK: - Offers

    @ViewBuilder
    private var offersList: some View {
        switch store.offersPhase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView("Couldn't load offers", systemImage: "exclamationmark.triangle", description: Text(message))
        case .ready:
            if store.offers.isEmpty {
                ContentUnavailableView("No active offers", systemImage: "tag", description: Text("Incoming best offers from buyers will show up here."))
            } else {
                List(store.offers) { offer in
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
                Button("Accept") { Task { await store.accept(offer) } }
                    .buttonStyle(.borderedProminent).tint(.green)
                Button("Counter") { countering = offer }
                    .buttonStyle(.bordered)
                Button("Decline", role: .destructive) { Task { await store.decline(offer) } }
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
            ContentUnavailableView("Couldn't load messages", systemImage: "exclamationmark.triangle", description: Text(message))
        case .ready:
            if store.messages.isEmpty {
                ContentUnavailableView("No messages", systemImage: "bubble.left.and.bubble.right", description: Text("Buyer messages from the last 30 days will show up here."))
            } else {
                List(store.messages) { message in
                    Button { replying = message } label: { messageRow(message) }
                        .tint(.primary)
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
                    Text("Replied").font(.caption2.weight(.semibold)).foregroundStyle(.green)
                }
            }
            if let subject = message.subject, !subject.isEmpty {
                Text(subject).font(.caption.weight(.medium))
            }
            if let body = message.body {
                Text(body).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Sheets

private struct CounterOfferSheet: View {
    let offer: BestOffer
    let onSubmit: (Double, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var priceText = ""
    @State private var message = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Counter price") {
                    TextField("Amount", text: $priceText).keyboardType(.decimalPad)
                }
                Section("Message (optional)") {
                    TextField("Note to buyer", text: $message, axis: .vertical).lineLimit(2...4)
                }
            }
            .navigationTitle("Counter offer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        if let price = Double(priceText), price > 0 {
                            onSubmit(price, message.isEmpty ? nil : message)
                            dismiss()
                        }
                    }
                    .disabled(Double(priceText) == nil)
                }
            }
        }
    }
}

private struct MessageReplySheet: View {
    let message: BuyerMessage
    let onSubmit: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var replyText = ""

    var body: some View {
        NavigationStack {
            Form {
                if let original = message.body {
                    Section("Buyer wrote") { Text(original).font(.callout) }
                }
                Section("Your reply") {
                    TextField("Reply…", text: $replyText, axis: .vertical).lineLimit(3...8)
                }
            }
            .navigationTitle("Reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        onSubmit(replyText)
                        dismiss()
                    }
                    .disabled(replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

private struct SendOfferSheet: View {
    let onSubmit: (String, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var discount: Double = 10
    @State private var message = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading) {
                        Text("Discount: \(Int(discount))%")
                        Slider(value: $discount, in: 5...50, step: 5)
                    }
                } header: {
                    Text("Offer to interested buyers")
                } footer: {
                    Text("Sends a limited-time offer to buyers who've shown interest (watchers / cart) on all eligible listings.")
                }
                Section("Message (optional)") {
                    TextField("Note to buyers", text: $message, axis: .vertical).lineLimit(2...4)
                }
            }
            .navigationTitle("Send offer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        onSubmit(String(Int(discount)), message.isEmpty ? nil : message)
                        dismiss()
                    }
                }
            }
        }
    }
}
