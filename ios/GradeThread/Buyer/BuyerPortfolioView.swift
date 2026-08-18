import SwiftUI
import Observation

// US-2503 AC2, screen 2 of 4: the closet portfolio.
//
// What you own, what it is worth now, and what that is against what you paid.
// Reads GET /api/buyer/closet/valuation, which already computed the estimates
// and the totals; this release adds the item identity to the same response so
// the phone does not need a second read and a second copy of the closet row
// shape.

struct BuyerPortfolioItem: Decodable, Equatable, Identifiable {
    let id: String
    let brand: String?
    let garmentType: String?
    let size: String?
    let title: String?
    let conditionGrade: Double?
    let certificateId: String?
    /// nil when this item has not been valued. Rendered as "not valued yet",
    /// never as $0.00 — a garment we have not priced is not a garment worth
    /// nothing, and the two look identical in a total.
    let estimateCents: Int?
    let costBasisCents: Int?
    let confidence: String
    let trend: String
    let sellGuidance: String

    var displayName: String {
        let brand = self.brand?.trimmingCharacters(in: .whitespaces) ?? ""
        let type = garmentType?.trimmingCharacters(in: .whitespaces) ?? ""
        let title = self.title?.trimmingCharacters(in: .whitespaces) ?? ""
        if !brand.isEmpty && !type.isEmpty { return "\(brand) \(type)" }
        if !brand.isEmpty && !title.isEmpty { return "\(brand) \(title)" }
        if !brand.isEmpty { return brand }
        if !title.isEmpty { return title }
        if !type.isEmpty { return type }
        return "Untitled item"
    }
}

struct BuyerPortfolioTotals: Decodable, Equatable {
    let totalEstimateCents: Int
    let costBasisCents: Int
    let unrealizedGainCents: Int
    let itemsValued: Int
    let itemsUnvalued: Int
}

struct BuyerPortfolio: Decodable, Equatable {
    let items: [BuyerPortfolioItem]
    let totals: BuyerPortfolioTotals
}

@MainActor
@Observable
final class BuyerPortfolioStore {

    enum Phase: Equatable {
        case loading
        case ready(BuyerPortfolio)
        case failed(String)
        case locked
    }

    private(set) var phase: Phase = .loading

    private let fetch: () async throws -> BuyerPortfolio

    init(fetch: (() async throws -> BuyerPortfolio)? = nil) {
        self.fetch = fetch ?? { try await Self.loadPortfolio() }
    }

    func load(entitlements: BuyerEntitlementsStore) async {
        guard let capability = BuyerCapability.all.first(where: { $0.id == "wardrobePortfolio" }) else {
            phase = .failed("The portfolio is unavailable.")
            return
        }
        guard entitlements.isIncluded(capability) else {
            phase = .locked
            return
        }
        phase = .loading
        do {
            phase = .ready(try await fetch())
        } catch {
            phase = .failed(
                (error as? LocalizedError)?.errorDescription
                    ?? "We couldn't value your closet.")
        }
    }

    private static func loadPortfolio() async throws -> BuyerPortfolio {
        try await EdgeAPI.shared.getJSON("/api/buyer/closet/valuation")
    }
}

struct BuyerPortfolioView: View {
    @Environment(BuyerEntitlementsStore.self) private var entitlements
    @State private var store = BuyerPortfolioStore()

    var body: some View {
        List {
            switch store.phase {
            case .loading:
                HStack { Spacer(); ProgressView(); Spacer() }
                    .listRowBackground(Color.clear)
            case .locked:
                lockedSection
            case .failed(let message):
                failedSection(message)
            case .ready(let portfolio):
                if portfolio.items.isEmpty {
                    emptySection
                } else {
                    totalsSection(portfolio.totals)
                    itemsSection(portfolio.items)
                }
            }
        }
        .navigationTitle("Closet")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(entitlements: entitlements) }
        .task { await store.load(entitlements: entitlements) }
    }

    // MARK: - Sections

    private func totalsSection(_ totals: BuyerPortfolioTotals) -> some View {
        Section {
            LabeledContent("Estimated value", value: Self.money(totals.totalEstimateCents))
            if totals.costBasisCents > 0 {
                LabeledContent("You paid", value: Self.money(totals.costBasisCents))
                LabeledContent("Change", value: Self.signedMoney(totals.unrealizedGainCents))
            }
        } header: {
            Text("Your closet")
        } footer: {
            // Says what the number does NOT include. A total that silently omits
            // a third of the closet is worse than one that says so.
            Text(Self.coverageFooter(totals))
        }
    }

    private func itemsSection(_ items: [BuyerPortfolioItem]) -> some View {
        Section {
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.displayName).font(.subheadline)
                    Text(Self.itemDetail(item))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(item.displayName). \(Self.itemDetail(item))")
            }
        } header: {
            Text("Items")
        }
    }

    private var emptySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your closet is empty.")
                    .font(.subheadline)
                Text("Add a graded item and we'll track what it's worth over time, so you know when it's worth selling.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private var lockedSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your plan doesn't include the closet portfolio.")
                    .font(.subheadline)
                Text("The portfolio values everything you own against real sale prices, so you can see what your wardrobe is worth and when to sell.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private func failedSection(_ message: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("We couldn't value your closet. Nothing has been lost - this is a display problem.")
                    .font(.subheadline)
                Text(message).font(.caption).foregroundStyle(.secondary)
                Button("Try again") {
                    Task { await store.load(entitlements: entitlements) }
                }
                .font(.subheadline)
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Copy helpers

    static func money(_ cents: Int?) -> String {
        guard let cents else { return "-" }
        return String(format: "$%.2f", Double(cents) / 100)
    }

    /// A gain and a loss are different facts and must not both read as "$12.00".
    static func signedMoney(_ cents: Int) -> String {
        let magnitude = String(format: "$%.2f", Double(abs(cents)) / 100)
        if cents > 0 { return "+\(magnitude)" }
        if cents < 0 { return "-\(magnitude)" }
        return magnitude
    }

    /// One line per item: what it is worth, and the honest version when we do
    /// not know.
    static func itemDetail(_ item: BuyerPortfolioItem) -> String {
        guard let estimate = item.estimateCents else {
            return "Not valued yet"
        }
        var parts = [money(estimate)]
        if item.confidence == "low" {
            // Says the estimate is rough rather than quietly presenting a weak
            // number with the same weight as a strong one.
            parts.append("rough estimate")
        }
        if item.sellGuidance == "sell_now" {
            parts.append("good time to sell")
        }
        return parts.joined(separator: " - ")
    }

    static func coverageFooter(_ totals: BuyerPortfolioTotals) -> String {
        if totals.itemsUnvalued == 0 {
            return "Based on all \(totals.itemsValued) items in your closet."
        }
        if totals.itemsValued == 0 {
            return "None of your items have been valued yet."
        }
        let noun = totals.itemsUnvalued == 1 ? "item" : "items"
        return "Based on \(totals.itemsValued) items. \(totals.itemsUnvalued) \(noun) not valued yet, and not counted above."
    }
}
