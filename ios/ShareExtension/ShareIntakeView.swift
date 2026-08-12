import SwiftUI
import UIKit

/// SwiftUI surface hosted inside the Share Extension. Lets the user assign each
/// shared image to a slot before tapping 'Add to FlipDesk'. The extension's
/// principal class receives the assignments + writes them to the App Group
/// inbox.
///
/// We can't import the main app's types directly (separate target without a
/// shared framework), so the slot constants are mirrored here.
///
/// TWO LISTS, ON PURPOSE (US-2461):
///
///   - ``allSlots`` mirrors `PhotoSlotType.allCases` and is the WIRE contract.
///     A batch written by an older build names `detail_2`, and the main app
///     still decodes it, so this list may never shrink.
///   - ``offeredSlots`` is what the picker SHOWS. It drops the retired numbered
///     slots and offers the (type, role) pairs they stood in for, written as
///     `CaptureSlot.storageKey` values ("tag|brand"), which the inbox consumer
///     already decodes.
///
/// Keep both aligned with the main app's raw values — the inbox manifest
/// carries them verbatim and `ShareInboxTests` trips if either drifts.
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
        // PhotosDropHandler so users get the same intuition. US-1647: use the
        // default-assignment order (which SKIPS the measurement_* calibration
        // slots), not allSlots — after the US-1571 mirror reorder put
        // measurement_* before defects, the raw allSlots order spilled the 5th+
        // shared photo into measurement slots (and pushed a calibration frame
        // to the public bucket). Users can still pick a measurement slot manually.
        let slots = ShareIntakeView.defaultAssignmentSlots
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
        // US-2470: the two profile roles that gained a capture case.
        "on_hanger", "set_pair",
    ]

    /// US-2461: what the per-photo picker actually OFFERS.
    ///
    /// ``allSlots`` above stays the wire mirror of `PhotoSlotType` — an inbox
    /// batch written by an older build still names `detail_2`, and the main app
    /// still has to decode it. But those numbered slots are the RETIRED
    /// vocabulary, and this picker was the last surface still handing them to a
    /// seller as a new choice, five months after `PhotoRole.captureSlot` started
    /// refusing them. A photo tagged "Detail 3" here landed as `detail_3` and
    /// told the grader nothing about what it showed.
    ///
    /// So the numbered slots are replaced one-for-one by the (type, role) pairs
    /// they used to stand in for. These are ``CaptureSlot/storageKey`` values —
    /// `"type|role"` — which `ShareInboxConsumer` already decodes, so nothing
    /// about the inbox contract changes.
    ///
    /// No profile is loaded at share time (no item, no garment word, no
    /// network guarantee inside an extension), so this is the generic role set
    /// rather than a category-specific one. The seller can still retag in the
    /// app, where the profile IS resolved.
    static let offeredSlots: [String] = [
        "front", "back",
        "tag|brand", "tag|size", "tag|care", "tag|made_in",
        "detail|fabric", "detail|hem", "detail|hardware",
        "detail|pocket", "detail|print", "detail|collar",
        "measurement|chest", "measurement|waist", "measurement|length",
        "measurement|sleeve", "measurement|inseam",
        "defect1", "defect2", "defect3",
        "interior", "flatlay", "on_model", "on_hanger", "set_pair",
        // US-1571: the MeasureCard calibration frame. A bare `measurement`,
        // deliberately — it is a different photo from a tape close-up.
        "measurement",
        "angle", "sole", "marking", "serial", "accessory",
        "certificate", "corner", "surface",
    ]

    /// US-1647: the order used to DEFAULT-assign shared photos to slots — the
    /// offered order minus the measurement_* / calibration slots, so a
    /// batch of shared photos spills into defects/details (never into
    /// measurement slots, which are for the MeasureCard flow, not share import).
    /// The full ``offeredSlots`` set is still available in the per-photo picker.
    static let defaultAssignmentSlots: [String] = offeredSlots.filter {
        !$0.hasPrefix("measurement")
    }

    static func displayName(for slot: String) -> String {
        // US-2461: a slot key may be a (type, role) pair. Name the ROLE, which
        // is what the photo shows — "Fabric close-up", not "Detail".
        if let sep = slot.firstIndex(of: "|") {
            let type = String(slot[slot.startIndex..<sep])
            let role = String(slot[slot.index(after: sep)...])
            return roleName(type: type, role: role) ?? "\(displayName(for: type)): \(role)"
        }
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
        case "on_hanger": return "On hanger"
        case "set_pair":  return "Set / pair"
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

    /// US-2461: the label for a (type, role) pair. Mirrors
    /// `PhotoRoleVocabulary` in the main app — the extension is a separate
    /// target with no shared framework, which is why every constant in this file
    /// is a hand mirror. `ShareInboxTests` pins the pairs against the offered
    /// list so a role can never be offered without a name.
    static func roleName(type: String, role: String) -> String? {
        switch (type, role) {
        case ("tag", "brand"):    return "Tag: Brand label"
        case ("tag", "size"):     return "Tag: Size"
        case ("tag", "care"):     return "Tag: Care & fabric"
        case ("tag", "made_in"):  return "Tag: Made in / union label"
        case ("detail", "fabric"):   return "Detail: Fabric close-up"
        case ("detail", "hem"):      return "Detail: Hem & stitching"
        case ("detail", "hardware"): return "Detail: Hardware"
        case ("detail", "pocket"):   return "Detail: Pocket"
        case ("detail", "print"):    return "Detail: Print or graphic"
        case ("detail", "collar"):   return "Detail: Collar or cuff"
        case ("measurement", "chest"):  return "Measure: Chest / Bust"
        case ("measurement", "waist"):  return "Measure: Waist"
        case ("measurement", "length"): return "Measure: Length"
        case ("measurement", "sleeve"): return "Measure: Sleeve"
        case ("measurement", "inseam"): return "Measure: Inseam"
        default: return nil
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
                get: { assignments[index] ?? Self.offeredSlots[0] },
                set: { assignments[index] = $0 }
            )) {
                ForEach(Self.offeredSlots, id: \.self) { slot in
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
