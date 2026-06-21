import SwiftUI
import Observation

/// Drives per-listing Promoted Listings + Sale controls (US-1044 / US-1045).
@MainActor
@Observable
final class EbayMarketingStore {
    enum Phase: Equatable { case loading, ready, failed(String) }

    private let service: EbayMarketingProviding
    let listingId: String

    var phase: Phase = .loading
    var status: EbayPromotionStatus?
    var busy = false
    var actionError: String?

    init(listingId: String, service: EbayMarketingProviding = EbayMarketingService()) {
        self.listingId = listingId
        self.service = service
    }

    func load() async {
        phase = .loading
        do {
            status = try await service.promotion(listingId: listingId)
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func promote(ratePct: Double) async {
        await run { try await self.service.setPromotion(listingId: self.listingId, ratePct: ratePct) }
    }
    func stopPromote() async {
        await run { try await self.service.removePromotion(listingId: self.listingId) }
    }
    func startSale(percentOff: Double) async {
        await run { try await self.service.startSale(listingId: self.listingId, percentOff: percentOff) }
    }
    func endSale() async {
        await run { try await self.service.endSale(listingId: self.listingId) }
    }

    private func run(_ op: @escaping () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await op()
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

/// Promote-at-rate + Sale (markdown) controls, rendered as a Form `Section`.
/// Shown for an item's live eBay listing.
struct EbayMarketingControls: View {
    let listingId: String
    @State private var store: EbayMarketingStore
    @State private var rate: Double = 8
    @State private var salePct: Double = 15
    /// US-981: gate the network-only promote / sale actions when offline.
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    private var isOffline: Bool { NetworkMonitor.isOffline(networkMonitor) }

    init(listingId: String) {
        self.listingId = listingId
        _store = State(initialValue: EbayMarketingStore(listingId: listingId))
    }

    var body: some View {
        Section {
            switch store.phase {
            case .loading:
                HStack { ProgressView(); Text("Loading promotion…").foregroundStyle(.secondary) }
            case .failed(let message):
                // US-1163: a transient load failure shouldn't permanently hide
                // the promote/sale controls — offer a retry.
                VStack(alignment: .leading, spacing: 8) {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                    Button("Try again") { Task { await store.load() } }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.bordered)
                }
            case .ready:
                if let status = store.status {
                    if isOffline {
                        OfflineNotice(intent: .blocked, detail: "to change promotion or sale")
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                    promoteControls(status)
                    saleControls(status)
                }
            }
        } header: {
            Text("Promotion & Sale")
        } footer: {
            Text("Promoted Listings boosts visibility (ad fee charged only on an attributed sale). A Sale shows a strike-through price + SALE badge and notifies watchers; ending it restores the price.")
                .font(.caption)
        }
        .task { await store.load() }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.actionError != nil }, set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(store.actionError ?? "") }
    }

    @ViewBuilder
    private func promoteControls(_ status: EbayPromotionStatus) -> some View {
        let promoted = !status.optOut && status.adId != nil
        Stepper(value: $rate, in: 2...20, step: 0.5) {
            Text("Ad rate: \(rate, specifier: "%.1f")%")
        }
        .onAppear { rate = status.ratePct ?? status.suggestedRatePct }
        HStack {
            Button(promoted ? "Update rate" : "Promote") {
                Task { await store.promote(ratePct: rate) }
            }
            .disabled(store.busy || isOffline)
            if promoted {
                Spacer()
                Button("Stop promoting", role: .destructive) {
                    Task { await store.stopPromote() }
                }
                .disabled(store.busy || isOffline)
            }
        }
    }

    @ViewBuilder
    private func saleControls(_ status: EbayPromotionStatus) -> some View {
        if status.saleActive {
            HStack {
                Label("Sale running\(status.salePct.map { " · \(Int($0))% off" } ?? "")", systemImage: "tag.fill")
                    .foregroundStyle(Color.brandNavy)
                Spacer()
                Button("End Sale", role: .destructive) {
                    Task { await store.endSale() }
                }
                .disabled(store.busy || isOffline)
            }
        } else {
            Stepper(value: $salePct, in: 5...70, step: 5) {
                Text("Sale: \(Int(salePct))% off")
            }
            Button("Start Sale") {
                Task { await store.startSale(percentOff: salePct) }
            }
            .disabled(store.busy || isOffline)
        }
    }
}
