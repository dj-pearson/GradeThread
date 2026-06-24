import SwiftUI

/// Runs after photo intake. Kicks off the AI extraction in
/// ``AIExtractionManager`` (which survives this screen being dismissed), shows
/// progress, and offers "Continue in background" so the user doesn't have to
/// wait out the ~40s call. When the extraction finishes the high-confidence
/// fields are auto-applied and the reversible review is registered (US-686);
/// this screen then lands the user on the item, whose canvas auto-presents the
/// review. If the user dismissed to the background instead, the inventory list
/// shows a status pill and opening the item later pops the same review.
struct AIExtractView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PhotoUploadStore.self) private var uploadStore
    /// US-981: short-circuit with friendly copy when offline.
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    let inventoryItemId: String
    let userId: String
    /// Captured photos in their final upload slots.
    let photos: [(slot: PhotoSlotType, capture: PhotoCapture)]
    /// Invoked to land the user ON the new item (canvas) once extraction
    /// finishes (or on Skip after a failure).
    let onComplete: () -> Void
    /// Invoked when the user chooses to let the extraction finish in the
    /// background — dismisses this screen and returns to the inventory list,
    /// where the item shows a processing/review-ready pill.
    let onBackground: () -> Void

    @State private var manager = AIExtractionManager.shared
    /// Guards against firing `onComplete` more than once when the phase settles.
    @State private var navigated = false

    var body: some View {
        NavigationStack {
            content
                .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
                .navigationTitle("AI suggestions")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbarContent }
                .task {
                    manager.start(
                        itemId: inventoryItemId,
                        userId: userId,
                        photos: photos,
                        uploadStore: uploadStore,
                        isOffline: NetworkMonitor.isOffline(networkMonitor)
                    )
                }
                // Land on the item the moment the result is ready (covers the
                // already-ready case via `initial: true`).
                .onChange(of: isReady, initial: true) { _, ready in
                    guard ready, !navigated else { return }
                    navigated = true
                    onComplete()
                }
        }
    }

    private var isReady: Bool {
        if case .ready = manager.phase(for: inventoryItemId) { return true }
        return false
    }

    // MARK: - Phase routing

    @ViewBuilder
    private var content: some View {
        switch manager.phase(for: inventoryItemId) {
        case .failed(let message):
            failed(message: message)
        case .ready:
            // Result is in; `onChange` is navigating to the item.
            applying
        case .running, .none:
            processing
        }
    }

    // MARK: - States

    private var processing: some View {
        VStack(spacing: 16) {
            ProgressView().tint(Color.brandNavy).scaleEffect(1.4)
            Text("AI is reading your photos…")
                .font(.brandHeadline)
            Text("This can take up to a minute. You can keep working — we'll have it ready in your inventory.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
            ProgressDots()

            Button {
                AppRouter.haptic()
                onBackground()
            } label: {
                Text("Continue in background")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(Color.brandNavy)
                    .clipShape(Capsule())
            }
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var applying: some View {
        VStack(spacing: 14) {
            ProgressView().tint(Color.brandNavy).scaleEffect(1.2)
            Text("Applying AI suggestions…")
                .font(.brandHeadline)
            Text("Taking you to your item")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failed(message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(Color.brandAmber)
            Text("AI couldn't read these photos")
                .font(.brandHeadline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

            // US-1182: a transient/offline failure shouldn't force abandoning the
            // AI flow — offer an in-place retry, keeping Skip as the secondary out.
            Button {
                AppRouter.haptic()
                retry()
            } label: {
                Text("Try again")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(Color.brandNavy)
                    .clipShape(Capsule())
            }
            .padding(.top, 8)

            Button {
                manager.clear(for: inventoryItemId)
                onComplete()
            } label: {
                Text("Skip — I'll fill in manually")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private func retry() {
        manager.clear(for: inventoryItemId)
        manager.start(
            itemId: inventoryItemId,
            userId: userId,
            photos: photos,
            uploadStore: uploadStore,
            isOffline: NetworkMonitor.isOffline(networkMonitor)
        )
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            // Same effect as "Continue in background": the run keeps going.
            Button("Close") { onBackground() }
        }
    }
}

// MARK: - Progress dots

/// Three animated dots while the extract call is in flight.
private struct ProgressDots: View {
    private let phases = [0, 1, 2]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3) { _ in
                Circle()
                    .fill(Color.secondary.opacity(0.2))
                    .frame(width: 8, height: 8)
            }
        }
        .phaseAnimator(phases) { _, highestLit in
            HStack(spacing: 6) {
                ForEach(0..<3) { idx in
                    Circle()
                        .fill(idx <= highestLit ? Color.brandNavy : Color.secondary.opacity(0.2))
                        .frame(width: 8, height: 8)
                }
            }
        } animation: { _ in
            .easeInOut(duration: 0.4)
        }
    }
}
