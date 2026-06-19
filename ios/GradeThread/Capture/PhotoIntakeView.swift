import AVFoundation
import PhotosUI
import SwiftUI
import UIKit

/// Guided 4-shot capture screen. Renders the camera preview full-bleed
/// with a slot strip + capture button overlay. The capture flow follows
/// the order Front → Back → Tag → Detail; the user can override by tapping
/// or swiping the strip.
///
/// Defect slots are hidden by default and revealed one at a time via the
/// "Add detail / defect" button — up to three.
struct PhotoIntakeView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var store: PhotoIntakeStore
    @State private var camera = CameraSession()
    @State private var permissionState: PermissionState = .unknown
    @State private var isCapturing = false
    @State private var startupError: String?
    @State private var slotForPreview: PhotoSlotType?
    @State private var showingExitConfirmation = false

    // US-646: photo-capture draft recovery.
    @State private var seededWithInitialPhotos: Bool
    @State private var photoDraftToResume = false

    /// Default initializer (camera-first flow with empty slots).
    init() {
        _store = State(initialValue: PhotoIntakeStore())
        _seededWithInitialPhotos = State(initialValue: false)
    }

    /// Pre-stage initializer (US-193) — accepts already-captured
    /// photos keyed by slot and seeds the intake store with them.
    /// Used by the drag-drop-from-Photos.app path on the inventory
    /// list.
    init(initialPhotos: [PhotoSlotType: PhotoCapture]) {
        let preloaded = PhotoIntakeStore()
        for (slot, photo) in initialPhotos {
            preloaded.setPhoto(photo, for: slot)
        }
        _store = State(initialValue: preloaded)
        _seededWithInitialPhotos = State(initialValue: !initialPhotos.isEmpty)
    }

    /// Inventory item id created when the user hits Done. Anchors every
    /// upload for this intake session AND the subsequent AI-extract review
    /// screen. Setting it presents the AIExtractView fullScreenCover.
    @State private var draftItemId: String?
    @State private var isCreatingItem = false

    // Injected services (US-175)
    @Environment(\.photoUploadService) private var uploadService
    @Environment(PhotoUploadStore.self) private var uploadStore
    @Environment(AuthStore.self) private var authStore

    // Library-import flow (US-174)
    @State private var showingLibraryPicker = false
    @State private var isLoadingLibraryPicks = false
    @State private var stagedPhotos: [PhotoCapture] = []
    @State private var showingStagingTray = false

    /// US-651: VoiceOver focus is moved here when the camera is ready so the
    /// user lands on the primary action instead of hunting for it.
    @AccessibilityFocusState private var captureControlFocused: Bool
    private static let libraryPickLimit = 8

    private enum PermissionState: Equatable {
        case unknown
        case granted
        case denied
    }

    var body: some View {
        ZStack {
            // Only the camera preview is full-bleed. The overlay (top close/Done
            // bar + bottom slot strip and capture button) must respect the safe
            // area — otherwise on notch / Dynamic Island devices the bars render
            // under the status bar and home indicator, sitting on top of the
            // buttons and making them hard to tap.
            cameraLayer
                .ignoresSafeArea()
            overlay
        }
        .navigationBarBackButtonHidden(true)
        .task {
            await bootstrap()
            // US-651: move VoiceOver focus to the shutter once the camera's up.
            if permissionState == .granted { captureControlFocused = true }
            // US-646: offer to resume an unsaved photo set from a prior session
            // (only on a fresh, non-preseeded launch with nothing captured yet).
            if !seededWithInitialPhotos, store.photos.isEmpty, PhotoDraftStore.hasDraft() {
                photoDraftToResume = true
            }
        }
        // US-646: persist captures as they change so a background-kill is
        // recoverable.
        .onChange(of: store.photos) { _, photos in
            PhotoDraftStore.save(photos: photos)
        }
        .confirmationDialog(
            "Resume your unsaved photos?",
            isPresented: $photoDraftToResume,
            titleVisibility: .visible
        ) {
            Button("Resume") { Task { await PhotoDraftStore.restore(into: store) } }
            Button("Start fresh", role: .destructive) { PhotoDraftStore.clear() }
        } message: {
            Text("You have photos from a session that didn't finish.")
        }
        // US-651: announce upload outcomes as they land (live region).
        .onChange(of: uploadTally) { old, new in
            if new.uploaded > old.uploaded {
                announce("Photo uploaded. \(new.uploaded) of \(store.visibleSlots.count) uploaded.")
            }
            if new.failed > old.failed {
                announce("Photo upload failed. Double-tap the slot to retry.")
            }
        }
        .onDisappear { camera.stop() }
        .confirmationDialog(
            "Discard captured photos?",
            isPresented: $showingExitConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
                PhotoDraftStore.clear()  // US-646: explicit discard
                store.reset()
                dismiss()
            }
            Button("Keep capturing", role: .cancel) {}
        } message: {
            Text("You have \(store.photos.count) photo\(store.photos.count == 1 ? "" : "s") that haven't been saved yet.")
        }
        .fullScreenCover(item: $slotForPreview) { slot in
            if let capture = store.photos[slot] {
                PhotoPreview(
                    slot: slot,
                    capture: capture,
                    onRetake: {
                        store.clearPhoto(at: slot)
                        store.setActiveSlot(slot)
                    },
                    onDelete: {
                        store.clearPhoto(at: slot)
                    }
                )
            }
        }
        .sheet(isPresented: $showingLibraryPicker) {
            PhotoLibraryPicker(selectionLimit: Self.libraryPickLimit) { results in
                Task { await ingestLibraryPicks(results) }
            }
            .ignoresSafeArea()
        }
        .fullScreenCover(
            isPresented: Binding(
                get: { draftItemId != nil },
                set: { if !$0 { draftItemId = nil } }
            )
        ) {
            if let itemId = draftItemId {
                AIExtractView(
                    inventoryItemId: itemId,
                    userId: currentUserId() ?? "",
                    photos: capturedEntries(),
                    onComplete: {
                        // US-682: once the AI step finishes (Apply / Skip /
                        // error), land the user ON the item they just created
                        // (canvas) instead of bouncing back to the camera tab.
                        // Reuses the proven deep-link route; a pull keeps the
                        // local row fresh. From the canvas, the Add control
                        // (every tab, US-684) starts the next item.
                        store.reset()
                        draftItemId = nil
                        dismiss()
                        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                        DeepLinkRouter.post(.inventoryItem(id: itemId))
                    }
                )
            }
        }
        .sheet(isPresented: $showingStagingTray, onDismiss: {
            // A canceled tray drops everything that wasn't assigned — the
            // user can always re-pick.
            stagedPhotos.removeAll()
        }) {
            PhotoStagingTray(
                staged: stagedPhotos,
                availableSlots: availableSlots(for:),
                onAssign: assign(stagedPhoto:to:),
                onDiscard: { photo in
                    stagedPhotos.removeAll { $0.id == photo.id }
                }
            )
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: - Layers

    @ViewBuilder
    private var cameraLayer: some View {
        switch permissionState {
        case .granted:
            CameraPreview(session: camera.session)
                .background(Color.black)
        case .denied:
            permissionDeniedView
        case .unknown:
            ZStack {
                Color.black
                if let startupError {
                    Text(startupError)
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding()
                } else {
                    ProgressView().tint(.white)
                }
            }
        }
    }

    private var overlay: some View {
        VStack {
            topBar
            Spacer()
            Text(store.activeSlot.hint)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.black.opacity(0.45))
                .clipShape(Capsule())
                .padding(.bottom, 8)

            bottomStrip
            captureRow
        }
    }

    private var topBar: some View {
        HStack {
            Button {
                if store.hasUnsavedShots {
                    showingExitConfirmation = true
                } else {
                    dismiss()
                }
            } label: {
                Image(systemName: "xmark")
                    .scaledIconFont(size: 18, weight: .semibold)
                    .foregroundStyle(.white)
                    .padding(12)
                    .background(.black.opacity(0.45))
                    .clipShape(Circle())
            }
            .accessibilityLabel("Close")

            Spacer()

            if store.allRequiredFilled {
                Button {
                    AppRouter.haptic()
                    Task { await startIntakeFlow() }
                } label: {
                    HStack(spacing: 6) {
                        if isCreatingItem {
                            ProgressView().tint(.white)
                        }
                        Text("Done")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.brandNavy)
                    .clipShape(Capsule())
                }
                .disabled(uploadService == nil || isCreatingItem)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 24)
    }

    /// One slot in the bottom strip. A filled slot gets a visible trash
    /// badge (US-1022) so sighted users can discover deletion without the
    /// hidden 0.4s long-press — the long-press still works as a shortcut,
    /// and VoiceOver keeps using the `.accessibilityActions` delete action
    /// (the visible badge is hidden from it to avoid a duplicate).
    @ViewBuilder
    private func slotButton(for slot: PhotoSlotType) -> some View {
        Button {
            AppRouter.haptic()
            if let phase = uploadPhase(for: slot), case .failed = phase {
                // Tap on a failed slot retries the upload instead of
                // opening the preview — that's the affordance the slot's
                // failureOverlay teases.
                retryUpload(for: slot)
            } else if store.photos[slot] != nil {
                slotForPreview = slot
            } else {
                store.setActiveSlot(slot)
            }
        } label: {
            SlotThumbnail(
                slot: slot,
                capture: store.photos[slot],
                isActive: store.activeSlot == slot,
                uploadPhase: uploadPhase(for: slot)
            )
        }
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.4).onEnded { _ in
                if store.photos[slot] != nil {
                    AppRouter.haptic()
                    store.clearPhoto(at: slot)
                }
            }
        )
        // US-1022: visible delete affordance for filled slots. Scoped to
        // the capture/review stage (no in-flight upload) so it never
        // overlaps the upload progress / retry overlays. Sits on top of
        // the slot button so its tap takes precedence over opening the
        // preview.
        .overlay(alignment: .topLeading) {
            if store.photos[slot] != nil, uploadPhase(for: slot) == nil {
                deleteBadge(for: slot)
            }
        }
        // US-704: VoiceOver/Switch Control can't do the long-press, so
        // expose delete as an accessibility action on filled slots.
        .accessibilityActions {
            if store.photos[slot] != nil {
                Button("Delete photo") {
                    AppRouter.haptic()
                    store.clearPhoto(at: slot)
                }
            }
        }
    }

    /// Tappable trash badge overlaid on a filled slot's top-leading corner.
    /// Hidden from VoiceOver — the slot already carries a "Delete photo"
    /// accessibility action, so surfacing this as a second element would be
    /// a redundant control.
    private func deleteBadge(for slot: PhotoSlotType) -> some View {
        Button {
            AppRouter.haptic()
            store.clearPhoto(at: slot)
        } label: {
            Image(systemName: "trash.fill")
                .scaledIconFont(size: 11, weight: .bold, maxSize: 20)
                .foregroundStyle(.white)
                .padding(6)
                .background(Color.brandRed)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.9), lineWidth: 1.5))
        }
        .offset(x: -6, y: -6)
        .accessibilityHidden(true)
    }

    private var bottomStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(store.visibleSlots) { slot in
                    slotButton(for: slot)
                }

                if !store.hiddenExtraSlots.isEmpty {
                    Menu {
                        if let defect = store.nextHiddenDefectSlot {
                            Button {
                                AppRouter.haptic()
                                store.reveal(defect)
                            } label: {
                                Label("Defect", systemImage: defect.systemImage)
                            }
                        }
                        ForEach(
                            PhotoSlotType.extras.filter {
                                !store.extraSlots.contains($0)
                            }
                        ) { slot in
                            Button {
                                AppRouter.haptic()
                                store.reveal(slot)
                            } label: {
                                Label(slot.label, systemImage: slot.systemImage)
                            }
                        }
                        Section("Measurements") {
                            ForEach(
                                PhotoSlotType.measurements.filter {
                                    !store.extraSlots.contains($0)
                                }
                            ) { slot in
                                Button {
                                    AppRouter.haptic()
                                    store.reveal(slot)
                                } label: {
                                    Label(slot.label, systemImage: slot.systemImage)
                                }
                            }
                        }
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "plus")
                                .scaledIconFont(size: 20, weight: .medium, maxSize: 40)
                                .foregroundStyle(.white)
                                .frame(width: 64, height: 64)
                                .background(.white.opacity(0.08))
                                .overlay(
                                    RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous)
                                        .stroke(.white.opacity(0.4), style: .init(lineWidth: 1, dash: [4, 3]))
                                )
                                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                            Text("More")
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.7))
                        }
                    }
                    .accessibilityLabel("Add a photo slot")
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private var captureRow: some View {
        HStack(spacing: 32) {
            // Library button on the left — opens PHPicker. Disabled while
            // we're already loading a pick batch so the user can't queue
            // up a second picker before the first one finishes processing.
            Button {
                AppRouter.haptic()
                showingLibraryPicker = true
            } label: {
                ZStack {
                    if isLoadingLibraryPicks {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "photo.on.rectangle")
                            .scaledIconFont(size: 22, weight: .medium, maxSize: 34)
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 56, height: 56)
                .background(.black.opacity(0.45))
                .clipShape(Circle())
            }
            .disabled(isLoadingLibraryPicks)
            .accessibilityLabel("Pick from photo library")

            Button(action: capture) {
                ZStack {
                    Circle()
                        .stroke(.white, lineWidth: 4)
                        .frame(width: 76, height: 76)
                    Circle()
                        .fill(isCapturing ? Color.brandNavy : .white)
                        .frame(width: 62, height: 62)
                    if isCapturing {
                        ProgressView().tint(.white)
                    }
                }
            }
            .disabled(permissionState != .granted || isCapturing)
            .accessibilityLabel("Capture photo")
            .accessibilityHint("\(store.photos.count) of \(store.visibleSlots.count) slots filled")
            .accessibilityFocused($captureControlFocused)

            // Right-side spacer balances the layout. Reserved for a future
            // "switch camera" button (front-facing capture isn't part of
            // the grading flow but US-179 may want it for selfies on
            // workspace photos).
            Color.clear.frame(width: 56, height: 56)
        }
        .padding(.bottom, 32)
    }

    private var permissionDeniedView: some View {
        VStack(spacing: 18) {
            Image(systemName: "camera.fill")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(.white)
            Text("Camera access is off")
                .font(.brandTitle2)
                .foregroundStyle(.white)
            Text("Turn it on in Settings to capture photos, or pick existing shots from your library to keep going.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white.opacity(0.8))
                .padding(.horizontal, 32)

            // US-1005: real Photo Library fallback. PHPicker needs no camera
            // (or library) permission, so this works even with camera access
            // denied. Picks flow through the same staging-tray → assign →
            // upload pipeline as captured shots via `ingestLibraryPicks`.
            Button {
                AppRouter.haptic()
                showingLibraryPicker = true
            } label: {
                HStack(spacing: 8) {
                    if isLoadingLibraryPicks {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "photo.on.rectangle")
                            .scaledIconFont(size: 16, weight: .semibold)
                    }
                    Text("Pick from Library")
                        .font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Color.brandNavy)
                .clipShape(Capsule())
            }
            .disabled(isLoadingLibraryPicks)
            .accessibilityLabel("Pick from photo library")

            if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: settingsURL) {
                    Text("Open Settings")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .overlay(Capsule().stroke(.white.opacity(0.5), lineWidth: 1))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }

    // MARK: - Accessibility (US-651)

    /// Tally of upload outcomes across the visible slots, used to drive
    /// success/failure VoiceOver announcements via `.onChange`.
    private struct UploadTally: Equatable { let uploaded: Int; let failed: Int }

    private var uploadTally: UploadTally {
        var uploaded = 0
        var failed = 0
        for slot in store.visibleSlots {
            guard let phase = uploadPhase(for: slot) else { continue }
            if case .uploaded = phase { uploaded += 1 }
            else if case .failed = phase { failed += 1 }
        }
        return UploadTally(uploaded: uploaded, failed: failed)
    }

    /// Posts a VoiceOver announcement (live region) when VoiceOver is running.
    private func announce(_ message: String) {
        guard UIAccessibility.isVoiceOverRunning else { return }
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    // MARK: - Actions

    private func bootstrap() async {
        do {
            try await camera.start()
            permissionState = .granted
        } catch CameraSession.CameraError.permissionDenied {
            permissionState = .denied
        } catch {
            // US-1025: friendly copy on-screen; raw detail to Sentry.
            let detail = FriendlyErrorCopy.rawDetail(for: error)
            Telemetry.breadcrumb("Camera start failed: \(detail)", category: "capture")
            startupError = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't start the camera. Please try again."
            )
        }
    }

    // MARK: - Upload + AI extract flow (US-175 / US-176)

    private func uploadPhase(for slot: PhotoSlotType) -> PhotoUploadTask.Phase? {
        guard let itemId = draftItemId else { return nil }
        return uploadStore.task(for: slot, inventoryItemId: itemId)?.phase
    }

    private func capturedEntries() -> [(slot: PhotoSlotType, capture: PhotoCapture)] {
        store.visibleSlots.compactMap { slot in
            guard let capture = store.photos[slot] else { return nil }
            return (slot, capture)
        }
    }

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }

    /// End-to-end intake hand-off:
    ///   1. Create the `inventory_items` row so US-175's item_photos
    ///      insert has a valid foreign key.
    ///   2. Enqueue the photo uploads against the new row id.
    ///   3. Set `draftItemId` to present the AIExtractView fullScreenCover.
    private func startIntakeFlow() async {
        guard let service = uploadService else { return }
        guard let userId = currentUserId() else { return }
        guard !isCreatingItem else { return }

        isCreatingItem = true
        defer { isCreatingItem = false }

        let entries = capturedEntries()
        guard !entries.isEmpty else { return }

        let newItemId: String
        do {
            newItemId = try await createDraftInventoryItem(userId: userId)
        } catch {
            // US-1025: friendly copy on-screen; raw detail to Sentry.
            let detail = FriendlyErrorCopy.rawDetail(for: error)
            Telemetry.breadcrumb("Create draft item failed: \(detail)", category: "intake")
            Telemetry.event("intake_save_error", props: ["detail": detail])
            startupError = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't create your item. Please try again."
            )
            return
        }

        // US-682: mirror the new row into the local cache immediately so the
        // post-intake deep link lands on the item's canvas (not the list). The
        // next sync pull upserts it by id; it won't be pruned as stale because
        // it already exists server-side.
        let localItem = LocalInventoryItem(
            id: newItemId,
            userId: userId,
            title: "Untitled item",
            status: "cataloged"
        )
        modelContext.insert(localItem)
        try? modelContext.save()

        service.enqueueAll(
            photos: entries,
            inventoryItemId: newItemId,
            userId: userId
        )
        // US-646: the captures are committed to the upload queue — drop the
        // recovery draft.
        PhotoDraftStore.clear()
        draftItemId = newItemId
    }

    /// Inserts an `inventory_items` row with the minimum required fields
    /// so the AI extract step has somewhere to write accepted suggestions.
    /// Returns the new row id.
    private func createDraftInventoryItem(userId: String) async throws -> String {
        struct ItemInsert: Encodable {
            let user_id: String
            let title: String
            let status: String
        }
        struct ItemRowId: Decodable {
            let id: String
        }
        // Title is intentionally generic — the AI extract step typically
        // surfaces a brand + descriptor that the user can promote to a
        // real title later (US-178 / US-182).
        let payload = ItemInsert(
            user_id: userId,
            title: "Untitled item",
            status: "cataloged"
        )
        let response: [ItemRowId] = try await SupabaseShared.client
            .from("inventory_items")
            .insert(payload, returning: .representation)
            .select("id")
            .execute()
            .value
        guard let id = response.first?.id else {
            throw EdgeAPIError.serverError(detail: "No id returned from insert")
        }
        return id
    }

    private func retryUpload(for slot: PhotoSlotType) {
        guard let itemId = draftItemId,
              let task = uploadStore.task(for: slot, inventoryItemId: itemId),
              let service = uploadService
        else { return }
        service.retry(task.id)
    }

    // MARK: - Library import (US-174)

    /// Slots eligible for the given staged photo — empty slots in the
    /// currently-visible strip, plus every optional slot not yet revealed
    /// (next hidden defect first, then the extended taxonomy). Re-evaluated
    /// per-photo so two staged photos can both pick "Defect 1" or both
    /// target newly-revealed slots without confusing the menu.
    private func availableSlots(for _: PhotoCapture) -> [PhotoSlotType] {
        store.visibleSlots.filter { store.photos[$0] == nil }
            + store.hiddenExtraSlots
    }

    private func assign(stagedPhoto: PhotoCapture, to slot: PhotoSlotType) {
        // setPhoto auto-reveals hidden optional slots, so the strip always
        // shows the assigned photo.
        store.setPhoto(stagedPhoto, for: slot)
        stagedPhotos.removeAll { $0.id == stagedPhoto.id }
    }

    /// Compresses each picked image on the background actor pool, then
    /// flips to the staging tray. PHPicker results sometimes arrive out
    /// of order; we keep the picker's order for the tray.
    private func ingestLibraryPicks(_ results: [PHPickerResult]) async {
        guard !results.isEmpty else { return }
        isLoadingLibraryPicks = true
        defer { isLoadingLibraryPicks = false }

        var staged: [PhotoCapture] = []
        for result in results {
            guard let image = await result.loadImage() else { continue }
            guard let output = await PhotoCompressor.compressOffMain(image) else { continue }
            // Read the original PHAsset capture time before compression strips
            // EXIF (US-289); fall back to now if the library isn't readable.
            let capturedAt = result.creationDate() ?? .now
            staged.append(
                PhotoCapture(
                    imageData: output.imageData,
                    thumbnail: output.thumbnail,
                    capturedAt: capturedAt,
                    source: .library
                )
            )
        }
        guard !staged.isEmpty else {
            startupError = "Couldn't read those photos. Try again or pick different ones."
            return
        }
        stagedPhotos = staged
        showingStagingTray = true
    }

    private func capture() {
        guard !isCapturing else { return }
        // US-195: medium impact for an action with a tangible outcome
        // (photo captured) + the standard iOS shutter sound that's
        // mandatory in some locales.
        HapticFeedback.medium()
        HapticFeedback.playShutterSound()
        isCapturing = true
        Task {
            defer { isCapturing = false }
            do {
                let image = try await camera.capturePhoto()
                // US-636: compress off the main actor.
                guard let output = await PhotoCompressor.compressOffMain(image) else {
                    startupError = "Couldn't compress the photo."
                    return
                }
                let photo = PhotoCapture(
                    imageData: output.imageData,
                    thumbnail: output.thumbnail,
                    source: .camera
                )
                store.recordCapture(photo)
                // US-651: announce slot-filled progress as a live region.
                announce("Photo captured. \(store.photos.count) of \(store.visibleSlots.count) slots filled.")
            } catch {
                // US-1025: friendly copy on-screen; raw detail to Sentry.
                let detail = FriendlyErrorCopy.rawDetail(for: error)
                Telemetry.breadcrumb("Photo capture failed: \(detail)", category: "capture")
                startupError = FriendlyErrorCopy.actionMessage(
                    for: error,
                    fallback: "Couldn't capture the photo. Please try again."
                )
            }
        }
    }
}

#Preview {
    PhotoIntakeView()
}
