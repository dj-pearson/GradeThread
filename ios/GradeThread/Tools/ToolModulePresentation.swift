import SwiftUI

/// The three sourcing/valuation modules that are presented over another screen
/// rather than pushed: ScoutAI, Snap-to-Value and Item Prospecting.
///
/// They live in one enum because a view may only carry ONE sheet modifier.
/// Chaining `.sheet(isPresented:)` three times on the same view — which both
/// the Home tab and the Tools hub used to do — is undefined in SwiftUI: the
/// modifiers compete for the single presentation slot, and the losers present
/// and are torn down again in the same frame, which reads to the user as the
/// screen opening and closing on its own. ``PlanGatePresentation`` records the
/// same lesson from the billing surfaces.
///
/// So: one `.sheet(item:)`, one source of truth for which module is up.
enum ToolModule: String, Identifiable, CaseIterable {
    case scout
    case snap
    case prospect

    var id: String { rawValue }
}

extension View {
    /// Present whichever of the three modules `selection` names, from a single
    /// sheet slot. Attach this ONCE per presenting view.
    func toolModulePresentation(_ selection: Binding<ToolModule?>, router: AppRouter) -> some View {
        sheet(item: selection) { module in
            switch module {
            case .scout:
                // US-3106: a demand chip on Prospect's empty state hands its
                // term over here. Cleared as it is read, so returning to Scout
                // by hand does not re-run somebody's earlier tap.
                ScoutView(initialKeyword: router.takePendingScoutKeyword())
            case .snap:
                SnapView(router: router)
            case .prospect:
                ProspectView(router: router)
            }
        }
    }
}
