import GradeThreadCore
import SwiftUI

/// US-2964 - the description, as the ordered list of blocks it actually is.
///
/// The iOS port of the web composer's description card. The box used to be one
/// long text field, and that is what made the same fact appear in three places
/// with only two of them updatable - a seller who fixed a measurement was left
/// with prose advertising the old number and no way to clear it short of a full
/// AI rewrite that threw away every other edit.
///
/// So the description is rows now. Each row is one block: a switch, a tag saying
/// who owns its content, and either an in-place field (the seller's own prose)
/// or a control that jumps to the field it reads (everything derived). NOTHING
/// here renders the description - the edge service does, and the preview at the
/// bottom shows exactly what it returned, which is exactly what eBay receives.
struct DescriptionBlocksSection: View {

    @Bindable var store: DescriptionBlocksStore
    /// The one-line summaries read these off the live draft.
    let rowContext: DescriptionBlocks.RowContext
    /// Scroll the canvas to the card a derived row reads from.
    let onGoToField: (DescriptionBlocks.FieldAnchor) -> Void
    /// True for an eBay-originated listing, whose copy eBay owns.
    let locked: Bool

    @State private var reordering = false
    @State private var editing: Int?
    @State private var previewOpen = false

    /// Blocks live on a listing row. With none, the rows would be a local
    /// decoration with nowhere to save to.
    private var hasListing: Bool { store.listingId != nil }

    var body: some View {
        Section {
            if !hasListing {
                Text(
                    "Draft or publish a listing for this item and its "
                    + "description sections show up here."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            } else {
                if store.unavailable {
                    Text(
                        "Sections could not be loaded for this listing, so "
                        + "nothing here will save. Reopen the item; if it keeps "
                        + "happening the description is unchanged and safe."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                if store.converted {
                    Text(
                        "This listing was written before sections existed. What "
                        + "you see is your current description split up, and "
                        + "nothing changes until you save."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                if store.loading && store.blocks.isEmpty {
                    Text("Loading sections")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.blocks.indices, id: \.self) { index in
                        row(at: index)
                            .moveDisabled(
                                locked || DescriptionBlocks.isPinned(store.blocks[index].key)
                            )
                    }
                    .onMove { source, destination in
                        editing = nil
                        store.move(fromOffsets: source, toOffset: destination)
                    }
                    .environment(\.editMode, .constant(reordering ? .active : .inactive))
                }

                snippetMenu
                previewRow

                if let message = store.message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        } header: {
            HStack {
                Text("Description sections")
                Spacer()
                if hasListing && store.blocks.count > 1 && !locked {
                    Button(reordering ? "Done" : "Reorder") {
                        AppRouter.haptic()
                        editing = nil
                        reordering.toggle()
                    }
                    .font(.caption)
                    .textCase(nil)
                }
            }
        } footer: {
            Text(
                "Switch a section off, drag to reorder, edit one at a time. The "
                + "preview is the exact text the marketplace receives."
            )
            .font(.caption)
        }
    }

    // MARK: - One row

    @ViewBuilder
    private func row(at index: Int) -> some View {
        let block = store.blocks[index]
        let label = DescriptionBlocks.label(for: block.key)

        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Toggle(isOn: onBinding(index)) {
                    Text(label)
                }
                .toggleStyle(.switch)
                .labelsHidden()
                .disabled(locked)
                .accessibilityLabel("Include \(label)")

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(label).font(.subheadline.weight(.medium))
                        Text(DescriptionBlocks.label(for: block.src))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if editing != index {
                        Text(DescriptionBlocks.describe(block, context: rowContext))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 0)
                rowActions(index: index, block: block, label: label)
            }

            if editing == index {
                TextField(
                    "Write the \(label.lowercased()) section.",
                    text: textBinding(index),
                    axis: .vertical
                )
                .lineLimit(3...10)
                .font(.callout)
                .disabled(locked)
            }
        }
        .opacity(block.on ? 1 : 0.5)
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func rowActions(
        index: Int,
        block: DescriptionBlock,
        label: String
    ) -> some View {
        HStack(spacing: 12) {
            if DescriptionBlocks.isEditable(block.key) {
                Button {
                    AppRouter.haptic()
                    editing = editing == index ? nil : index
                } label: {
                    Image(systemName: editing == index ? "checkmark" : "pencil")
                }
                .buttonStyle(.borderless)
                .disabled(locked)
                .accessibilityLabel(
                    editing == index ? "Done editing \(label)" : "Edit \(label)"
                )
            }
            if DescriptionBlocks.isRegenerable(block.key) {
                Button {
                    AppRouter.haptic()
                    Task { await store.regenerate(block.key) }
                } label: {
                    if store.regenerating == block.key {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .buttonStyle(.borderless)
                .disabled(locked || store.regenerating != nil)
                .accessibilityLabel("Rewrite \(label) with AI")
            }
            if let anchor = DescriptionBlocks.anchor(for: block.key) {
                Button {
                    AppRouter.haptic()
                    onGoToField(anchor)
                } label: {
                    Image(systemName: "arrow.right")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Go to the \(label) fields")
            }
            if DescriptionBlocks.isRemovable(block.key) {
                Button(role: .destructive) {
                    AppRouter.haptic()
                    editing = nil
                    store.remove(at: index)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .disabled(locked)
                .accessibilityLabel("Remove \(label)")
            }
        }
        .font(.footnote)
    }

    // MARK: - Snippets and preview

    @ViewBuilder
    private var snippetMenu: some View {
        if !store.snippets.isEmpty {
            Menu {
                ForEach(store.snippets) { snippet in
                    Button(snippet.name) {
                        AppRouter.haptic()
                        store.addSnippet(ref: snippet.id)
                    }
                }
            } label: {
                Label("Add a saved snippet", systemImage: "plus")
            }
            .disabled(locked)
        }
    }

    private var previewRow: some View {
        DisclosureGroup(isExpanded: $previewOpen) {
            if store.preview.isEmpty {
                Text("Save the item once and the rendered description shows up here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text(store.preview)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } label: {
            HStack(spacing: 6) {
                Text("Preview what the marketplace receives")
                    .font(.subheadline)
                Spacer(minLength: 0)
                if store.previewPending {
                    ProgressView().controlSize(.mini)
                }
                Text("\(store.preview.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }

    // MARK: - Bindings
    //
    // The store owns the array, so the row controls write through it rather than
    // mutating a copy - every edit has to go through `setBlocks` for the preview
    // to be re-requested.

    private func onBinding(_ index: Int) -> Binding<Bool> {
        Binding(
            get: { store.blocks.indices.contains(index) ? store.blocks[index].on : false },
            set: { _ in store.toggle(at: index) }
        )
    }

    private func textBinding(_ index: Int) -> Binding<String> {
        Binding(
            get: {
                guard store.blocks.indices.contains(index) else { return "" }
                return store.blocks[index].text ?? ""
            },
            set: { store.setText(at: index, to: $0) }
        )
    }
}
