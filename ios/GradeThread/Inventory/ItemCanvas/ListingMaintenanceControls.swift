import SwiftUI
import Observation

/// US-1973: the two single-item maintenance actions the item screen needs —
/// set the live listing's quantity (0 = out of stock) and end it. Both were
/// previously reachable only through the inventory list's bulk tools (End) or
/// not at all (quantity), which made one-item upkeep a multi-screen detour.
///
/// A protocol so the store unit-tests against a fake instead of the live
/// ``EbayPublishService`` (which needs a URLSession + a Supabase token).
@MainActor
protocol ListingMaintenanceProviding {
    func updateQuantity(listingId: String, quantity: Int) async -> ReviseOutcome
    func endListing(listingId: String) async -> PublishOutcome
}

extension EbayPublishService: ListingMaintenanceProviding {}

/// Drives the quantity + end-listing actions for ONE live listing. Holds no
/// SwiftData: each action returns its result to the view, which owns the local
/// mirror write. That keeps the decision/copy logic testable with no store.
@MainActor
@Observable
final class ListingMaintenanceStore {

    /// Internal result of one action: what to apply, or the copy to show.
    /// (A `Result<Applied, String>` won't do — `String` isn't an `Error`.)
    private enum ActionResult {
        case applied(Applied)
        case error(String)
    }

    /// What a successful action did, so the view can mirror it locally and
    /// surface the right copy.
    enum Applied: Equatable {
        case quantity(Int)
        /// `note` is set only when eBay did NOT confirm the withdraw (US-1506
        /// parity) — the listing is ended in FlipDesk but may still be live.
        case ended(note: String?)
    }

    /// Upper bound on the stepper. eBay allows far more, but the item screen is
    /// the SINGLE-item surface: a seller with real multi-quantity stock uses the
    /// bulk price/quantity tool. Keeping it small stops a fat-fingered stepper
    /// from listing hundreds of a one-off garment.
    static let maxQuantity = 99

    let listingId: String
    private let service: any ListingMaintenanceProviding

    /// The in-flight stepper value.
    var quantity: Int
    /// The quantity eBay is believed to be serving — the baseline "Update"
    /// diffs against, advanced only by a confirmed round-trip (US-1006: never
    /// re-seed an edit from a value the server hasn't acknowledged).
    private(set) var appliedQuantity: Int

    var busy = false
    var actionError: String?

    init(
        listingId: String,
        quantity: Int?,
        // Default is nil (not `EbayPublishService()`): a default argument is
        // evaluated in a nonisolated context, but `EbayPublishService.init` is
        // @MainActor-isolated — so a direct default is a hard error under strict
        // concurrency. Coalesce in this @MainActor init body instead (matches
        // DraftsLibraryStore / DraftsBulkEditStore).
        service: (any ListingMaintenanceProviding)? = nil
    ) {
        self.listingId = listingId
        // A listing synced before `quantity` was mirrored reads nil. Assume the
        // single item it almost certainly is — never 0, which would render an
        // out-of-stock badge for a listing that's live and buyable.
        let seed = quantity ?? 1
        self.quantity = seed
        self.appliedQuantity = seed
        self.service = service ?? EbayPublishService()
    }

    /// True once the stepper differs from what's live — gates the Update button
    /// so a no-op tap can't spend an eBay call.
    var quantityChanged: Bool { quantity != appliedQuantity }

    /// The live listing is published but unbuyable.
    var isOutOfStock: Bool { appliedQuantity == 0 }

    func applyQuantity() async -> Applied? {
        await run {
            switch await self.service.updateQuantity(
                listingId: self.listingId, quantity: self.quantity
            ) {
            case .revised:
                return .applied(.quantity(self.quantity))
            case .noOfferId:
                return .error(
                    "This listing has no eBay offer to update. Republish it to enable edits."
                )
            case .failed(let message):
                return .error("Couldn\u{2019}t update the quantity on eBay: \(message)")
            }
        }
    }

    /// One-tap out-of-stock: the common case (pull it, keep the listing).
    func markOutOfStock() async -> Applied? {
        quantity = 0
        return await applyQuantity()
    }

    func endListing() async -> Applied? {
        await run {
            switch await self.service.endListing(listingId: self.listingId) {
            case .ended(let response):
                // US-1506: eBay didn't confirm the withdraw — it's ended in
                // FlipDesk only. Carry a note (server's, else the same fallback
                // the bulk End uses) so the view can't report a clean success
                // for a listing buyers may still see.
                return .applied(.ended(
                    note: response.endedOnEbay
                        ? nil
                        : (response.note
                            ?? "Ended in FlipDesk; verify on eBay that it\u{2019}s no longer live.")
                ))
            case .noOfferId:
                return .error("This listing isn\u{2019}t linked to an eBay offer.")
            case .planLimit(let message):
                return .error(message)
            case .failed(let message):
                return .error("Couldn\u{2019}t end the listing: \(message)")
            case .validated, .pushed, .priceUpdated, .blockers:
                return .error("Unexpected response from server.")
            }
        }
    }

