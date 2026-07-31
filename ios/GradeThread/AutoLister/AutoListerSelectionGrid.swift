import SwiftUI

/// US-2373: the ungrouped photo grid — the heart of AutoLister's manual
/// grouping. Photos land here on import, listed in the order the seller
/// chooses (file name, date taken, shooting order, import order). They tap the
/// photos of one item, tap "Group", and those photos leave the grid: the next
/// item's photos are then the first thing in front of them.
///
/// This replaces the old horizontal "Ungrouped" strip, which only appeared
/// after the app had already auto-grouped everything and could only be worked
/// one photo at a time through a context menu.
struct AutoListerSelectionGrid: View {
    @ObservedObject var model: AutoListerReviewModel
    /// Photos-per-item options for the "Group every" shortcut.
    private let everyOptions = [2, 3, 4, 5, 6, 8]

    /// Tile edge, matching the thumbnails on the item cards. Fixed rather than
    /// proportional so the grid packs as many columns as the device fits — 3 on
    /// a phone, 8+ on an iPad — with no aspect-ratio guesswork per cell.
    private static let tileSize: CGFloat = 96

    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: Self.tileSize, maximum: Self.tileSize), spacing: 8)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            toolRow
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(model.ungroupedSorted) { photo in
                    tile(photo)
                }
            }
        }
        .padding()
        .cardStyle(.flush)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Photos to group")
                .font(.brandHeadline)
            Spacer(minLength: 8)
            Text("\(model.ungroupedCount) left")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var toolRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                sortMenu
                Button(model.hasSelection ? "Clear" : "Select all") {
                    if model.hasSelection {
                        model.clearSelection()
                    } else {
                        model.selectAllUngrouped()
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.ungroupedCount == 0)
                Button {
                    HapticFeedback.light()
                    let photos = model.ungroupedCount
                    let created = withAnimation { model.autoGroupUngrouped() }
                    Telemetry.event(
                        "autolister_group_created",
                        props: ["photos": photos, "items": created, "method": "auto"]
                    )
                } label: {
                    Label("Auto-group", systemImage: "wand.and.stars")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.ungroupedCount == 0)
                .accessibilityHint("Sorts the remaining photos into items by capture time and file name. You can ungroup any item afterwards.")
                everyMenu
                // US-1909: a vision pass over the remaining photos, proposing
                // where each item begins. Metered — the AI-action count is
                // confirmed before any of it is spent.
                Button {
                    Task { await model.proposeGroupsNow() }
                } label: {
                    Label("AI group", systemImage: "sparkles")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.ungroupedCount < 2 || model.proposing)
                .accessibilityHint(
                    "The AI looks at the remaining photos in order and proposes where each item begins. Uses AI actions — you'll see the count first."
                )
            }
        }
    }

    private var sortMenu: some View {
        Menu {
            ForEach(UngroupedSortMode.allCases) { mode in
                Button {
                    model.ungroupedSort = mode
                } label: {
                    if model.ungroupedSort == mode {
                        Label(mode.label, systemImage: "checkmark")
                    } else {
                        Text(mode.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.arrow.down")
                Text(model.ungroupedSort.label)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
            }
        }
        .accessibilityLabel("Sort photos, currently \(model.ungroupedSort.label)")
    }

    private var everyMenu: some View {
        Menu {
            ForEach(everyOptions, id: \.self) { size in
                Button("Every \(size) photos") {
                    HapticFeedback.light()
                    withAnimation { _ = model.groupEveryN(size) }
                }
            }
        } label: {
            Label("Group every…", systemImage: "square.grid.2x2")
                .font(.caption.weight(.medium))
        }
        .disabled(model.ungroupedCount == 0)
        .accessibilityHint("Cuts the photos into items of a fixed size, in the order shown.")
    }

    // MARK: - Tile

    private func tile(_ photo: PhotoCapture) -> some View {
        let selected = model.isSelected(photo.id)
        let caption = model.gridCaption(for: photo)
        return Button {
            HapticFeedback.light()
            model.toggleSelection(photo.id)
        } label: {
            VStack(spacing: 4) {
                Image(uiImage: photo.thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: Self.tileSize, height: Self.tileSize)
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control))
                    .overlay(
                        RoundedRectangle(cornerRadius: CornerRadius.control)
                            .strokeBorder(
                                selected ? Color.brandNavy : Color.secondary.opacity(0.25),
                                lineWidth: selected ? 3 : 1
                            )
                    )
                    .overlay(alignment: .topTrailing) {
                        if selected {
                            Image(systemName: "checkmark.circle.fill")
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, Color.brandNavy)
                                .font(.title3)
                                .padding(4)
                        }
                    }
                // US-2373: show whatever the grid is sorted BY, so the seller
                // can see the run of shots that belong together instead of
                // trusting the order blindly.
                if let caption {
                    Text(caption)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(width: Self.tileSize)
                }
            }
        }
        .buttonStyle(.plain)
        .contextMenu { tileMenu(photo) }
        .accessibilityLabel(photoLabel(photo))
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityHint("Double-tap to select. Use Actions to select a range or make this photo its own item.")
        // US-1411: VoiceOver and Switch Control can't open a `.contextMenu`, so
        // every tile action is mirrored as a flat list of accessibility actions.
        .accessibilityActions {
            Button("Select through here") { model.selectRange(through: photo.id) }
            Button("Make this photo its own item") {
                model.groupUngroupedPhoto(photo.id, into: nil)
            }
            ForEach(model.groups) { group in
                Button("Add to item \(model.displayIndex(of: group))") {
                    model.groupUngroupedPhoto(photo.id, into: group.id)
                }
            }
            Button("Rotate right") { Task { await model.rotate(photo.id, clockwise: true) } }
            Button("Rotate left") { Task { await model.rotate(photo.id, clockwise: false) } }
            Button("Remove photo") { model.removePhoto(photo.id) }
        }
    }

    /// Name the photo by whatever provenance it actually has, so a grid sorted
    /// by file name or date reads the same to VoiceOver as it looks on screen.
    private func photoLabel(_ photo: PhotoCapture) -> String {
        if let caption = model.gridCaption(for: photo), !caption.isEmpty {
            return "Photo \(caption)"
        }
        return "Photo"
    }

    @ViewBuilder
    private func tileMenu(_ photo: PhotoCapture) -> some View {
        Button {
            withAnimation { model.selectRange(through: photo.id) }
        } label: {
            Label("Select through here", systemImage: "checklist")
        }
        Button {
            withAnimation { model.groupUngroupedPhoto(photo.id, into: nil) }
        } label: {
            Label("Make its own item", systemImage: "plus.rectangle")
        }
        if !model.groups.isEmpty {
            Menu("Add to…") {
                ForEach(model.groups) { group in
                    Button("Item \(model.displayIndex(of: group))") {
                        model.groupUngroupedPhoto(photo.id, into: group.id)
                    }
                }
            }
        }
        Button {
            Task { await model.rotate(photo.id, clockwise: true) }
        } label: {
            Label("Rotate right", systemImage: "rotate.right")
        }
        Button {
            Task { await model.rotate(photo.id, clockwise: false) }
        } label: {
            Label("Rotate left", systemImage: "rotate.left")
        }
        Divider()
        Button(role: .destructive) {
            model.removePhoto(photo.id)
        } label: {
            Label("Remove photo", systemImage: "trash")
        }
    }
}
