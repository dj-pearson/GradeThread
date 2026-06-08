import PhotosUI
import SwiftData
import SwiftUI
import UIKit

/// Full item canvas — inline-editable form covering identity, pricing,
/// photos, measurements, comps, and notes. Saves via supabase-swift with
/// optimistic write to the SwiftData cache and rollback on failure.
///
/// The Comps section fetches live eBay comps on demand (category-resolve →
/// Browse search) and offers a one-tap "use median" into the target price.
/// The Photos section supports add (US-650, fills unfilled standard slots) +
/// Manage (reorder/cover/remove); an overflow menu adds Duplicate, Delete, and
/// Share-certificate. The view binds to a single `LocalInventoryItem` passed in
/// by the inventory list — re-renders reactively when SwiftData updates the row
/// after a sync pull.
struct ItemCanvasView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(\.photoUploadService) private var uploadService

    let item: LocalInventoryItem

    @Query private var allPhotos: [LocalItemPhoto]
    /// US-665: this item's sale(s) for the realized per-item P&L row.
    @Query private var itemSales: [LocalSale]
    @State private var state: ItemCanvasState?
    @State private var showingDiscardConfirmation = false
    @State private var showingPublishDialog = false
    @State private var showingPhotoManager = false
    @State private var compsStore = CompsStore()
    /// US-676: consignors for the consignment picker.
    @State private var consignorStore = ConsignorStore()
    @State private var labelError: String?

    // US-650 item-level actions
    @State private var showingDeleteConfirmation = false
    @State private var showingAddPhotosPicker = false
    // US-687: camera capture straight into this item.
    @State private var showingCameraCapture = false
    @State private var isAddingPhotos = false
    @State private var actionToast: String?
    private let currencyFormatter = CurrencyFormatter()

    /// Statuses where "Publish to eBay" makes sense — anything pre-list
    /// where the item could reasonably go live. Mirrors the web canvas
    /// predicate.
    private static let publishableStatuses: Set<String> = [
        "photographed", "graded", "comped", "drafted", "measured",
    ]
    private var canPublish: Bool {
        Self.publishableStatuses.contains(item.status)
    }

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
        self._itemSales = Query(
            filter: #Predicate<LocalSale> { $0.inventoryItemId == itemId },
            sort: \.saleDate, order: .reverse
        )
    }

    /// US-665: realized per-item P&L once the item has sold (sale − fees − cost).
    private var realizedPnL: (revenue: Double, fees: Double, cogs: Double, net: Double)? {
        guard let sale = itemSales.first else { return nil }
        let cogs = item.acquiredPrice ?? 0
        return (sale.salePrice, sale.platformFees, cogs, sale.salePrice - sale.platformFees - cogs)
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
        .task { await consignorStore.load() }
        .alert(
            "Couldn't print label",
            isPresented: Binding(
                get: { labelError != nil },
                set: { if !$0 { labelError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(labelError ?? "")
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
        // US-650: item-level actions overflow menu.
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                // US-687: add photos to this item — camera or library, always
                // available (extra shots land as additional detail photos).
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button {
                        showingCameraCapture = true
                    } label: {
                        Label("Take photo", systemImage: "camera")
                    }
                }
                Button {
                    showingAddPhotosPicker = true
                } label: {
                    Label("Add from library", systemImage: "photo.badge.plus")
                }
                Button {
                    Task { await duplicateItem() }
                } label: {
                    Label("Duplicate item", systemImage: "plus.square.on.square")
                }
                if let certURL = certificateShareURL {
                    ShareLink(item: certURL) {
                        Label("Share certificate", systemImage: "square.and.arrow.up")
                    }
                }
                Divider()
                Button(role: .destructive) {
                    showingDeleteConfirmation = true
                } label: {
                    Label("Delete item", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .accessibilityLabel("Item actions")
            }
        }
    }

    /// Public certificate URL when the item carries a certified grade (US-650).
    private var certificateShareURL: URL? {
        guard item.gradeValue != nil else { return nil }
        if let explicit = item.certificateURL, let url = URL(string: explicit) { return url }
        return nil
    }

    // MARK: - Form sections

    @ViewBuilder
    private func form(state: ItemCanvasState) -> some View {
        @Bindable var state = state

        Form {
            identitySection(state: state)
            storageSection(state: state)
            pricingSection(state: state)
            if let pnl = realizedPnL {
                pnlSection(pnl)
            }
            photosSection
            CertifiedGradeSection(item: item)
            measurementsSection
            compsSection(state: state)
            notesSection(state: state)
            statusSection(state: state)
            specificsSection
            if canPublish {
                publishSection
            }
            if case let .failed(message) = state.savePhase {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        }
        .sheet(isPresented: $showingPublishDialog) {
            PublishDialog(inventoryItemId: item.id, acquiredCost: item.acquiredPrice) { response in
                // Optimistic local apply so the row flips to listed
                // before the next sync pull lands.
                item.status = "listed"
                item.updatedAt = .now
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                _ = response  // listing_id + url are tracked server-side
            }
        }
        .sheet(isPresented: $showingPhotoManager) {
            PhotoManagerView(item: item, photos: allPhotos)
        }
        // US-650/US-687: add photos straight into THIS item (not a new intake).
        // selectionLimit 0 = unlimited, so users can add extra/detail shots
        // beyond the standard slots.
        .sheet(isPresented: $showingAddPhotosPicker) {
            PhotoLibraryPicker(selectionLimit: 0) { results in
                Task { await ingestAddedPhotos(results) }
            }
            .ignoresSafeArea()
        }
        // US-687: camera capture into this item.
        .fullScreenCover(isPresented: $showingCameraCapture) {
            CameraPicker { image in
                Task { await ingestCapturedImage(image) }
            }
            .ignoresSafeArea()
        }
        .alert(
            "Delete item?",
            isPresented: $showingDeleteConfirmation
        ) {
            Button("Delete", role: .destructive) { Task { await deleteItem() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(item.title) and its photos will be removed. This can't be undone.")
        }
        .overlay(alignment: .bottom) {
            if let actionToast {
                Text(actionToast)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(Color.brandNavy, in: Capsule())
                    .padding(.bottom, 24)
                    .task(id: actionToast) {
                        try? await Task.sleep(nanoseconds: 2_500_000_000)
                        self.actionToast = nil
                    }
            }
        }
    }

    /// Entry to the eBay Category + Item Specifics editor. Required item
    /// specifics are category-driven and block publish when missing, so this
    /// sits just above the publish action.
    private var specificsSection: some View {
        Section {
            NavigationLink {
                EbayCategorySpecificsView(itemId: item.id)
            } label: {
                Label("Category & item specifics", systemImage: "list.bullet.rectangle")
            }
        } header: {
            Text("eBay listing")
        } footer: {
            Text("Set the eBay category and required item specifics so the listing can publish.")
                .font(.caption)
        }
    }

    /// US-683: what's missing before this item can be listed, from local signals.
    private var publishBlockers: [String] {
        PublishReadiness.blockers(
            title: item.title,
            hasPhotos: !allPhotos.isEmpty,
            targetPrice: item.targetPrice,
            status: item.status
        )
    }

    private var publishSection: some View {
        Section {
            // US-683: surface readiness up front so the user fixes blockers
            // before opening the publish sheet (where they used to only appear
            // after a round-trip).
            if !publishBlockers.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Before you list", systemImage: "checklist")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.brandAmber)
                    ForEach(publishBlockers, id: \.self) { blocker in
                        Label(blocker, systemImage: "circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .labelStyle(.titleAndIcon)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color.brandAmber.opacity(0.10), in: RoundedRectangle(cornerRadius: CornerRadius.control))
                .listRowInsets(.init(top: 4, leading: 0, bottom: 8, trailing: 0))
                .listRowBackground(Color.clear)
                .accessibilityElement(children: .combine)
            } else {
                Label("Ready to list", systemImage: "checkmark.seal.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandEmerald)
                    .listRowBackground(Color.clear)
                    .listRowInsets(.init(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            Button {
                AppRouter.haptic()
                showingPublishDialog = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "tag.fill")
                    Text("Publish to eBay")
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }
            .listRowBackground(Color.clear)
            .listRowInsets(.init(top: 4, leading: 0, bottom: 4, trailing: 0))
        } footer: {
            Text("Validates against eBay's metadata rules first; you'll see any blockers before the push.")
                .font(.caption)
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

    /// US-676: storage location/bin, consignment link, and SKU label printing.
    private func storageSection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        return Section("Storage & consignment") {
            TextField("Location / bin", text: $state.draft.locationBin)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()

            Picker("Consignor", selection: $state.draft.consignorId) {
                Text("None").tag(String?.none)
                ForEach(consignorStore.consignors) { consignor in
                    Text(consignor.name).tag(Optional(consignor.id))
                }
            }
            if state.draft.consignorId != nil {
                HStack {
                    TextField("Split %", text: $state.draft.consignmentSplitText)
                        .keyboardType(.numberPad)
                    Text("% to consignor")
                        .foregroundStyle(.secondary)
                }
            }

            Button {
                printSKULabel()
            } label: {
                Label("Print SKU label", systemImage: "printer")
            }
            .disabled(state.draft.sku.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func printSKULabel() {
        guard let state else { return }
        do {
            try LabelPrinter.printLabel(
                sku: state.draft.sku,
                title: state.draft.title.nonEmpty ?? item.title
            )
        } catch {
            labelError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            HapticFeedback.error()
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

    /// US-665: realized P&L once the item has sold.
    private func pnlSection(_ pnl: (revenue: Double, fees: Double, cogs: Double, net: Double)) -> some View {
        Section {
            LabeledContent("Sold for", value: currencyFormatter.formatDisplay(pnl.revenue))
            LabeledContent("Platform fees", value: "−" + currencyFormatter.formatDisplay(pnl.fees))
            LabeledContent("Cost of goods", value: "−" + currencyFormatter.formatDisplay(pnl.cogs))
            LabeledContent("Net profit") {
                Text(currencyFormatter.formatDisplay(pnl.net))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(pnl.net < 0 ? Color.brandRed : Color.brandEmerald)
            }
        } header: {
            Text("Profit & loss")
        }
    }

    /// US-687: camera + library options shared by the empty-state, header, and
    /// toolbar add controls.
    @ViewBuilder
    private func addPhotosMenuItems() -> some View {
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button {
                showingCameraCapture = true
            } label: {
                Label("Take photo", systemImage: "camera")
            }
        }
        Button {
            showingAddPhotosPicker = true
        } label: {
            Label("Add from library", systemImage: "photo.badge.plus")
        }
    }

    private var photosSection: some View {
        Section {
            if allPhotos.isEmpty {
                // US-650/US-687: add photos directly (camera or library).
                Menu {
                    addPhotosMenuItems()
                } label: {
                    Label(isAddingPhotos ? "Adding…" : "Add photos", systemImage: "photo.badge.plus")
                }
                .disabled(isAddingPhotos || uploadService == nil)
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
                if !allPhotos.isEmpty {
                    // US-687: always available; extra shots become detail photos.
                    Menu {
                        addPhotosMenuItems()
                    } label: {
                        Text("Add").font(.caption.weight(.semibold)).textCase(nil)
                    }
                    .disabled(isAddingPhotos || uploadService == nil)
                    Button("Manage") { showingPhotoManager = true }
                        .font(.caption.weight(.semibold))
                        .textCase(nil)
                }
                Text("\(allPhotos.count)").foregroundStyle(.secondary)
            }
        } footer: {
            if !allPhotos.isEmpty {
                // US-687: corrected copy — adding happens here, not the + tab.
                Text("Tap Add to capture or import more photos, or Manage to reorder, set the cover, or remove photos.")
                    .font(.footnote)
            }
        }
    }

    @ViewBuilder
    private func photoCell(_ photo: LocalItemPhoto) -> some View {
        let url = URL(string: photo.thumbnailURL ?? photo.photoURL)
        ZStack(alignment: .bottomLeading) {
            // US-635: cached + downsampled to the 84pt grid cell.
            CachedThumbnail(url: url, maxDimension: 84) {
                Image(systemName: "photo")
                    .font(.system(size: 22, weight: .light))
                    .frame(width: 84, height: 84)
                    .background(Color.secondary.opacity(0.12))
            }
            .frame(width: 84, height: 84)
            .clipped()
            Text(photo.photoType.capitalized)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(.black.opacity(0.6))
                .foregroundStyle(.white)
                .clipShape(Capsule())
                .padding(4)
        }
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous))
        // US-705: each photo reads as "<type> photo" instead of an unlabeled image.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(photo.photoType.capitalized) photo")
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

    private func compsSection(state: ItemCanvasState) -> some View {
        Section {
            switch compsStore.phase {
            case .idle:
                Button {
                    AppRouter.haptic()
                    fetchComps(state: state)
                } label: {
                    Label("Get eBay comps", systemImage: "chart.bar.doc.horizontal")
                }
                .disabled(state.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            case .loading:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Checking eBay…").foregroundStyle(.secondary)
                }

            case .loaded(let lookup):
                compsResults(lookup, state: state)

            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Try again") { fetchComps(state: state) }
                        .font(.subheadline)
                }
            }
        } header: {
            Text("Comps")
        } footer: {
            if case .idle = compsStore.phase {
                Text("Searches active eBay listings for similar items to suggest a price.")
                    .font(.caption)
            }
        }
    }

    @ViewBuilder
    private func compsResults(_ lookup: CompsLookup, state: ItemCanvasState) -> some View {
        if lookup.stats.count == 0 || lookup.stats.median == nil {
            VStack(alignment: .leading, spacing: 8) {
                Text("No active comps found for this item.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Search again") { fetchComps(state: state) }
                    .font(.subheadline)
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 0) {
                    compStat("Low", lookup.stats.min)
                    Divider()
                    compStat("Median", lookup.stats.median)
                    Divider()
                    compStat("High", lookup.stats.max)
                }
                // US-705: read the price triad as one coherent element.
                .accessibilityElement(children: .combine)
                Text("Based on \(lookup.stats.count) active eBay listing\(lookup.stats.count == 1 ? "" : "s") · \(lookup.categoryPath)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if let median = lookup.stats.median {
                    Button {
                        AppRouter.haptic()
                        // Populate the target-price field; the user reviews
                        // and taps Save (marks the form dirty).
                        state.draft.targetPriceText = currencyFormatter.formatRaw(median)
                    } label: {
                        Label(
                            "Use median (\(currencyFormatter.formatDisplay(median)))",
                            systemImage: "arrow.down.circle"
                        )
                    }
                    .font(.subheadline.weight(.semibold))
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func compStat(_ label: String, _ value: Double?) -> some View {
        VStack(spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value.map { currencyFormatter.formatDisplay($0) } ?? "—")
                .font(.subheadline.weight(.semibold))
        }
        .frame(maxWidth: .infinity)
    }

    /// Kicks off a comps lookup from the *draft* values so it reflects any
    /// unsaved title/brand/size edits on screen.
    private func fetchComps(state: ItemCanvasState) {
        Task {
            await compsStore.fetch(
                title: state.draft.title,
                brand: state.draft.brand.nonEmpty,
                size: state.draft.size.nonEmpty
            )
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

    // MARK: - Item-level actions (US-650)

    /// Standard photo slots this item doesn't have yet — the targets the
    /// "Add photos" action fills (front/back/tag/detail, then unused defects).
    private var unfilledStandardSlots: [PhotoSlotType] {
        let present = Set(allPhotos.map(\.photoType))
        var slots: [PhotoSlotType] = []
        for slot in [PhotoSlotType.front, .back, .tag, .detail]
        where !present.contains(slot.serverPhotoType) {
            slots.append(slot)
        }
        let defectCount = allPhotos.filter { $0.photoType == "defect" }.count
        let defectSlots: [PhotoSlotType] = [.defect1, .defect2, .defect3]
        if defectCount < defectSlots.count {
            slots.append(contentsOf: defectSlots[defectCount...])
        }
        return slots
    }

    /// US-687: the slot a newly-added photo at `offset` should fill — unfilled
    /// standard slots first, then extra `.detail` shots once the standard set
    /// is full (so users aren't capped at front/back/tag/detail + 3 defects).
    private func slotForAddedPhoto(offset: Int) -> PhotoSlotType {
        let slots = unfilledStandardSlots
        return offset < slots.count ? slots[offset] : .detail
    }

    /// Compresses picked photos and uploads them into THIS item. Fills unfilled
    /// standard slots first, then adds extras as detail photos (US-687).
    private func ingestAddedPhotos(_ results: [PHPickerResult]) async {
        guard let uploadService, !results.isEmpty else { return }
        isAddingPhotos = true
        defer { isAddingPhotos = false }
        var pairs: [(slot: PhotoSlotType, capture: PhotoCapture)] = []
        var accepted = 0
        for result in results {
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(image) else { continue }
            let capture = PhotoCapture(
                imageData: output.imageData,
                thumbnail: output.thumbnail,
                capturedAt: result.creationDate() ?? .now,
                source: .library
            )
            pairs.append((slotForAddedPhoto(offset: accepted), capture))
            accepted += 1
        }
        guard !pairs.isEmpty else {
            actionToast = "Couldn't read those photos."
            return
        }
        uploadService.enqueueAll(photos: pairs, inventoryItemId: item.id, userId: item.userId)
        actionToast = "Added \(pairs.count) photo\(pairs.count == 1 ? "" : "s")."
        HapticFeedback.success()
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    /// US-687: compresses a freshly-captured camera image and uploads it into
    /// THIS item (next unfilled standard slot, else an extra detail photo).
    private func ingestCapturedImage(_ image: UIImage) async {
        guard let uploadService else { return }
        isAddingPhotos = true
        defer { isAddingPhotos = false }
        guard let output = await PhotoCompressor.compressOffMain(image) else {
            actionToast = "Couldn't process that photo."
            return
        }
        let capture = PhotoCapture(
            imageData: output.imageData,
            thumbnail: output.thumbnail,
            capturedAt: .now,
            source: .camera
        )
        uploadService.enqueueAll(
            photos: [(slotForAddedPhoto(offset: 0), capture)],
            inventoryItemId: item.id,
            userId: item.userId
        )
        actionToast = "Added 1 photo."
        HapticFeedback.success()
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    /// Server-side duplicate of the item's core fields (not photos or grade).
    private func duplicateItem() async {
        struct Insert: Encodable {
            let user_id: String
            let title: String
            let brand: String?
            let size: String?
            let color: String?
            let material: String?
            let status: String
            let target_price: Double?
            let acquired_price: Double?
            let condition_notes: String?
        }
        let payload = Insert(
            user_id: item.userId,
            title: item.title + " (copy)",
            brand: item.brand,
            size: item.size,
            color: item.color,
            material: item.material,
            status: "cataloged",
            target_price: item.targetPrice,
            acquired_price: item.acquiredPrice,
            condition_notes: item.conditionNotes
        )
        do {
            try await SupabaseShared.client.from("inventory_items").insert(payload).execute()
            actionToast = "Duplicated to a new item."
            HapticFeedback.success()
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        } catch {
            actionToast = "Couldn't duplicate: \(error.localizedDescription)"
            HapticFeedback.error()
        }
    }

    /// Server delete + local delete + dismiss.
    private func deleteItem() async {
        let executor = BulkActionExecutor()
        if let error = await executor.deleteItem(item) {
            actionToast = "Couldn't delete: \(error)"
            HapticFeedback.error()
        } else {
            modelContext.delete(item)
            try? modelContext.save()
            HapticFeedback.success()
            dismiss()
        }
    }

    // MARK: - Save

    private func save() async {
        guard let state else { return }
        guard state.isSavable, state.isDirty else { return }
        guard state.canTransition(to: state.draft.status) else {
            HapticFeedback.error()
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
            HapticFeedback.success()
            dismiss()
        } catch {
            HapticFeedback.error()
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
        let location_bin: String?
        let consignor_id: String?
        let consignment_split_pct: Double?
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
            item_category: state.draft.category?.rawValue,
            location_bin: state.draft.locationBin.nonEmpty,
            consignor_id: state.draft.consignorId,
            consignment_split_pct: Self.parseSplit(state)
        )
    }

    /// Parses the per-item split override. Only meaningful when a consignor is
    /// set; cleared (nil) otherwise so an unlinked item carries no stray split.
    private static func parseSplit(_ state: ItemCanvasState) -> Double? {
        guard state.draft.consignorId != nil else { return nil }
        let trimmed = state.draft.consignmentSplitText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Double(trimmed) else { return nil }
        return min(max(value, 0), 100)
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
        item.locationBin = state.draft.locationBin.nonEmpty
        item.consignorId = state.draft.consignorId
        item.consignmentSplitPct = Self.parseSplit(state)
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
