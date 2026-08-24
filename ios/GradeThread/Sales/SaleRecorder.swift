import Foundation

/// Records a sale: the `sales` row, the item's status, and closing out whatever
/// the item was listed on.
///
/// Until now iOS could only READ sales (``SalesStore``), while the item page's
/// status picker offered "Sold" as a word to choose. Picking it wrote
/// `inventory_items.status` with no sale behind it, so sold totals, profit and
/// reconciliation each disagreed with inventory and nothing surfaced the gap.
/// Web has refused that pick since US-2260 and routes through this flow
/// instead. US-2840 is the iOS half.
///
/// Order matters and is the same as web's. The sale row goes in FIRST, because
/// it is the record that must exist; everything after it is best effort and
/// reports rather than fails. A sale that is recorded but whose listing did not
/// close is a listing to end by hand. A sale that failed to record because the
/// listing would not close is money missing from the books.
@MainActor
struct SaleRecorder {

    /// What happened, so the caller can tell the seller the whole truth rather
    /// than just "saved".
    struct Outcome {
        /// The sale is on the books. False only when the insert itself failed.
        let recorded: Bool
        /// Non-fatal problems after the sale was recorded, in the order they
        /// happened. Shown to the seller; none of them undoes the sale.
        let warnings: [String]
        /// Status the item ended on, so the caller can update its local copy
        /// without a round trip.
        let newStatus: String?
        let errorMessage: String?

        static func failed(_ message: String) -> Outcome {
            Outcome(recorded: false, warnings: [], newStatus: nil, errorMessage: message)
        }
    }

    /// The listing to close out, read off the item's local mirror.
    struct ListingRef {
        let id: String
        let quantity: Int?
        let hasEbayOffer: Bool
    }

    var publishService: EbayPublishService = EbayPublishService()

    /// Insert the sale, advance the item, close the listing.
    ///
    /// `netProfit` is passed in rather than recomputed so the number stored is
    /// the number the seller saw while typing.
    func record(
        itemId: String,
        currentStatus: String,
        listing: ListingRef?,
        values: SaleValues,
        netProfit: Double
    ) async -> Outcome {
        do {
            try await insertSale(itemId: itemId, listing: listing, values: values, net: netProfit)
        } catch {
            return .failed(error.localizedDescription)
        }

        var warnings: [String] = []
        var newStatus: String?

        // Forward-only, same rule as the web `advanceItemStatus`: an item
        // already past "sold" (shipped, completed) must not be dragged back.
        if ItemWorkflow.rank(currentStatus) < ItemWorkflow.rank("sold") {
            do {
                try await advanceToSold(itemId: itemId)
                newStatus = "sold"
            } catch {
                warnings.append(
                    "Sale recorded, but the item's status didn't change: \(error.localizedDescription)"
                )
            }
        }

        if let listing {
            warnings.append(contentsOf: await closeOut(listing))
        }

        return Outcome(
            recorded: true, warnings: warnings, newStatus: newStatus, errorMessage: nil
        )
    }

    // MARK: - Steps

    private func insertSale(
        itemId: String, listing: ListingRef?, values: SaleValues, net: Double
    ) async throws {
        // `user_id` is deliberately absent: the set_sales_tenant trigger fills it
        // from the item's owner, and sending our own would be a second source of
        // truth for who owns the row.
        struct Insert: Encodable {
            let inventory_item_id: String
            let listing_id: String?
            let sale_price: Double
            let shipping_collected: Double
            let platform_fees: Double
            let payment_processing_fees: Double
            let shipping_cost: Double
            let tax: Double
            let other_costs: Double
            let net_profit: Double
            let buyer_username: String?
            let sale_date: String
            let sold_at: String
        }
        let day = Self.dayFormatter.string(from: values.saleDate)
        try await SupabaseShared.client
            .from("sales")
            .insert(Insert(
                inventory_item_id: itemId,
                listing_id: listing?.id,
                sale_price: values.salePrice,
                shipping_collected: values.shippingCollected,
                platform_fees: values.platformFees,
                payment_processing_fees: values.paymentProcessingFees,
                shipping_cost: values.shippingCost,
                tax: values.tax,
                other_costs: values.otherCosts,
                net_profit: net,
                buyer_username: values.buyerUsername,
                sale_date: day,
                sold_at: day
            ))
            .execute()
    }

    private func advanceToSold(itemId: String) async throws {
        struct Patch: Encodable { let status: String }
        try await SupabaseShared.client
            .from("inventory_items")
            .update(Patch(status: "sold"))
            .eq("id", value: itemId)
            .execute()
    }

    /// A sold item must not stay buyable.
    ///
    /// A multi-quantity listing only ENDS when the last unit goes; before that
    /// the remaining count drops and it stays active. Getting this backwards
    /// either oversells the item or pulls a listing that still had stock.
    private func closeOut(_ listing: ListingRef) async -> [String] {
        let remaining = max(0, (listing.quantity ?? 1) - 1)
        do {
            if remaining > 0 {
                struct Patch: Encodable { let quantity: Int }
                try await SupabaseShared.client
                    .from("listings")
                    .update(Patch(quantity: remaining))
                    .eq("id", value: listing.id)
                    .execute()
                return []
            }
            struct Patch: Encodable {
                let listing_status: String
                let is_active: Bool
                let quantity: Int
            }
            try await SupabaseShared.client
                .from("listings")
                .update(Patch(listing_status: "sold", is_active: false, quantity: 0))
                .eq("id", value: listing.id)
                .execute()
        } catch {
            return [
                "Sale recorded, but updating the listing failed: \(error.localizedDescription)"
            ]
        }

        guard listing.hasEbayOffer else { return [] }
        // Ending on eBay is the one step that can fail for reasons outside this
        // app entirely -- eBay may have ended it already. Say so and let the
        // seller finish it there; never undo a recorded sale over it.
        switch await publishService.endListing(listingId: listing.id) {
        case .ended, .noOfferId:
            // .noOfferId is a 409: the server has no eBay offer to end, so
            // there is nothing left to do and nothing to warn about.
            return []
        default:
            return [
                "Sale recorded, but ending the eBay listing failed. End it on eBay yourself."
            ]
        }
    }

    /// Sales are dated by DAY, in the seller's own calendar. A UTC ISO stamp
    /// would file an evening sale under tomorrow for anyone east of UTC.
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
}

/// The parsed, validated numbers a sale is recorded with. Built from
/// ``RecordSaleForm`` once, so the view's strings are parsed in exactly one
/// place and the row and the on-screen total cannot disagree.
struct SaleValues: Equatable {
    var salePrice: Double
    var shippingCollected: Double
    var platformFees: Double
    var paymentProcessingFees: Double
    var shippingCost: Double
    var tax: Double
    var otherCosts: Double
    var buyerUsername: String?
    var saleDate: Date

    init(form: RecordSaleForm, parse: (String) -> Double?) {
        func n(_ s: String) -> Double { parse(s) ?? 0 }
        salePrice = n(form.salePrice)
        shippingCollected = n(form.shippingCollected)
        platformFees = n(form.platformFees)
        paymentProcessingFees = n(form.paymentProcessingFees)
        shippingCost = n(form.shippingCost)
        tax = n(form.tax)
        otherCosts = n(form.otherCosts)
        let buyer = form.buyerUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        buyerUsername = buyer.isEmpty ? nil : buyer
        saleDate = form.saleDate
    }
}
