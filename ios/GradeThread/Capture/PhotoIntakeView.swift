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
    // US-1408: drives camera-session restart on return to foreground.
    @Environment(\.scenePhase) private var scenePhase
    /// US-2470: the server-authoritative photo profile table. The camera-first
    /// intake has no item and therefore no category yet, so this resolves the
    /// default clothing profile — but the SERVER's, whose roles are named
    /// (brand label, size tag, fabric close-up) instead of the numbered
    /// `tag_2`/`detail_2` slots the strip used to offer.
    @Environment(PhotoProfileStore.self) private var photoProfileStore

    @State private var store: PhotoIntakeStore
    @State private var camera = CameraSession()
    @State private var permissionState: PermissionState = .unknown
    @State private var isCapturing = false
    @State private var startupError: String?
    // US-1181: runtime failures that happen AFTER the camera is up (item
    // creation, library import, compression, capture) — `startupError` is only
    // rendered in the camera-bootstrap (.unknown) placeholder, so those were
    // set but never shown. This drives an alert visible in the .granted state.
    @State private var captureError: String?
    /// US-1181: when a library import partially fails we still want to open the
    /// staging tray, but only after the "couldn't load N photos" alert is
    /// dismissed (presenting an alert + sheet in the same tick is unreliable).
    @State private var openTrayAfterAlert = false
    /// US-2925: ONE full-screen cover slot. The slot preview and the AI-extract
    /// step were two `.fullScreenCover` modifiers on this view; covers have the
    /// same single-slot rule as sheets, and check-chained-sheets.py never looked
    /// at them.
    private enum IntakeCover: Identifiable {
        case slotPreview(CaptureSlot)
        case aiExtract(String)

        var id: String {
            switch self {
            case .slotPreview(let slot): return "preview-\(slot)"
            case .aiExtract(let itemId): return "extract-\(itemId)"
            }
        }
    }
    @State private var intakeCover: IntakeCover?
    @State private var showingExitConfirmation = false
    /// US-686: tag-photo quality pre-flight (nudge to retake a blurry/low-res
    /// tag before spending an AI action). `isCheckingTag` covers the brief OCR
    /// pass; `pendingPoorTag` drives the retake prompt.
    @State private var isCheckingTag = false
    @State private var pendingPoorTag: TagPhotoQuality.Reason?

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
    init(initialPhotos: [CaptureSlot: PhotoCapture]) {
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
    /// US-2925: ONE sheet slot. The library picker and the staging tray were
    /// two chained `.sheet` modifiers competing for it, and the staging tray is
    /// what the picker hands off to - so the losing frame landed exactly where
    /// a multi-photo pick needs to be assigned.
    private enum IntakeSheet: String, Identifiable {
        case libraryPicker
        case stagingTray
        var id: String { rawValue }
    }
    @State private var intakeSheet: IntakeSheet?
    @State private var isLoadingLibraryPicks = false
    @State private var stagedPhotos: [PhotoCapture] = []


    /// US-651: VoiceOver focus is moved here when the camera is ready so the
    /// user lands on the primary action instead of hunting for it.
    @AccessibilityFocusState private var captureControlFocused: Bool
    private static let libraryPickLimit = 8

    /// US-2070: how many library picks are decoded and compressed at once.
    ///
    /// Deliberately the same 3 as `AutoListerReviewModel.importConcurrency`, and
    /// for the same reason it gives: three at a time keeps at most three
    /// full-resolution images resident - the bound `PhotoCompressor.compressBatch`
    /// uses to stay clear of a jetsam kill - while overlapping each photo's
    /// iCloud download with the previous one's encode.
    private static let libraryImportConcurrency = 3

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
        // US-1408: iOS stops the capture session when the app backgrounds (or
        // during a call / Control Center / FaceTime PiP) and does NOT auto-resume
        // it; this view survives in a fullScreenCover so its one-shot `.task`
        // won't re-fire. Restart on return to foreground so the preview can't
        // freeze on a black frame with a live-but-dead shutter. (CameraSession
        // also self-heals from interruption notifications; this is belt-and-
        // suspenders and idempotent.)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { camera.restartIfNeeded() }
        }
        .task {
            // Applied BEFORE bootstrap: the strip renders on the first frame and
            // a profile that landed after it would visibly reshuffle the slots
            // under the seller's thumb. `loadIfNeeded` is a no-op after the
            // app-launch fetch, so this is normally free.
            await photoProfileStore.loadIfNeeded()
            store.apply(profile: photoProfileStore.profile(for: nil, garment: nil))
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
        // recoverable. US-1519: incremental — only the changed slot's JPEG is
        // written, on a background queue (the full sync rewrite of every staged
        // photo per shutter press was a growing MainActor hitch).
        .onChange(of: store.photos) { old, new in
            PhotoDraftStore.update(from: old, to: new)
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
        // US-965: announce the active slot's capture guidance to VoiceOver when
        // the slot changes (tap, swipe, or auto-advance after a capture) so the
        // per-slot guidance is not sighted-only.
        .onChange(of: store.activeSlot) { _, slot in
            announce("\(slot.label). \(slot.hint)")
        }
        .onDisappear { camera.stop() }
        // US-1181: surface runtime capture/import/save failures that occur while
        // the camera preview is showing (the .unknown placeholder text never
        // appears in the .granted state).
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { captureError != nil },
                set: { if !$0 { captureError = nil } }
            )
        ) {
            Button("OK") {
                captureError = nil
                if openTrayAfterAlert {
                    openTrayAfterAlert = false
                    if !stagedPhotos.isEmpty { intakeSheet = .stagingTray }
                }
            }
        } message: {
            Text(captureError ?? "")
        }
        // US-686: nudge to retake a blurry/low-res tag before AI runs.
        .alert(
            "Tag photo looks hard to read",
            isPresented: Binding(
                get: { pendingPoorTag != nil },
                set: { if !$0 { pendingPoorTag = nil } }
            )
        ) {
            Button("Retake tag photo") {
                pendingPoorTag = nil
                store.clearPhoto(at: .tag)
                store.setActiveSlot(.tag)
            }
            Button("Use anyway", role: .destructive) {
                pendingPoorTag = nil
                Task { await startIntakeFlow() }
            }
            Button("Cancel", role: .cancel) { pendingPoorTag = nil }
        } message: {
            Text(pendingPoorTag.map(TagPhotoQuality.message(for:)) ?? "")
        }
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
        // US-2925: ONE cover slot. See ``IntakeCover``.
        // US-2925: mirror the AI-extract trigger into the single cover slot.
        .onChange(of: draftItemId) { _, id in
            if let id { intakeCover = .aiExtract(id) }
            else if case .aiExtract = intakeCover { intakeCover = nil }
        }
        .fullScreenCover(item: $intakeCover) { cover in
            switch cover {
            case .slotPreview(let slot):
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
            case .aiExtract(let itemId):
                aiExtractCover(itemId: itemId)
            }
        }
        .sheet(item: $intakeSheet) { sheet in
            switch sheet {
            case .libraryPicker:
                PhotoLibraryPicker(selectionLimit: Self.libraryPickLimit) { results in
                    Task { await ingestLibraryPicks(results) }
                }
                .ignoresSafeArea()
            case .stagingTray:
                PhotoStagingTray(
                    staged: stagedPhotos,
                    availableSlots: availableSlots(for:),
                    autoAssignCapacity: store.autoAssignTargets(count: stagedPhotos.count).count,
                    onAssignAll: assignAllStagedPhotos,
                    onAssign: assign(stagedPhoto:to:),
                    onDiscard: { photo in
                        stagedPhotos.removeAll { $0.id == photo.id }
                    }
                )
                .presentationDetents([.medium, .large])
                // The tray's cleanup lives on the TRAY's content, not in a
                // shared `onDismiss`: a swipe-dismiss never calls a modal's own
                // callback, and a shared one would also fire for the picker and
                // wipe the photos it had just staged.
                .onDisappear {
                    // A canceled tray drops everything that wasn't assigned -
                    // the user can always re-pick.
                    stagedPhotos.removeAll()
                }
            }
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
                // US-965: label the guidance capsule so VoiceOver reads it as
                // capture guidance rather than a bare floating phrase.
                .accessibilityLabel("Capture guidance for \(store.activeSlot.label): \(store.activeSlot.hint)")

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
                    Task { await handleDone() }
                } label: {
                    HStack(spacing: 6) {
                        if isCreatingItem || isCheckingTag {
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
                .disabled(uploadService == nil || isCreatingItem || isCheckingTag)
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
    private func slotButton(for slot: CaptureSlot) -> some View {
        Button {
            AppRouter.haptic()
            if let phase = uploadPhase(for: slot), case .failed = phase {
                // Tap on a failed slot retries the upload instead of
                // opening the preview — that's the affordance the slot's
                // failureOverlay teases.
                retryUpload(for: slot)
            } else if store.photos[slot] != nil {
                intakeCover = .slotPreview(slot)
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
    private func deleteBadge(for slot: CaptureSlot) -> some View {
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

                // US-2470: every entry below comes from the RESOLVED PHOTO
                // PROFILE, not from a fixed `PhotoSlotType.extras +
                // .measurements` list. That list offered a pair of trousers a
                // sleeve measurement, offered a watch a flat lay, and could only
                // call a second tag shot "Tag 2" — the profile knows it is the
                // size tag and says so.
                if !store.hiddenExtraSlots.isEmpty {
                    Menu {
                        if let defect = store.nextHiddenDefectSlot {
                            Button {
                                AppRouter.haptic()
                                store.reveal(defect)
                            } label: {
                                Label(defect.label, systemImage: defect.systemImage)
                            }
                        }
                        ForEach(store.hiddenGeneralSlots) { slot in
                            Button {
                                AppRouter.haptic()
                                store.reveal(slot)
                            } label: {
                                Label(slot.label, systemImage: slot.systemImage)
                            }
                        }
                        // Measurements keep their own section: a garment can
                        // have five and they would otherwise bury everything
                        // else in the menu.
                        if !store.hiddenMeasurementSlots.isEmpty {
                            Section("Measurements") {
                                ForEach(store.hiddenMeasurementSlots) { slot in
                                    Button {
                                        AppRouter.haptic()
                                        store.reveal(slot)
                                    } label: {
                                        Label(slot.label, systemImage: slot.systemImage)
                                    }
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
                intakeSheet = .libraryPicker
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
            .accessibilityIdentifier("capture.shutter") // US-1173: stable UI-test selector
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
                intakeSheet = .libraryPicker
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

    private func uploadPhase(for slot: CaptureSlot) -> PhotoUploadTask.Phase? {
        guard let itemId = draftItemId else { return nil }
        return uploadStore.task(for: slot, inventoryItemId: itemId)?.phase
    }

    /// US-2470: the profile's own order, which IS the `sort_order` written to
    /// `item_photos` and therefore the gallery order and the eBay cover. It used
    /// to be the strip order, which was close enough only while every category
    /// shared one hard-coded strip.
    private func capturedEntries() -> [(slot: CaptureSlot, capture: PhotoCapture)] {
        store.orderedCaptures
    }

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }

    /// US-686: gate the hand-off on a tag-photo quality check. If a tag was
    /// captured but is too low-res / unreadable, prompt to retake BEFORE
    /// creating the item + spending an AI action; otherwise proceed straight in.
    /// No tag captured → nothing to check, proceed.
    private func handleDone() async {
        // US-2470: whichever tag shot the seller took. Under a profile the tag
        // slots are `tag:brand` / `tag:size` / `tag:care`, so keying on the bare
        // `.tag` slot skipped the blur check on every one of them.
        if let tag = store.visibleSlots.first(where: { $0.isTagSlot && store.photos[$0] != nil })
            .flatMap({ store.photos[$0] }) {
            isCheckingTag = true
            let assessment = await TagPhotoQuality.assess(tag)
            isCheckingTag = false
            if case .poor(let reason) = assessment {
                pendingPoorTag = reason
                return
            }
        }
        await startIntakeFlow()
    }

    /// End-to-end intake hand-off:
    ///   1. Create the `inventory_items` row so US-175's item_photos
    ///      insert has a valid foreign key.
    ///   2. Enqueue the photo uploads against the new row id.
    ///   3. Set `draftItemId` to present the AIExtractView fullScreenCover.
    private func startIntakeFlow() async {
        guard let service = uploadService else { return }
        // US-1522: auth died mid-capture — surface it instead of silently
        // no-oping on Done (the user tapped Done and nothing happened).
        guard let userId = currentUserId() else {
            captureError = "Your session expired. Sign in again to save these photos."
            return
        }
        guard !isCreatingItem else { return }

        isCreatingItem = true
        defer { isCreatingItem = false }

        let entries = capturedEntries()
        guard !entries.isEmpty else { return }

        // Client-generated id so the row has a stable identity whether it lands
        // on the server now or replays from the offline queue later. This lets
        // the photo-first path survive a flaky/absent network the same way the
        // manual details form does, instead of dead-ending on "Couldn't create
        // your item" and discarding the captures.
        //
        // LOWERCASED (load-bearing): Postgres normalizes the `uuid` column to
        // lowercase, but Swift's `UUID().uuidString` is UPPERCASE. If the local
        // SwiftData mirror below keeps the uppercase id, the next sync pull
        // returns the row lowercased and the case-sensitive merge lookup
        // (`existingById[remote.id]` in SyncMergeActor) MISSES — inserting a
        // SECOND item. Photos (item_photos.inventory_item_id, also lowercased by
        // Postgres) attach to the server/lowercase row, so you get a duplicate:
        // one item WITH photos (lowercase) and one WITHOUT (uppercase mirror).
        let newItemId = UUID().uuidString.lowercased()
        // US-1516: a workspace MEMBER adding an item while viewing a shared
        // workspace must write it under the OWNER's tenant (mirrors web/edge +
        // DetailsIntake's US-670 path). Writing it under `self` landed it in the
        // member's PERSONAL tenant — never returned by the owner-scoped sync pull,
        // and the local mirror got pruned on the next full backfill ("I added an
        // item and it disappeared"). Personal workspace: tenantOwnerId falls back
        // to self. RLS: the 00042 member INSERT policy (listing_manager+) permits
        // the owner-scoped write. Photo uploads below still use the member's OWN
        // uid for the storage folder (per-user-folder storage RLS = auth.uid()).
        let ownerId = WorkspaceScope.tenantOwnerId(selfId: userId)
        let payload = ItemInsert(
            id: newItemId,
            user_id: ownerId,
            title: "Untitled item",
            status: "cataloged"
        )
        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .insert(payload)
                .execute()
        } catch {
            // A network-y failure → queue the create for SyncEngine replay (UPSERT
            // by the client id) and proceed, exactly like DetailsIntakeView. The
            // captures still enqueue and the item appears locally, so nothing is
            // lost offline. Anything else (RLS denial, enum mismatch, …) is a real
            // problem and is surfaced — US-1025: friendly copy on-screen, raw
            // detail to Sentry.
            if FriendlyErrorCopy.isOffline(error) {
                enqueueOfflineItemCreate(payload: payload, id: newItemId)
            } else {
                let detail = FriendlyErrorCopy.rawDetail(for: error)
                Telemetry.breadcrumb("Create draft item failed: \(detail)", category: "intake")
                Telemetry.event("intake_save_error", props: ["detail": detail])
                captureError = FriendlyErrorCopy.actionMessage(
                    for: error,
                    fallback: "Couldn't create your item. Please try again."
                )
                return
            }
        }

        // US-682: mirror the new row into the local cache immediately so the
        // post-intake deep link lands on the item's canvas (not the list). The
        // next sync pull upserts it by id; it won't be pruned as stale because
        // it already exists server-side.
        // US-1516: mirror under the SAME (owner) tenant as the server row so the
        // owner-scoped pull reconciles it instead of pruning it as stale.
        let localItem = LocalInventoryItem(
            id: newItemId,
            userId: ownerId,
            title: "Untitled item",
            status: "cataloged"
        )
        modelContext.insert(localItem)
        modelContext.saveOrLog("startIntakeFlow")

        service.enqueueAll(
            photos: entries,
            inventoryItemId: newItemId,
            userId: userId
        )
        // US-646/US-1621: the captures are now DURABLY committed — enqueueAll
        // writes a LocalPendingMutation per photo, so even a mid-batch app kill
        // replays them at launch (idempotent via the deterministic photo_id)
        // rather than orphaning the item. Safe to drop the recovery draft.
        PhotoDraftStore.clear()
        draftItemId = newItemId
    }

    /// Minimal `inventory_items` insert for the photo-first draft row. The
    /// client-generated `id` gives the row a stable identity across the online
    /// insert and the offline-replay UPSERT, and is the foreign key the photo
    /// uploads + AI-extract writes hang off. Title is intentionally generic —
    /// the AI extract step typically surfaces a brand + descriptor the user can
    /// promote to a real title later (US-178 / US-182).
    private struct ItemInsert: Encodable {
        let id: String
        let user_id: String
        let title: String
        let status: String
    }

    /// Queues the draft-item create for SyncEngine replay when the live insert
    /// failed offline. The payload already carries the client id, so the replay
    /// UPSERTs the same row (no duplicate) once connectivity returns — mirroring
    /// `DetailsIntakeView.enqueueOfflineMutation`.
    private func enqueueOfflineItemCreate(payload: ItemInsert, id: String) {
        guard let data = try? JSONEncoder().encode(payload) else { return }
        let mutation = LocalPendingMutation(
            kind: .createInventoryItem,
            payload: data,
            targetId: id
        )
        modelContext.insert(mutation)
        modelContext.saveOrLog("PhotoIntake.enqueueOfflineItemCreate")
    }

    private func retryUpload(for slot: CaptureSlot) {
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
    private func availableSlots(for _: PhotoCapture) -> [CaptureSlot] {
        store.visibleSlots.filter { store.photos[$0] == nil }
            + store.hiddenExtraSlots
    }

    /// US-2818: place the whole batch without asking for a tag, the way the web
    /// bulk add does. Required slots fill first (so the item still earns
    /// "photographed"), the rest become ordinary listing photos, and anything
    /// that did not fit stays in the tray to be tagged or discarded rather than
    /// being dropped.
    private func assignAllStagedPhotos() {
        let targets = store.autoAssignTargets(count: stagedPhotos.count)
        guard !targets.isEmpty else { return }
        for (photo, slot) in zip(stagedPhotos, targets) {
            store.setPhoto(photo, for: slot)
        }
        let placed = Set(stagedPhotos.prefix(targets.count).map(\.id))
        stagedPhotos.removeAll { placed.contains($0.id) }
        HapticFeedback.success()
        announce("Added \(targets.count) photo\(targets.count == 1 ? "" : "s").")
    }

    private func assign(stagedPhoto: PhotoCapture, to slot: CaptureSlot) {
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

        // US-2070: bounded-concurrency import, mirroring
        // `AutoListerReviewModel.importPicks`. This was strictly serial, so 200
        // iCloud-backed photos meant 200 sequential round trips with the seller
        // watching a spinner.
        //
        // SLICED rather than one big task group, and NOT "load everything then
        // compress": both would hold every decoded UIImage in memory at once,
        // which is the jetsam risk `PhotoCompressor` warns about. Three at a
        // time is the same width the AutoLister import settled on.
        //
        // Order is restored per slice because PHPicker results can finish out of
        // order and the tray shows the picker's order - the doc comment above
        // has always promised that, and a task group alone would break it.
        var staged: [PhotoCapture] = []
        var index = 0
        while index < results.count {
            let upper = min(index + Self.libraryImportConcurrency, results.count)
            let slice = Array(results[index..<upper])
            var batch = [PhotoCapture?](repeating: nil, count: slice.count)
            await withTaskGroup(of: (Int, PhotoCapture?).self) { group in
                for (offset, result) in slice.enumerated() {
                    group.addTask {
                        guard let image = await result.loadImage() else { return (offset, nil) }
                        guard let output = await PhotoCompressor.compressOffMain(image) else {
                            return (offset, nil)
                        }
                        // Read the original PHAsset capture time before
                        // compression strips EXIF (US-289); fall back to now if
                        // the library isn't readable.
                        let capturedAt = result.creationDate() ?? .now
                        return (
                            offset,
                            PhotoCapture(
                                imageData: output.imageData,
                                thumbnail: output.thumbnail,
                                capturedAt: capturedAt,
                                source: .library,
                                // US-1547: provenance filename →
                                // item_photos.original_filename.
                                sourceName: result.itemProvider.suggestedName
                            )
                        )
                    }
                }
                for await (offset, capture) in group {
                    batch[offset] = capture
                }
            }
            staged.append(contentsOf: batch.compactMap { $0 })
            index = upper
        }
        guard !staged.isEmpty else {
            captureError = "Couldn't read those photos. They may still be downloading from iCloud — try again or pick different ones."
            return
        }
        stagedPhotos = staged
        // US-1181: tell the user when some picks were dropped (e.g. still
        // downloading from iCloud) instead of silently staging fewer than picked.
        let dropped = results.count - staged.count
        if dropped > 0 {
            openTrayAfterAlert = true
            captureError = "Couldn't load \(dropped) of \(results.count) photos. They may still be downloading from iCloud. We added the \(staged.count) that loaded."
        } else {
            intakeSheet = .stagingTray
        }
    }

    private func capture() {
        guard !isCapturing else { return }
        // US-195: medium impact for an action with a tangible outcome
        // (photo captured) + the standard iOS shutter sound that's
        // mandatory in some locales.
        HapticFeedback.medium()
        HapticFeedback.playShutterSound()
        isCapturing = true
        // US-1648: pin the target slot SYNCHRONOUSLY before the async capture +
        // compress, so a slot-strip tap mid-flight can't record this photo into a
        // different (e.g. public 'front') slot — a sensitive tag photo must never
        // be redirected into the public bucket.
        let capturedSlot = store.activeSlot
        Task {
            defer { isCapturing = false }
            do {
                let image = try await camera.capturePhoto()
                // US-636: compress off the main actor.
                // US-2135: at the slot's own cap. `capturedSlot` is pinned above
                // precisely so an async hop cannot change which slot this is, and
                // the cap has to follow the same pinned value - reading the live
                // active slot here would let a strip tap mid-capture compress a
                // serial shot at the 1600px default.
                guard let output = await PhotoCompressor.compressOffMain(
                    image,
                    maxLongEdge: capturedSlot.uploadMaxLongEdge
                ) else {
                    captureError = "Couldn't process the photo. Please try again."
                    return
                }
                let photo = PhotoCapture(
                    imageData: output.imageData,
                    thumbnail: output.thumbnail,
                    source: .camera
                )
                store.recordCapture(photo, into: capturedSlot)
                // US-651: announce slot-filled progress as a live region.
                announce("Photo captured. \(store.photos.count) of \(store.visibleSlots.count) slots filled.")
            } catch {
                // US-1025: friendly copy on-screen; raw detail to Sentry.
                let detail = FriendlyErrorCopy.rawDetail(for: error)
                Telemetry.breadcrumb("Photo capture failed: \(detail)", category: "capture")
                captureError = FriendlyErrorCopy.actionMessage(
                    for: error,
                    fallback: "Couldn't capture the photo. Please try again."
                )
            }
        }
    }

    /// US-2925: the AI-extract step, lifted out of its own
    /// `.fullScreenCover` so it can share ``IntakeCover``'s single slot.
    /// `draftItemId` stays the source of truth - every existing read and
    /// write of it is unchanged - and an `onChange` mirrors it into the
    /// cover, so this is a presentation change and not a state change.
    @ViewBuilder
    private func aiExtractCover(itemId: String) -> some View {
        if let userId = currentUserId(), !userId.isEmpty {
                AIExtractView(
                    inventoryItemId: itemId,
                    userId: userId,
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
                    },
                    onBackground: {
                        // The extraction keeps running in AIExtractionManager;
                        // drop the user on the inventory list where the new item
                        // shows a "processing → review ready" pill. Opening it
                        // later pops the same review.
                        store.reset()
                        draftItemId = nil
                        dismiss()
                        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                        DeepLinkRouter.post(.inventoryTab)
                    },
                    onRetryUploads: {
                        // US-1212: re-enqueue every failed upload for this item so
                        // the captured photos aren't lost; the uploads continue in
                        // the background and land before the grade flow needs them.
                        guard let service = uploadService else { return }
                        let failed = uploadStore.tasks(inventoryItemId: itemId).filter {
                            if case .failed = $0.phase { return true }
                            return false
                        }
                        for task in failed { service.retry(task.id) }
                    }
                )
            } else {
                // US-1176: never build the AI step with an empty user id — that
                // produces malformed storage/signed-URL paths and a silent
                // failure. Surface a re-sign-in prompt instead.
                ContentUnavailableView {
                    Label("Sign in again", systemImage: "person.crop.circle.badge.exclamationmark")
                } description: {
                    Text("Your session expired. Sign in again to run AI extraction on these photos.")
                } actions: {
                    Button("OK") { draftItemId = nil }
                        .buttonStyle(.borderedProminent)
                }
            }
    }
}

#Preview {
    // The profile store is a non-optional environment value, so the preview has
    // to supply one the same way the app scene does.
    PhotoIntakeView()
        .environment(PhotoProfileStore())
}
