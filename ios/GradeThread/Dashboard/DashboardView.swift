import SwiftData
import SwiftUI

/// Home tab: a glanceable snapshot of the business — inventory value,
/// active listings, the trailing-7-day money figures, and a nudge list of
/// aging stock. Reads the local SwiftData mirror via `@Query` (instant,
/// offline-friendly, and auto-updates as sync lands new rows) and reduces
/// it through ``DashboardRollup``.
struct DashboardView: View {
    /// Drives the quick-action buttons (Add sheet / tab switches). Owned by
    /// the shell; we only mutate `selection` / `showingAddSheet`.
    let router: AppRouter

    /// US-613: presents the Snap-to-Value sheet.
    @State private var showingSnap = false
    /// ScoutAI: presents the "find underpriced deals" sheet.
    @State private var showingScout = false
    /// US-953: presents the in-store Item Prospecting (snap → comps) sheet.
    @State private var showingProspect = false
    /// US-647: post-signup activation checklist.
    @State private var activation = ActivationChecklistStore()

    @Query(sort: \LocalInventoryItem.updatedAt, order: .forward)
    private var items: [LocalInventoryItem]
    @Query private var sales: [LocalSale]

    /// US-693: lets the empty branch tell "first sync still running" apart from
    /// "genuinely no data yet" so a fresh launch shows skeletons, not a
    /// premature Welcome card.
    @Environment(SyncStatusStore.self) private var syncStatus

    private let currency = CurrencyFormatter()

    private var metrics: DashboardMetrics {
        DashboardRollup.compute(items: items, sales: sales, now: .now)
    }

    /// Oldest-first (the `@Query` sort) on-hand items past the aging
    /// threshold, capped to a short nudge list.
    private var agingItems: [LocalInventoryItem] {
        let now = Date.now
        return Array(
            items.lazy
                .filter { DashboardRollup.isAging($0, now: now) }
                .prefix(5)
        )
    }

