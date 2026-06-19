import SwiftUI

/// US-1064: the iOS Community Insights surface. Turns the anonymized community
/// benchmarks into actionable sourcing/pricing recommendations — each with its
/// confidence and the cohort size behind it. Brand recommendations deep-link to
/// a brand-filtered inventory list so the reseller can act immediately.
///
/// Reachable from the Money tab. The web twin lives at
/// `src/pages/flipdesk/community-insights.tsx`.
struct CommunityInsightsView: View {
    @State private var store = CommunityInsightsStore()

    var body: some View {
        content
            .navigationTitle("Community Insights")
            .navigationBarTitleDisplayMode(.inline)
            .task { await store.refresh() }
            .refreshable { await store.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ScrollView { SkeletonRows(count: 5) }

        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load insights", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.refresh() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .ready where store.recommendations.isEmpty:
            ContentUnavailableView(
                "Not enough community data yet",
                systemImage: "person.3",
                description: Text(
                    "Recommendations appear once enough sellers have traded the "
                    + "same brands and categories. Check back soon."
                )
            )

        case .ready:
            recommendationList
        }
    }

    private var recommendationList: some View {
        List {
            Section {
                ForEach(store.recommendations) { rec in
                    if let brand = rec.brandFilter {
                        NavigationLink {
                            InventoryListView(initialBrand: brand)
                        } label: {
                            RecommendationRow(rec: rec)
                        }
                    } else {
                        RecommendationRow(rec: rec)
                    }
                }
            } header: {
                Text("Recommendations")
            } footer: {
                Text(
                    "Every number is aggregated across at least 5 sellers — no "
                    + "individual seller's data is ever shown."
                )
                .font(.footnote)
            }
        }
    }
}

/// One recommendation row — title, detail, confidence chip, and cohort size.
private struct RecommendationRow: View {
    let rec: CommunityRecommendation

    private var icon: String {
        switch rec.kind {
        case .source: return "magnifyingglass.circle.fill"
        case .price:  return "tag.circle.fill"
        }
    }

    private var confidenceColor: Color {
        switch rec.confidenceLevel {
        case .high:   return .brandEmerald
        case .medium: return .brandAmber
        case .low:    return .secondary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Color.brandNavy)
            VStack(alignment: .leading, spacing: 4) {
                Text(rec.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(rec.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Text(rec.confidenceLevel.label)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(confidenceColor.opacity(0.15), in: Capsule())
                        .foregroundStyle(confidenceColor)
                    Label("\(rec.cohortSize) sellers", systemImage: "person.2")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
