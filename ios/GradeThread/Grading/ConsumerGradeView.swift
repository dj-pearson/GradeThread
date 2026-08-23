import Photos
import PhotosUI
import SwiftUI
import UIKit

/// US-2815 / US-2016 AC-entry-point: the screen that opens ``ConsumerGradeFlow``.
///
/// The flow itself — submit, pay, poll, result, with the credits detour and the
/// no-charge abstain — has been complete and unit-tested since US-2016 and was
/// presented by nothing. Every reference to it in the repo was in its own test
/// file. This is the missing half, not a new feature.
///
/// ONE SLOT PER REQUIRED SHOT rather than a free multi-select. The route rejects
/// duplicate image types and abstains when `front`, `back` or `label` is absent
/// — after charging, after a vision call per image, then refunding. Asking for
/// the three by name means the refusal happens here, before any of that, which
/// is the whole point of ``PhotoGradeContract/missingRequired(from:)``.
///
/// Photos go through ``PhotoCompressor``, never `jpegData` directly: it bakes
/// orientation upright before encoding, and the grading pipeline is one of the
/// consumers that ignores the EXIF flag. `ios/Scripts/no-raw-jpeg-encode.py`
/// enforces that, and it is the reason this view compresses rather than encodes.
struct ConsumerGradeView: View {

    /// A buyer's closet item, when the grade was started from one. Nil for the
    /// plain "grade a garment" entry, where there is nothing to attach to yet.
    var closetItemId: String?
    var onGraded: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var flow = ConsumerGradeFlow()
    @State private var shots: [String: Data] = [:]
    /// US-2802: slot -> where that shot came from. Absent means library,
    /// which is the fail-closed default.
    @State private var sources: [String: String] = [:]
    @State private var pending: PendingShot?
    @State private var title = ""
    @State private var garmentType = GarmentVocabulary.types.first ?? "tops"
    @State private var garmentCategory = GarmentVocabulary.categories.first ?? "other"

    @State private var loadFailed = false

    /// Which slot the picker is open for, and which way it was opened.
    ///
    /// ONE sheet slot rather than two modifiers. Two `.sheet`s on the same
    /// view compete and the loser opens and closes in the same frame;
    /// `ios/Scripts/check-chained-sheets.py` exists because twelve views in
    /// this app were doing exactly that.
    private struct PendingShot: Identifiable {
        let slot: String
        let fromCamera: Bool
        var id: String { "\(slot)-\(fromCamera)" }
    }

    /// Whether the device has a camera at all. Simulators do not, and neither
    /// do a few iPads, so the in-app option is offered rather than assumed -
    /// `CameraPicker` says to guard this at the call site and this is it.
    private var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    /// Every required shot taken in the app. Shown, never chosen.
    private var isLiveCapture: Bool {
        missing.isEmpty
            && PhotoGradeContract.qualifiesForLiveCapture(
                requiredSlots.map { sources[$0] ?? PhotoGradeContract.captureSourceLibrary }
            )
    }

    /// The three the route blocks on, in the order the message names them.
    private var requiredSlots: [String] { PhotoGradeContract.requiredGradingTypes }

    private var missing: [String] {
        PhotoGradeContract.missingRequired(from: Array(shots.keys))
    }

    private var canSubmit: Bool {
        // A blank title is the one field the route will not fill in for us.
        missing.isEmpty && !title.trimmingCharacters(in: .whitespaces).isEmpty
            && flow.step == .ready
    }

    /// Built here rather than taken as a parameter: the plain entry point has
    /// no item to inherit from, and the route validates every field of this
    /// against its own vocabulary AFTER the photos have uploaded.
    private var request: PhotoGradeRequest {
        PhotoGradeRequest(
            garmentType: garmentType,
            garmentCategory: garmentCategory,
            title: title.trimmingCharacters(in: .whitespaces),
            tier: "standard",
            brand: nil,
            description: nil,
            inventoryItemId: nil,
            closetItemId: closetItemId
        )
    }

