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
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var store = PhotoIntakeStore()
    @State private var camera = CameraSession()
    @State private var permissionState: PermissionState = .unknown
    @State private var isCapturing = false
    @State private var startupError: String?
    @State private var slotForPreview: PhotoSlotType?
    @State private var showingExitConfirmation = false

    // Library-import flow (US-174)
    @State private var showingLibraryPicker = false
    @State private var isLoadingLibraryPicks = false
    @State private var stagedPhotos: [PhotoCapture] = []
    @State private var showingStagingTray = false
    private static let libraryPickLimit = 8

    private enum PermissionState: Equatable {
        case unknown
        case granted
        case denied
    }

    var body: some View {
        ZStack {
            cameraLayer
            overlay
        }
        .ignoresSafeArea()
        .navigationBarBackButtonHidden(true)
        .task { await bootstrap() }
        .onDisappear { camera.stop() }
        .confirmationDialog(
            "Discard captured photos?",
            isPresented: $showingExitConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
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
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(12)
                    .background(.black.opacity(0.45))
                    .clipShape(Circle())
            }
            .accessibilityLabel("Close")

            Spacer()

            if store.allRequiredFilled {
                Button {
                    // TODO(US-175): hand the captures off to the upload
                    // service. For now we just pop back to the previous
                    // screen so the placeholder route flow stays clean.
                    dismiss()
                } label: {
                    Text("Done")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Color.brandNavy)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 24)
    }

    private var bottomStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(store.visibleSlots) { slot in
                    Button {
                        AppRouter.haptic()
                        if store.photos[slot] != nil {
                            slotForPreview = slot
                        } else {
                            store.setActiveSlot(slot)
                        }
                    } label: {
                        SlotThumbnail(
                            slot: slot,
                            capture: store.photos[slot],
                            isActive: store.activeSlot == slot
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
                }

                if store.canAddDefectSlot {
                    Button {
                        AppRouter.haptic()
                        store.revealNextDefectSlot()
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "plus")
                                .font(.system(size: 20, weight: .medium))
                                .foregroundStyle(.white)
                                .frame(width: 64, height: 64)
                                .background(.white.opacity(0.08))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(.white.opacity(0.4), style: .init(lineWidth: 1, dash: [4, 3]))
                                )
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            Text("Defect")
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.7))
                        }
                    }
                    .accessibilityLabel("Add a defect slot")
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
                            .font(.system(size: 22, weight: .medium))
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
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
            Text("Turn it on in Settings to capture photos. Or use the Library button (coming soon) to pick from your Photos.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white.opacity(0.8))
                .padding(.horizontal, 32)
            if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: settingsURL) {
                    Text("Open Settings")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(Color.brandNavy)
                        .clipShape(Capsule())
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }

    // MARK: - Actions

    private func bootstrap() async {
        do {
            try await camera.start()
            permissionState = .granted
        } catch CameraSession.CameraError.permissionDenied {
            permissionState = .denied
        } catch {
            startupError = error.localizedDescription
        }
    }

    // MARK: - Library import (US-174)

    /// Slots eligible for the given staged photo — empty slots in the
    /// currently-visible strip, plus the next defect slot if any remain
    /// hidden. Re-evaluated per-photo so two staged photos can both pick
    /// "Defect 1" or both target newly-revealed slots without confusing
    /// the menu.
    private func availableSlots(for _: PhotoCapture) -> [PhotoSlotType] {
        var slots = store.visibleSlots.filter { store.photos[$0] == nil }
        if store.canAddDefectSlot {
            // The "next" hidden defect slot, surfaced so the user can park
            // a defect-only library import without leaving the tray to
            // hit the "+ Defect" tile.
            let nextHidden = PhotoSlotType.defects[store.defectSlotsVisible]
            slots.append(nextHidden)
        }
        return slots
    }

    private func assign(stagedPhoto: PhotoCapture, to slot: PhotoSlotType) {
        // Reveal the defect slot if the user picked one beyond the
        // currently-visible set, so the strip shows the assigned photo.
        if slot.isRequired == false {
            while !store.visibleSlots.contains(slot) && store.canAddDefectSlot {
                store.revealNextDefectSlot()
            }
        }
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
            guard let output = PhotoCompressor.compress(image) else { continue }
            staged.append(
                PhotoCapture(
                    imageData: output.imageData,
                    thumbnail: output.thumbnail,
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
        AppRouter.haptic()
        isCapturing = true
        Task {
            defer { isCapturing = false }
            do {
                let image = try await camera.capturePhoto()
                guard let output = PhotoCompressor.compress(image) else {
                    startupError = "Couldn't compress the photo."
                    return
                }
                let photo = PhotoCapture(
                    imageData: output.imageData,
                    thumbnail: output.thumbnail,
                    source: .camera
                )
                store.recordCapture(photo)
            } catch {
                startupError = error.localizedDescription
            }
        }
    }
}

#Preview {
    PhotoIntakeView()
}
