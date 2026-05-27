import SwiftData
import SwiftUI

/// Full item canvas — inline-editable form covering identity, pricing,
/// photos, measurements, comps, and notes. Saves via supabase-swift with
/// optimistic write to the SwiftData cache and rollback on failure.
///
/// Photos / comps sections are read-only this pass; full drag-to-reorder
/// + add-photo + add-comp wire-up are scoped to follow-up stories. The
/// view binds to a single `LocalInventoryItem` passed in by the inventory
/// list — re-renders reactively when SwiftData updates the row after a
/// sync pull.
struct ItemCanvasView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let item: LocalInventoryItem

    @Query private var allPhotos: [LocalItemPhoto]
    @State private var state: ItemCanvasState?
    @State private var showingDiscardConfirmation = false
    private let currencyFormatter = CurrencyFormatter()

    init(item: LocalInventoryItem) {
        self.item = item
        // Filter photos by item id at @Query time — far cheaper than
        // fetching every photo and filtering in the body. The predicate
        // captures `id` so SwiftData re-runs it as the underlying store
        // updates.
        let itemId = item.id
        self._allPhotos = Query(
            filter: #Predicate<LocalItemPhoto> { $0.inventoryItemId == itemId },
            sort: \.sortOrder
        )
    }

    var body: some View {
        Group {
            if let state {
                form(state: state)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .onAppear {
            if state == nil {
                state = ItemCanvasState(item: item, currencyFormatter: currencyFormatter)
            }
        }
        .interactiveDismissDisabled(state?.isDirty == true)
        .confirmationDialog(
            "Discard your changes?",
            isPresented: $showingDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
                state?.discardChanges()
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("You have unsaved changes on this item.")
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Back") {
                if state?.isDirty == true {
                    showingDiscardConfirmation = true
                } else {
                    dismiss()
                }
            }
        }
        ToolbarItem(placement: .confirmationAction) {
            Button {
                Task { await save() }
            } label: {
                if state?.savePhase == .saving {
                    ProgressView()
                } else {
                    Text("Save").font(.subheadline.weight(.semibold))
                }
            }
            .disabled(!(state?.isDirty ?? false) || !(state?.isSavable ?? false) || state?.savePhase == .saving)
        }
    }

    // MARK: - Form sections

    @ViewBuilder
    private func form(state: ItemCanvasState) -> some View {
        @Bindable var state = state

        Form {
            identitySection(state: state)
            pricingSection(state: state)
            photosSection
            measurementsSection
            compsSection
            notesSection(state: state)
            statusSection(state: state)
            if case let .failed(message) = state.savePhase {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        }
    }

    private func identitySection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        return Section("Item") {
            TextField("Title", text: $state.draft.title)
                .textInputAutocapitalization(.words)
            TextField("Brand", text: $state.draft.brand)
                .textInputAutocapitalization(.words)
            TextField("SKU", text: $state.draft.sku)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Size", text: $state.draft.size)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Color", text: $state.draft.color)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Material", text: $state.draft.material)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Picker("Category", selection: $state.draft.category) {
                Text("—").tag(FlipdeskCategory?.none)
                ForEach(FlipdeskCategory.allCases) { cat in
                    Text(cat.label).tag(Optional(cat))
                }
            }
        }
    }

    private func pricingSection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        return Section("Pricing") {
            HStack {
                Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                TextField("Target price", text: $state.draft.targetPriceText)
                    .keyboardType(.decimalPad)
            }
            HStack {
                Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                TextField("Cost", text: $state.draft.acquiredPriceText)
                    .keyboardType(.decimalPad)
            }
        }
    }

    private var photosSection: some View {
        Section {
            if allPhotos.isEmpty {
                Text("No photos yet. Capture from the + tab to add some.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(allPhotos) { photo in
                            photoCell(photo)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        } header: {
            HStack {
                Text("Photos")
                Spacer()
                Text("\(allPhotos.count)").foregroundStyle(.secondary)
            }
        } footer: {
            if !allPhotos.isEmpty {
                Text("Reorder + add-photo land in a later pass. Edit photos on the web for now.")
                    .font(.footnote)
            }
        }
    }

    @ViewBuilder
    private func photoCell(_ photo: LocalItemPhoto) -> some View {
        let url = URL(string: photo.thumbnailURL ?? photo.photoURL)
        ZStack(alignment: .bottomLeading) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .empty, .failure:
                    Image(systemName: "photo")
                        .font(.system(size: 22, weight: .light))
                        .frame(width: 84, height: 84)
                        .background(Color.secondary.opacity(0.12))
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                        .frame(width: 84, height: 84)
                        .clipped()
                @unknown default:
                    EmptyView()
                }
            }
            Text(photo.photoType.capitalized)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(.black.opacity(0.6))
                .foregroundStyle(.white)
                .clipShape(Capsule())
                .padding(4)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var measurementsSection: some View {
        Section {
            if let measurements = parsedMeasurements(), !measurements.isEmpty {
                ForEach(Array(measurements.keys.sorted()), id: \.self) { key in
                    HStack {
                        Text(key.capitalized)
                        Spacer()
                        Text(String(format: "%.1f in", measurements[key] ?? 0))
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("No measurements recorded. Run AI extract or add manually from the web.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Measurements")
        }
    }

    private var compsSection: some View {
        Section {
            Text("Comp editor lands in a later pass (web parity).")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } header: {
            Text("Comps")
        }
    }

    private func notesSection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        return Section("Notes") {
            TextField("Condition notes…", text: $state.draft.conditionNotes, axis: .vertical)
                .lineLimit(3...6)
        }
    }

    private func statusSection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        return Section {
            Picker("Status", selection: $state.draft.status) {
                ForEach(InventoryStage.allKnownStatuses, id: \.self) { status in
                    Text(status.capitalized).tag(status)
                }
            }
        } header: {
            Text("Status")
        } footer: {
            if !state.canTransition(to: state.draft.status) {
                Text("This item is already in a terminal state. Reverting to a pre-sale status isn't allowed from here.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
    }

    // MARK: - Save

    private func save() async {
        guard let state else { return }
        guard state.isSavable, state.isDirty else { return }
        guard state.canTransition(to: state.draft.status) else {
            state.failSaving("Can't move a \(state.original.status) item back to \(state.draft.status).")
            return
        }
        state.beginSaving()

        let payload = buildUpdatePayload(state: state)
        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .update(payload)
                .eq("id", value: item.id)
                .execute()

            // Optimistic write to the local cache so the list view
            // reflects the change immediately rather than waiting for
            // the next sync pull.
            applyToLocalItem(state: state)
            state.acceptDraftAsOriginal()
            try? modelContext.save()
            dismiss()
        } catch {
            state.failSaving(error.localizedDescription)
        }
    }

    /// Encodable subset of inventory_items columns the canvas writes.
    /// Nullable fields stay nil to preserve Postgres NULL semantics over
    /// empty strings.
    private struct ItemCanvasUpdate: Encodable {
        let title: String
        let brand: String?
        let sku: String?
        let size: String?
        let color: String?
        let material: String?
        let condition_notes: String?
        let status: String
        let target_price: Double?
        let acquired_price: Double?
        let item_category: String?
    }

    private func buildUpdatePayload(state: ItemCanvasState) -> ItemCanvasUpdate {
        let (target, cost) = state.parsedPrices()
        return ItemCanvasUpdate(
            title: state.draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
            brand: state.draft.brand.nonEmpty,
            sku: state.draft.sku.nonEmpty,
            size: state.draft.size.nonEmpty,
            color: state.draft.color.nonEmpty,
            material: state.draft.material.nonEmpty,
            condition_notes: state.draft.conditionNotes.nonEmpty,
            status: state.draft.status,
            target_price: target,
            acquired_price: cost,
            item_category: state.draft.category?.rawValue
        )
    }

    private func applyToLocalItem(state: ItemCanvasState) {
        let (target, cost) = state.parsedPrices()
        item.title = state.draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        item.brand = state.draft.brand.nonEmpty
        item.sku = state.draft.sku.nonEmpty
        item.size = state.draft.size.nonEmpty
        item.color = state.draft.color.nonEmpty
        item.material = state.draft.material.nonEmpty
        item.conditionNotes = state.draft.conditionNotes.nonEmpty
        item.status = state.draft.status
        item.targetPrice = target
        item.acquiredPrice = cost
        item.hasLocalChanges = false  // server now has our write
        item.updatedAt = .now
    }

    // MARK: - Measurements

    private func parsedMeasurements() -> [String: Double]? {
        guard let json = item.measurementsJSON?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: Double].self, from: json)
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
