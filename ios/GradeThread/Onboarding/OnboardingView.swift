import SwiftUI

/// First-run welcome carousel. Sells the reseller value prop across a few
/// branded slides, then hands off to the login / main shell. Shown once
/// (gated by ``OnboardingState``) over everything else at launch.
struct OnboardingView: View {
    /// Called when the user finishes or skips. The host persists the flag
    /// and dismisses.
    let onFinish: () -> Void

    @State private var index = 0
    private let pages = OnboardingPage.pages

    private var isLastPage: Bool { index >= pages.count - 1 }

    var body: some View {
        VStack(spacing: 0) {
            skipBar
            TabView(selection: $index) {
                ForEach(pages) { page in
                    pageView(page).tag(page.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .accessibleAnimation(.easeInOut, value: index)

            pageDots
            primaryButton
        }
        .background(Color(uiColor: .systemBackground))
        .onAppear { Telemetry.event("onboarding_started") }
    }

    // MARK: - Sections

    private var skipBar: some View {
        HStack {
            Spacer()
            Button("Skip") {
                Telemetry.event("onboarding_skipped", props: ["page": index])
                finish()
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .opacity(isLastPage ? 0 : 1)
            .disabled(isLastPage)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
    }

    private func pageView(_ page: OnboardingPage) -> some View {
        VStack(spacing: 28) {
            Spacer(minLength: 0)
            ZStack {
                Circle()
                    .fill(Color.brandNavy.opacity(0.10))
                    .frame(width: 148, height: 148)
                Image(systemName: page.systemImage)
                    .font(.system(size: 60, weight: .semibold))
                    .foregroundStyle(Color.brandNavy)
            }
            VStack(spacing: 12) {
                Text(page.title)
                    .font(.title.weight(.bold))
                    .multilineTextAlignment(.center)
                Text(page.body)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
    }

    private var pageDots: some View {
        HStack(spacing: 8) {
            ForEach(pages) { page in
                Capsule()
                    .fill(page.id == index ? Color.brandNavy : Color.secondary.opacity(0.3))
                    .frame(width: page.id == index ? 22 : 8, height: 8)
                    .accessibleAnimation(.easeInOut(duration: 0.2), value: index)
            }
        }
        .padding(.bottom, 20)
        .accessibilityHidden(true)
    }

    private var primaryButton: some View {
        Button {
            AppRouter.haptic()
            if isLastPage {
                finish()
            } else {
                withAnimation(ReducedMotion.animation(.easeInOut)) {
                    index += 1
                }
            }
        } label: {
            Text(isLastPage ? "Get started" : "Next")
                .font(.brandHeadline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private func finish() {
        if isLastPage { Telemetry.event("onboarding_completed") }
        onFinish()
    }
}

#Preview {
    OnboardingView(onFinish: {})
}
