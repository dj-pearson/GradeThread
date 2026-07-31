import SwiftUI

/// The eBay category + item specifics, rendered INLINE as sections of the item
/// page instead of behind a "Category & item specifics" push.
///
/// Why: the pushed editor made every specifics edit a round trip — open the
/// item, save it (the push was blocked while dirty, because that screen reads
/// the SAVED row), push, edit, save again, come back. On a category with a
/// handful of required aspects that is most of the work of listing. The web
/// composer has always been one page, so this is the iOS half of that parity.
///
/// Three deliberate differences from the pushed editor this replaced:
///
///  * **No duplicate fields.** Aspects backed by a main-page column (Brand,
///    Size, Color, Material, Style) are hidden here — the seller already has
///    those inputs further up the same page, and they write to the same column.
///    Showing both is the "why am I typing this twice" problem.
///  * **Optional aspects are collapsed.** A category can return 30+ specifics;
///    required and recommended stay visible and the long tail sits behind one
///    disclosure so the item page doesn't become an endless scroll.
///  * **No Save button of its own.** The item page's Save commits both, so the
///    seller never has to think about which of two Saves they need.
struct ItemSpecificsInlineSections: View {
    let model: SpecificsEditorModel
    @Binding var showAllOptional: Bool
    @State private var searchDebounce: Task<Void, Never>?
    @State private var aiFillEmptyNote = false

    var body: some View {
        categorySection

        if model.hasCategory {
            switch model.phase {
            case .loadingAspects:
                Section { HStack { ProgressView(); Text("Loading item specifics…") } }
            case .failed(let message):
                Section {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.brandRed)
                    Button {
                        Task { await model.reload() }
                    } label: {
                        Label("Try again", systemImage: "arrow.clockwise")
                    }
                    .accessibilityHint("Reloads the eBay item specifics for this category")
                }
            default:
                aspectSections
            }
        }
    }

    // MARK: - Category

    @ViewBuilder
    private var categorySection: some View {
        @Bindable var model = model
        Section {
            if let current = model.selectedCategoryPath
                ?? model.selectedCategoryName
                ?? model.selectedCategoryId
            {
                Label(current, systemImage: "tag.fill")
                    .foregroundStyle(Color.brandNavy)
            }
            TextField("Search categories…", text: $model.categoryQuery)
                .autocorrectionDisabled()
                .onChange(of: model.categoryQuery) { _, q in
                    searchDebounce?.cancel()
                    searchDebounce = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 300_000_000)
                        if !Task.isCancelled, q == model.categoryQuery { await model.search() }
                    }
                }
            if model.isSearching {
                HStack { ProgressView(); Text("Searching…").foregroundStyle(.secondary) }
            }
            ForEach(model.suggestions, id: \.categoryId) { suggestion in
                Button {
                    Task { await model.select(suggestion) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(suggestion.categoryName).foregroundStyle(.primary)
                        if !suggestion.categoryTreePath.isEmpty {
                            Text(suggestion.categoryTreePath)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            }
        } header: {
            Text("eBay category")
        } footer: {
            if !model.hasCategory {
                Text("Pick the category to see the specifics eBay requires for it.")
                    .font(.caption)
            }
        }
    }

    // MARK: - Aspects

    private var required: [AspectSpec] { model.specs(usage: .required, hidingColumnBacked: true) }
    private var recommended: [AspectSpec] { model.specs(usage: .recommended, hidingColumnBacked: true) }
    private var optional: [AspectSpec] { model.specs(usage: .optional, hidingColumnBacked: true) }

    @ViewBuilder
    private var aspectSections: some View {
        if model.specs.isEmpty {
            Section {
                Text("This category has no item specifics.").foregroundStyle(.secondary)
            }
        } else {
            // Required-but-empty, listed up front: eBay refuses to publish
            // without them, and finding that out at publish time is far worse
            // than seeing it here. `missing` intentionally counts ALL required
            // aspects, including the column-backed ones hidden below — a missing
            // Brand still blocks the listing, and the seller fixes it in the
            // Brand field above.
            if !model.missing.isEmpty {
                Section {
                    Label(
                        "\(model.missing.count) required specific\(model.missing.count == 1 ? "" : "s") still missing",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(Color.brandRed)
                    ForEach(model.missing, id: \.self) { name in
                        Text(name).font(.caption).foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("eBay won't publish until these are filled.")
                }
            }

            Section {
                Button {
                    Task {
                        aiFillEmptyNote = false
                        let filled = await model.fillWithAI()
                        if model.errorMessage != nil {
                            HapticFeedback.error()
                        } else if filled == 0 {
                            aiFillEmptyNote = true
                            HapticFeedback.warning()
                        } else {
                            HapticFeedback.success()
                        }
                        Telemetry.event("ebay_specifics_ai_fill", props: [
                            "filled": filled,
                            "inline": true,
                        ])
                    }
                } label: {
                    if model.isFillingAI {
                        HStack { ProgressView(); Text("Filling with AI…") }
                    } else {
                        Label("Fill specifics with AI", systemImage: "wand.and.stars")
                    }
                }
                .disabled(model.isFillingAI)
                .accessibilityHint("Suggests item-specific values from the item's details and photos.")
            } footer: {
                if aiFillEmptyNote {
                    Text("No new suggestions — enter the specifics below.")
                } else if !model.aiFilled.isEmpty {
                    Text("AI filled \(model.aiFilled.count) specific\(model.aiFilled.count == 1 ? "" : "s"). Review before saving.")
                }
            }

            group("Required specifics", required)
            group("Recommended specifics", recommended)

            if !optional.isEmpty {
                Section {
                    // One disclosure rather than a separate screen: the long tail
                    // stays a tap away instead of a navigation away.
                    Button {
                        withAnimation { showAllOptional.toggle() }
                    } label: {
                        Label(
                            showAllOptional
                                ? "Hide optional specifics"
                                : "Show \(optional.count) more optional specific\(optional.count == 1 ? "" : "s")",
                            systemImage: showAllOptional ? "chevron.up" : "chevron.down"
                        )
                    }
                    if showAllOptional {
                        ForEach(optional) { spec in
                            AspectRowView(model: model, spec: spec)
                        }
                    }
                } header: {
                    Text("Optional specifics")
                } footer: {
                    if !showAllOptional {
                        Text("Optional specifics can improve search placement but never block publishing.")
                            .font(.caption)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ specs: [AspectSpec]) -> some View {
        if !specs.isEmpty {
            Section(title) {
                ForEach(specs) { spec in
                    AspectRowView(model: model, spec: spec)
                }
            }
        }
    }
}
