import SwiftUI

/// Sheet shown after PHPicker dismisses. Each picked image is compressed
/// on import (same pipeline as the camera flow) and parked in the tray
/// until the user assigns it to a slot. Discard removes the photo
/// entirely. When the tray empties the sheet dismisses automatically and
/// the user returns to the camera with whatever they assigned now in the
/// slot strip.
struct PhotoStagingTray: View {
    @Environment(\.dismiss) private var dismiss
    let staged: [PhotoCapture]
    /// Slots the user can pick from for each photo. Filtered by the caller
    /// to "still empty" plus the next revealable defect slot when relevant.
    let availableSlots: (PhotoCapture) -> [PhotoSlotType]

    let onAssign: (PhotoCapture, PhotoSlotType) -> Void
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
            .navigationTitle("Assign photos")
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

    private var list: some View {
        List {
            Section {
                ForEach(staged) { photo in
                    HStack(spacing: 12) {
                        Image(uiImage: photo.thumbnail)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

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
                            Text("Assign")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(Color.brandNavy)
                                .clipShape(Capsule())
                        }
                    }
                    .padding(.vertical, 4)
                }
            } footer: {
                Text("\(staged.count) photo\(staged.count == 1 ? "" : "s") waiting. Pick a slot for each.")
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
                .font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