    var body: some View {
        content
            .navigationTitle("Grade a garment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isWorking)
                }
            }
            .sheet(item: $pending) { shot in
                if shot.fromCamera {
                    // The ONLY path that may claim in-app capture. Everything
                    // else defaults to library, including a retake through the
                    // picker below, which overwrites the source for that slot.
                    CameraPicker { image in
                        pending = nil
                        Task { await loadCamera(image, into: shot.slot) }
                    }
                    .ignoresSafeArea()
                } else {
                    // selectionLimit 1: one shot per named slot, because the
                    // route rejects duplicate image types. A multi-select would
                    // hand back photos with no way to say which is the front.
                    PhotoLibraryPicker(selectionLimit: 1) { results in
                        pending = nil
                        guard let first = results.first else { return }
                        Task { await load(first, into: shot.slot) }
                    }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch flow.step {
        case .ready:
            pickStep
        default:
            ConsumerGradeProgressView(step: flow.step, onDone: finish)
        }
    }

    private var pickStep: some View {
        List {
            Section {
                TextField("What is it?", text: $title)
                Picker("Kind", selection: $garmentType) {
                    ForEach(GarmentVocabulary.types, id: \.self) { value in
                        Text(GarmentVocabulary.label(value)).tag(value)
                    }
                }
                Picker("Garment", selection: $garmentCategory) {
                    ForEach(GarmentVocabulary.categories, id: \.self) { value in
                        Text(GarmentVocabulary.label(value)).tag(value)
                    }
                }
            } header: {
                Text("Details")
            }

            Section {
                ForEach(requiredSlots, id: \.self) { slot in
                    slotRow(slot)
                }
            } header: {
                Text("Photos")
            } footer: {
                // Named before paying, not after. The route's abstain refunds the
                // money and not the vision spend, and the seller has already
                // waited for it by then.
                VStack(alignment: .leading, spacing: 4) {
                    Text(
                        missing.isEmpty
                            ? "Ready to grade."
                            : "Still needed: \(missing.map(Self.friendly).joined(separator: ", "))."
                    )
                    // A STATUS, not an advert. Live Capture is earned by how the
                    // photos were taken, so the honest thing to show is which
                    // side of that line this submission is on. The second
                    // sentence matters: nobody is penalised for adding a photo,
                    // and a line that only named the reward would read as one.
                    Text(
                        isLiveCapture
                            ? "Every photo was taken here, so this qualifies for the stronger Live-Verified check."
                            : "Take the photos here instead of adding them and this qualifies for the stronger Live-Verified check. Your grade is never lowered for adding them."
                    )
                }
            }

            if loadFailed {
                Section {
                    Text("That photo could not be read. Try another.")
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Button("Grade this garment") {
                    Task { await submit() }
                }
                .disabled(!canSubmit)
            }
        }
    }

    private func slotRow(_ slot: String) -> some View {
        HStack {
            Text(Self.friendly(slot))
            if shots[slot] != nil {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .accessibilityLabel("Added")
            }
            Spacer()
            if cameraAvailable {
                Button("Take") {
                    loadFailed = false
                    pending = PendingShot(slot: slot, fromCamera: true)
                }
                // .borderless on BOTH, because a List row treats a plain
                // Button as the row's own tap target: without it the first
                // button swallows taps meant for the second.
                .buttonStyle(.borderless)
            }
            Button(shots[slot] == nil ? "Library" : "Replace") {
                loadFailed = false
                pending = PendingShot(slot: slot, fromCamera: false)
            }
            .buttonStyle(.borderless)
        }
    }

    private var isWorking: Bool {
        switch flow.step {
        case .ready, .graded, .failed, .needsPhotos: return false
        default: return true
        }
    }

    /// GRADING vocabulary is the wire format; these are the words on the strip.
    /// `label` is the tag shot — the exact pair US-2304 found two requirement
    /// lists disagreeing over, so the mapping is spelled out rather than
    /// prettified from the raw value.
    private static func friendly(_ gradingType: String) -> String {
        switch gradingType {
        case "front": return "Front"
        case "back": return "Back"
        case "label": return "Tag"
        default: return gradingType.capitalized
        }
    }

    /// Mirrors ``DisputeEvidence/photos(from:room:)``: load, then compress.
    /// Never `jpegData` — PhotoCompressor bakes the orientation upright first,
    /// and the grading pipeline is one of the consumers that ignores the EXIF
    /// flag (`ios/Scripts/no-raw-jpeg-encode.py` is the gate).
    private func load(_ result: PHPickerResult, into slot: String) async {
        guard
            let image = await result.loadImage(),
            let output = await PhotoCompressor.compressOffMain(image)
        else {
            // Surfaced, not swallowed: an iCloud asset still downloading
            // returns nil here and the row would otherwise just stay empty
            // with no explanation.
            loadFailed = true
            return
        }
        shots[slot] = output.imageData
        // A library pick REPLACES any in-app source for this slot. Retaking
        // from the library after a camera shot must not keep the live claim,
        // and leaving the old entry in place is exactly how it would.
        sources[slot] = PhotoGradeContract.captureSourceLibrary
    }

    /// US-2802: a shot taken IN THE APP.
    ///
    /// Same compression as the library path, deliberately. US-2658 is the one
    /// where the two paths differed: the camera path skipped the compressor, so
    /// the same garment went up at full sensor resolution with EXIF intact if
    /// shot in-app and downsized with none if picked - and the grading pipeline
    /// ignores the EXIF rotation tag, so a photo kept upright only by that tag
    /// arrives sideways.
    private func loadCamera(_ image: UIImage, into slot: String) async {
        guard let output = await PhotoCompressor.compressOffMain(image) else {
            loadFailed = true
            return
        }
        shots[slot] = output.imageData
        sources[slot] = PhotoGradeContract.captureSourceInAppCamera
    }

    private func submit() async {
        // Ordered by the contract, not by dictionary order, so the parts arrive
        // in the same sequence the strip showed them.
        let images = requiredSlots.compactMap { slot -> PhotoGradeImage? in
            guard let jpeg = shots[slot] else { return nil }
            return PhotoGradeImage(
                gradingType: slot,
                jpeg: jpeg,
                captureSource: sources[slot] ?? PhotoGradeContract.captureSourceLibrary
            )
        }
        await flow.start(images: images, request: request)
    }

    private func finish(_ submissionId: String) {
        onGraded(submissionId)
        dismiss()
    }
}
