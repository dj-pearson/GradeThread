import SwiftUI

/// The advanced-filter editor presented from the inventory toolbar. Edits a
/// working copy of ``InventoryFilterCriteria`` and commits on Done, so a
/// half-built filter never flickers the list mid-edit. Surfaces a live
/// result count, saved "smart views", and only offers facet values that
/// actually exist in the current cache (via ``InventoryFacets``).
struct InventoryFilterSheet: View {
    /// Committed back to the caller on Done.
    @Binding var criteria: InventoryFilterCriteria
    let facets: InventoryFacets
    let savedFilters: SavedFilterStore
    /// How many items the given criteria would yield under the caller's
    /// current stage + search. Drives the live "Showing N" footer.
    let resultCount: (InventoryFilterCriteria) -> Int

    @Environment(\.dismiss) private var dismiss

    /// Working copy; the bound `criteria` only updates on Done.
    @State private var draft: InventoryFilterCriteria
    @State private var minPriceText = ""
    @State private var maxPriceText = ""
    @State private var showingSaveAlert = false
    @State private var saveName = ""

    private let currencyFormatter = CurrencyFormatter()

    init(
        criteria: Binding<InventoryFilterCriteria>,
        facets: InventoryFacets,
        savedFilters: SavedFilterStore,
        resultCount: @escaping (InventoryFilterCriteria) -> Int
    ) {
        self._criteria = criteria
        self.facets = facets
        self.savedFilters = savedFilters
        self.resultCount = resultCount
        self._draft = State(initialValue: criteria.wrappedValue)
    }

