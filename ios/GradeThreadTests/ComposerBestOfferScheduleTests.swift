import XCTest
@testable import GradeThread

/// US-1970 / US-1971 / US-1972 — the composer's Best Offer + scheduled-publish
/// controls. The server has always accepted these; the phone had no UI for them,
/// so a camera-created listing couldn't reach them. These cover the PURE pieces:
/// the validate-summary decoding, the threshold rules, the resume merge, and the
/// schedule edit's write semantics.
final class ComposerBestOfferScheduleTests: XCTestCase {

    // MARK: - Fixtures

    /// Locale pinned so the money-parsing assertions don't depend on the host.
    private let usFormatter = CurrencyFormatter(locale: Locale(identifier: "en_US"))

    private func summary(
        priceValue: String = "42.00",
        bestOfferEnabled: Bool = false,
        autoAccept: String? = nil,
        autoDecline: String? = nil
    ) -> PublishSummary {
        PublishSummary(
            title: "Server title",
            description: "Server description",
            condition: "USED_GOOD",
            conditionDescription: "server note",
            priceValue: priceValue,
            currency: "USD",
            aspects: nil,
            bestOfferEnabled: bestOfferEnabled,
            bestOfferAutoAccept: autoAccept,
            bestOfferAutoDecline: autoDecline
        )
    }

    private func edits(
        bestOffer: ComposerBestOffer? = nil,
        schedule: ComposerScheduleEdit = .unchanged
    ) -> ComposerEdits {
        ComposerEdits(
            title: "Edited title",
            condition: .usedExcellent,
            conditionDescription: "edited note",
            description: "Edited description",
            bestOffer: bestOffer,
            schedule: schedule
        )
    }

    // MARK: - US-1970: summary decoding

    func test_publishSummary_decodesBestOfferFields() throws {
        let json = """
        {
          "title": "Vintage 501",
          "description": "Classic indigo wash.",
          "condition": "USED_EXCELLENT",
          "conditionDescription": "Light fading.",
          "priceValue": "42.00",
          "currency": "USD",
          "bestOfferEnabled": true,
          "bestOfferAutoAccept": "38.00",
          "bestOfferAutoDecline": "25.00"
        }
        """
        let parsed = try JSONDecoder().decode(PublishSummary.self, from: Data(json.utf8))
        XCTAssertTrue(parsed.bestOfferEnabled)
        XCTAssertEqual(parsed.bestOfferAutoAccept, "38.00")
        XCTAssertEqual(parsed.bestOfferAutoDecline, "25.00")
    }

    /// An older edge that omits the keys must decode as "off" — matching the
    /// column default — not fail the whole composer.
    func test_publishSummary_bestOfferAbsent_decodesAsDisabled() throws {
        let json = """
        {
          "title": "T", "description": "D", "priceValue": "42.00", "currency": "USD"
        }
        """
        let parsed = try JSONDecoder().decode(PublishSummary.self, from: Data(json.utf8))
        XCTAssertFalse(parsed.bestOfferEnabled)
        XCTAssertNil(parsed.bestOfferAutoAccept)
        XCTAssertNil(parsed.bestOfferAutoDecline)
    }

    /// An explicit JSON null (Best Offer on, but no threshold resolved) means
    /// "enabled but unbounded" — not "disabled".
    func test_publishSummary_bestOfferEnabledWithNullThresholds() throws {
        let json = """
        {
          "title": "T", "description": "D", "priceValue": "42.00", "currency": "USD",
          "bestOfferEnabled": true, "bestOfferAutoAccept": null, "bestOfferAutoDecline": null
        }
        """
        let parsed = try JSONDecoder().decode(PublishSummary.self, from: Data(json.utf8))
        XCTAssertTrue(parsed.bestOfferEnabled)
        XCTAssertNil(parsed.bestOfferAutoAccept)
    }

    // MARK: - US-1970: threshold parsing

    func test_bestOfferCents_blankIsNil_meaningUseTheSuggestion() {
        XCTAssertNil(BestOfferValidation.cents("", formatter: usFormatter))
        XCTAssertNil(BestOfferValidation.cents("   ", formatter: usFormatter))
    }

