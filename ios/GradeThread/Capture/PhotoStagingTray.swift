import SwiftUI

/// Sheet shown after PHPicker dismisses. Each picked image is compressed
/// on import (same pipeline as the camera flow) and parked in the tray
/// until it lands in a slot. Discard removes the photo entirely. When the
/// tray empties the sheet dismisses automatically and the user returns to
/// the camera with whatever they added now in the slot strip.
///
/// US-2818: tagging every photo BEFORE the item exists was the slowest step in
/// listing one item, and the web stopped asking for it long ago — its bulk add
/// auto-assigns a provisional tag and lets the seller correct it afterwards
/// (photo-uploader.tsx `bulkUpload`). "Add all" is now the primary action here
/// and per-photo assignment is the option, not the toll gate.
struct PhotoStagingTray: View {
    @Environment(\.dismiss) private var dismiss
    let staged: [PhotoCapture]
    /// Slots the user can pick from for each photo. Filtered by the caller
    /// to "still empty" plus the next revealable defect slot when relevant.
    let availableSlots: (PhotoCapture) -> [CaptureSlot]

    /// How many of the staged photos "Add all" can actually place. Fewer than
    /// `staged.count` when the profile runs out of slots — said out loud rather
    /// than silently dropping the tail.
    let autoAssignCapacity: Int

    let onAssignAll: () -> Void
    let onAssign: (PhotoCapture, CaptureSlot) -> Void
    let onDiscard: (PhotoCapture) -> Void

    var body: some View {
        NavigationStack {
            Group {
                if staged.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("Add photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onChange(of: staged.isEmpty) { _, isEmpty in
            // Auto-dismiss the moment the last photo lands in a slot — the
            // user is done here and should be back at the camera.
            if isEmpty { dismiss() }
        }
    }

    private var placeableCount: Int { min(autoAssignCapacity, staged.count) }

    private var list: some View {
        List {
            Section {
                Button {
                    AppRouter.haptic()
                    onAssignAll()
                } label: {
                    HStack {
                        Image(systemName: "square.stack.3d.down.forward")
                        Text(placeableCount == 1
                             ? "Add 1 photo"
                             : "Add all \(placeableCount) photos")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                    }
                }
                .disabled(placeableCount == 0)
            } footer: {
                if placeableCount == 0 {
                    Text("Every slot is full. Assign a photo over an existing one below, or discard some.")
                        .font(.footnote)
                } else if placeableCount < staged.count {
                    Text("Front and back go first, then the rest become listing photos. There's room for \(placeableCount) of your \(staged.count) — assign or discard the others below. You can change any tag later under Manage.")
                        .font(.footnote)
                } else {
                    Text("Front and back go first, then the rest become listing photos. You can change any tag later under Manage.")
                        .font(.footnote)
                }
            }

            Section {
                ForEach(staged) { photo in
                    HStack(spacing: 12) {
                        Image(uiImage: photo.thumbnail)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous))

                        Text("Picked from library")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        Spacer()

                        Menu {
                            let slots = availableSlots(photo)
                            if slots.isEmpty {
                                Text("All slots are full — discard or retake a slot first.")
                            } else {
                                ForEach(slots) { slot in
                                    Button {
                                        AppRouter.haptic()
                                        onAssign(photo, slot)
                                    } label: {
                                        Label(slot.label, systemImage: slot.systemImage)
                                    }
                                }
                            }
                            Divider()
                            Button(role: .destructive) {
                                onDiscard(photo)
                            } label: {
                                Label("Discard", systemImage: "trash")
                            }
                        } label: {
                            Text("Tag")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.brandNavy)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(Color.brandNavy.opacity(0.1))
                                .clipShape(Capsule())
                        }
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("Or tag them one at a time")
            } footer: {
                Text("\(staged.count) photo\(staged.count == 1 ? "" : "s") waiting.")
                    .font(.footnote)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(Color.brandNavy)
            Text("All set")
                .font(.brandHeadline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