    var body: some View {
        Group {
            if items.isEmpty && sales.isEmpty {
                // US-693: while the very first sync is still pulling, show
                // skeleton cards instead of flashing the Welcome empty state.
                if syncStatus.phase == .syncing {
                    loadingState
                } else {
                    emptyState
                }
            } else {
                dashboard
            }
        }
        .navigationTitle("Home")
        .refreshable {
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
        .sheet(isPresented: $showingSnap) {
            SnapView(router: router)
        }
        .sheet(isPresented: $showingScout) {
            ScoutView()
        }
        .sheet(isPresented: $showingProspect) {
            ProspectView(router: router)
        }
        // US-967: rebuild the 14-day trend series only when sales or items
        // change, not on every `body` re-evaluation (where it was read 3×).
        .onChange(of: trendSignature, initial: true) { _, _ in
            trendPoints = DashboardTrend.dailySeries(sales: sales, items: items, days: 14, now: .now)
        }
    }

    // MARK: - Populated dashboard

    /// US-967: the trailing-14-day daily revenue/profit series, memoized in
    /// `@State`. It's read up to three times per `body` pass (the activity gate,
    /// the header total, the sparkline), and `DashboardTrend.dailySeries` is an
    /// O(n) bucket over every sale plus an item cost-basis map — so recomputing
    /// it per read (and on every unrelated re-render) is wasted main-thread work.
    /// Rebuilt via `.onChange` only when the sales or items actually change.
    @State private var trendPoints: [DashboardTrendPoint] = []

    /// Cheap signature of the inputs `DashboardTrend.dailySeries` consumes: each
    /// sale's bucketing fields plus each item's cost basis.
    private var trendSignature: Int { DashboardView.trendSignature(sales: sales, items: items) }

    static func trendSignature(sales: [LocalSale], items: [LocalInventoryItem]) -> Int {
        var hasher = Hasher()
        hasher.combine(sales.count)
        for sale in sales {
            hasher.combine(sale.inventoryItemId)
            hasher.combine(sale.saleDate)
            hasher.combine(sale.salePrice)
            hasher.combine(sale.platformFees)
        }
        hasher.combine(items.count)
        for item in items {
            hasher.combine(item.id)
            hasher.combine(item.acquiredPrice)
        }
        return hasher.finalize()
    }

    /// Certified-graded items, newest first (for the grades card).
    private var gradedItems: [LocalInventoryItem] {
        items.filter { $0.gradeValue != nil }
    }

    private var dashboard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !activation.isDismissed, !activation.allComplete(hasItem: !items.isEmpty) {
                    ActivationChecklistView(router: router, hasItem: !items.isEmpty, store: activation)
                }
                kpiGrid
                if DashboardTrend.hasActivity(trendPoints) { trendCard }
                analyticsCard
                if !gradedItems.isEmpty { gradesCard }
                if !agingItems.isEmpty { agingCard }
                quickActions
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private var trendCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Revenue · 14 days")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(currency.formatDisplay(Money.sum(trendPoints) { $0.revenue }))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.brandNavy)
            }
            TrendSparkline(points: trendPoints)
                .frame(height: 56)
        }
        .padding(16)
        .cardStyle(.flush)
    }

    private var analyticsCard: some View {
        NavigationLink {
            AnalyticsView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "chart.bar.xaxis")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Analytics")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Profit, sell-through & grade trends")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    private var gradesCard: some View {
        NavigationLink(value: GradesRoute()) {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Certified grades")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("\(gradedItems.count) graded item\(gradedItems.count == 1 ? "" : "s")\(averageGradeSuffix)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    private var averageGradeSuffix: String {
        let values = gradedItems.compactMap(\.gradeValue)
        guard !values.isEmpty else { return "" }
        let avg = values.reduce(0, +) / Double(values.count)
        return " · avg \(String(format: "%.1f", avg))"
    }

    private var kpiGrid: some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
            spacing: 12
        ) {
            DashboardCard(
                title: "Inventory value",
                value: currency.formatDisplay(metrics.inventoryValue),
                subtitle: "\(metrics.onHandCount) item\(metrics.onHandCount == 1 ? "" : "s") on hand",
                systemImage: "shippingbox.fill",
                tint: .brandNavy
            )
            DashboardCard(
                title: "Listed",
                value: "\(metrics.listedCount)",
                subtitle: "active listing\(metrics.listedCount == 1 ? "" : "s")",
                systemImage: "tag.fill",
                tint: .brandNavy
            )
            DashboardCard(
                title: "Sold · 7 days",
                value: "\(metrics.soldThisWeekCount)",
                subtitle: "\(currency.formatDisplay(metrics.revenueThisWeek)) revenue",
                systemImage: "bag.fill",
                tint: .brandNavy
            )
            DashboardCard(
                title: "Net profit · 7 days",
                value: currency.formatDisplay(metrics.netProfitThisWeek),
                subtitle: "after fees + cost",
                systemImage: "chart.line.uptrend.xyaxis",
                tint: metrics.netProfitThisWeek < 0 ? .brandRed : .brandEmerald
            )
        }
    }

    private var agingCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Aging stock", systemImage: "clock.badge.exclamationmark")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(metrics.agingCount)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            Divider().padding(.leading, 14)

            ForEach(Array(agingItems.enumerated()), id: \.element.id) { index, item in
                NavigationLink(value: item) {
                    AgingRow(item: item)
                }
                .buttonStyle(.plain)
                if index < agingItems.count - 1 {
                    Divider().padding(.leading, 14)
                }
            }
        }
        .cardStyle(.flush)
    }

    private var quickActions: some View {
        VStack(spacing: 10) {
            // US-690: brand button styles for the primary/secondary CTAs.
            Button {
                AppRouter.haptic()
                router.showingAddSheet = true
            } label: {
                Label("Add an item", systemImage: "plus.circle.fill")
            }
            .buttonStyle(.brandPrimary)

            // US-613: Snap-to-Value — the free "what's it worth?" scan.
            Button {
                AppRouter.haptic()
                showingSnap = true
            } label: {
                Label("What's it worth?", systemImage: "sparkles")
            }
            .buttonStyle(.brandSecondary)

            // US-953: Item Prospecting — snap an item in-store, get comps.
            Button {
                AppRouter.haptic()
                showingProspect = true
            } label: {
                Label("Prospect an item", systemImage: "viewfinder.circle")
            }
            .buttonStyle(.brandSecondary)

            // ScoutAI — find underpriced listings to buy and flip.
            Button {
                AppRouter.haptic()
                showingScout = true
            } label: {
                Label("Scout deals", systemImage: "binoculars")
            }
            .buttonStyle(.brandSecondary)

            Button {
                AppRouter.haptic()
                router.selection = .inventory
            } label: {
                Label("View inventory", systemImage: "shippingbox")
            }
            .buttonStyle(.brandSecondary)
        }
        .padding(.top, 4)
    }

    // MARK: - Loading (first-sync) state

    /// US-693: skeleton KPI grid shown while the initial sync is in flight so
    /// the home tab doesn't flash a Welcome card before data lands.
    private var loadingState: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                LazyVGrid(
                    columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                    spacing: 12
                ) {
                    ForEach(0..<4, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: 8) {
                            SkeletonLine(widthFraction: 0.5, height: 11)
                            SkeletonLine(widthFraction: 0.7, height: 20)
                            SkeletonLine(widthFraction: 0.4, height: 10)
                        }
                        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
                        .padding(16)
                        .cardStyle(.flush)
                    }
                }
                SkeletonBlock(cornerRadius: CornerRadius.card).frame(height: 96)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .accessibilityLabel("Loading your dashboard")
    }

    // MARK: - Empty (first-run) state

    /// US-647: the empty state links into the same activation steps (the
    /// checklist) so a brand-new user has a guided path, not just a CTA.
    private var emptyState: some View {
        ScrollView {
            VStack(spacing: 20) {
                if !activation.isDismissed {
                    ActivationChecklistView(router: router, hasItem: false, store: activation)
                }
                VStack(spacing: 10) {
                    Image(systemName: "shippingbox")
                        .font(.system(size: 48, weight: .light))
                        .foregroundStyle(Color.brandNavy)
                    Text("Welcome to GradeThread")
                        .font(.brandTitle2)
                    Text("Capture an item to start building your inventory. Your value, listings, and sales will show up here.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button {
                        AppRouter.haptic()
                        router.startIntake(.photoFirst)
                    } label: {
                        Label("Capture your first item", systemImage: "camera.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
                    .padding(.top, 4)
                }
                .padding(.top, 12)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

// MARK: - Subviews

/// A single KPI tile. Fixed height so the 2-column grid stays even when one
/// value wraps.
private struct DashboardCard: View {
    let title: String
    let value: String
    let subtitle: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.caption)
                    .foregroundStyle(tint)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value.isEmpty ? "—" : value)
                .font(.title2.weight(.bold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
        .padding(16)
        .cardStyle(.flush)
    }
}

/// One row in the aging-stock nudge list.
private struct AgingRow: View {
    let item: LocalInventoryItem

    private var daysIdle: Int {
        Calendar.current.dateComponents([.day], from: item.updatedAt, to: .now).day ?? 0
    }

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title.isEmpty ? "Untitled item" : item.title)
                    .font(.subheadline)
                    .lineLimit(1)
                Text("\(daysIdle) days idle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