    func test_bestOfferCents_parsesToWholeCents() {
        XCTAssertEqual(BestOfferValidation.cents("38.00", formatter: usFormatter), 3800)
        XCTAssertEqual(BestOfferValidation.cents("38.49", formatter: usFormatter), 3849)
        XCTAssertEqual(BestOfferValidation.cents("38", formatter: usFormatter), 3800)
    }

    /// Zero/negative/garbage are not thresholds — they must not become 0 cents,
    /// which would mean "auto-accept every offer".
    func test_bestOfferCents_rejectsNonPositive() {
        XCTAssertNil(BestOfferValidation.cents("0", formatter: usFormatter))
        XCTAssertNil(BestOfferValidation.cents("0.00", formatter: usFormatter))
        XCTAssertNil(BestOfferValidation.cents("-5", formatter: usFormatter))
        XCTAssertNil(BestOfferValidation.cents("abc", formatter: usFormatter))
    }

    /// A comma-decimal locale must round-trip — `Double("19,99")` is nil, which
    /// would silently drop the seller's threshold (US-1236).
    func test_bestOfferCents_commaDecimalLocale() {
        let de = CurrencyFormatter(locale: Locale(identifier: "de_DE"))
        XCTAssertEqual(BestOfferValidation.cents("19,99", formatter: de), 1999)
    }

    // MARK: - US-1970: threshold rules (eBay needs decline < accept < price)

    func test_bestOfferError_disabled_neverComplains() {
        let offer = ComposerBestOffer(enabled: false, autoAcceptText: "999", autoDeclineText: "888")
        XCTAssertNil(BestOfferValidation.error(offer, priceCents: 4200, formatter: usFormatter))
    }

    func test_bestOfferError_blankThresholdsAreValid() {
        let offer = ComposerBestOffer(enabled: true)
        XCTAssertNil(BestOfferValidation.error(offer, priceCents: 4200, formatter: usFormatter))
    }

    func test_bestOfferError_validPair() {
        let offer = ComposerBestOffer(enabled: true, autoAcceptText: "38", autoDeclineText: "25")
        XCTAssertNil(BestOfferValidation.error(offer, priceCents: 4200, formatter: usFormatter))
    }

    /// A FILLED but unparseable box is an error, not a silent fall-back to the
    /// suggestion — otherwise a typo publishes terms the seller never chose.
    func test_bestOfferError_unparseableFilledBox() {
        let accept = ComposerBestOffer(enabled: true, autoAcceptText: "abc")
        XCTAssertNotNil(BestOfferValidation.error(accept, priceCents: 4200, formatter: usFormatter))

        let decline = ComposerBestOffer(enabled: true, autoDeclineText: "0")
        XCTAssertNotNil(BestOfferValidation.error(decline, priceCents: 4200, formatter: usFormatter))
    }

    func test_bestOfferError_acceptAtOrAboveListingPrice() {
        let atPrice = ComposerBestOffer(enabled: true, autoAcceptText: "42")
        XCTAssertEqual(
            BestOfferValidation.error(atPrice, priceCents: 4200, formatter: usFormatter),
            "Auto-accept must be below the listing price."
        )
        let above = ComposerBestOffer(enabled: true, autoAcceptText: "50")
        XCTAssertNotNil(BestOfferValidation.error(above, priceCents: 4200, formatter: usFormatter))
    }

    func test_bestOfferError_declineAtOrAboveListingPrice() {
        let offer = ComposerBestOffer(enabled: true, autoDeclineText: "42")
        XCTAssertEqual(
            BestOfferValidation.error(offer, priceCents: 4200, formatter: usFormatter),
            "Auto-decline must be below the listing price."
        )
    }

    func test_bestOfferError_declineAtOrAboveAccept() {
        let equal = ComposerBestOffer(enabled: true, autoAcceptText: "30", autoDeclineText: "30")
        XCTAssertEqual(
            BestOfferValidation.error(equal, priceCents: 4200, formatter: usFormatter),
            "Auto-decline must be below auto-accept."
        )
        let inverted = ComposerBestOffer(enabled: true, autoAcceptText: "25", autoDeclineText: "35")
        XCTAssertNotNil(BestOfferValidation.error(inverted, priceCents: 4200, formatter: usFormatter))
    }

