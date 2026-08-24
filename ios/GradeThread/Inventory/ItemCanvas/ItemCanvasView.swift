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
    /// US-2470: the per-category photo profile, so "Add photos" fills the slots
    /// THIS item's category actually has instead of a hard-coded four.
    @Environment(PhotoProfileStore.self) private var photoProfileStore

    let item: LocalInventoryItem

    @Query private var allPhotos: [LocalItemPhoto]
    /// US-665: this item's sale(s) for the realized per-item P&L row.
    @Query private var itemSales: [LocalSale]
    /// US-748: this item's listing(s) so the canvas shows where it's listed
    /// and links out to the live listing — part of the Item↔Listing↔Sale thread.
    @Query private var itemListings: [LocalListing]
    /// The live store row(s) for this item's id — see the note in `init`.
    @Query private var itemRows: [LocalInventoryItem]
    /// Report the stale-row state at most once per appearance, so a screen left
    /// open doesn't spam telemetry.
    @State private var reportedStaleRow = false
    @State private var state: ItemCanvasState?
    /// The eBay specifics, now edited INLINE on this page rather than behind a
    /// push (see `specificsSection`). Owned here so this page's Save commits the
    /// specifics in the same action as the item's own fields — the seller should
    /// never have to reason about which of two Saves they need.
    @State private var specificsModel: SpecificsEditorModel?
    @State private var showAllOptionalSpecifics = false

    /// Unsaved work anywhere on this page — the item's own fields OR the inline
    /// eBay specifics. Both are committed by the single Save, so both must arm
    /// the discard guard; keying it on the item fields alone would let a
    /// back-swipe silently drop a category + ten aspects the seller just filled.
    private var pageIsDirty: Bool {
        state?.isDirty == true || specificsModel?.isDirty == true
    }
    /// US-967: parsed `measurements_json`, memoized so the Measurements section
    /// reads a cached value instead of re-decoding JSON on every `body` pass.
    /// Rebuilt via `.onChange(of: item.measurementsJSON)`.
    @State private var measurements: [String: Double]?
    // Draft fields for the "Add comp" row in the saved-comps editor.
    @State private var newCompPriceText = ""
    @State private var newCompSource = ""
    @State private var newCompURL = ""
    @State private var showingDiscardConfirmation = false
    // US-1575: the MeasureCard photo being edited (sheet item).
    @State private var measureEditorPhoto: LocalItemPhoto?
    /// Which of the canvas's three sheets is up. One optional driving ONE
    /// `.sheet(item:)` — a view has a single sheet slot, and three chained
    /// `.sheet(isPresented:)` modifiers compete for it (see ``ToolModule``).
    @State private var sheet: CanvasSheet?

    /// Duplicate-SKU merge resolution (web parity). A function rather than an
    /// inline case body so the `let sku` binding stays in ordinary Swift rather
    /// than inside a result builder.
    ///
    /// `state` is a PARAMETER, not the `@State` property of the same name. The
    /// property is `ItemCanvasState?`; this body used to live inside
    /// `form(state:)`, where the non-optional parameter shadows it. Lifting it
    /// out silently rebound `state` to the optional and broke the build.
    @ViewBuilder
    private func skuMergeSheet(_ existing: ExistingSkuItem, state: ItemCanvasState) -> some View {
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
                sheet = nil
                mergeError = nil
                state.savePhase = .idle
            }
        )
    }

    /// The sheets the item canvas can present.
    private enum CanvasSheet: Identifiable {
        case publish
        case photoManager
        /// US-686: reversible review of the post-intake AI auto-fill.
        case aiReview
        /// US-650/US-687: add photos straight into THIS item (not a new intake).
        case addPhotos
        /// Duplicate-SKU merge resolution (web parity).
        case skuMerge(ExistingSkuItem)
        /// The ONLY path to a sold item (web parity, US-2260). The status
        /// picker no longer offers the word.
        case recordSale

        var id: String {
            switch self {
            case .publish:                return "publish"
            case .photoManager:           return "photoManager"
            case .aiReview:               return "aiReview"
            case .addPhotos:              return "addPhotos"
            case .skuMerge(let existing): return "skuMerge-\(existing.id)"
            case .recordSale:             return "recordSale"
            }
        }
    }
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
    // US-2266: "Complete with AI" — re-run the extract on THIS item from its
    // persisted photos (web composer parity). The manager owns the run so it
    // survives this view going away; these two drive the local spinner + the
    // failure message.
    @State private var aiManager = AIExtractionManager.shared
    @State private var aiRerunMessage: String?
    // US-2818: the web composer's description card — per-garment template plus
    // the two AI rewrite passes (tighten, regenerate-from-photos).
    @State private var descriptionRewriteRunning: ListingRewriteAction?
    @State private var descriptionAiMessage: String?
    @State private var confirmingDescriptionTemplate = false
    private let descriptionRewriteService: ListingRewriting = ListingRewriteService()

    // US-650 item-level actions
    @State private var showingDeleteConfirmation = false
    // US-687: camera capture straight into this item.
    @State private var showingCameraCapture = false
    @State private var isAddingPhotos = false
    // US-1497: guards the server-side item duplicate so a slow-connection re-tap
    // can't create several copies.
    @State private var isDuplicating = false
    @State private var actionToast: String?
    // Duplicate-SKU merge: when a save trips idx_inventory_items_user_sku we
    // fetch the record that owns the SKU and offer to merge instead of
    // dead-ending on the raw Postgres error (web parity — MergeSkuDialog).
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
    /// US-1976: mirror the server `deriveListingOrigin` default. `listingOrigin`
    /// is authoritative when persisted; otherwise DEFAULT to gradethread — the
    /// server's ambiguous default — instead of guessing eBay from a missing
    /// offer id, which mislabelled a GT-origin listing (whose `listingOrigin`
    /// hadn't backfilled yet) as a locked eBay mirror. The edge revise/price/end
    /// routes carry the batch_id/synced_to_ebay_at signals iOS lacks and are the
    /// single enforcement point if a genuinely eBay-origin row slips through.
    private func isEbayOriginated(_ l: LocalListing) -> Bool {
        l.listingOrigin == "ebay"
    }

    private var gtLiveListing: LocalListing? {
        guard let l = activeEbayListing else { return nil }
        return isEbayOriginated(l) ? nil : l
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

    /// US-1973: optimistically mirror a confirmed quantity/end onto the local
    /// rows so the canvas reflects it before the next pull. `hasLocalChanges`
    /// guards each value against a racing pull that predates the server write
    /// (US-1249 policy). Ending also flips the item to `drafted` — what the
    /// server does — which the editable-signature `onChange` folds into the form
    /// (no-op while the user is mid-edit, so it can't clobber a draft).
    private func applyListingMaintenance(
        _ applied: ListingMaintenanceStore.Applied,
        to listing: LocalListing
    ) {
        switch applied {
        case .quantity(let quantity):
            listing.quantity = quantity
        case .ended:
            listing.listingStatus = "ended"
            listing.endedAt = .now
            item.status = "drafted"
            item.updatedAt = .now
            // The eBay side may still be live (US-1506, surfaced in the toast) —
            // pull so the mirror reconciles to whatever actually happened.
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
        listing.hasLocalChanges = true
        listing.updatedAt = .now
        modelContext.saveOrLog("applyListingMaintenance")
    }

    /// Fold a recorded sale into the screen the seller is still looking at.
    ///
    /// The server already holds every one of these writes -- this is the local
    /// mirror catching up, so the row does not keep saying "listed" until the
    /// next sync pull. The draft's status moves too: leaving it on the old
    /// value would make the page dirty against a status the seller never chose,
    /// and Save would then try to push it back.
    private func applyRecordedSale(
        _ outcome: SaleRecorder.Outcome, state: ItemCanvasState
    ) {
        guard outcome.recorded else { return }
        if let status = outcome.newStatus {
            item.status = status
            state.applyExternalStatus(status)
        }
        item.updatedAt = .now
        if let listing = activeEbayListing {
            let remaining = max(0, (listing.quantity ?? 1) - 1)
            if remaining > 0 {
                listing.quantity = remaining
            } else {
                listing.listingStatus = "sold"
                listing.quantity = 0
                listing.endedAt = .now
            }
            listing.updatedAt = .now
        }
        modelContext.saveOrLog("applyRecordedSale")
        // A warning here is never a failed sale -- it is one of the follow-on
        // steps (status, listing, eBay) that did not land. Say which, rather
        // than a flat "Saved." over a half-finished close-out.
        actionToast = outcome.warnings.first ?? "Sale recorded."
        // The sale row, the status and the listing were all written server-side;
        // pull so the mirror reconciles to what actually happened.
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    /// Whether publishing this item is a relist: it was previously listed (an
    /// ended draft, or a still-live listing being replaced) rather than a
    /// first-time publish.
    private var isRelist: Bool {
        activeEbayListing != nil || endedEbayListing != nil
    }

    // MARK: - Stale row recovery

    /// Why this screen can no longer trust the object it was handed, or nil when
    /// the row is still live and still the same object.
    ///
    /// Two distinct ways a background sync invalidates it:
    ///   * `removed` — the merge's prune deleted the row (it wasn't in the server
    ///     payload) and nothing replaced it.
    ///   * `replaced` — the merge deleted and re-inserted the row, so a LIVE row
    ///     exists for this id but it is a different object than the one this view
    ///     holds. Rendering the old one shows empty fields, which reads as a blank
    ///     screen rather than an error.
    private var staleRowReason: String? {
        guard let live = itemRows.first else { return "removed" }
        // Reference identity: @Model generates a class, so a re-insert is a
        // genuinely different instance even though the id matches.
        return live === item ? nil : "replaced"
    }

    /// Honest recovery instead of a silently empty form. Reopening re-reads the
    /// row from the store, which is exactly what the seller was doing by hand
    /// (back out to Inventory, tap the item again).
    private func staleRow(_ reason: String) -> some View {
        ContentUnavailableView {
            Label("This item was refreshed", systemImage: "arrow.triangle.2.circlepath")
        } description: {
            Text(reason == "removed"
                 ? "A background sync removed this item from your device. Pull to refresh your inventory and open it again."
                 : "A background sync replaced this item while it was open, so this screen is out of date. Reopen it to pick up the current version.")
        } actions: {
            Button("Back to inventory") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
        }
        .onAppear {
            // This failure produced NO telemetry before — no throw, no crash, so
            // nothing to report. Record it so the next occurrence names the sync
            // that did it instead of leaving us to reason about it from source.
            guard !reportedStaleRow else { return }
            reportedStaleRow = true
            Telemetry.breadcrumb(
                "Item canvas hit a stale SwiftData row (\(reason))",
                category: "sync"
            )
            Telemetry.event("item_canvas_stale_row", props: [
                "item_id": item.id,
                "reason": reason,
                "live_rows": itemRows.count,
            ])
        }
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
        // The row this screen is drawing, re-read from the store on every store
        // change. `item` is a strong reference to ONE SwiftData object; a sync
        // merge can delete that object (prune) or delete-and-reinsert it under a
        // fresh identity, and this view would go on rendering the dead one — every
        // field reading empty, which is the "screen goes blank after grading"
        // report. Nothing throws and nothing crashes, so there is no crash report
        // either; comparing against the live row is the only way to notice.
        self._itemRows = Query(
            filter: #Predicate<LocalInventoryItem> { $0.id == itemId }
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
            if let reason = staleRowReason {
                staleRow(reason)
            } else if let state {
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
            // US-686 follow-up: pop the post-intake AI review as a sheet (not just
            // a banner that's easy to miss) so a fresh extraction surfaces its
            // results as a dialog. Once-only via the store's transient queue, so
            // it never re-pops when the user simply reopens the item.
            if aiReviewStore.shouldAutoPresent(item.id),
               let review = aiReviewStore.review(for: item.id),
               review.hasSomethingToReview {
                aiReviewStore.markAutoPresented(item.id)
                sheet = .aiReview
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
        // Build + load the inline specifics editor once per item. Keyed on the
        // item id so opening a different item rebuilds it rather than showing
        // the previous item's category and aspects.
        .task(id: item.id) {
            let model = SpecificsEditorModel(
                itemId: item.id,
                liveListingId: gtLiveListing?.id
            )
            specificsModel = model
            await model.start()
        }
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
        .interactiveDismissDisabled(pageIsDirty)
        // US-1513: the canvas is PUSHED (ContentView/GlobalSearch/Sales), so the
        // sheet-only interactiveDismissDisabled above never fires there — the
        // system back chevron and the edge-swipe pop both bypassed the custom
        // Back button's discard confirmation. While dirty: hide the chevron (the
        // toolbar Back with its confirm remains) and block the pop gesture.
        .navigationBarBackButtonHidden(pageIsDirty)
        .background(InteractivePopGuard(blocked: pageIsDirty))
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
                if pageIsDirty {
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
                    sheet = .addPhotos
                } label: {
                    Label("Add from library", systemImage: "photo.badge.plus")
                }
                // US-2266: re-read this item with the AI. Available at every
                // status — a listing can always be improved, and the AI is the
                // fastest way to fill a specific the seller left blank.
                Button {
                    runAiComplete()
                } label: {
                    Label(aiCompleteMenuLabel, systemImage: "sparkles")
                }
                .disabled(aiRerunRunning || !canCompleteWithAi)
                Button {
                    guard !isDuplicating else { return }
                    isDuplicating = true
                    Task { await duplicateItem() }
                } label: {
                    Label("Duplicate item", systemImage: "plus.square.on.square")
                }
                .disabled(isDuplicating)
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
            // US-2818: the web composer's card order, which is the order the
            // work happens in — shoot, measure, name it, grade it, price it,
            // write the copy, then the bookkeeping. iOS led with the identity
            // form and put Photos in the middle, so the two apps disagreed
            // about what a seller does next on the same item.
            photosSection
                .id(ItemPrepChecklist.Step.photos)
            measurementsSection(state: state)
            measurePhotoRow(state: state)
                .id(ItemPrepChecklist.Step.measurements)
            identitySection(state: state)
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
            pricingSection(state: state)
            if let pnl = realizedPnL {
                pnlSection(pnl)
            }
            compsSection(state: state)
                .id(ItemPrepChecklist.Step.comps)
            compSetSection(state: state)
            notesSection(state: state)
            descriptionSection(state: state)
            storageSection(state: state)
            statusSection(state: state)
            if !itemListings.isEmpty {
                listingsSection
            }
            // US-1044/1045: Promoted Listings + Sale controls for the live eBay listing.
            if let listing = activeEbayListing {
                EbayMarketingControls(listingId: listing.id)
            }
            // US-1973: single-item quantity / out-of-stock + End listing. Only for
            // a GradeThread-originated listing — eBay owns an imported mirror's
            // quantity and lifecycle (the edge 409s both writes), and the
            // eBay-origin branch of `listingsSection` already says "edit on eBay".
            if let listing = gtLiveListing {
                ListingMaintenanceControls(
                    listingId: listing.id,
                    quantity: listing.quantity,
                    onApplied: { applyListingMaintenance($0, to: listing) },
                    onToast: { actionToast = $0 }
                )
                // The store seeds its stepper once from `quantity`; keying on the
                // listing id rebuilds it if the canvas resolves a different live
                // listing (e.g. after a relist) instead of keeping the old seed.
                .id(listing.id)
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
        .sheet(item: $sheet) { presented in
            switch presented {
            case .publish:
                PublishDialog(
                    inventoryItemId: item.id,
                    acquiredCost: item.acquiredPrice,
                    // Relist when the item was previously listed; warn when a
                    // live listing still exists (the push ends it and creates a
                    // new one).
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
            case .photoManager:
                PhotoManagerView(item: item, photos: allPhotos, liveListing: gtLiveListing)
            case .aiReview:
                AIFillReviewSheet(item: item)
            case .addPhotos:
                // selectionLimit 0 = unlimited, so users can add extra/detail
                // shots beyond the standard slots.
                PhotoLibraryPicker(selectionLimit: 0) { results in
                    Task { await ingestAddedPhotos(results) }
                }
                .ignoresSafeArea()
            case .skuMerge(let existing):
                // `state` here is `form(state:)`'s non-optional parameter.
                skuMergeSheet(existing, state: state)
            case .recordSale:
                RecordSaleSheet(
                    itemTitle: item.title,
                    itemId: item.id,
                    currentStatus: item.status,
                    // The asking price is usually the answer, so seed it. The
                    // live listing's price wins over the target when there is
                    // one -- that is what the buyer actually saw.
                    listedPrice: activeEbayListing?.listingPrice ?? item.targetPrice,
                    purchasePrice: item.acquiredPrice,
                    listing: activeEbayListing.map {
                        SaleRecorder.ListingRef(
                            id: $0.id,
                            quantity: $0.quantity,
                            hasEbayOffer: $0.platformOfferId != nil
                                || $0.platformListingId != nil
                        )
                    },
                    onRecorded: { outcome in applyRecordedSale(outcome, state: state) }
                )
            }
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
        // US-2266: the re-run's terminal phase — a failure alerts here, a success
        // opens the same reversible review the post-capture fill uses.
        .onChange(of: aiManager.phase(for: item.id)) { _, phase in
            handleAiRerunPhase(phase)
        }
        .alert(
            "Complete with AI",
            isPresented: Binding(
                get: { aiRerunMessage != nil },
                set: { if !$0 { aiRerunMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { aiRerunMessage = nil }
        } message: {
            Text(aiRerunMessage ?? "")
        }
        // US-2818: description template + AI rewrite outcomes.
        .alert(
            "AI rewrite",
            isPresented: Binding(
                get: { descriptionAiMessage != nil },
                set: { if !$0 { descriptionAiMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { descriptionAiMessage = nil }
        } message: {
            Text(descriptionAiMessage ?? "")
        }
        .alert(
            "Replace the description?",
            isPresented: $confirmingDescriptionTemplate
        ) {
            Button("Replace", role: .destructive) {
                applyDescriptionTemplate(state: state)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The template writes a fresh description from this item's attributes, measurements and grade. What's in the box now is replaced.")
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
                sheet = .addPhotos
            } else {
                sheet = .photoManager
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
                // US-1976: provenance badge + editing affordance based on
                // listing_origin, defaulting to gradethread when unset (server
                // parity) so a not-yet-backfilled GT listing isn't shown locked.
                let ebayOriginated = isEbayOriginated(active)

                if ebayOriginated {
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
                    // US-1509: no Relist for eBay-originated listings. GradeThread
                    // never published them, so it can't end the live listing first
                    // (no offer id) — relisting would leave the original live AND
                    // corrupt its local mirror with the new listing's identity.
                    // The edge rejects it too (409); hiding the button here keeps
                    // the promise in the composer copy honest.
                    Text("Relist isn\u{2019}t available for listings created on eBay. To relist, end it on eBay and use Sell Similar there.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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

                    // Relist as a NEW listing: ends the current live listing and
                    // publishes a fresh one (new eBay item #). The publish sheet
                    // warns before it does this. US-1509: GradeThread-originated
                    // only — see the eBay-originated branch above.
                    Button {
                        AppRouter.haptic()
                        // US-1514: funnel through saveThenPublish (like the primary
                        // publish CTA) so unsaved canvas edits are persisted BEFORE
                        // the publish/relist path reads server state — otherwise a
                        // dirty-draft edit is silently dropped from the relisted item.
                        Task { await saveThenPublish() }
                    } label: {
                        Label("Relist as new listing", systemImage: "arrow.triangle.2.circlepath")
                    }
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
    @ViewBuilder
    private var specificsSection: some View {
        // The specifics are now INLINE, so the US-1514 "save first" gate is gone
        // with the push it guarded: that gate existed because the pushed editor
        // read the SAVED row, so opening it mid-edit showed a stale Brand. On one
        // page there is no second read and no second Save — and the fields that
        // used to disagree (Brand/Size/Color/Material/Style) aren't duplicated
        // here at all; they're the item's own inputs above.
        if let specificsModel {
            ItemSpecificsInlineSections(
                model: specificsModel,
                showAllOptional: $showAllOptionalSpecifics
            )
        } else {
            Section {
                HStack { ProgressView(); Text("Loading eBay specifics…") }
            } header: {
                Text("eBay listing")
            }
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
        // Matches saveThenPublish, which now saves the inline specifics too.
        let dirty = pageIsDirty
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
                sheet = .aiReview
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
            // US-1522: Save greys out when the title is blank (isSavable) — say so
            // inline instead of leaving the disabled button unexplained.
            if state.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Title is required to save.")
                    .font(.caption)
                    .foregroundStyle(Color.brandRed)
            }
            // US-2839: these five inputs are rendered from the chosen eBay
            // category's spec -- a closed list becomes a picker, a list of
            // recommended values becomes a suggest field, and anything else
            // stays the plain text field it always was. The specifics section
            // below hides the matching rows (one value, one input), so before
            // this the only inputs eBay had values for were the only ones that
            // never offered them.
            ColumnAspectField(
                model: specificsModel,
                column: "brand",
                label: "Brand",
                text: $state.draft.brand
            )
            // US-2818: SKU moved to "Storage & consignment" for web parity -
            // it lives in the web composer's Storage & SKU card, next to the
            // bin and the container, because all three answer "where is this
            // thing and what is written on it", not "what is it".
            ColumnAspectField(
                model: specificsModel,
                column: "size",
                label: "Size",
                text: $state.draft.size,
                capitalization: .never
            )
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
            ColumnAspectField(
                model: specificsModel,
                column: "color",
                label: "Color",
                text: $state.draft.color,
                capitalization: .never
            )
            ColumnAspectField(
                model: specificsModel,
                column: "material",
                label: "Material",
                text: $state.draft.material,
                capitalization: .never
            )
            ColumnAspectField(
                model: specificsModel,
                column: "style",
                label: "Style",
                text: $state.draft.style
            )
            Picker("Category", selection: $state.draft.category) {
                Text("—").tag(FlipdeskCategory?.none)
                ForEach(FlipdeskCategory.allCases) { cat in
                    Text(cat.label).tag(Optional(cat))
                }
            }
            // Garment type/category are REQUIRED to grade a clothing item
            // (flipdesk-grading.ts validate). Only relevant for Clothing —
            // other categories grade on item_category alone (web parity).
            if state.draft.category == .clothing {
                Picker("Garment type", selection: $state.draft.garmentType) {
                    Text("—").tag("")
                    ForEach(GarmentClassification.types, id: \.self) { type in
                        Text(GarmentClassification.label(type)).tag(type)
                    }
                }
                Picker("Garment category", selection: $state.draft.garmentCategory) {
                    Text("—").tag("")
                    ForEach(GarmentClassification.categories, id: \.self) { cat in
                        Text(GarmentClassification.label(cat)).tag(cat)
                    }
                }
                if state.draft.garmentType.isEmpty || state.draft.garmentCategory.isEmpty {
                    Text("Garment type & category are required to submit this item for grading.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Complete with AI (US-2266)

    /// True while THIS item's extract is in flight (the manager owns the run, so
    /// this stays true even if the canvas is dismissed and reopened).
    private var aiRerunRunning: Bool {
        aiManager.isRunning(item.id)
    }

    /// A disabled menu row with no reason reads as broken. Say why instead — the
    /// AI has nothing to read until there's a photo or some text.
    private var aiCompleteMenuLabel: String {
        if aiRerunRunning { return "AI is reading…" }
        if !canCompleteWithAi { return "Complete with AI (add a photo first)" }
        return "Complete with AI"
    }

    /// The AI needs photos or text. Mirrors the web composer's `canCompleteWithAi`
    /// so the disabled state means the same thing on both platforms.
    private var canCompleteWithAi: Bool {
        !aiRerunPhotoRefs.isEmpty || aiRerunInputs.text != nil
    }

    /// This item's persisted photos as plain refs, in `sortOrder` (the @Query is
    /// sorted), so the server's photo cap keeps front/back/tag rather than
    /// whatever happened to be first.
    private var aiRerunPhotoRefs: [PersistedPhotoRef] {
        allPhotos.map {
            PersistedPhotoRef(
                photoType: $0.photoType,
                photoRole: $0.photoRole,
                storagePath: $0.storagePath,
                photoURL: $0.photoURL
            )
        }
    }

    /// What the item already holds, shaped by the SAME rules the post-capture path
    /// uses (US-2268's ``AIExtractInputs``) so the two entry points can't drift on
    /// which fields count as known or what goes into the text blob.
    ///
    /// Built from the live DRAFT rather than the server row on purpose: the seller
    /// may have typed something they haven't saved yet, and telling the AI about it
    /// is strictly better than letting it propose a competing value.
    private var aiRerunInputs: AIExtractInputs {
        guard let draft = state?.draft else { return AIExtractInputs() }
        return AIExtractInputs(
            title: draft.title,
            itemDescription: draft.itemDescription,
            conditionNotes: draft.conditionNotes,
            brand: draft.brand,
            style: draft.style,
            size: draft.size,
            color: draft.color,
            material: draft.material,
            itemCategory: draft.category?.rawValue,
            garmentType: draft.garmentType,
            garmentCategory: draft.garmentCategory
        )
    }

    /// Kicks off the re-run. The manager keeps it alive past this view, and its
    /// completion registers the same reversible ``AIFillReview`` the post-capture
    /// fill does — so the result surfaces through the existing banner/sheet
    /// instead of a second, parallel review UI.
    private func runAiComplete() {
        guard !aiRerunRunning else { return }
        guard canCompleteWithAi else {
            aiRerunMessage =
                "Add a photo or a description first — the AI reads those to fill the rest."
            return
        }
        AppRouter.haptic()
        let inputs = aiRerunInputs
        aiManager.startRerun(
            itemId: item.id,
            photos: aiRerunPhotoRefs,
            knownFields: inputs.knownFields,
            text: inputs.text,
            isOffline: NetworkMonitor.isOffline(networkMonitor)
        )
    }

    /// Surfaces the manager's terminal phase for this item: a failure becomes the
    /// alert, a success pops the review sheet. Cleared afterwards so reopening the
    /// canvas doesn't replay a stale outcome.
    private func handleAiRerunPhase(_ phase: AIExtractionManager.Phase?) {
        switch phase {
        case .failed(let message):
            aiRerunMessage = message
            aiManager.clear(for: item.id)
        case .ready:
            aiManager.clear(for: item.id)
            // finish() registered the review with autoPresent, which the onAppear
            // path above consumes when the user comes BACK to a run that finished
            // while they were away. This canvas is already on screen, so open it
            // directly and consume the queue entry so it can't double-pop.
            if let review = aiReviewStore.review(for: item.id),
               review.hasSomethingToReview {
                aiReviewStore.markAutoPresented(item.id)
                sheet = .aiReview
            } else {
                aiRerunMessage =
                    "The AI didn't find anything new to add. Try a clearer tag or front photo."
            }
        case .running, .uploading, .none:
            break
        }
    }

    /// US-1088: run Size AI for this item — fills the Size field with the best
    /// guess and surfaces the rationale/confidence (or the failure) in an alert.
    /// US-1217: the inferred gender/department is an almost-always-required eBay
    /// aspect, so it's PERSISTED onto `inventory_items.attributes` (key
    /// "department", source "ai:size") alongside the size write rather than being
    /// discarded when the transient alert dismisses.
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
            // US-1217: persist the inferred department (gender) too — it's an
            // almost-always-required eBay aspect that was previously thrown away
            // when this alert dismissed. Stored on inventory_items.attributes via
            // the same writer/provenance path as the US-826 confirm chips, so the
            // specifics editor and listing flow pick it up. Best-effort: a failure
            // here must not mask the successful size write above.
            if let department = r.gender?.trimmingCharacters(in: .whitespacesAndNewlines),
               !department.isEmpty {
                try? await AIItemFieldWriter.writeAttributes(
                    itemId: item.id,
                    results: [AIAttributeConfirm.Result(
                        key: "department",
                        value: department,
                        source: "ai:size",
                        confidence: r.confidence
                    )]
                )
            }
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
            // US-2818: web parity - the composer's "Storage & SKU" card leads
            // with the SKU, and the label says "Item #" too because that is the
            // number printed on the tag the seller is holding.
            TextField("SKU / Item #", text: $state.draft.sku)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            TextField("Location / bin", text: $state.draft.locationBin)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()

            TextField("Sourced by", text: $state.draft.sourcedBy)
                .textInputAutocapitalization(.words)

            TextField("Container", text: $state.draft.container)
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
            // US-2818: "Target price" and "Cost" sat one above the other with
            // nothing but the words to tell them apart, so two filled fields
            // read as two prices. Each now carries the web's own wording plus
            // the one-line explanation the web cards put underneath.
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                    TextField("Listing price (what buyers pay)",
                              text: $state.draft.targetPriceText)
                        .keyboardType(.decimalPad)
                }
                if let help = MoneyFieldValidation.optionalPriceHelp(
                    state.draft.targetPriceText, formatter: currencyFormatter
                ) {
                    Text(help).font(.footnote).foregroundStyle(.secondary)
                } else {
                    Text("What you're asking for this item.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                    TextField("Purchase price (what you paid)",
                              text: $state.draft.acquiredPriceText)
                        .keyboardType(.decimalPad)
                }
                if let help = MoneyFieldValidation.optionalPriceHelp(
                    state.draft.acquiredPriceText, formatter: currencyFormatter
                ) {
                    Text(help).font(.footnote).foregroundStyle(.secondary)
                } else {
                    Text("Your cost basis. Never shown to buyers - it drives profit and margin.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            profitEstimateRow(state: state)
            // Acquisition date (web parity). Optional — the toggle controls
            // whether a date is set so an unset item doesn't default to today.
            Toggle("Set acquired date", isOn: Binding(
                get: { state.draft.acquiredDate != nil },
                set: { on in
                    state.draft.acquiredDate = on ? (state.draft.acquiredDate ?? Date()) : nil
                }
            ))
            if let acquired = state.draft.acquiredDate {
                DatePicker(
                    "Acquired date",
                    selection: Binding(
                        get: { acquired },
                        set: { state.draft.acquiredDate = $0 }
                    ),
                    displayedComponents: .date
                )
            }
        }
    }

    /// What this price leaves, live, while the seller is typing it.
    ///
    /// The number existed on iOS already -- ``ListingProfit``, mirroring the web
    /// estimator -- but only inside the publish sheet, which is the last screen
    /// before going live. Pricing is a margin decision, so the margin belongs
    /// next to the price, which is where web has kept it since US-553.
    @ViewBuilder
    private func profitEstimateRow(state: ItemCanvasState) -> some View {
        let price = currencyFormatter.parse(state.draft.targetPriceText) ?? 0
        if price > 0 {
            let cost = currencyFormatter.parse(state.draft.acquiredPriceText)
            // No shipping cost: the local item mirror does not carry the
            // column web reads here (inventory_items.shipping_cost), so the
            // estimate leaves it out rather than inventing a number. It reads
            // very slightly high on an item where the seller pays the label.
            let estimate = ListingProfit.estimate(price: price, costBasis: cost)
            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Est. net profit") {
                    Text("\(currencyFormatter.formatDisplay(estimate.netCents)) · \(Int(estimate.marginPctCents(price: price).rounded()))% margin")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(profitColor(estimate))
                }
                Text(profitDetail(estimate, cost: cost))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if cost == nil {
                    // Without a cost basis the margin is revenue after fees,
                    // which is the CEILING rather than the answer. Saying so is
                    // the difference between an estimate and a flattering one.
                    Text("Enter the purchase price above to see true margin. Until then this is the ceiling, not the answer.")
                        .font(.caption)
                        .foregroundStyle(.brandAmber)
                }
            }
        }
    }

    private func profitColor(_ estimate: ListingProfit) -> Color {
        if estimate.netCents < 0 { return .brandRed }
        if estimate.marginPct < 20 { return .brandAmber }
        return .brandEmerald
    }

    private func profitDetail(_ estimate: ListingProfit, cost: Double?) -> String {
        var parts = ["eBay fees ~\(currencyFormatter.formatDisplay(estimate.feesCents))"]
        parts.append("cost \(currencyFormatter.formatDisplay(cost ?? 0))")
        return parts.joined(separator: " · ")
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
            sheet = .addPhotos
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
                    Button("Manage") { sheet = .photoManager }
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
            Text(FlipdeskPhotoType.label(for: photo.photoType, role: photo.photoRole))
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
        .accessibilityLabel("\(FlipdeskPhotoType.label(for: photo.photoType, role: photo.photoRole)) photo")
    }

    /// US-1575: entry into the photo-measurement editor — shown only when the
    /// item has a MeasureCard shot (photo_type "measurement"). The editor
    /// applies values back onto the same draft the manual rows edit; the
    /// canvas save persists them.
    @ViewBuilder
    private func measurePhotoRow(state: ItemCanvasState) -> some View {
        if let measurePhoto = allPhotos.last(where: { $0.photoType == "measurement" }) {
            Section {
                Button {
                    AppRouter.haptic()
                    measureEditorPhoto = measurePhoto
                } label: {
                    Label("Measure from photo", systemImage: "ruler")
                }
                .accessibilityHint("Opens the MeasureCard editor. Values are estimated from the photo.")
            } footer: {
                Text("Estimated from the MeasureCard photo - review before listing.")
            }
            .sheet(item: $measureEditorPhoto) { photo in
                MeasurementPhotoEditorView(
                    itemId: item.id,
                    itemCategory: item.itemCategory,
                    photo: photo,
                    values: state.draft.measurements,
                    onApply: { next in
                        state.draft.measurements = next
                    }
                )
            }
        }
    }

    private func measurementsSection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        // Existing measurements first (canonical order), then any catalog fields
        // the user can still add for this item's category.
        let presentKeys = MeasurementCatalog.ordered(state.draft.measurements.keys)
        let addableKeys = MeasurementCatalog.suggestedKeys(forCategory: item.itemCategory)
            .filter { state.draft.measurements[$0] == nil }
        return Section {
            ForEach(presentKeys, id: \.self) { key in
                measurementRow(key: key, state: state)
            }
            .onDelete { offsets in
                AppRouter.haptic()
                for index in offsets where index < presentKeys.count {
                    state.draft.measurements[presentKeys[index]] = nil
                }
            }
            if !addableKeys.isEmpty {
                Menu {
                    ForEach(addableKeys, id: \.self) { key in
                        Button(MeasurementCatalog.label(for: key)) {
                            AppRouter.haptic()
                            // Seed at 0 so an editable row appears; the user types
                            // the real value. Saved-as-is (0 reads as "unset").
                            state.draft.measurements[key] = 0
                        }
                    }
                } label: {
                    Label("Add measurement", systemImage: "plus.circle")
                }
            }
            if presentKeys.isEmpty {
                Text("No measurements yet. Tap “Add measurement” to record flat measurements, or run AI extract.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Measurements")
        } footer: {
            Text("Flat measurements (garment laid flat). Lengths in inches; swipe a row to remove it.")
                .font(.caption)
        }
    }

    /// One editable measurement row: label + decimal field + unit suffix. Binds
    /// straight to the draft so edits mark the form dirty and persist on save.
    private func measurementRow(key: String, state: ItemCanvasState) -> some View {
        @Bindable var state = state
        let kind = MeasurementCatalog.kind(for: key)
        return HStack {
            Text(MeasurementCatalog.label(for: key))
            Spacer()
            TextField(
                "0",
                text: Binding(
                    get: {
                        guard let v = state.draft.measurements[key], v > 0 else { return "" }
                        return MeasurementCatalog.editableString(v)
                    },
                    set: { newValue in
                        // US-1491: locale-aware parse so "18,5" in comma-decimal
                        // locales stores 18.5 instead of silently dropping the
                        // fraction (raw Double("18,5") → nil).
                        let cleaned = newValue.trimmingCharacters(in: .whitespaces)
                        if cleaned.isEmpty {
                            state.draft.measurements[key] = 0
                        } else if let parsed = MeasurementCatalog.parse(cleaned), parsed >= 0 {
                            state.draft.measurements[key] = parsed
                        }
                    }
                )
            )
            .keyboardType(.decimalPad)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 90)
            Text(kind.unitSuffix)
                .foregroundStyle(.secondary)
                .frame(width: 28, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(MeasurementCatalog.label(for: key)) measurement, \(kind.unitSuffix)")
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
                        // US-1186: don't fire a network retry while offline.
                        .disabled(NetworkMonitor.isOffline(networkMonitor))
                    if NetworkMonitor.isOffline(networkMonitor) {
                        OfflineNotice(intent: .blocked, detail: "to pull eBay comps")
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
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
                    // US-1186: don't fire a network retry while offline.
                    .disabled(NetworkMonitor.isOffline(networkMonitor))
                if NetworkMonitor.isOffline(networkMonitor) {
                    OfflineNotice(intent: .blocked, detail: "to pull eBay comps")
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                // US-1186: flag comps that no longer match the edited draft so
                // the displayed prices/category aren't silently stale.
                if compsStore.fetchedKey != nil,
                   compsStore.fetchedKey != CompsStore.key(
                       title: state.draft.title,
                       brand: state.draft.brand,
                       size: state.draft.size
                   ) {
                    Label("Title changed since these comps — search again for current results.", systemImage: "clock.arrow.circlepath")
                        .font(.caption2)
                        .foregroundStyle(Color.brandAmber)
                }
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

    /// Hand-curated comparable sales stored on the item (`comp_set`, web parity),
    /// distinct from the live "Get eBay comps" lookup above. Add price + optional
    /// source/URL; swipe a row to remove it.
    private func compSetSection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        return Section {
            if state.draft.compSet.isEmpty {
                Text("No saved comps yet. Add comparable sales you want to keep with this item.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                // US-2090 AC2: editable in place. These were read-only Text rows
                // with only `.onDelete`, so fixing a typo in a saved comp meant
                // deleting it and retyping all three fields - and the delete is
                // the destructive half, so the cheapest correction was also the
                // one that loses data if the re-add is interrupted.
                //
                // Binding straight into `state.draft.compSet` is what makes the
                // existing save path pick these up: the canvas already diffs the
                // draft against `original`, so an edited comp marks the item
                // dirty exactly like any other field. No new persistence.
                ForEach($state.draft.compSet) { $comp in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                            TextField(
                                "Price",
                                text: compPriceBinding(for: $comp)
                            )
                            .keyboardType(.decimalPad)
                            .font(.subheadline.weight(.semibold))
                        }
                        TextField("Source (e.g. eBay sold)", text: optionalText($comp.source))
                            .font(.caption)
                            .textInputAutocapitalization(.words)
                        TextField("URL (optional)", text: optionalText($comp.url))
                            .font(.caption2)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                }
                .onDelete { offsets in
                    AppRouter.haptic()
                    state.draft.compSet.remove(atOffsets: offsets)
                }
            }
            VStack(spacing: 8) {
                HStack {
                    Text(currencyFormatter.symbol).foregroundStyle(.secondary)
                    TextField("Price", text: $newCompPriceText)
                        .keyboardType(.decimalPad)
                }
                TextField("Source (e.g. eBay sold)", text: $newCompSource)
                    .textInputAutocapitalization(.words)
                TextField("URL (optional)", text: $newCompURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                Button {
                    addComp(state: state)
                } label: {
                    Label("Add comp", systemImage: "plus.circle")
                }
                .disabled((currencyFormatter.parse(newCompPriceText) ?? 0) <= 0)
            }
        } header: {
            Text("Saved comps")
        } footer: {
            Text("Comparable sales kept with this item — separate from the live eBay comp lookup above.")
                .font(.caption)
        }
    }

    /// US-2090 AC2: a `Binding<String>` over an optional field, so a TextField
    /// can edit it directly.
    ///
    /// Writes back `nil` for an all-whitespace entry rather than `""`. The wire
    /// shape treats absent and empty differently - `ItemComp.source` is
    /// `String?` and the encoder omits nil - so storing `""` would round-trip a
    /// present-but-empty field where there had been none.
    private func optionalText(_ source: Binding<String?>) -> Binding<String> {
        Binding(
            get: { source.wrappedValue ?? "" },
            set: { source.wrappedValue = $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        )
    }

    /// US-2090 AC2: a `Binding<String>` over a comp's price.
    ///
    /// REFUSES an unparseable entry instead of writing zero, and that is the
    /// point rather than politeness. The field is edited by keystroke, so a
    /// seller clearing it to retype passes through "" and "1" on the way - and
    /// coercing those to 0 would silently rewrite a real comp price to nothing,
    /// which is the same data loss the delete-and-re-add flow had. An
    /// unparseable value simply leaves the stored price alone; the text the
    /// seller sees is whatever they typed, and it resolves on the next valid
    /// keystroke.
    private func compPriceBinding(for comp: Binding<ItemComp>) -> Binding<String> {
        Binding(
            get: { currencyFormatter.formatRaw(comp.wrappedValue.price) },
            set: {
                if let parsed = currencyFormatter.parse($0), parsed > 0 {
                    comp.wrappedValue.price = parsed
                }
            }
        )
    }

    private func addComp(state: ItemCanvasState) {
        guard let price = currencyFormatter.parse(newCompPriceText), price > 0 else { return }
        AppRouter.haptic()
        state.draft.compSet.append(ItemComp(
            price: price,
            source: newCompSource.nonEmpty,
            url: newCompURL.nonEmpty
        ))
        newCompPriceText = ""
        newCompSource = ""
        newCompURL = ""
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
        return Section {
            TextField("Condition notes…", text: $state.draft.conditionNotes, axis: .vertical)
                .lineLimit(3...6)
        } header: {
            Text("Notes")
        }
    }

    /// Buyer-facing listing description (`inventory_items.description`) — the copy
    /// pushed to marketplaces, distinct from the internal condition notes above.
    private func descriptionSection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        let group = ListingDescriptionTemplate.group(for: descriptionFacts(state: state))
        return Section {
            TextField("Listing description…", text: $state.draft.itemDescription, axis: .vertical)
                .lineLimit(6...18)

            // US-2818: the web composer's description card, ported. iOS could
            // only ever get a description out of the publish dialog's one-shot
            // AI call, which is why the copy read thinner than the web's: the
            // structured per-garment template, the tighten pass and the
            // regenerate-from-photos pass all existed only on the web.
            Button {
                AppRouter.haptic()
                requestDescriptionTemplate(state: state)
            } label: {
                Label("Apply \(group.rawValue) template", systemImage: "wand.and.stars")
            }
            .disabled(descriptionRewriteRunning != nil)

            Menu {
                Button {
                    AppRouter.haptic()
                    Task { await runDescriptionRewrite(.descriptionTighten, state: state) }
                } label: {
                    Label(ListingRewriteAction.descriptionTighten.label,
                          systemImage: "textformat")
                }
                .disabled(state.draft.itemDescription
                    .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button {
                    AppRouter.haptic()
                    Task { await runDescriptionRewrite(.descriptionRegen, state: state) }
                } label: {
                    Label(ListingRewriteAction.descriptionRegen.label,
                          systemImage: "photo.on.rectangle.angled")
                }
                .disabled(allPhotos.isEmpty)
            } label: {
                HStack(spacing: 6) {
                    if descriptionRewriteRunning != nil {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "sparkles")
                    }
                    Text(descriptionRewriteRunning == nil
                        ? "AI rewrite"
                        : "Rewriting…")
                }
            }
            .disabled(descriptionRewriteRunning != nil)
        } header: {
            Text("Listing description")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text("Shown to buyers on the marketplace listing.")
                if allPhotos.isEmpty {
                    Text("Add a photo to unlock \u{201C}Regenerate from photos\u{201D}.")
                }
            }
            .font(.caption)
        }
    }

    /// The item facts a description template interpolates. Reads the LIVE draft
    /// rather than the persisted row, so a brand the seller just typed is in the
    /// description they generate a second later.
    private func descriptionFacts(state: ItemCanvasState) -> ListingDescriptionTemplate.Facts {
        ListingDescriptionTemplate.Facts(
            brand: state.draft.brand,
            title: state.draft.title,
            size: state.draft.size,
            color: state.draft.color,
            material: state.draft.material,
            conditionNotes: state.draft.conditionNotes,
            gradeLabel: item.gradeLabel ?? "",
            gradeValue: item.gradeValue,
            measurements: state.draft.measurements,
            garmentDescriptor: descriptionGarmentDescriptor(state: state)
        )
    }

    private func descriptionGarmentDescriptor(state: ItemCanvasState) -> String {
        ListingDescriptionTemplate.garmentDescriptor(
            garmentCategory: state.draft.garmentCategory,
            garmentType: state.draft.garmentType,
            itemCategory: state.draft.category?.rawValue,
            style: state.draft.style,
            title: state.draft.title
        )
    }

    /// Applying the template REPLACES what is in the box, and there is no undo
    /// on a phone - so confirm first when there is something to lose. Mirrors
    /// the publish dialog's own template guard (US-1264).
    private func requestDescriptionTemplate(state: ItemCanvasState) {
        if state.draft.itemDescription
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            applyDescriptionTemplate(state: state)
        } else {
            confirmingDescriptionTemplate = true
        }
    }

    private func applyDescriptionTemplate(state: ItemCanvasState) {
        let facts = descriptionFacts(state: state)
        // The server-appended "Verified Seller" block survives the replacement:
        // it is HTML the template knows nothing about, and losing it silently
        // downgrades the listing the seller is about to publish.
        state.draft.itemDescription = ListingDescriptionTemplate.ensureSellerCredentials(
            ListingDescriptionTemplate.build(facts: facts),
            original: state.draft.itemDescription
        )
        HapticFeedback.success()
        actionToast = "Applied the \(ListingDescriptionTemplate.group(for: facts).rawValue) template."
    }

    /// One AI rewrite pass over the description. The result is applied straight
    /// to the draft (the seller still has to Save), with the grade line and the
    /// credentials block re-asserted - a regenerate writes fresh copy that drops
    /// both, and publish would then re-add a grade the preview never showed.
    private func runDescriptionRewrite(
        _ action: ListingRewriteAction,
        state: ItemCanvasState
    ) async {
        guard descriptionRewriteRunning == nil else { return }
        descriptionRewriteRunning = action
        defer { descriptionRewriteRunning = nil }
        do {
            let result = try await descriptionRewriteService.rewrite(
                itemId: item.id,
                action: action,
                title: state.draft.title,
                description: state.draft.itemDescription
            )
            let withGrade = ListingDescriptionTemplate.ensureGradeLine(
                result.value, gradeValue: item.gradeValue
            )
            state.draft.itemDescription = ListingDescriptionTemplate.ensureSellerCredentials(
                withGrade, original: state.draft.itemDescription
            )
            HapticFeedback.success()
            actionToast = "AI rewrote the description. Save to keep it."
        } catch {
            HapticFeedback.error()
            descriptionAiMessage = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }

    private func statusSection(state: ItemCanvasState) -> some View {
        @Bindable var state = state
        return Section {
            // US-2260 parity: sold / shipped / completed / returned are NOT
            // offered here. Picking one wrote the status with no sale behind
            // it, so sold totals, profit and reconciliation each disagreed
            // with inventory and nothing surfaced the gap. Recording the sale
            // is what makes an item sold. The item's CURRENT status stays in
            // the list either way, or an already-sold item's picker would
            // render showing something it is not.
            Picker("Status", selection: $state.draft.status) {
                ForEach(
                    SaleOwnedStatus.selectable(
                        from: InventoryStage.allKnownStatuses,
                        current: item.status
                    ),
                    id: \.self
                ) { status in
                    Text(status.capitalized).tag(status)
                }
            }
            if !SaleOwnedStatus.owns(item.status) {
                Button {
                    AppRouter.haptic()
                    sheet = .recordSale
                } label: {
                    Label("Record the sale", systemImage: "dollarsign.circle")
                }
                .accessibilityHint("Captures the price and fees, then marks the item sold.")
            }
        } header: {
            Text("Status")
        } footer: {
            if !state.canTransition(to: state.draft.status) {
                Text("This item is already in a terminal state. Reverting to a pre-sale status isn't allowed from here.")
                    .font(.footnote)
                    .foregroundStyle(.brandAmber)
            } else if !SaleOwnedStatus.owns(item.status) {
                Text("Sold this item? Record the sale instead of picking a status — that captures the price and fees, closes the listing, and sets the status.")
                    .font(.footnote)
            }
        }
    }

    // MARK: - Item-level actions (US-650)

    /// This item's resolved photo profile.
    private var photoProfile: PhotoProfile {
        photoProfileStore.profile(
            for: item.itemCategory,
            garment: item.garmentCategory ?? item.garmentType
        )
    }

    /// Photo slots this item doesn't have yet — the targets the "Add photos"
    /// action fills: the profile's default slots, then unused defects, then the
    /// profile's remaining DETAIL roles.
    ///
    /// US-2470 AC4: the tail used to be `detail_2`, `detail_3`, `detail_4`,
    /// which are RETIRED types. They stay legal forever (Postgres cannot drop
    /// an enum value and historical rows point at them) but a new capture must
    /// never write one, and this path was still writing three of them. The
    /// replacement is the profile's own detail roles — fabric, hardware, hem —
    /// which say what the photo shows instead of counting it.
    private var unfilledStandardSlots: [CaptureSlot] {
        let profile = photoProfile
        let present = Set(allPhotos.map { PhotoProfile.slotKey($0.photoType, $0.photoRole) })
        func isPresent(_ slot: CaptureSlot) -> Bool {
            present.contains(PhotoProfile.slotKey(slot.serverPhotoType, slot.role))
        }

        var slots = profile.defaultCaptureSlots.filter { !isPresent($0) }

        let defectCount = allPhotos.filter { $0.photoType == "defect" }.count
        let defectSlots = profile.defectCaptureSlots
        if defectCount < defectSlots.count {
            slots.append(contentsOf: defectSlots[defectCount...])
        }

        slots += profile.optionalCaptureSlots.filter {
            $0.serverPhotoType == "detail" && !isPresent($0)
        }
        return slots
    }

    /// US-687: the slot a newly-added photo at `offset` should fill — unfilled
    /// standard slots first, then extra `.detail` shots once the standard set
    /// is full (so users aren't capped at the standard slot count).
    private func slotForAddedPhoto(offset: Int) -> CaptureSlot {
        let slots = unfilledStandardSlots
        return offset < slots.count ? slots[offset] : CaptureSlot.detail
    }

    /// Compresses picked photos and uploads them into THIS item. Fills unfilled
    /// standard slots first, then adds extras as detail photos (US-687).
    private func ingestAddedPhotos(_ results: [PHPickerResult]) async {
        guard let uploadService, !results.isEmpty else { return }
        isAddingPhotos = true
        defer { isAddingPhotos = false }
        var pairs: [(slot: CaptureSlot, capture: PhotoCapture)] = []
        var accepted = 0
        for result in results {
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(image) else { continue }
            let capture = PhotoCapture(
                imageData: output.imageData,
                thumbnail: output.thumbnail,
                capturedAt: result.creationDate() ?? .now,
                source: .library,
                // US-1547: provenance filename → item_photos.original_filename.
                sourceName: result.itemProvider.suggestedName
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
        // US-1497: clear the in-flight guard set synchronously by the button when
        // the duplicate finishes (success or failure), re-enabling the control.
        defer { isDuplicating = false }
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
        let ebayPlan: (
            listingId: String, title: String?, description: String?,
            price: Double?, resync: Bool, conditionNotesChanged: Bool
        )? = {
            guard let live = gtLiveListing else { return nil }
            let o = state.original
            let d = state.draft
            let titleChanged = d.title != o.title
            // US-1501: a description edit must round-trip too. Previously
            // `itemDescription` wasn't in the trigger AND revise always sent
            // description:nil, so the server kept preferring the publish-time
            // snapshot `listing_description` — a canvas description edit on a
            // live-listed item toasted "Saved." and never reached eBay (even a
            // relist re-seeded the OLD text). Passing it to revise writes it back
            // to listing_description.
            let descriptionChanged = d.itemDescription != o.itemDescription
            // US-1501: track a condition-note change so we can mirror it onto the
            // listing's ebay_condition_description BEFORE revise — the server reads
            // `listing.ebay_condition_description ?? item.condition_notes`, so a
            // composer-set note otherwise silently shadowed the canvas edit while
            // the UI still claimed "updated on eBay".
            let conditionNotesChanged = d.conditionNotes != o.conditionNotes
            // Any column that feeds an eBay item specific (rebuilt on the revise
            // re-PUT via forceColumnAspects) must trigger the round-trip — not
            // just brand/size. Color/material/style edits otherwise saved locally
            // only and left the live listing's specifics stale. US-1503:
            // measurements feed measurement item specifics + the description
            // block, so a measurement edit after listing must round-trip too
            // (compare only meaningful >0 values so an empty new row doesn't fire).
            let measChanged =
                d.measurements.filter { $0.value > 0 }
                    != o.measurements.filter { $0.value > 0 }
            let structuralChanged =
                d.brand != o.brand || d.size != o.size
                    || d.color != o.color || d.material != o.material
                    || d.style != o.style
                    || d.category != o.category
                    || d.conditionNotes != o.conditionNotes
                    || measChanged
            // US-1491: parse with the SAME locale-aware formatter the DB payload
            // uses (parsedPrices → currencyFormatter.parse). A raw
            // Double(stripCommas) reads "24,99" as 2499.0 in comma-decimal
            // locales and pushes a 100× price to the live eBay offer.
            let newPrice = currencyFormatter.parse(d.targetPriceText)
            let oldPrice = currencyFormatter.parse(o.targetPriceText)
            let priceChanged = newPrice != nil && newPrice! > 0
                && newPrice != oldPrice
            guard titleChanged || structuralChanged || priceChanged
                    || descriptionChanged else {
                return nil
            }
            return (
                listingId: live.id,
                title: titleChanged
                    ? d.title.trimmingCharacters(in: .whitespacesAndNewlines)
                    : nil,
                // US-1501: send the edited description so the server writes it back
                // to listing_description (nil = "no change", leaving it as published).
                description: descriptionChanged
                    ? d.itemDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                    : nil,
                price: priceChanged ? newPrice : nil,
                // Force the structured re-PUT when a specific/measurement-feeding
                // field changed (US-1503) so the live listing's specifics +
                // measurement block + description regenerate server-side.
                resync: structuralChanged,
                conditionNotesChanged: conditionNotesChanged
            )
        }()

        // Keep the eBay item specifics in sync with the item's own fields: when
        // an aspect-feeding field changes, the "Auto"-derived specifics (Brand/
        // Size/Color/Material…) are re-derived after the save so the seller
        // doesn't have to re-enter them in "Category & eBay specifics". Captured
        // against the original BEFORE the draft becomes the new baseline.
        let aspectsNeedSync: Bool = {
            let o = state.original
            let d = state.draft
            return d.brand != o.brand || d.size != o.size
                || d.color != o.color || d.material != o.material
                // US-1501: style feeds the Style/Type item specifics, so a style
                // edit must re-derive them too (was omitted → stale ebay_aspects).
                || d.style != o.style
                || d.category != o.category
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
            // Commit the INLINE eBay specifics in the SAME save, before the eBay
            // push reads them — one page, one Save. Ordered after the item write
            // so the specifics land on top of the just-saved columns, and before
            // the re-derive below so column authority is applied last.
            // Best-effort: the item itself is already saved, and the model
            // surfaces its own error, so a specifics failure never fails the item
            // save the seller just asked for.
            if let specificsModel, specificsModel.isDirty, specificsModel.canSave {
                _ = await specificsModel.save()
            }
            // Push to the live GradeThread listing. A failed eBay push never
            // blocks the local save — surface the reason and keep the user here.
            var syncFailed = false
            if let plan = ebayPlan {
                // US-1501: when the condition note changed, mirror it onto the
                // listing's canonical `ebay_condition_description` BEFORE the revise
                // — the server reads that column first, so a composer-set note would
                // otherwise shadow the canvas edit and the revise would silently push
                // the stale note while the toast claimed success. Clearing the note
                // writes null (explicit) so it falls back to the (also-cleared) item
                // column rather than republishing the old note.
                if plan.conditionNotesChanged,
                   !(await mirrorConditionNote(
                        listingId: plan.listingId, note: state.draft.conditionNotes.nonEmpty)) {
                    ebaySyncError =
                        "Saved on your device, but couldn't update the eBay condition note."
                    syncFailed = true
                }
                let outcome = await EbayPublishService().revise(
                    listingId: plan.listingId,
                    title: plan.title,
                    description: plan.description,
                    price: plan.price,
                    syncPhotos: true,
                    resyncFields: plan.resync
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
            // Best-effort, fire-and-forget: re-derive the item-owned eBay
            // specifics from the just-saved fields. Reads/writes the server row
            // directly (which now has our values), so it never blocks the save
            // and a failure leaves the existing specifics untouched.
            if aspectsNeedSync {
                let syncId = item.id
                Task { await InventoryAspectSync.reassertDerivedAspects(itemId: syncId) }
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
            // error (web parity — see the composer's saveDraft(), src/pages/flipdesk/
            // composer.tsx, and the payload builders in src/lib/composer-save.ts).
            let sku = state.draft.sku.trimmingCharacters(in: .whitespacesAndNewlines)
            if ItemMergePlan.isDuplicateSkuError(error), !sku.isEmpty,
               let existing = await fetchExistingSkuOwner(sku) {
                mergeConflicts = ItemMergePlan.conflicts(
                    current: state.draft, existing: existing, formatter: currencyFormatter
                )
                dismissAfterMerge = dismissAfter
                mergeError = nil
                state.savePhase = .idle  // the merge sheet takes over; not a hard fail
                sheet = .skuMerge(existing)  // presents the sheet
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
                // US-1508: the online path also revises the live eBay listing, but
                // that revise only ran in the success branch — an offline Save & Sync
                // dropped it silently (only price drift later hinted). Queue it too
                // (targetId = item.id so FIFO + the same-target hold replay it AFTER
                // the item update lands), so the reconnect flush re-pushes it.
                if let plan = ebayPlan {
                    let revise = OfflineRevisePayload(
                        listingId: plan.listingId,
                        title: plan.title,
                        description: plan.description,
                        price: plan.price,
                        resyncFields: plan.resync,
                        conditionNoteChanged: plan.conditionNotesChanged,
                        conditionNote: plan.conditionNotesChanged
                            ? state.draft.conditionNotes.nonEmpty : nil
                    )
                    OfflineMutationQueue.enqueueUpdate(
                        kind: .reviseListing, payload: revise, targetId: item.id, in: modelContext
                    )
                }
                applyToLocalItem(state: state)
                item.hasLocalChanges = true  // not yet on the server — keep it from prune
                state.acceptDraftAsOriginal()
                modelContext.saveOrLog("save")
                state.savePhase = .idle
                HapticFeedback.warning()
                // Truthful copy: only promise the eBay update when we actually
                // queued a re-push for it (US-1508 AC3).
                actionToast = ebayPlan != nil
                    ? "Saved offline — your device and the eBay listing will sync when you reconnect."
                    : "Saved offline — will sync when you reconnect."
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
        sheet = nil
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
        // Unsaved SPECIFICS block publishing just as hard as unsaved fields —
        // eBay validates against the saved row, so publishing with a dirty
        // inline editor would push the pre-edit aspects.
        if pageIsDirty {
            guard await save(dismissAfter: false) else { return }
        }
        sheet = .publish
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
        let garment_type: String?
        let garment_category: String?
        let description: String?
        let style: String?
        let sourced_by: String?
        let acquired_date: String?
        let container: String?
        let comp_set: [ItemComp]
        let location_bin: String?
        let consignor_id: String?
        let consignment_split_pct: Double?
        // Flat garment measurements (jsonb), keyed by canonical key. Zero/blank
        // entries are dropped so an untouched "Add" row never persists a 0.
        let measurements: [String: Double]
    }

    /// US-1501: writes the live listing's canonical `ebay_condition_description`
    /// so a canvas condition-note edit isn't shadowed by the composer's publish-time
    /// snapshot on the revise (the server reads that column first). Passing nil
    /// CLEARS it (explicit null, not an omitted key) so clearing the note on the
    /// canvas falls back to the item column instead of republishing the old note.
    /// Returns false on failure so the caller surfaces a truthful sync error rather
    /// than a false "updated on eBay" toast. RLS scopes the update to the owner.
    private func mirrorConditionNote(listingId: String, note: String?) async -> Bool {
        struct Patch: Encodable {
            let ebay_condition_description: String?
            enum CodingKeys: String, CodingKey { case ebay_condition_description }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                // `encode` (not `encodeIfPresent`) so a nil writes an explicit null.
                try c.encode(ebay_condition_description, forKey: .ebay_condition_description)
            }
        }
        do {
            try await SupabaseShared.client
                .from("listings")
                .update(Patch(ebay_condition_description: note))
                .eq("id", value: listingId)
                .execute()
            return true
        } catch {
            return false
        }
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
            garment_type: Self.garmentValue(state.draft.garmentType, state: state),
            garment_category: Self.garmentValue(state.draft.garmentCategory, state: state),
            description: state.draft.itemDescription.nonEmpty,
            style: state.draft.style.nonEmpty,
            sourced_by: state.draft.sourcedBy.nonEmpty,
            acquired_date: Self.acquiredDateString(state.draft.acquiredDate),
            container: state.draft.container.nonEmpty,
            comp_set: state.draft.compSet,
            location_bin: state.draft.locationBin.nonEmpty,
            consignor_id: state.draft.consignorId,
            consignment_split_pct: Self.parseSplit(state),
            measurements: Self.cleanedMeasurements(state)
        )
    }

    /// Drop zero/non-positive measurement entries — a 0 means "added but not yet
    /// filled" and should never be persisted. Pure.
    static func cleanedMeasurements(_ state: ItemCanvasState) -> [String: Double] {
        state.draft.measurements.filter { $0.value > 0 }
    }

    /// Garment type/category only persist for clothing — and only when set.
    /// Returns nil otherwise so a non-clothing item never carries a stray value
    /// (and switching away from Clothing clears them on the next save).
    private static func garmentValue(_ raw: String, state: ItemCanvasState) -> String? {
        guard state.draft.category == .clothing else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// `acquired_date` is a calendar date — serialize to "yyyy-MM-dd" at UTC so
    /// it round-trips the timestamptz/date column without timezone drift.
    private static let acquiredDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func acquiredDateString(_ date: Date?) -> String? {
        date.map { acquiredDateFormatter.string(from: $0) }
    }

    /// Parses the per-item split override. Only meaningful when a consignor is
    /// set; cleared (nil) otherwise so an unlinked item carries no stray split.
    private static func parseSplit(_ state: ItemCanvasState) -> Double? {
        guard state.draft.consignorId != nil else { return nil }
        // US-1491: locale-aware parse so a comma-decimal split (e.g. "12,5") isn't
        // dropped to nil. Static context → a fresh formatter (locale-derived).
        guard let value = CurrencyFormatter().parse(state.draft.consignmentSplitText) else { return nil }
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
        item.itemCategory = state.draft.category?.rawValue
        item.garmentType = Self.garmentValue(state.draft.garmentType, state: state)
        item.garmentCategory = Self.garmentValue(state.draft.garmentCategory, state: state)
        item.itemDescription = state.draft.itemDescription.nonEmpty
        item.style = state.draft.style.nonEmpty
        item.sourcedBy = state.draft.sourcedBy.nonEmpty
        item.acquiredDate = state.draft.acquiredDate
        item.container = state.draft.container.nonEmpty
        item.compSetJSON = ItemComp.encodeList(state.draft.compSet)
        item.locationBin = state.draft.locationBin.nonEmpty
        item.consignorId = state.draft.consignorId
        item.consignmentSplitPct = Self.parseSplit(state)
        // Mirror measurements into the local cache so the section + checklist
        // reflect the edit immediately, not just after the next sync pull.
        let cleaned = Self.cleanedMeasurements(state)
        item.measurementsJSON = cleaned.isEmpty
            ? nil
            : (try? JSONSerialization.data(withJSONObject: cleaned))
                .flatMap { String(data: $0, encoding: .utf8) }
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
        hasher.combine(item.itemCategory)
        hasher.combine(item.garmentType)
        hasher.combine(item.garmentCategory)
        hasher.combine(item.itemDescription)
        hasher.combine(item.style)
        hasher.combine(item.sourcedBy)
        hasher.combine(item.acquiredDate)
        hasher.combine(item.container)
        hasher.combine(item.compSetJSON)
        hasher.combine(item.status)
        hasher.combine(item.targetPrice)
        hasher.combine(item.acquiredPrice)
        hasher.combine(item.locationBin)
        hasher.combine(item.consignorId)
        hasher.combine(item.consignmentSplitPct)
        // Measurements are draft-mirrored now, so a server-side change should
        // re-seed the canvas (when not dirty) just like the other fields.
        hasher.combine(item.measurementsJSON)
        return hasher.finalize()
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