    var body: some View {
        NavigationStack {
            Form {
                savedViewsSection
                gradeSection
                priceSection
                attributesSection   // brand / size / color / source / category
                photosAndDateSection
                datesSection        // purchase / sale date ranges
                advancedSection     // AND/OR rule builder
            }
            .keyboardDoneToolbar()
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Reset") {
                        withAnimation(ReducedMotion.animation(.default)) { draft = .empty }
                        syncPriceText()
                    }
                    .disabled(!draft.isActive)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { commit() }
                        .font(.brandHeadline)
                }
            }
            .safeAreaInset(edge: .bottom) { resultFooter }
        }
        .onAppear(perform: syncPriceText)
        .alert("Save view", isPresented: $showingSaveAlert) {
            TextField("Name (e.g. Nike size L)", text: $saveName)
            Button("Save") {
                savedFilters.save(name: saveName, criteria: draft)
                saveName = ""
            }
            Button("Cancel", role: .cancel) { saveName = "" }
        } message: {
            Text("Pin the current filters as a one-tap view.")
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var savedViewsSection: some View {
        if !savedFilters.filters.isEmpty || draft.isActive {
            Section("Saved views") {
                ForEach(savedFilters.filters) { saved in
                    Button {
                        AppRouter.haptic()
                        withAnimation(ReducedMotion.animation(.default)) { draft = saved.criteria }
                        syncPriceText()
                    } label: {
                        HStack {
                            Image(systemName: "bookmark.fill")
                                .foregroundStyle(Color.brandNavy)
                            Text(saved.name)
                                .foregroundStyle(.primary)
                            Spacer()
                            if draft == saved.criteria {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.brandNavy)
                            }
                        }
                    }
                    .accessibilityHint("Applies this saved filter")
                }
                .onDelete { savedFilters.delete(at: $0) }

                if draft.isActive {
                    Button {
                        AppRouter.haptic()
                        // US-1185: prefill with the matched view's name so
                        // "Update saved view…" overwrites it instead of opening a
                        // blank field that creates a duplicate.
                        saveName = savedFilters.matchingName(for: draft) ?? ""
                        showingSaveAlert = true
                    } label: {
                        Label(
                            savedFilters.matchingName(for: draft) == nil
                                ? "Save current view…"
                                : "Update saved view…",
                            systemImage: "plus.circle"
                        )
                    }
                }
            }
        }
    }

    private var gradeSection: some View {
        Section("Grade") {
            Toggle(isOn: gradedOnlyBinding) {
                Label("Graded only", systemImage: "checkmark.seal")
            }
            Picker(selection: minGradeBinding) {
                Text("Any").tag(0.0)
                ForEach([5.0, 6.0, 7.0, 8.0, 9.0, 9.5], id: \.self) { g in
                    Text(String(format: "%.1f and up", g)).tag(g)
                }
            } label: {
                Label("Minimum grade", systemImage: "arrow.up.forward")
            }
        }
    }

    private var priceSection: some View {
        Section {
            HStack {
                Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                TextField("Min", text: $minPriceText)
                    .keyboardType(.decimalPad)
                    .onChange(of: minPriceText) { _, new in
                        draft.minPrice = currencyFormatter.parse(new)
                    }
                Divider()
                Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                TextField("Max", text: $maxPriceText)
                    .keyboardType(.decimalPad)
                    .onChange(of: maxPriceText) { _, new in
                        draft.maxPrice = currencyFormatter.parse(new)
                    }
            }
        } header: {
            Text("Price")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let bounds = facets.priceBounds {
                    Text("Items range \(currencyFormatter.formatDisplay(bounds.lowerBound)) – \(currencyFormatter.formatDisplay(bounds.upperBound)). Compares the listed, then target, then cost price.")
                } else {
                    Text("Compares the listed, then target, then cost price.")
                }
                // US-1247: unpriced items stay reachable under a max-only band,
                // but a minimum hides them (an unknown price can't clear a floor).
                if facets.unpricedCount > 0 {
                    Text("\(facets.unpricedCount) item\(facets.unpricedCount == 1 ? "" : "s") have no price — kept when only a max is set, hidden when a min is set.")
                }
            }
        }
    }

    private var attributesSection: some View {
        Section("Attributes") {
            facetLink("Brand", systemImage: "tag", values: facets.brands, selection: $draft.brands)
            facetLink("Size", systemImage: "ruler", values: facets.sizes, selection: $draft.sizes)
            facetLink("Color", systemImage: "paintpalette", values: facets.colors, selection: $draft.colors)
            if !facets.categories.isEmpty {
                facetLink("Category", systemImage: "square.grid.2x2", values: facets.categories, selection: $draft.categories)
            }
            if !facets.sources.isEmpty {
                facetLink("Source", systemImage: "bag", values: facets.sources, selection: $draft.sources)
            }
            // US-3124. Directly under Source on purpose: one is where the item
            // came from, the other is who bought it, and the words collide.
            if !facets.sourcers.isEmpty {
                facetLink("Sourced by", systemImage: "person", values: facets.sourcers, selection: $draft.sourcers)
            }
            if !facets.locationBins.isEmpty {
                facetLink("Location", systemImage: "shippingbox", values: facets.locationBins, selection: $draft.locationBins)
            }
        }
    }

    /// US-1052: absolute purchase- and sale-date windows (web parity).
    private var datesSection: some View {
        Section {
            DateBandEditor(title: "Purchased", systemImage: "cart", band: $draft.purchaseDates)
            DateBandEditor(title: "Sold", systemImage: "dollarsign.circle", band: $draft.saleDates)
        } header: {
            Text("Date ranges")
        } footer: {
            Text("Purchase windows the acquisition date; sale windows the sold date.")
        }
    }

    /// US-1052: entry point to the AND/OR advanced rule builder.
    private var advancedSection: some View {
        Section {
            NavigationLink {
                InventoryRuleBuilderView(query: $draft.ruleQuery)
            } label: {
                Label("Advanced rules", systemImage: "slider.horizontal.3")
                    .badge(draft.ruleQuery.isActive
                           ? "\(draft.ruleQuery.effectiveRules.count)"
                           : "Off")
            }
        } footer: {
            Text("Combine cross-field conditions with AND / OR logic.")
        }
    }

    private var photosAndDateSection: some View {
        Section {
            Picker(selection: $draft.photoState) {
                ForEach(InventoryFilterCriteria.PhotoState.allCases) { state in
                    Text(state.label).tag(state)
                }
            } label: {
                Label("Photos", systemImage: "photo")
            }
            Picker(selection: $draft.dateAdded) {
                ForEach(InventoryFilterCriteria.DatePreset.allCases) { preset in
                    Text(preset.label).tag(preset)
                }
            } label: {
                Label("Date added", systemImage: "calendar")
            }
        }
    }

    // MARK: - Facet link row

    @ViewBuilder
    private func facetLink(
        _ title: String,
        systemImage: String,
        values: [InventoryFacets.Value],
        selection: Binding<Set<String>>
    ) -> some View {
        if values.isEmpty {
            Label(title, systemImage: systemImage)
                .foregroundStyle(.secondary)
                .badge("None")
        } else {
            NavigationLink {
                FacetSelectionView(title: title, values: values, selection: selection)
            } label: {
                Label(title, systemImage: systemImage)
                    .badge(selection.wrappedValue.isEmpty ? "Any" : "\(selection.wrappedValue.count)")
            }
        }
    }

    // MARK: - Footer

    private var resultFooter: some View {
        let count = resultCount(draft)
        return Button { commit() } label: {
            Text(count == 1 ? "Show 1 item" : "Show \(count) items")
                .font(.brandHeadline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .background(.bar)
    }

    // MARK: - Bindings & actions

    private var gradedOnlyBinding: Binding<Bool> {
        Binding(
            get: { draft.gradedOnly },
            set: { on in
                draft.gradedOnly = on
                if !on { draft.minGrade = nil }  // floor is meaningless without graded-only
            }
        )
    }

    private var minGradeBinding: Binding<Double> {
        Binding(
            get: { draft.minGrade ?? 0 },
            set: { value in
                if value <= 0 {
                    draft.minGrade = nil
                } else {
                    draft.minGrade = value
                    draft.gradedOnly = true
                }
            }
        )
    }

    private func syncPriceText() {
        minPriceText = draft.minPrice.map { currencyFormatter.formatRaw($0) } ?? ""
        maxPriceText = draft.maxPrice.map { currencyFormatter.formatRaw($0) } ?? ""
    }

    private func commit() {
        AppRouter.haptic()
        criteria = draft
        dismiss()
    }
}

/// Searchable multi-select list for one facet (brand / size / color). Lives
/// in its own pushed screen because a power user's brand list can run to
/// hundreds of values — far too many for an inline picker.
private struct FacetSelectionView: View {
    let title: String
    let values: [InventoryFacets.Value]
    @Binding var selection: Set<String>
    @State private var search = ""

    var body: some View {
        List {
            ForEach(filtered) { value in
                Button {
                    AppRouter.haptic()
                    toggle(value.value)
                } label: {
                    HStack {
                        Text(value.label)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        Text("\(value.count)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if selection.contains(value.value) {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color.brandNavy)
                        }
                    }
                    .contentShape(Rectangle())
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $search, prompt: "Search \(title.lowercased())")
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !selection.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear") { selection.removeAll() }
                }
            }
        }
    }

    private var filtered: [InventoryFacets.Value] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return values }
        return values.filter { $0.label.lowercased().contains(needle) }
    }

    private func toggle(_ value: String) {
        if selection.contains(value) {
            selection.remove(value)
        } else {
            selection.insert(value)
        }
    }
}

