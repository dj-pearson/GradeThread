import SwiftUI

/// US-3103 — "send this draft to these marketplaces, at these prices".
///
/// The web composer has had this since US-717; the phone had a Listing Kit that
/// could only copy fields into a clipboard and a single "Run on my desktop"
/// button per platform. So a seller who wanted the same item on Poshmark at $45
/// and Shopify at $52 did it by hand, twice, or waited until they were at a
/// laptop.
///
/// **The two mechanisms are shown, not hidden.** An API channel is live when
/// the call returns; an extension channel is a job queued for a desktop browser
/// that may not open for hours. A sheet that reported both as "cross-posted"
/// would be telling the seller something false about half their listings, and
/// they would find out from a buyer.
struct PushToSheet: View {
    let listingId: String
    let itemId: String
    /// The draft's own price, shown as the placeholder each field falls back to.
    let listingPrice: Double?
    /// US-3454: the item's listing rows, so each channel row says what the
    /// item is already doing there (the same word the web shows) and a
    /// channel the item is already on cannot be ticked again.
    let rows: [ChannelRow]

    @Environment(\.dismiss) private var dismiss

    @State private var selected: Set<String> = []
    @State private var priceTexts: [String: String] = [:]
    @State private var outcomes: [CrossPushOutcome] = []
    @State private var isPushing = false
    @State private var pushError: String?
    /// US-3454: this item's jobs, read once when the sheet opens.
    @State private var queue: [ExtensionQueueService.QueueItem] = []
    @State private var queueMessage: String?
    @State private var queueBusy = false

    private let service: CrossPushProviding

    /// Same rule as ``CrossPushService/init(queue:)``: a default argument is
    /// nonisolated, and `CrossPushService` is @MainActor. Defaulting to nil and
    /// building it in the body keeps the injection point and compiles.
    @MainActor
    init(
        listingId: String,
        itemId: String,
        listingPrice: Double?,
        rows: [ChannelRow] = [],
        service: CrossPushProviding? = nil
    ) {
        self.listingId = listingId
        self.itemId = itemId
        self.listingPrice = listingPrice
        self.rows = rows
        self.service = service ?? CrossPushService()
    }

    /// What the item is doing on `channel`, from the rows and this item's jobs.
    func status(for channel: CrossListingRegistry.Channel) -> ChannelStatus {
        ChannelStateDerivation.derive(rows: rows, queue: queue, platform: channel.id)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(CrossListingRegistry.channels) { channel in
                        channelRow(channel)
                    }
                } header: {
                    Text("Where to list it")
                } footer: {
                    Text("Leave a price blank to use this listing's own price.")
                }

                if !outcomes.isEmpty {
                    Section {
                        ForEach(outcomes) { outcome in
                            outcomeRow(outcome)
                        }
                    } header: {
                        Text("Results")
                    }
                }

                if let pushError {
                    Section {
                        Label(pushError, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(Color.brandRed)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let queueMessage {
                    Section {
                        Text(queueMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .task { await loadQueue() }
            .navigationTitle("List on")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await push() }
                    } label: {
                        if isPushing {
                            ProgressView().controlSize(.mini)
                        } else {
                            Text("Push")
                        }
                    }
                    .disabled(selected.isEmpty || isPushing)
                }
            }
        }
    }

    // MARK: - Rows