    /// With no known price the price rules can't apply — the composer blocks
    /// Push on an invalid price separately, so this must not double-report.
    func test_bestOfferError_unknownPrice_skipsPriceRules() {
        let offer = ComposerBestOffer(enabled: true, autoAcceptText: "38", autoDeclineText: "25")
        XCTAssertNil(BestOfferValidation.error(offer, priceCents: 0, formatter: usFormatter))
    }

    // MARK: - US-1970: seeding

    func test_composerBestOffer_seedsFromSummary() {
        let seeded = ComposerBestOffer(
            summary: summary(bestOfferEnabled: true, autoAccept: "38.00", autoDecline: "25.00")
        )
        XCTAssertTrue(seeded.enabled)
        XCTAssertEqual(seeded.autoAcceptText, "38.00")
        XCTAssertEqual(seeded.autoDeclineText, "25.00")

        // Nil thresholds seed BLANK — blank means "use the suggestion".
        let unbounded = ComposerBestOffer(summary: summary(bestOfferEnabled: true))
        XCTAssertTrue(unbounded.enabled)
        XCTAssertEqual(unbounded.autoAcceptText, "")
        XCTAssertEqual(unbounded.autoDeclineText, "")
    }

    // MARK: - US-1970: resume merge (US-1006 edit preservation)

    /// A transient push failure must not revert the seller's Best Offer choice
    /// back to the server's resolution when the composer is restored.
    func test_merging_carriesBestOfferChoice() {
        let base = summary(bestOfferEnabled: false)
        let turnedOn = ComposerBestOffer(enabled: true, autoAcceptText: "38", autoDeclineText: "25")
        let merged = PublishSummary.merging(edits(bestOffer: turnedOn), into: base)
        XCTAssertTrue(merged.bestOfferEnabled)
        XCTAssertEqual(merged.bestOfferAutoAccept, "38")
        XCTAssertEqual(merged.bestOfferAutoDecline, "25")
    }

    /// A CLEARED threshold round-trips as nil rather than re-seeding the
    /// server's number — otherwise "use the suggestion" would silently revert to
    /// a pinned value on every retry.
    func test_merging_clearedThresholdStaysCleared() {
        let base = summary(bestOfferEnabled: true, autoAccept: "38.00", autoDecline: "25.00")
        let cleared = ComposerBestOffer(enabled: true)
        let merged = PublishSummary.merging(edits(bestOffer: cleared), into: base)
        XCTAssertTrue(merged.bestOfferEnabled)
        XCTAssertNil(merged.bestOfferAutoAccept)
        XCTAssertNil(merged.bestOfferAutoDecline)
    }

    /// No Best Offer control shown (nil) → the base summary's resolution stands.
    func test_merging_noBestOfferEdit_keepsBase() {
        let base = summary(bestOfferEnabled: true, autoAccept: "38.00", autoDecline: "25.00")
        let merged = PublishSummary.merging(edits(bestOffer: nil), into: base)
        XCTAssertTrue(merged.bestOfferEnabled)
        XCTAssertEqual(merged.bestOfferAutoAccept, "38.00")
        XCTAssertEqual(merged.bestOfferAutoDecline, "25.00")
    }

    // MARK: - US-1971: schedule write semantics

    /// On a FRESH row there's no prior value, so "unchanged" and "clear" both
    /// mean "not scheduled" — only `.at` writes a timestamp.
    func test_scheduleInsertValue() {
        XCTAssertNil(ListingDraftService.scheduleInsertValue(.unchanged))
        XCTAssertNil(ListingDraftService.scheduleInsertValue(.clear))

        let when = Date(timeIntervalSince1970: 1_800_000_000)
        let iso = ListingDraftService.scheduleInsertValue(.at(when))
        XCTAssertNotNil(iso)
        XCTAssertEqual(iso.flatMap(ScheduledDropScheduling.parseTimestamp), when)
    }

    /// The enum keeps "leave the column alone" and "cancel the drop" distinct —
    /// a `Date??` would collapse them and silently cancel scheduled drops.
    func test_scheduleEdit_clearIsNotUnchanged() {
        XCTAssertNotEqual(ComposerScheduleEdit.clear, .unchanged)
        let when = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(ComposerScheduleEdit.at(when), .at(when))
        XCTAssertNotEqual(ComposerScheduleEdit.at(when), .at(when.addingTimeInterval(60)))
    }

