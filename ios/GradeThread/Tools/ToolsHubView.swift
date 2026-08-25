import SwiftUI

/// US-749: a single, discoverable home for the power modules that were
/// previously reachable only from a Dashboard button (Scout, Snap, Prospect),
/// a Dashboard nav link (Grades), the Add sheet (AutoLister), buried in Settings
/// (Referrals, Verified), or only inside Marketplaces (Reconcile).
///
/// Presented as a sheet from the shell toolbar (``MainShell``) so it's reachable
/// from a stable surface on every tab without touching the 5-tab spine. Modules
/// that own their own `NavigationStack` (Scout/Snap/Prospect) are presented as
/// nested sheets; the rest push onto this hub's stack.
struct ToolsHubView: View {
    let router: AppRouter
    /// Live orphan-listing count so the Reconcile row mirrors the shell banner.
    var orphanCount: Int = 0

    @Environment(AuthStore.self) private var authStore
    @Environment(\.dismiss) private var dismiss

    /// The sheet-owning module currently presented over the hub (each wraps its
    /// own NavigationStack). ONE optional, driving ONE sheet modifier — see
    /// ``ToolModule`` for why three booleans and three `.sheet` modifiers is not
    /// the same thing.
    @State private var presentedModule: ToolModule?

    var body: some View {
        NavigationStack {
            List {
                sourcingSection
                captureSection
                listGradeSection
                manageSection
                reconcileSection
                growSection
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Tools")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            // Push destinations for the non-sheet modules.
            .navigationDestination(for: ToolRoute.self) { route in
                destination(for: route)
            }
        }
        .toolModulePresentation($presentedModule, router: router)
    }

    // MARK: - Sections

    private var sourcingSection: some View {
        Section {
            Button { present(.scout) } label: {
                ToolRow(
                    icon: "binoculars",
                    title: "Scout deals",
                    subtitle: "Find underpriced eBay listings to flip"
                )
            }
            .buttonStyle(.plain)
            Button { present(.prospect) } label: {
                ToolRow(
                    icon: "viewfinder.circle",
                    title: "Prospect an item",
                    subtitle: "Snap an item in-store, get instant comps"
                )
            }
            .buttonStyle(.plain)
        } header: {
            Text("Sourcing")
        }
    }

    private var captureSection: some View {
        Section {
            Button { present(.snap) } label: {
                ToolRow(
                    icon: "sparkles",
                    title: "What's it worth?",
                    subtitle: "Snap-to-Value — a free condition + price read"
                )
            }
            .buttonStyle(.plain)
        } header: {
            Text("Capture & value")
        }
    }

    private var listGradeSection: some View {
        Section {
            NavigationLink(value: ToolRoute.autoLister) {
                ToolRow(
                    icon: "wand.and.stars",
                    title: "AutoLister",
                    subtitle: "Batch photos → AI-drafted listings"
                )
            }
            NavigationLink(value: ToolRoute.grades) {
                ToolRow(
                    icon: "checkmark.seal.fill",
                    title: "Certified grades",
                    subtitle: "Review every graded item in one place"
                )
            }
            NavigationLink(value: ToolRoute.scheduledDrops) {
                ToolRow(
                    icon: "calendar.badge.clock",
                    title: "Scheduled drops",
                    subtitle: "Queue listings to publish at peak times"
                )
            }
        } header: {
            Text("List & grade")
        }
    }

    /// US-1129: surface the secondary "manage" modules that were previously only
    /// reachable from Settings → Data (Templates/Consignors/Sources) or buried
    /// inside the Money tab (Repricing/Community Insights).
    private var manageSection: some View {
        Section {
            NavigationLink(value: ToolRoute.templates) {
                ToolRow(
                    icon: "doc.on.doc",
                    title: "Listing templates",
                    subtitle: "Reusable description, condition + policy presets"
                )
            }
            NavigationLink(value: ToolRoute.consignors) {
                ToolRow(
                    icon: "person.2.badge.gearshape",
                    title: "Consignors",
                    subtitle: "Manage consignors + their payout splits"
                )
            }
            NavigationLink(value: ToolRoute.sources) {
                ToolRow(
                    icon: "mappin.and.ellipse",
                    title: "Sources",
                    subtitle: "Organize where your inventory comes from"
                )
            }
            NavigationLink(value: ToolRoute.repricing) {
                ToolRow(
                    icon: "tag.fill",
                    title: "Repricing",
                    subtitle: "Condition-aware price suggestions for live listings"
                )
            }
            NavigationLink(value: ToolRoute.automations) {
                ToolRow(
                    icon: "bolt.badge.automatic",
                    title: "Automations",
                    subtitle: "Rules that act on their own when a listing sits too long or gets no views"
                )
            }
            NavigationLink(value: ToolRoute.communityInsights) {
                ToolRow(
                    icon: "chart.bar.xaxis",
                    title: "Community Insights",
                    subtitle: "Anonymized sourcing + pricing benchmarks"
                )
            }
        } header: {
            Text("Manage")
        }
    }

    private var reconcileSection: some View {
        Section {
            NavigationLink(value: ToolRoute.reconciliation) {
                ToolRow(
                    icon: "arrow.left.arrow.right",
                    title: "Reconciliation",
                    subtitle: orphanCount > 0
                        ? "\(orphanCount) unmatched eBay listing\(orphanCount == 1 ? "" : "s")"
                        : "Match eBay listings to your inventory",
                    badgeCount: orphanCount,
                    tint: orphanCount > 0 ? .brandAmber : .brandNavy
                )
            }
            NavigationLink(value: ToolRoute.reconcileIntake) {
                ToolRow(
                    icon: "rectangle.stack.badge.plus",
                    title: "Reconcile photo dump",
                    subtitle: "Send a batch of photos to a reconcile session"
                )
            }
        } header: {
            Text("Marketplace cleanup")
        }
    }

    private var growSection: some View {
        Section {
            NavigationLink(value: ToolRoute.referrals) {
                ToolRow(
                    icon: "gift",
                    title: "Referrals",
                    subtitle: "Invite resellers, earn credit"
                )
            }
            NavigationLink(value: ToolRoute.verified) {
                ToolRow(
                    icon: "checkmark.shield",
                    title: "Verified seller",
                    subtitle: "Claim your public handle + trust badge"
                )
            }
        } header: {
            Text("Grow your shop")
        }
    }

    // MARK: - Push destinations

    @ViewBuilder
    private func destination(for route: ToolRoute) -> some View {
        switch route {
        case .autoLister:
            AutoListerView()
        case .grades:
            GradesListView()
        case .scheduledDrops:
            ScheduledDropsView()
        case .reconciliation:
            ReconciliationView()
        case .reconcileIntake:
            ReconcileIntakeView(ownerId: WorkspaceScope.tenantOwnerId(selfId: currentUserId() ?? ""))
        case .templates:
            TemplatesView()
        case .consignors:
            ConsignorsView()
        case .sources:
            SourcesView()
        case .repricing:
            RepricingView()
        case .automations:
            AutomationsView()
        case .communityInsights:
            CommunityInsightsView()
        case .referrals:
            ReferralsView()
        case .verified:
            VerifiedView()
        }
    }

    /// Fire a haptic, then name the module to present. The module sheet stacks
    /// over the hub (SwiftUI sheet-on-sheet); dismissing returns here.
    private func present(_ module: ToolModule) {
        AppRouter.haptic()
        presentedModule = module
    }

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }
}

/// Value-based routes for the hub's push destinations.
private enum ToolRoute: Hashable {
    case autoLister
    case grades
    case scheduledDrops
    case reconciliation
    case reconcileIntake
    case templates
    case consignors
    case sources
    case repricing
    case automations
    case communityInsights
    case referrals
    case verified
}

/// One row in the Tools hub. Mirrors the icon/title/subtitle/chevron card rows
/// used across Marketplaces + Dashboard, adapted for a `List`.
private struct ToolRow: View {
    let icon: String
    let title: String
    let subtitle: String
    var badgeCount: Int = 0
    var tint: Color = .brandNavy

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            if badgeCount > 0 {
                Text("\(badgeCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.brandAmber, in: Capsule())
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
