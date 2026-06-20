import SwiftUI

/// US-804: the final onboarding step — offers subscription tiers + credit packs
/// to a freshly-signed-up user instead of silently dropping them on the free
/// tier. It reuses the existing ``PaywallView``/``PaywallStore`` (no duplicated
/// product list); "Continue with Free" is always visible and never blocks entry.
///
/// Shown exactly once per fresh account, gated by ``PlanSelectionState``: the
/// host (``MainShell``) presents this only when `shouldOffer(userId:)` is true,
/// and the step records `markOffered` on every exit (free or purchased) so it
/// can never re-prompt.
struct OnboardingPlanStepView: View {
    let userId: UUID
    /// Called when the step finishes (skipped or a plan purchased) so the host
    /// can dismiss the cover. The step records the show-once flag itself first.
    let onFinish: () -> Void

    @State private var store: PaywallStore

    init(userId: UUID, onFinish: @escaping () -> Void) {
        self.userId = userId
        self.onFinish = onFinish
        _store = State(initialValue: PaywallStore(userId: userId))
    }

    var body: some View {
        NavigationStack {
            PaywallView(
                store: store,
                onboarding: PaywallView.OnboardingConfig(
                    onContinueFree: continueFree,
                    onPurchased: purchased
                )
            )
        }
        .onAppear { Telemetry.event("onboarding_plan_shown") }
    }

    private func continueFree() {
        Telemetry.event("onboarding_plan_skipped")
        PlanSelectionState().markOffered(userId: userId)
        onFinish()
    }

    private func purchased(_ entry: IAPCatalogEntry) {
        Telemetry.event("onboarding_plan_purchased", props: ["product": entry.productId])
        // Record the show-once flag regardless of which product was bought so the
        // step never re-prompts.
        PlanSelectionState().markOffered(userId: userId)
        // A subscription is the natural end of onboarding → advance into the app.
        // A credit pack leaves the step open so the user can still pick a plan
        // (it's already marked offered, so leaving won't re-prompt next launch).
        if entry.isSubscription {
            onFinish()
        }
    }
}