    /// Shared busy/error plumbing. A success advances the applied baseline so
    /// the Update button settles and a retry after a FAILED push still diffs
    /// against the last confirmed value rather than the typed one.
    private func run(_ op: @escaping () async -> ActionResult) async -> Applied? {
        guard !busy else { return nil }
        busy = true
        defer { busy = false }
        switch await op() {
        case .applied(let applied):
            if case .quantity(let q) = applied { appliedQuantity = q }
            HapticFeedback.success()
            return applied
        case .error(let message):
            actionError = message
            HapticFeedback.error()
            return nil
        }
    }
}

/// Quantity + End-listing controls for a GradeThread-originated live listing,
/// rendered as a Form `Section` from the item canvas.
///
/// Only ever mounted for a GT-origin listing (the caller resolves provenance):
/// an eBay-originated listing is a read-only mirror whose lifecycle and
/// quantity eBay owns, and the edge rejects both writes with a 409 anyway.
struct ListingMaintenanceControls: View {
    let listingId: String
    /// Seed for the stepper — the mirrored `listings.quantity`.
    let quantity: Int?
    /// Mirrors a confirmed change onto the local `LocalListing`/item rows so the
    /// canvas reflects it before the next sync pull.
    let onApplied: (ListingMaintenanceStore.Applied) -> Void
    /// Reuses the canvas's toast so success copy matches the revise UX.
    let onToast: (String) -> Void

    @State private var store: ListingMaintenanceStore
    @State private var confirmingEnd = false
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    init(
        listingId: String,
        quantity: Int?,
        onApplied: @escaping (ListingMaintenanceStore.Applied) -> Void,
        onToast: @escaping (String) -> Void
    ) {
        self.listingId = listingId
        self.quantity = quantity
        self.onApplied = onApplied
        self.onToast = onToast
        _store = State(initialValue: ListingMaintenanceStore(listingId: listingId, quantity: quantity))
    }

    /// US-981: quantity + end are network-only (no offline queue), so block them
    /// offline rather than failing after a round-trip.
    private var isOffline: Bool { NetworkMonitor.isOffline(networkMonitor) }

    var body: some View {
        Section {
            if isOffline {
                OfflineNotice(intent: .blocked, detail: "to change quantity or end the listing")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if store.isOutOfStock {
                Label("Out of stock \u{2014} the listing is live but nothing is buyable.", systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(Color.brandAmber)
            }
            Stepper(value: $store.quantity, in: 0...ListingMaintenanceStore.maxQuantity) {
                Text(store.quantity == 0 ? "Quantity: 0 (out of stock)" : "Quantity: \(store.quantity)")
            }
            HStack {
                Button("Update quantity") {
                    Task { await apply { await store.applyQuantity() } }
                }
                .disabled(store.busy || isOffline || !store.quantityChanged)
                if !store.isOutOfStock {
                    Spacer()
                    Button("Mark out of stock") {
                        Task { await apply { await store.markOutOfStock() } }
                    }
                    .disabled(store.busy || isOffline)
                }
            }
            Button("End listing", role: .destructive) {
                confirmingEnd = true
            }
            .disabled(store.busy || isOffline)
        } header: {
            Text("Quantity & availability")
        } footer: {
            Text("Setting the quantity to 0 pulls the item out of stock but keeps the listing \u{2014} raise it again to make it buyable. Ending removes it from eBay and returns the item to drafted, so it can be relisted later.")
                .font(.caption)
        }
        // Destructive + not one-tap reversible (a relist mints a new eBay item
        // number), so it confirms; a quantity change doesn't.
        .confirmationDialog(
            "End this listing?",
            isPresented: $confirmingEnd,
            titleVisibility: .visible
        ) {
            Button("End listing", role: .destructive) {
                Task { await apply { await store.endListing() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It'll be withdrawn from eBay and the item goes back to drafted. To pull it temporarily instead, set the quantity to 0.")
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.actionError != nil }, set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(store.actionError ?? "") }
    }

    private func apply(_ op: () async -> ListingMaintenanceStore.Applied?) async {
        guard let applied = await op() else { return }
        onApplied(applied)
        onToast(Self.successToast(for: applied))
    }

    /// Success copy per outcome. `internal` + `static` so the wording (including
    /// the "unconfirmed on eBay" hedge) is asserted without a view host.
    static func successToast(for applied: ListingMaintenanceStore.Applied) -> String {
        switch applied {
        case .quantity(0):
            return "Marked out of stock on eBay."
        case .quantity(let q):
            return "Quantity updated to \(q) on eBay."
        case .ended(let note):
            // US-1506: never claim a clean end eBay didn't confirm.
            return note ?? "Listing ended on eBay."
        }
    }
}
