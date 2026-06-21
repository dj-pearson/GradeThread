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
    /// US-981: gate the network-only "Get eBay comps" lookup when offline.
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    let item: LocalInventoryItem

    @Query private var allPhotos: [LocalItemPhoto]
    /// US-665: this item's sale(s) for the realized per-item P&L row.
    @Query private var itemSales: [LocalSale]
    /// US-748: this item's listing(s) so the canvas shows where it's listed
    /// and links out to the live listing — part of the Item↔Listing↔Sale thread.
    @Query private var itemListings: [LocalListing]
    @State private var state: ItemCanvasState?
    /// US-967: parsed `measurements_json`, memoized so the Measurements section
    /// reads a cached value instead of re-decoding JSON on every `body` pass.
    /// Rebuilt via `.onChange(of: item.measurementsJSON)`.
    @State private var measurements: [String: Double]?
    @State private var showingDiscardConfirmation = false
    @State private var showingPublishDialog = false
    @State private var showingPhotoManager = false
    // US-310: editing a GradeThread-published live listing is folded into Save —
    // "Save & sync to eBay" pushes the change in place (eBay blocks editing
    // inventory-based listings on its own site). This holds a soft warning when
    // the local save succeeded but the eBay push failed (never blocks the save).
    @State private var ebaySyncError: String?
    // US-1088: Size AI — estimate a missing/cut-off size from the item's photos.
    @State private var sizeAiRunning = false
    @State private var sizeAiMessage: String?
    @State private var compsStore = CompsStore()
    /// US-676: consignors for the consignment picker.
    @State private var consignorStore = ConsignorStore()
    @State private var labelError: String?
    // US-686: reversible "AI filled N fields — review" entry point, populated
    // when the user lands here straight after an AI-extract auto-apply.
    @State private var aiReviewStore = AIFillReviewStore.shared
    @State private var showingAIReview = false

    // US-650 item-level actions
    @State private var showingDeleteConfirmation = false
    @State private var showingAddPhotosPicker = false
    // US-687: camera capture straight into this item.
    @State private var showingCameraCapture = false
    @State private var isAddingPhotos = false
    @State private var actionToast: String?
    // Duplicate-SKU merge: when a save trips idx_inventory_items_user_sku we
    // fetch the record that owns the SKU and offer to merge instead of
    // dead-ending on the raw Postgres error (web parity — MergeSkuDialog).
    @State private var mergeExisting: ExistingSkuItem?
    @State private var mergeConflicts: [ItemMergeConflict] = []
    @State private var isMerging = false
    @State private var mergeError: String?
    @State private var dismissAfterMerge = true
    private let currencyFormatter = CurrencyFormatter()

    /// Statuses where "Publish to eBay" makes sense — anything pre-list
    /// where the item could reasonably go live. Mirrors
    /// `PublishReadiness.publishableStatuses` (and the inventory list's
    /// swipe action) so the canvas never hides a publish path the list
    /// offers.
    private static let publishableStatuses: Set<String> =
        PublishReadiness.publishableStatuses
    private var canPublish: Bool {
        Self.publishableStatuses.contains(item.status)
    }

    /// The item's live eBay listing, if any — drives the "Edit live listing"
    /// and "Sync photo order to eBay" affordances.
    private var activeEbayListing: LocalListing? {
        itemListings.first {
            $0.platform == "ebay"
                && ($0.listingStatus == "active" || $0.listingStatus == "relisted")
        }
    }

    /// A GradeThread-originated live listing is revisable in place via Save & Sync.
    /// eBay-originated (imported) listings are locked mirrors — user edits on eBay.
    /// US-1086: prefer `listingOrigin` from the DB; fall back to `platformOfferId`
    /// for rows synced before the column was backfilled.
    private var gtLiveListing: LocalListing? {
        guard let l = activeEbayListing else { return nil }
        let isGT = l.listingOrigin == "gradethread" ||
            (l.listingOrigin == nil && l.platformOfferId != nil)
        return isGT ? l : nil
    }

    /// True when the item's edited target price differs from what's published on
    /// the live eBay listing — i.e. a saved price change hasn't been pushed yet.
    /// Price is the only field the local listing mirror carries, so it's the one
    /// reliable "unsynced" signal on iOS (title/description aren't mirrored).
    /// Saving the canvas writes FlipDesk only; "Edit live listing" pushes to eBay.
    private var listingPriceUnsynced: Bool {
        guard let listing = activeEbayListing, let target = item.targetPrice else {
            return false
        }
        return abs(target - listing.listingPrice) >= 0.01
    }

    /// The item's most recent ended eBay listing, if any — drives relist mode
    /// (an ended listing republishes as a brand-new listing on the same SKU).
    private var endedEbayListing: LocalListing? {
        itemListings.first {
            $0.platform == "ebay" && $0.listingStatus == "ended"
        }
    }

    /// Whether publishing this item is a relist: it was previously listed (an
    /// ended draft, or a still-live listing being replaced) rather than a
    /// first-time publish.
    private var isRelist: Bool {
        activeEbayListing != nil || endedEbayListing != nil
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
        self._itemListings = Query(
            filter: #Predicate<LocalListing> { $0.inventoryItemId == itemId },
            sort: \.updatedAt, order: .reverse
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
        .keyboardDoneToolbar()
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .onAppear {
            if state == nil {
                state = ItemCanvasState(item: item, currencyFormatter: currencyFormatter)
            }
        }
        // US-682: when a sync pull (or realtime push) updates the underlying
        // row's editable fields while the canvas is open, fold the new values
        // into the form snapshot — but only when the user hasn't started
        // editing (refreshFromItem no-ops while dirty). This is what lets the
        // freshly AI-extracted fields appear right after photo intake instead
        // of requiring a back-out/re-enter to rebuild the snapshot. The
        // ItemDraft key changes exactly when an editable field changes.
        // US-967: key on a cheap integer signature of the item's editable fields
        // instead of constructing a full `ItemDraft` (two `CurrencyFormatter`
        // calls) on every `body` pass. The signature changes exactly when an
        // editable field changes, so a realtime/sync push still folds in while
        // unrelated re-renders no longer rebuild the draft.
        .onChange(of: ItemCanvasView.editableSignature(item)) { _, _ in
            state?.refreshFromItem(item)
        }
        // US-967: decode measurements JSON once per change, not every body pass.
        .onChange(of: item.measurementsJSON, initial: true) { _, _ in
            measurements = ItemCanvasView.decodeMeasurements(item.measurementsJSON)
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
                    // A live GradeThread listing is revised in place on save.
                    Text(gtLiveListing != nil ? "Save & Sync" : "Save")
                        .font(.subheadline.weight(.semibold))
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

        ScrollViewReader { proxy in
        Form {
            if let review = aiReviewStore.review(for: item.id), review.hasSomethingToReview {
                aiReviewBanner(review)
            }
            // US-815: prep checklist computed from item facts; each incomplete
            // row jumps to the action (or section) that completes it.
            if showPrepChecklist {
                prepChecklistSection(scroll: proxy)
            }
            identitySection(state: state)
            storageSection(state: state)
            pricingSection(state: state)
            if let pnl = realizedPnL {
                pnlSection(pnl)
            }
            photosSection
                .id(ItemPrepChecklist.Step.photos)
            CertifiedGradeSection(
                item: item,
                // US-746: a graded, still-publishable item can jump straight to
                // the existing publish flow (parent owns the dialog + post-
                // publish handling); nil once listed so the CTA disappears.
                onListItem: canPublish
                    ? { Task { await saveThenPublish() } }
                    : nil
            )
            .id(ItemPrepChecklist.Step.grade)
            measurementsSection
                .id(ItemPrepChecklist.Step.measurements)
            compsSection(state: state)
                .id(ItemPrepChecklist.Step.comps)
            notesSection(state: state)
            statusSection(state: state)
            if !itemListings.isEmpty {
                listingsSection
            }
            // US-1044/1045: Promoted Listings + Sale controls for the live eBay listing.
            if let listing = activeEbayListing {
                EbayMarketingControls(listingId: listing.id)
            }
            specificsSection
            if canPublish {
                publishSection
                    .id(ItemPrepChecklist.Step.draft)
            }
            if case let .failed(message) = state.savePhase {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        }
        // US-815: auto-advance the pipeline status as completed work lands
        // (measurements from AI extract, required photos from upload sync, …).
        // Forward-only and best-effort — never blocks; `save()` reconciles too.
        .task(id: prepAdvanceSignature) { await autoAdvanceStatusIfNeeded() }
        .sheet(isPresented: $showingPublishDialog) {
            PublishDialog(
                inventoryItemId: item.id,
                acquiredCost: item.acquiredPrice,
                // Relist when the item was previously listed; warn when a live
                // listing still exists (the push ends it and creates a new one).
                relist: isRelist,
                listingActive: activeEbayListing != nil
            ) { response in
                // Optimistic local apply so the row flips to listed
                // before the next sync pull lands.
                item.status = "listed"
                item.updatedAt = .now
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                _ = response  // listing_id + url are tracked server-side
            }
        }
        .sheet(isPresented: $showingPhotoManager) {
            PhotoManagerView(item: item, photos: allPhotos, liveListing: activeEbayListing)
        }
        // US-686: reversible review of the post-intake AI auto-fill.
        .sheet(isPresented: $showingAIReview) {
            AIFillReviewSheet(item: item)
        }
        .alert(
            "eBay sync failed",
            isPresented: Binding(
                get: { ebaySyncError != nil },
                set: { if !$0 { ebaySyncError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { ebaySyncError = nil }
        } message: {
            Text(ebaySyncError ?? "")
        }
        .alert(
            "Size AI",
            isPresented: Binding(
                get: { sizeAiMessage != nil },
                set: { if !$0 { sizeAiMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { sizeAiMessage = nil }
        } message: {
            Text(sizeAiMessage ?? "")
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
        // Duplicate-SKU merge resolution (web parity).
        .sheet(item: $mergeExisting) { existing in
            let sku = (state.draft.sku.isEmpty ? (item.sku ?? "") : state.draft.sku)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            MergeSkuSheet(
                explanation: "Another inventory record already uses SKU “\(sku)”. Merging combines both into this item — photos, listings, sales and grading history are kept from both, then the other record is removed. Pick which value to keep where they differ; this item’s values are selected by default.",
                conflicts: mergeConflicts,
                merging: isMerging,
                errorMessage: mergeError,
                onConfirm: { chosen in
                    Task { await confirmMerge(existing: existing, keepExisting: chosen) }
                },
                onCancel: {
                    guard !isMerging else { return }
                    mergeExisting = nil
                    mergeError = nil
                    state.savePhase = .idle
                }
            )
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
        }  // ScrollViewReader
    }

    // MARK: - Prep checklist (US-815)

    /// Show the prep checklist only while the item is still working through the
    /// pre-list pipeline. Hidden once listed/sold (rank ≥ "listed") and for
    /// side-track statuses (keeping/wearing/archived/returned — rank −1).
    private var showPrepChecklist: Bool {
        let r = ItemWorkflow.rank(item.status)
        return r >= 0 && r < ItemWorkflow.rank("listed")
    }

    /// Live facts for the checklist DISPLAY. The target price reflects the
    /// (possibly unsaved) draft so "Comp & price" ticks as the user types;
    /// everything else derives from persisted item state.
    private var displayPrepFacts: ItemWorkflow.Facts {
        let livePrice = state.flatMap { currencyFormatter.parse($0.draft.targetPriceText) }
            ?? item.targetPrice
        return ItemWorkflow.Facts(
            hasMeasurements: !((measurements ?? [:]).isEmpty),
            hasRequiredPhotos: ItemPrepChecklist.hasRequiredPhotos(
                photoTypes: Set(allPhotos.map(\.photoType))),
            hasTargetPrice: (livePrice ?? 0) > 0,
            hasGrade: item.gradeValue != nil,
            hasDraftListing: !itemListings.isEmpty
        )
    }

    @ViewBuilder
    private func prepChecklistSection(scroll: ScrollViewProxy) -> some View {
        let facts = displayPrepFacts
        Section {
            ForEach(ItemPrepChecklist.rows(facts: facts)) { row in
                Button {
                    AppRouter.haptic()
                    handlePrepTap(row.step, scroll: scroll)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: row.done ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 18))
                            .foregroundStyle(row.done ? Color.brandEmerald : Color.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                            Text(row.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        if row.done {
                            if row.optional {
                                Text("Optional")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // US-705: each row reads as one element with its done/todo state.
                .accessibilityElement(children: .combine)
                .accessibilityHint(row.done ? "Completed" : "Incomplete — tap to complete")
            }
        } header: {
            HStack {
                Text("Prep checklist")
                Spacer()
                Text("\(ItemPrepChecklist.completedRequired(facts: facts))/\(ItemPrepChecklist.totalRequired(facts: facts))")
                    .foregroundStyle(.secondary)
            }
        } footer: {
            Text("Tap a step to jump to it. Status advances automatically as you complete each step.")
                .font(.caption)
        }
    }

    /// Routes an incomplete checklist row to the action that completes it:
    /// photos open the manager (or the add-photos picker when there are none),
    /// every other step scrolls the form to its section.
    private func handlePrepTap(_ step: ItemPrepChecklist.Step, scroll: ScrollViewProxy) {
        switch step {
        case .photos:
            if allPhotos.isEmpty {
                showingAddPhotosPicker = true
            } else {
                showingPhotoManager = true
            }
        case .measurements, .comps, .grade, .draft:
            withAnimation { scroll.scrollTo(step, anchor: .top) }
        }
    }

    /// US-815: PERSISTED facts (ignores the unsaved draft price) that drive the
    /// reactive auto-advance — typing a price shouldn't move the status until the
    /// price is actually saved.
    private func persistedPrepFacts() -> ItemWorkflow.Facts {
        ItemWorkflow.Facts(
            hasMeasurements: !((ItemCanvasView.decodeMeasurements(item.measurementsJSON) ?? [:]).isEmpty),
            hasRequiredPhotos: ItemPrepChecklist.hasRequiredPhotos(
                photoTypes: Set(allPhotos.map(\.photoType))),
            hasTargetPrice: (item.targetPrice ?? 0) > 0,
            hasGrade: item.gradeValue != nil,
            hasDraftListing: !itemListings.isEmpty
        )
    }

    /// Cheap signature of the persisted facts (+ current status) so the
    /// auto-advance `.task` re-runs exactly when completed work changes.
    private var prepAdvanceSignature: Int {
        var hasher = Hasher()
        hasher.combine(!((measurements ?? [:]).isEmpty))
        hasher.combine(ItemPrepChecklist.hasRequiredPhotos(
            photoTypes: Set(allPhotos.map(\.photoType))))
        hasher.combine((item.targetPrice ?? 0) > 0)
        hasher.combine(item.gradeValue != nil)
        hasher.combine(!itemListings.isEmpty)
        hasher.combine(item.status)
        return hasher.finalize()
    }

    /// US-815: advance the item's pipeline status to the furthest stage its
    /// completed work has earned. Forward-only (never regresses, never overrides
    /// a terminal/side-track status). Best-effort: a network failure queues the
    /// status change for replay; anything else is left for `save()` to reconcile.
    private func autoAdvanceStatusIfNeeded() async {
        guard state?.savePhase != .saving else { return }
        let facts = persistedPrepFacts()
        let resolved = ItemWorkflow.resolveStatus(
            current: item.status, selected: item.status, facts: facts)
        guard resolved != item.status else { return }

        let payload = StatusUpdate(status: resolved)
        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .update(payload)
                .eq("id", value: item.id)
                .execute()
            item.status = resolved
            item.updatedAt = .now
            modelContext.saveOrLog("autoAdvanceStatusIfNeeded")
        } catch {
            guard OfflineMutationQueue.shouldQueue(error) else { return }
            _ = OfflineMutationQueue.enqueueUpdate(
                kind: .updateInventoryItem, payload: payload, targetId: item.id, in: modelContext)
            item.status = resolved
            item.hasLocalChanges = true
            item.updatedAt = .now
            modelContext.saveOrLog("autoAdvanceStatusIfNeeded")
        }
        // Reflect the new status into the form when the user isn't mid-edit.
        if state?.isDirty == false { state?.refreshFromItem(item) }
    }

    /// Partial `inventory_items` update carrying only the auto-advanced status.
    private struct StatusUpdate: Encodable {
        let status: String
    }

    /// US-748: where this item is listed, with a link out to the live listing —
    /// part of the Item↔Listing↔Sale thread so the item isn't a dead-end once
    /// it goes live.
    private var listingsSection: some View {
        Section {
            ForEach(itemListings) { listing in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(listing.platform == "ebay" ? "eBay" : listing.platform.capitalized)
                            .font(.subheadline.weight(.medium))
                        // US-753: shared StatusBadge so a listing's status reads
                        // with the same tone/shape as item status everywhere else.
                        StatusBadge(status: listing.listingStatus)
                    }
                    Spacer()
                    if listing.id == activeEbayListing?.id && listingPriceUnsynced {
                        Text("Not on eBay")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.brandAmber.opacity(0.18), in: Capsule())
                            .foregroundStyle(Color.brandAmber)
                            .accessibilityLabel("Price not yet pushed to eBay")
                    }
                    Text(currencyFormatter.formatDisplay(listing.listingPrice))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if let raw = listing.externalURL, let url = URL(string: raw) {
                        Link(destination: url) {
                            Image(systemName: "arrow.up.right.square")
                        }
                        .accessibilityLabel("Open live listing")
                    }
                }
                .padding(.vertical, 2)
            }

            if let active = activeEbayListing {
                // US-1086: provenance badge + editing affordance based on listing_origin.
                // Prefer `listingOrigin` from DB; fall back to `platformOfferId` heuristic
                // for rows synced before the column was backfilled.
                let isEbayOriginated = active.listingOrigin == "ebay" ||
                    (active.listingOrigin == nil && active.platformOfferId == nil)

                if isEbayOriginated {
                    // eBay-originated mirror: user must edit on eBay; GradeThread locks
                    // eBay-owned fields and never overwrites them on sync.
                    HStack(spacing: 5) {
                        Image(systemName: "lock.fill")
                            .font(.caption2)
                        Text("Edit on eBay")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(Color.brandAmber)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.brandAmber.opacity(0.12), in: Capsule())
                    .accessibilityLabel("eBay-originated listing — edit on eBay")
                    if let raw = active.externalURL, let url = URL(string: raw) {
                        Link(destination: url) {
                            Label("Open on eBay to edit", systemImage: "square.and.pencil")
                                .fontWeight(.semibold)
                        }
                    }
                } else {
                    // GradeThread-originated: editing folded into Save & Sync.
                    HStack(spacing: 5) {
                        Image(systemName: "pencil")
                            .font(.caption2)
                        Text("Edit in GradeThread")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(Color.brandNavy)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.brandNavy.opacity(0.10), in: Capsule())
                    .accessibilityLabel("GradeThread-originated listing — edits sync via Save & Sync")
                    Text("Edits here sync to eBay when you tap \u{201C}Save & Sync\u{201D}.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                // Relist as a NEW listing: ends the current live listing and
                // publishes a fresh one (new eBay item #). The publish sheet
                // warns before it does this.
                Button {
                    AppRouter.haptic()
                    showingPublishDialog = true
                } label: {
                    Label("Relist as new listing", systemImage: "arrow.triangle.2.circlepath")
                }
            }
        } header: {
            Text(itemListings.count == 1 ? "Listing" : "Listings")
        } footer: {
            Text("Where this item is listed. Tap the arrow to open the live listing. GradeThread-originated listings sync edits via Save & Sync; eBay-originated listings are read-only mirrors (edit on eBay).")
                .font(.caption)
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

    /// Label for the canvas publish button, relist-aware so an ended draft
    /// reads "Relist" instead of "Publish".
    private var publishButtonLabel: String {
        let dirty = state?.isDirty == true
        if isRelist {
            return dirty ? "Save & relist on eBay" : "Relist on eBay"
        }
        return dirty ? "Save & publish to eBay" : "Publish to eBay"
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
                Task { await saveThenPublish() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isRelist ? "arrow.triangle.2.circlepath" : "tag.fill")
                    Text(publishButtonLabel)
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }
            .disabled(state?.savePhase == .saving)
            .listRowBackground(Color.clear)
            .listRowInsets(.init(top: 4, leading: 0, bottom: 4, trailing: 0))
        } footer: {
            Text("Unsaved edits are saved first, then validated against eBay's metadata rules — you'll see any blockers before the push.")
                .font(.caption)
        }
    }

    /// US-686: reversible entry point to the AI-fill review. Shows what the AI
    /// auto-applied (and any low-confidence suggestions waiting on opt-in), with
    /// a tap into ``AIFillReviewSheet`` to keep, opt in, or undo.
    private func aiReviewBanner(_ review: AIFillReview) -> some View {
        Section {
            Button {
                AppRouter.haptic()
                showingAIReview = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 20))
                        .foregroundStyle(Color.brandNavy)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(review.entryPointLabel)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        Text("Keep, undo, or add suggestions.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .listRowBackground(Color.brandNavy.opacity(0.06))
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
            // US-1088: Size AI — only while Size is blank (e.g. a cut-off
            // Lululemon label); fills the field on success, then hides.
            if state.draft.size.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button {
                    AppRouter.haptic()
                    Task { await runSizeAi(state: state) }
                } label: {
                    HStack(spacing: 6) {
                        if sizeAiRunning {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "sparkles")
                        }
                        Text(sizeAiRunning
                            ? "Analyzing photos…"
                            : "Size AI — estimate from photos")
                            .font(.subheadline)
                    }
                }
                .disabled(sizeAiRunning)
            }
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

    /// US-1088: run Size AI for this item — fills the Size field with the best
    /// guess and surfaces the rationale/confidence (or the failure) in an alert.
    /// Gender rides on the eBay category (resolved elsewhere), so it's only
    /// shown for context here, not written to a separate field.
    private func runSizeAi(state: ItemCanvasState) async {
        sizeAiRunning = true
        defer { sizeAiRunning = false }
        do {
            let r = try await SizeAIService().estimate(itemId: item.id)
            guard !r.size.isEmpty else {
                sizeAiMessage =
                    "Size AI couldn't read a size — add a measurement or flat-lay photo and try again."
                return
            }
            // US-1171: persist with provenance through AIItemFieldWriter so the
            // size carries an `ai_field_sources` entry (and the "AI" badge), just
            // like extract-fill — rather than writing only the local draft.
            try await AIItemFieldWriter.write(
                itemId: item.id,
                fields: [(field: "size", value: r.size)],
                measurements: nil,
                sources: ["size": AIItemFieldWriter.SourceEntry(
                    source: "ai:size", confidence: r.confidence, accepted: true)],
                seedTitle: false
            )
            state.draft.size = r.size
            HapticFeedback.success()
            let genderNote = r.gender.map { " · \($0)" } ?? ""
            let head = r.lowConfidence
                ? "Best guess: \(r.size)\(genderNote)"
                : "Size AI: \(r.size)\(genderNote)"
            let detail = r.rationale.isEmpty
                ? (r.lowConfidence
                    ? "Low confidence — double-check before listing."
                    : "")
                : r.rationale
            sizeAiMessage = detail.isEmpty ? head : "\(head)\n\n\(detail)"
        } catch {
            HapticFeedback.error()
            sizeAiMessage = "Size AI failed: \(error.localizedDescription)"
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
            // US-970: inline feedback when a typed price can't be parsed, so the
            // value isn't silently dropped on Save (which, for a live GradeThread
            // listing, also revises the eBay price). Reuses the details-intake
            // help pattern (US-754).
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                    TextField("Target price", text: $state.draft.targetPriceText)
                        .keyboardType(.decimalPad)
                }
                if let help = MoneyFieldValidation.optionalPriceHelp(
                    state.draft.targetPriceText, formatter: currencyFormatter
                ) {
                    Text(help).font(.footnote).foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                    TextField("Cost", text: $state.draft.acquiredPriceText)
                        .keyboardType(.decimalPad)
                }
                if let help = MoneyFieldValidation.optionalPriceHelp(
                    state.draft.acquiredPriceText, formatter: currencyFormatter
                ) {
                    Text(help).font(.footnote).foregroundStyle(.secondary)
                }
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
                Text("Tap Add to capture or import more photos, or Manage to reorder, set the cover, change a photo's type, or remove photos.")
                    .font(.footnote)
            }
        }
    }

    @ViewBuilder
    private func photoCell(_ photo: LocalItemPhoto) -> some View {
        ZStack(alignment: .bottomLeading) {
            // US-635: cached + downsampled to the 84pt grid cell.
            // US-979: resolves a signed URL for sensitive (private-bucket) photos.
            ItemPhotoThumbnail(photo: photo, maxDimension: 84) {
                Image(systemName: "photo")
                    .font(.system(size: 22, weight: .light))
                    .frame(width: 84, height: 84)
                    .background(Color.secondary.opacity(0.12))
            }
            .frame(width: 84, height: 84)
            .clipped()
            Text(FlipdeskPhotoType.label(for: photo.photoType))
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
        .accessibilityLabel("\(FlipdeskPhotoType.label(for: photo.photoType)) photo")
    }

    private var measurementsSection: some View {
        Section {
            if let measurements, !measurements.isEmpty {
                ForEach(Array(measurements.keys.sorted()), id: \.self) { key in
                    // US-753: shared DataRow — figures align down the column via
                    // the brand tabular-data font, and the pair reads as one
                    // element to VoiceOver.
                    DataRow(
                        label: key.capitalized,
                        value: String(format: "%.1f in", measurements[key] ?? 0)
                    )
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
                .disabled(
                    state.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || NetworkMonitor.isOffline(networkMonitor)
                )
                if NetworkMonitor.isOffline(networkMonitor) {
                    OfflineNotice(intent: .blocked, detail: "to pull eBay comps")
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

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
                    .foregroundStyle(.brandAmber)
            }
        }
    }

    // MARK: - Item-level actions (US-650)

    /// Standard photo slots this item doesn't have yet — the targets the
    /// "Add photos" action fills (front/back/tag/detail, then unused defects,
    /// then detail 2–4). Exotic types (interior, flat lay, measurements…)
    /// are never auto-assigned — retag via Manage instead.
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
        for slot in [PhotoSlotType.detail2, .detail3, .detail4]
        where !present.contains(slot.serverPhotoType) {
            slots.append(slot)
        }
        return slots
    }

    /// US-687: the slot a newly-added photo at `offset` should fill — unfilled
    /// standard slots first, then extra `.detail` shots once the standard set
    /// is full (so users aren't capped at the standard slot count).
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
            modelContext.saveOrLog("deleteItem")
            HapticFeedback.success()
            dismiss()
        }
    }

    // MARK: - Save

    /// Persists the draft. Returns true when the item is saved (or had
    /// nothing to save). `dismissAfter` is false for flows that continue on
    /// the canvas after saving — e.g. save-then-publish.
    @discardableResult
    private func save(dismissAfter: Bool = true) async -> Bool {
        guard let state else { return false }
        guard state.isSavable else { return false }
        guard state.isDirty else { return true }
        guard state.canTransition(to: state.draft.status) else {
            HapticFeedback.error()
            state.failSaving("Can't move a \(state.original.status) item back to \(state.draft.status).")
            return false
        }
        state.beginSaving()

        // US-815: auto-advance the status to the furthest stage the saved work
        // earns (forward-only; a manual non-prep pick still wins). Web parity
        // with `resolveStatus` in the prep flow. Applied to the draft before the
        // payload/local-apply so the wire write, the cache, and the Status picker
        // all carry the resolved value.
        let (savedTarget, _) = state.parsedPrices()
        let saveFacts = ItemWorkflow.Facts(
            hasMeasurements: !((ItemCanvasView.decodeMeasurements(item.measurementsJSON) ?? [:]).isEmpty),
            hasRequiredPhotos: ItemPrepChecklist.hasRequiredPhotos(
                photoTypes: Set(allPhotos.map(\.photoType))),
            hasTargetPrice: (savedTarget ?? 0) > 0,
            hasGrade: item.gradeValue != nil,
            hasDraftListing: !itemListings.isEmpty
        )
        state.draft.status = ItemWorkflow.resolveStatus(
            current: item.status, selected: state.draft.status, facts: saveFacts)

        // Unified Save & sync (web parity): capture the eBay-relevant change
        // BEFORE the draft is accepted as the new original. Only a
        // GradeThread-published listing (with a Sell offer) is revisable in
        // place; if only internal fields changed there's no eBay round-trip.
        let ebayPlan: (listingId: String, title: String?, price: Double?)? = {
            guard let live = gtLiveListing else { return nil }
            let o = state.original
            let d = state.draft
            let titleChanged = d.title != o.title
            let structuralChanged =
                d.brand != o.brand || d.size != o.size
                    || d.category != o.category
                    || d.conditionNotes != o.conditionNotes
            let newPrice = Double(
                d.targetPriceText.replacingOccurrences(of: ",", with: ""))
            let oldPrice = Double(
                o.targetPriceText.replacingOccurrences(of: ",", with: ""))
            let priceChanged = newPrice != nil && newPrice! > 0
                && newPrice != oldPrice
            guard titleChanged || structuralChanged || priceChanged else {
                return nil
            }
            return (
                listingId: live.id,
                title: titleChanged
                    ? d.title.trimmingCharacters(in: .whitespacesAndNewlines)
                    : nil,
                price: priceChanged ? newPrice : nil
            )
        }()

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
            do {
                try modelContext.save()
            } catch {
                // US-792: the server write already succeeded — only the local
                // SwiftData cache mirror failed. The change is persisted remotely
                // and self-heals on the next sync pull, so we don't fail the user
                // flow; we log it so a recurring local-persistence fault is visible.
                Telemetry.breadcrumb(
                    "ItemCanvas local cache save failed (server write OK): \(error.localizedDescription)",
                    category: "inventory"
                )
            }
            // Push to the live GradeThread listing. A failed eBay push never
            // blocks the local save — surface the reason and keep the user here.
            var syncFailed = false
            if let plan = ebayPlan {
                let outcome = await EbayPublishService().revise(
                    listingId: plan.listingId,
                    title: plan.title,
                    description: nil,
                    price: plan.price,
                    syncPhotos: true
                )
                switch outcome {
                case .revised:
                    break
                case .noOfferId:
                    ebaySyncError =
                        "Saved on your device, but this listing has no eBay offer to update."
                    syncFailed = true
                case .failed(let message):
                    ebaySyncError =
                        "Saved on your device, but the eBay update failed: \(message)"
                    syncFailed = true
                }
            }
            HapticFeedback.success()
            // US-972: when we stay on the canvas (not auto-dismissing, and the
            // eBay revise didn't fail into `ebaySyncError`), confirm the save
            // wasn't silent. A failed eBay push already surfaces `ebaySyncError`.
            if !syncFailed && !dismissAfter {
                actionToast = ebayPlan != nil ? "Saved and updated on eBay." : "Saved."
            }
            if dismissAfter && !syncFailed { dismiss() }
            return true
        } catch {
            // Duplicate SKU (partial unique index on user_id, sku) → offer to
            // merge the two records instead of dead-ending on the raw Postgres
            // error (web parity — see item-canvas.tsx `save()`).
            let sku = state.draft.sku.trimmingCharacters(in: .whitespacesAndNewlines)
            if ItemMergePlan.isDuplicateSkuError(error), !sku.isEmpty,
               let existing = await fetchExistingSkuOwner(sku) {
                mergeConflicts = ItemMergePlan.conflicts(
                    current: state.draft, existing: existing, formatter: currencyFormatter
                )
                dismissAfterMerge = dismissAfter
                mergeError = nil
                state.savePhase = .idle  // the merge sheet takes over; not a hard fail
                mergeExisting = existing  // presents the sheet
                HapticFeedback.warning()
                return false
            }
            // US-982: a true network failure queues the edit for replay instead
            // of failing the user; the change persists locally and syncs on
            // reconnect. App-level rejections (RLS, enum mismatch) still surface.
            if OfflineMutationQueue.shouldQueue(error) {
                OfflineMutationQueue.enqueueUpdate(
                    kind: .updateInventoryItem, payload: payload, targetId: item.id, in: modelContext
                )
                applyToLocalItem(state: state)
                item.hasLocalChanges = true  // not yet on the server — keep it from prune
                state.acceptDraftAsOriginal()
                modelContext.saveOrLog("save")
                state.savePhase = .idle
                HapticFeedback.warning()
                actionToast = "Saved offline — will sync when you reconnect."
                if dismissAfter { dismiss() }
                return true
            }
            HapticFeedback.error()
            state.failSaving(error.localizedDescription)
            return false
        }
    }

    /// Looks up the record that already owns `sku` for this workspace so the
    /// merge sheet can show the field-level conflicts. Tenant-scoped to the
    /// item's owner (US-268). Returns nil on a query failure — the caller then
    /// surfaces the original save error unchanged.
    private func fetchExistingSkuOwner(_ sku: String) async -> ExistingSkuItem? {
        do {
            let rows: [ExistingSkuItem] = try await SupabaseShared.client
                .from("inventory_items")
                .select(
                    "id,title,brand,size,color,material,condition_notes,status,item_category,target_price,acquired_price,location_bin"
                )
                .eq("user_id", value: item.userId)
                .eq("sku", value: sku)
                .neq("id", value: item.id)
                .limit(1)
                .execute()
                .value
            return rows.first
        } catch {
            return nil
        }
    }

    /// Confirmed duplicate-SKU merge. The RPC atomically re-points photos,
    /// listings, sales and grading history from the existing record onto this
    /// item, coalesces non-UI columns, deletes the existing record, and claims
    /// the SKU — then the user's field choices are saved through the normal
    /// update path (which now succeeds because the SKU is free).
    private func confirmMerge(existing: ExistingSkuItem, keepExisting: Set<ItemMergeField>) async {
        guard let state else { return }
        let sku = state.draft.sku.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sku.isEmpty else { return }
        isMerging = true
        mergeError = nil

        // Phase 1 — the merge RPC. It's atomic: on failure NOTHING committed, so
        // we keep the sheet open and let the user retry the Merge button.
        do {
            struct MergeParams: Encodable, Sendable {
                let p_survivor_id: String
                let p_duplicate_id: String
                let p_sku: String
            }
            try await SupabaseShared.client
                .rpc("merge_inventory_items", params: MergeParams(
                    p_survivor_id: item.id,
                    p_duplicate_id: existing.id,
                    p_sku: sku
                ))
                .execute()
        } catch {
            isMerging = false
            mergeError = error.localizedDescription
            HapticFeedback.error()
            return
        }

        // The merge has committed: the duplicate is gone and this item owns the
        // SKU. From here it's irreversible, so a field-save failure must NOT
        // re-run the RPC (it would fail — the duplicate no longer exists). Close
        // the sheet and pull to reconcile the re-pointed photos/listings/sales.
        isMerging = false
        mergeExisting = nil
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)

        // Phase 2 — persist the user's field choices. We write only the
        // user-reconciled fields and deliberately OMIT consignor_id /
        // consignment_split_pct: the RPC just coalesced those from the absorbed
        // row onto the survivor, and the normal payload would null them back out
        // when this item had none (web parity — its post-merge save doesn't
        // touch coalesced columns). The SKU is free now, so this won't 23505.
        ItemMergePlan.apply(keepExisting, from: existing, to: &state.draft, formatter: currencyFormatter)
        let (mTarget, mCost) = state.parsedPrices()
        struct MergeSurvivorUpdate: Encodable, Sendable {
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
        }
        let payload = MergeSurvivorUpdate(
            title: state.draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
            brand: state.draft.brand.nonEmpty,
            sku: state.draft.sku.nonEmpty,
            size: state.draft.size.nonEmpty,
            color: state.draft.color.nonEmpty,
            material: state.draft.material.nonEmpty,
            condition_notes: state.draft.conditionNotes.nonEmpty,
            status: state.draft.status,
            target_price: mTarget,
            acquired_price: mCost,
            item_category: state.draft.category?.rawValue,
            location_bin: state.draft.locationBin.nonEmpty
        )
        do {
            try await SupabaseShared.client
                .from("inventory_items")
                .update(payload)
                .eq("id", value: item.id)
                .execute()
            applyToLocalItem(state: state)
            state.acceptDraftAsOriginal()
            modelContext.saveOrLog("confirmMerge")
            HapticFeedback.success()
            if dismissAfterMerge { dismiss() }
        } catch {
            // The merge itself committed; only the field choices failed to save
            // (web parity). Leave the user on the canvas to review and re-save.
            HapticFeedback.error()
            actionToast = "Records merged, but saving your changes failed — review the item and save again."
        }
    }

    /// One-tap "save my edits, then publish" — saves any dirty draft (staying
    /// on the canvas) before opening the publish dialog, so the user never
    /// has to save, back out, and swipe the row to list an item.
    private func saveThenPublish() async {
        if state?.isDirty == true {
            guard await save(dismissAfter: false) else { return }
        }
        showingPublishDialog = true
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

    /// US-967: decode `measurements_json` into `[name: inches]`. Static + pure so
    /// it's unit-testable and so the section reads a memoized `@State`
    /// (`measurements`) rather than re-parsing JSON on every `body` pass.
    static func decodeMeasurements(_ json: String?) -> [String: Double]? {
        guard let data = json?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: Double].self, from: data)
    }

    /// US-967: cheap signature of the editable `inventory_items` fields the
    /// canvas mirrors — the exact set ``ItemDraft/init(from:currencyFormatter:)``
    /// reads (category is always nil there, so it's excluded). Prices fold in as
    /// raw `Double`s, avoiding the per-render `CurrencyFormatter` work the old
    /// `ItemDraft`-as-onChange-key incurred.
    static func editableSignature(_ item: LocalInventoryItem) -> Int {
        var hasher = Hasher()
        hasher.combine(item.title)
        hasher.combine(item.brand)
        hasher.combine(item.sku)
        hasher.combine(item.size)
        hasher.combine(item.color)
        hasher.combine(item.material)
        hasher.combine(item.conditionNotes)
        hasher.combine(item.status)
        hasher.combine(item.targetPrice)
        hasher.combine(item.acquiredPrice)
        hasher.combine(item.locationBin)
        hasher.combine(item.consignorId)
        hasher.combine(item.consignmentSplitPct)
        return hasher.finalize()
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
