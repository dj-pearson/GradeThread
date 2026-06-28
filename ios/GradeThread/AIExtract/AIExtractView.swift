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
    /// US-1212: re-enqueues this item's failed photo uploads (they continue in
    /// the background). Lives in ``PhotoIntakeView`` where the upload service is.
    let onRetryUploads: () -> Void

    @State private var manager = AIExtractionManager.shared
    /// Guards against firing `onComplete` more than once when the phase settles.
    @State private var navigated = false
    /// US-1212: set when the handoff is gated on a photo-upload failure.
    @State private var showUploadFailurePrompt = false

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
                    guard ready else { return }
                    completeHandoff()
                }
                // US-1212: a captured photo that failed to upload (flaky network,
                // expired token, iCloud-not-downloaded) used to whisk the user to
                // the canvas with no warning — then the grade flow later blocked
                // on a "missing" photo they actually took. Gate the handoff on a
                // retry prompt instead of silently dropping the failure.
                .confirmationDialog(
                    "Some photos didn't upload",
                    isPresented: $showUploadFailurePrompt,
                    titleVisibility: .visible
                ) {
                    Button("Retry uploads") {
                        onRetryUploads()
                        onComplete()
                    }
                    Button("Continue anyway", role: .destructive) { onComplete() }
                } message: {
                    Text("\(failedUploadCount) photo\(failedUploadCount == 1 ? "" : "s") didn't finish uploading. Retry now so they're attached before grading.")
                }
        }
    }

    private var isReady: Bool {
        if case .ready = manager.phase(for: inventoryItemId) { return true }
        return false
    }

    /// US-1212: count of this item's captured photos whose upload failed.
    private var failedUploadCount: Int {
        uploadStore.tasks(inventoryItemId: inventoryItemId).filter {
            if case .failed = $0.phase { return true }
            return false
        }.count
    }

    /// Completes the AI handoff, but first surfaces a retry prompt if any of the
    /// item's photo uploads failed (US-1212), so failures aren't silently dropped
    /// on the way to the canvas. `navigated` keeps it single-shot.
    private func completeHandoff() {
        guard !navigated else { return }
        navigated = true
        if failedUploadCount > 0 {
            showUploadFailurePrompt = true
        } else {
            onComplete()
        }
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
        case .uploading(let done, let total):
            // Publish gate: photos are being saved to the DB before the AI runs.
            publishing(done: done, total: total)
        case .running, .none:
            processing
        }
    }

    // MARK: - States

    /// Publish gate (the AI hasn't started yet): show how many photos have landed
    /// in the DB. The AI kicks off automatically once the required (front/back)
    /// photos are saved; optional photos keep uploading in the background.
    private func publishing(done: Int, total: Int) -> some View {
        VStack(spacing: 16) {
            ProgressView(value: Double(done), total: Double(max(total, 1)))
                .tint(Color.brandNavy)
                .padding(.horizontal, 40)
            Text("Saving your photos…")
                .font(.brandHeadline)
            Text("\(done) of \(total) saved")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("The AI starts as soon as your main photos are saved. You can keep working — it finishes on its own.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)

            if failedUploadCount > 0 {
                Button {
                    AppRouter.haptic()
                    onRetryUploads()
                } label: {
                    Text("Retry \(failedUploadCount) that didn't upload")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.brandNavy)
                }
                .padding(.top, 4)
            }

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
                completeHandoff()
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
        // US-1212/US-1231: if the failure was photos not landing, restarting the
        // extract alone is a no-op — the upload tasks are already terminal
        // (.failed), so waitForUploads returns immediately on the same empty set
        // and we bail again ("says Try again but nothing happens"). Re-enqueue the
        // failed uploads first so the retry actually re-sends the photos; the
        // restarted extract then waits for them and runs server-side once they
        // land.
        if failedUploadCount > 0 {
            onRetryUploads()
        }
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