    /// The composer's default slot is a real future peak-time instant, not now.
    func test_defaultSchedulePreset_isInTheFuture() throws {
        let preset = try XCTUnwrap(ScheduledDropScheduling.presets.first { $0.id == "tonight-7pm" })
        let next = ScheduledDropScheduling.nextPresetDate(
            preset, timeZoneIdentifier: "America/Chicago", from: .now
        )
        XCTAssertGreaterThan(next, .now)
    }

    // MARK: - US-1972: edits carry through unchanged by default

    /// A composer that never touches the new controls must not write them —
    /// `.unchanged` + nil Best Offer is the "leave the draft alone" contract
    /// that keeps existing publish behavior byte-identical.
    func test_composerEdits_defaultsAreNonWriting() {
        let plain = edits()
        XCTAssertNil(plain.bestOffer)
        XCTAssertEqual(plain.schedule, .unchanged)
    }

    /// `.none` is the "no listing row yet" seed a camera-created item starts
    /// from — nothing scheduled, no pinned thresholds.
    func test_draftSettings_noneIsEmpty() {
        XCTAssertFalse(ListingDraftSettings.none.bestOfferEnabled)
        XCTAssertNil(ListingDraftSettings.none.autoAcceptCents)
        XCTAssertNil(ListingDraftSettings.none.autoDeclineCents)
        XCTAssertNil(ListingDraftSettings.none.scheduledPublishAt)
    }

    // MARK: - Baseline advance after a save (US-1006 edit preservation)

    /// `applying` must mirror `saveDraft`'s write semantics — it's what the
    /// composer re-seeds from after a save, and after the save that precedes a
    /// failed push. A stale baseline reverts the seller's typed thresholds on
    /// "Try again".
    func test_applying_persistsBestOfferAndSchedule() {
        let when = Date(timeIntervalSince1970: 1_800_000_000)
        let next = ListingDraftSettings.none.applying(
            edits(
                bestOffer: ComposerBestOffer(
                    enabled: true, autoAcceptText: "38", autoDeclineText: "25"
                ),
                schedule: .at(when)
            ),
            formatter: usFormatter
        )
        XCTAssertTrue(next.bestOfferEnabled)
        XCTAssertEqual(next.autoAcceptCents, 3800)
        XCTAssertEqual(next.autoDeclineCents, 2500)
        XCTAssertEqual(next.scheduledPublishAt, when)
    }

    /// A blank threshold clears the override back to "use the suggestion" — it
    /// must not leave the previously pinned cents in place.
    func test_applying_blankThresholdClearsOverride() {
        let seeded = ListingDraftSettings(
            bestOfferEnabled: true, autoAcceptCents: 3800,
            autoDeclineCents: 2500, scheduledPublishAt: nil
        )
        let next = seeded.applying(
            edits(bestOffer: ComposerBestOffer(enabled: true)), formatter: usFormatter
        )
        XCTAssertTrue(next.bestOfferEnabled)
        XCTAssertNil(next.autoAcceptCents)
        XCTAssertNil(next.autoDeclineCents)
    }

    /// `.unchanged` + nil Best Offer touches nothing — the "leave the draft
    /// alone" contract, so an unrelated save can't cancel a scheduled drop.
    func test_applying_unchangedLeavesEverythingAlone() {
        let when = Date(timeIntervalSince1970: 1_800_000_000)
        let seeded = ListingDraftSettings(
            bestOfferEnabled: true, autoAcceptCents: 3800,
            autoDeclineCents: 2500, scheduledPublishAt: when
        )
        XCTAssertEqual(seeded.applying(edits(), formatter: usFormatter), seeded)
    }

    /// Cancelling clears only the schedule; the draft's other settings stay.
    func test_applying_clearCancelsScheduleOnly() {
        let seeded = ListingDraftSettings(
            bestOfferEnabled: true, autoAcceptCents: 3800,
            autoDeclineCents: 2500, scheduledPublishAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
        let next = seeded.applying(edits(schedule: .clear), formatter: usFormatter)
        XCTAssertNil(next.scheduledPublishAt)
        XCTAssertTrue(next.bestOfferEnabled)
        XCTAssertEqual(next.autoAcceptCents, 3800)
    }
}