/// US-1052: a from/to date-window editor for one ``InventoryFilterCriteria/
/// DateBand``. Each bound is independently optional — a toggle enables it and
/// reveals a compact `DatePicker`; turning it off clears that bound so the
/// window stays open-ended.
private struct DateBandEditor: View {
    let title: String
    let systemImage: String
    @Binding var band: InventoryFilterCriteria.DateBand

    var body: some View {
        DisclosureGroup {
            Toggle("After", isOn: enabled(\.from))
            if band.from != nil {
                DatePicker("From", selection: bound(\.from), displayedComponents: .date)
                    .labelsHidden()
            }
            Toggle("Before", isOn: enabled(\.to))
            if band.to != nil {
                DatePicker("To", selection: bound(\.to), displayedComponents: .date)
                    .labelsHidden()
            }
        } label: {
            Label(title, systemImage: systemImage)
                .badge(band.isActive ? "On" : "Any")
        }
    }

    /// Toggle binding: on ⇒ seed the bound with "now", off ⇒ clear it.
    private func enabled(_ key: WritableKeyPath<InventoryFilterCriteria.DateBand, Date?>) -> Binding<Bool> {
        Binding(
            get: { band[keyPath: key] != nil },
            set: { on in band[keyPath: key] = on ? Date() : nil }
        )
    }

    /// Non-optional proxy for a `DatePicker` once the bound is enabled.
    private func bound(_ key: WritableKeyPath<InventoryFilterCriteria.DateBand, Date?>) -> Binding<Date> {
        Binding(
            get: { band[keyPath: key] ?? Date() },
            set: { band[keyPath: key] = $0 }
        )
    }
}
