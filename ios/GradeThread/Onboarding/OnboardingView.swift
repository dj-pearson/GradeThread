import SwiftUI

/// First-run welcome carousel + use-case picker (US-747). Sells the reseller
/// value prop across a few branded slides, then asks the user what they're here
/// to do so we can drop them on the fitting first action instead of a generic
/// dismissal. Shown once (gated by ``OnboardingState``) over everything at launch.
struct OnboardingView: View {
    /// Called when the user finishes or skips, with the chosen use case (nil if
    /// skipped). The host persists the flag + use case and dismisses.
    let onFinish: (OnboardingUseCase?) -> Void

    @State private var index = 0
    /// US-747: once the carousel ends we swap to the use-case picker.
    @State private var showingUseCasePicker = false
    private let pages = OnboardingPage.pages

    private var isLastPage: Bool { index >= pages.count - 1 }

    /// Spoken position for VoiceOver — the visual dots are `accessibilityHidden`
    /// and the paged `TabView` exposes no position, so we surface it here.
    private var pagePositionLabel: String { "Page \(index + 1) of \(pages.count)" }

    var body: some View {
        Group {
            if showingUseCasePicker {
                useCasePicker
            } else {
                carousel
            }
        }
        .background(Color(uiColor: .systemBackground))
        .onAppear { Telemetry.event("onboarding_started") }
    }

    // MARK: - Carousel

    private var carousel: some View {
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
        // Swiping (or tapping Next) changes the page with no native VoiceOver
        // feedback, so announce the new position. No-op when VoiceOver is off.
        .onChange(of: index) { _, _ in
            A11yAnnounce.announce(pagePositionLabel)
        }
    }

    private var skipBar: some View {
        HStack {
            Spacer()
            Button("Skip") {
                Telemetry.event("onboarding_skipped", props: ["page": index])
                onFinish(nil)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Page position")
        .accessibilityValue(pagePositionLabel)
    }

    private var primaryButton: some View {
        Button {
            AppRouter.haptic()
            if isLastPage {
                // US-747: the carousel hands off to the use-case picker rather
                // than dismissing into a generic shell.
                Telemetry.event("onboarding_usecase_shown")
                withAnimation(ReducedMotion.animation(.easeInOut)) {
                    showingUseCasePicker = true
                }
            } else {
                withAnimation(ReducedMotion.animation(.easeInOut)) {
                    index += 1
                }
            }
        } label: {
            Text(isLastPage ? "Choose your focus" : "Next")
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

    // MARK: - Use-case picker (US-747)

    private var useCasePicker: some View {
        VStack(spacing: 0) {
            VStack(spacing: 12) {
                Text("What brings you to GradeThread?")
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)
                Text("We'll drop you straight into the right first step.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 24)
            .padding(.top, 32)
            .padding(.bottom, 24)

            ScrollView {
                VStack(spacing: 12) {
                    ForEach(OnboardingUseCase.allCases) { useCase in
                        useCaseCard(useCase)
                    }
                }
                .padding(.horizontal, 20)
            }

            Button("Not sure yet — just explore") {
                Telemetry.event("onboarding_usecase_skipped")
                onFinish(nil)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.vertical, 20)
        }
    }

    private func useCaseCard(_ useCase: OnboardingUseCase) -> some View {
        Button {
            AppRouter.haptic()
            Telemetry.event("onboarding_completed", props: ["use_case": useCase.rawValue])
            onFinish(useCase)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: useCase.systemImage)
                    .font(.title2)
                    .foregroundStyle(Color.brandNavy)
                    .frame(width: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text(useCase.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(useCase.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .contentShape(Rectangle())
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(useCase.title). \(useCase.subtitle)")
    }
}

#Preview {
    OnboardingView(onFinish: { _ in })
}
