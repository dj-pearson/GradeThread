import SwiftUI
import UIKit

/// SwiftUI surface hosted inside the Share Extension. Lets the user
/// assign each shared image to a slot (Front / Back / Tag / Detail /
/// Defect 1-3 / Tag 2 / Detail 2-4 / Interior / Flat lay / On model /
/// measurements) before tapping 'Add to FlipDesk'. The extension's
/// principal class receives the assignments + writes them to the App
/// Group inbox.
///
/// We can't import the main app's PhotoSlotType enum directly (separate
/// target without a shared framework), so the slot constants are mirrored
/// here. Keep the raw values aligned with the main app's
/// `PhotoSlotType.rawValue` strings — the inbox manifest carries those
/// verbatim and the main app reads them back.
struct ShareIntakeView: View {
    let images: [UIImage]
    let onSubmit: ([(slot: String, image: UIImage)]) -> Void
    let onCancel: () -> Void

    @State private var assignments: [Int: String]

    init(
        images: [UIImage],
        onSubmit: @escaping ([(slot: String, image: UIImage)]) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.images = images
        self.onSubmit = onSubmit
        self.onCancel = onCancel

        // Default each image to the next required slot, then spill
        // into defects. Mirrors the drag-drop sequencing in
        // PhotosDropHandler so users get the same intuition.
        let slots = ShareIntakeView.allSlots
        var initial: [Int: String] = [:]
        for (idx, _) in images.enumerated() {
            initial[idx] = slots[min(idx, slots.count - 1)]
        }
        _assignments = State(initialValue: initial)
    }

    /// Mirror of PhotoSlotType's canonical declaration order (front → back → tag
    /// → detail → measurements → defects → extras → universal). Declaration order
    /// IS the gallery/cover order in the main app, so this mirror must match it
    /// exactly — ShareInboxTests.test_shareExtensionSlotConstants_alignWithPhotoSlotType
    /// trips if it drifts.
    static let allSlots: [String] = [
        "front", "back", "tag", "detail",
        "measurement_chest", "measurement_waist", "measurement_length",
        "measurement_sleeve", "measurement_inseam",
        "defect1", "defect2", "defect3",
        "tag_2", "detail_2", "detail_3", "detail_4",
        "interior", "flatlay", "on_model",
        // US-1571: the MeasureCard calibration-frame tag.
        "measurement",
        "angle", "sole", "marking", "serial", "accessory",
        "certificate", "corner", "surface",
    ]

    static func displayName(for slot: String) -> String {
        switch slot {
        case "front":    return "Front"
        case "back":     return "Back"
        case "tag":      return "Tag"
        case "detail":   return "Detail"
        case "defect1":  return "Defect 1"
        case "defect2":  return "Defect 2"
        case "defect3":  return "Defect 3"
        case "tag_2":    return "Tag 2"
        case "detail_2": return "Detail 2"
        case "detail_3": return "Detail 3"
        case "detail_4": return "Detail 4"
        case "interior": return "Interior"
        case "flatlay":  return "Flat lay"
        case "on_model": return "On model"
        case "measurement": return "Measurement card"
        case "angle":       return "Angle / Profile"
        case "sole":        return "Sole"
        case "marking":     return "Markings"
        case "serial":      return "Serial / Model"
        case "accessory":   return "Accessories"
        case "certificate": return "Certificate"
        case "corner":      return "Corners"
        case "surface":     return "Surface"
        case "measurement_chest":  return "Measure: Chest / Bust"
        case "measurement_waist":  return "Measure: Waist"
        case "measurement_length": return "Measure: Length"
        case "measurement_sleeve": return "Measure: Sleeve"
        case "measurement_inseam": return "Measure: Inseam"
        default:         return slot.capitalized
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if images.isEmpty {
                    emptyState
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(Array(images.enumerated()), id: \.offset) { idx, image in
                            row(index: idx, image: image)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
            }
            .navigationTitle("Add to FlipDesk")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add (\(assignedCount))") {
                        submit()
                    }
                    .disabled(assignedCount == 0)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.secondary)
            Text("No images to share")
                .font(.headline)
            Text("Choose Photos.app first and tap Share to send images here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(40)
    }

    private func row(index: Int, image: UIImage) -> some View {
        HStack(spacing: 12) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            Picker("Slot", selection: Binding(
                get: { assignments[index] ?? Self.allSlots[0] },
                set: { assignments[index] = $0 }
            )) {
                ForEach(Self.allSlots, id: \.self) { slot in
                    Text(Self.displayName(for: slot)).tag(slot)
                }
            }
            .pickerStyle(.menu)
            Spacer()
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var assignedCount: Int {
        assignments.values.count
    }

    private func submit() {
        var out: [(String, UIImage)] = []
        for (idx, image) in images.enumerated() {
            guard let slot = assignments[idx] else { continue }
            out.append((slot, image))
        }
        onSubmit(out)
    }
}