    @ViewBuilder
    private func channelRow(_ channel: CrossListingRegistry.Channel) -> some View {
        let status = status(for: channel)
        let blocked = status.state.blocksPush || !channel.isSelectable
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button {
                    toggle(channel)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: selected.contains(channel.id)
                            ? "checkmark.circle.fill"
                            : "circle")
                            .foregroundStyle(selected.contains(channel.id)
                                ? Color.brandEmerald
                                : Color.secondary)
                        Text(channel.label)
                            .foregroundStyle(blocked ? .secondary : .primary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(blocked)

                Spacer()

                // US-3454: the state word first, when the item is already on
                // or on its way to this channel; the tier word otherwise.
                Text(status.state.blocksPush
                    ? status.state.word
                    : (channel.blockedReason ?? channel.tier.label))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if status.state == .failed, let error = queue.first(where: { $0.id == status.queueItemId })?.result?.error {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let urlString = status.url, let url = URL(string: urlString) {
                Link("View on \(channel.label)", destination: url)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }

            // US-3454: a live extension-channel row can take an edit or a
            // relist from the phone. Both queue for the desktop, so both say so.
            if status.state == .live, channel.mechanism == .extensionLister, let rowId = status.rowId {
                HStack(spacing: 12) {
                    Menu {
                        ForEach(ExtensionQueueService.ReviseField.allCases, id: \.self) { field in
                            Button(Self.reviseLabel(field)) {
                                Task { await revise(rowId: rowId, channel: channel, field: field) }
                            }
                        }
                    } label: {
                        Text("Revise")
                            .font(.caption.weight(.semibold))
                    }
                    .disabled(queueBusy)
                    Button("Relist") {
                        Task { await relist(rowId: rowId, channel: channel) }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.brandNavy)
                    .disabled(queueBusy)
                }
            }

            // The price field appears only once the channel is picked. Six
            // always-visible price boxes for channels nobody chose is a form
            // that looks like work before any has been done.
            if selected.contains(channel.id) {
                HStack(spacing: 6) {
                    Text("Price")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField(
                        placeholderPrice,
                        text: Binding(
                            get: { priceTexts[channel.id] ?? "" },
                            set: { priceTexts[channel.id] = $0 }
                        )
                    )
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .keyboardDoneToolbar()
                }
                if channel.mechanism == .extensionLister {
                    // Said on the row, not once at the bottom: this is the fact
                    // that decides whether the seller can walk away.
                    Text("Queued for your desktop browser. It runs the next time you open it.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func outcomeRow(_ outcome: CrossPushOutcome) -> some View {
        let label = CrossListingRegistry.channel(id: outcome.platform)?.label ?? outcome.platform
        HStack(alignment: .top, spacing: 8) {
            switch outcome.state {
            case .listed:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.brandEmerald)
            case .queued:
                Image(systemName: "clock").foregroundStyle(Color.brandAmber)
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.brandRed)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.subheadline.weight(.medium))
                switch outcome.state {
                case .listed(let url):
                    if let url, let parsed = URL(string: url) {
                        Link(String(localized: "View listing"), destination: parsed)
                            .font(.caption)
                    } else {
                        Text("Listed.").font(.caption).foregroundStyle(.secondary)
                    }
                case .queued:
                    Text("Queued for your desktop.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .failed(let reason):
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var placeholderPrice: String {
        guard let listingPrice, listingPrice > 0 else { return "0.00" }
        return String(format: "%.2f", listingPrice)
    }

    // MARK: - Actions

    private static func reviseLabel(_ field: ExtensionQueueService.ReviseField) -> String {
        switch field {
        case .price: return String(localized: "Price changed")
        case .title: return String(localized: "Title changed")
        case .description: return String(localized: "Description changed")
        case .photos: return String(localized: "Photos changed")
        }
    }

    private func loadQueue() async {
        guard let snapshot = try? await ExtensionQueueService.shared.snapshot() else { return }
        queue = (snapshot.pending + snapshot.needsAttention).filter { $0.inventoryItemId == itemId }
    }

    /// Queue a field edit for a live extension-channel listing. The seller
    /// names the field that changed; the values are read off the row when the
    /// desktop applies it.
    private func revise(rowId: String, channel: CrossListingRegistry.Channel, field: ExtensionQueueService.ReviseField) async {
        queueBusy = true
        defer { queueBusy = false }
        do {
            _ = try await ExtensionQueueService.shared.enqueueRevise(
                listingId: rowId,
                platform: channel.id,
                fields: [field]
            )
            queueMessage = "Edit queued for \(channel.label). \(ExtensionQueueService.queuedNotice)"
            await loadQueue()
        } catch {
            queueMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func relist(rowId: String, channel: CrossListingRegistry.Channel) async {
        queueBusy = true
        defer { queueBusy = false }
        do {
            _ = try await ExtensionQueueService.shared.enqueueRelist(listingId: rowId, platform: channel.id)
            queueMessage = "Relist queued for \(channel.label). \(ExtensionQueueService.queuedNotice)"
            await loadQueue()
        } catch {
            queueMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func toggle(_ channel: CrossListingRegistry.Channel) {
        guard channel.isSelectable, !status(for: channel).state.blocksPush else { return }
        AppRouter.haptic()
        if selected.contains(channel.id) {
            selected.remove(channel.id)
            // The typed price goes with it. A price left behind for a channel
            // the seller deselected would be sent if they picked it again for a
            // different reason later.
            priceTexts[channel.id] = nil
        } else {
            selected.insert(channel.id)
        }
    }

    private func push() async {
        isPushing = true
        pushError = nil
        defer { isPushing = false }

        let split = CrossListingRegistry.partition(selected: selected)
        var results: [CrossPushOutcome] = []

        // API channels first: they either succeed or report why, and the seller
        // reads that before the queued rows which cannot say yet.
        if let request = CrossPush.request(
            listingId: listingId,
            platforms: split.api.map(\.id),
            priceTexts: priceTexts
        ) {
            do {
                let response = try await service.push(request)
                results += CrossPush.outcomes(requested: request.platforms, response: response)
            } catch {
                // The whole call failed, so nothing was published. Every
                // requested API channel is reported failed rather than left
                // absent — a row missing from the results reads as "fine".
                let reason = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                results += split.api.map {
                    CrossPushOutcome(platform: $0.id, state: .failed(reason))
                }
            }
        }

        for channel in split.extensionQueued {
            do {
                try await service.enqueueExtension(
                    platform: channel.id,
                    itemId: itemId,
                    price: CrossPush.priceEntry(priceTexts[channel.id] ?? "")
                )
                results.append(CrossPushOutcome(platform: channel.id, state: .queued))
            } catch {
                let reason = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                results.append(CrossPushOutcome(platform: channel.id, state: .failed(reason)))
            }
        }

        outcomes = results
        // Anything that landed or queued is done being asked for; leaving it
        // ticked invites a second push that would duplicate the listing. A
        // FAILED channel stays selected, because retrying it is the next thing
        // the seller will want to do.
        for outcome in results {
            if case .failed = outcome.state { continue }
            selected.remove(outcome.platform)
        }
    }
}
