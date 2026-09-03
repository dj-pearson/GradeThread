import XCTest
@testable import GradeThread

/// US-3099 — the phone reads the tag before it uploads anything.
///
/// Vision has read these care tags on-device since US-177: free, offline, in the
/// time the shutter takes. Prospect threw that reading away and paid a metered
/// AI action to have Claude read the same tag from a JPEG that had to be
/// uploaded first.
///
/// The split matters and is tested as such: the phone REPORTS what it read, and
/// the server decides whether it is good enough to skip the identify call
/// (`lib/prospect-onboard-hints.ts`). A client that decided for itself would be
/// a second copy of a rule that has to match, and the copy holding the money is
/// the one that should win.
@MainActor
final class OnDeviceHintsTests: XCTestCase {

    // MARK: - Reading the tag

    func test_brandAndSizeAreParsedFromRecognizedLines() {
        let hints = TagHintParser.hints(from: [
            line("100% COTTON", 0.97),
            line("Patagonia", 0.95),
            line("M", 0.91),
            line("MADE IN VIETNAM", 0.88),
        ])
        XCTAssertEqual(hints.brand, "Patagonia")
        XCTAssertEqual(hints.size, "M")
    }

    func test_confidenceIsTheMinimumNotTheMean() {
        // A brand at 0.95 beside a size at 0.30 is not an 0.62 reading of
        // anything. It is one thing we know and one we do not, and averaging
        // lets the weak half ride in on the strong one.
        let hints = TagHintParser.hints(from: [
            line("Patagonia", 0.95),
            line("M", 0.30),
        ])
        XCTAssertEqual(hints.confidence ?? 1, 0.30, accuracy: 0.001)
        XCTAssertFalse(
            TagHintParser.willSkipServerIdentify(hints),
            "the weak size must drag the whole reading below the floor"
        )
    }

    func test_aTagWithNothingRecognizableYieldsNoHints() {
        let hints = TagHintParser.hints(from: [line("XXXXX", 0.4), line("////", 0.2)])
        XCTAssertNil(hints.brand)
        XCTAssertTrue(hints.isEmpty)
    }

    func test_noLinesAtAllIsEmptyRatherThanACrash() {
        XCTAssertEqual(TagHintParser.hints(from: []), .none)
    }

    // MARK: - Whether it saves a call

    func test_aConfidentBrandSkipsTheServerIdentify() {
        let hints = OnDeviceHints(brand: "Patagonia", size: "M", confidence: 0.93)
        XCTAssertTrue(TagHintParser.willSkipServerIdentify(hints))
    }

    func test_aSizeAloneNeverSkipsIt() {
        // "M" is not an identification. A comp search on size with no brand
        // returns every medium garment on eBay.
        let hints = OnDeviceHints(brand: nil, size: "M", confidence: 0.99)
        XCTAssertFalse(TagHintParser.willSkipServerIdentify(hints))
    }

    func test_theFloorMatchesTheServers() {
        // ONDEVICE_HINT_CONFIDENCE_FLOOR in
        // services/edge-functions/src/lib/prospect-onboard-hints.ts. The phone
        // mirrors it ONLY to tell the seller whether the chips saved a step; a
        // drift here would promise a saving the server does not give.
        XCTAssertEqual(TagHintParser.serverTrustFloor, 0.8)
        XCTAssertTrue(TagHintParser.willSkipServerIdentify(
            OnDeviceHints(brand: "Nike", confidence: 0.8)
        ))
        XCTAssertFalse(TagHintParser.willSkipServerIdentify(
            OnDeviceHints(brand: "Nike", confidence: 0.79)
        ))
    }

    func test_aBarcodeSkipsItWithNoBrandAtAll() {
        XCTAssertTrue(TagHintParser.willSkipServerIdentify(
            OnDeviceHints(barcode: "0123456789012")
        ))
    }

    // MARK: - Correcting a chip

    func test_aCorrectedChipGoesUpAtFullConfidence() {
        // A hand-typed brand is not a reading; it is the seller telling us what
        // the garment is. Reporting it at OCR confidence would throw away the
        // best evidence in the request.
        let read = OnDeviceHints(brand: "Patogonia", size: "M", confidence: 0.42)
        let edited = TagHintParser.edited(read, brand: "Patagonia", size: "M")
        XCTAssertEqual(edited.brand, "Patagonia")
        XCTAssertEqual(edited.confidence, 1.0)
        XCTAssertTrue(TagHintParser.willSkipServerIdentify(edited))
    }

    func test_anUneditedChipKeepsItsOwnConfidence() {
        let read = OnDeviceHints(brand: "Patagonia", size: "M", confidence: 0.42)
        let same = TagHintParser.edited(read, brand: "Patagonia", size: "M")
        XCTAssertEqual(same.confidence ?? 0, 0.42, accuracy: 0.001)
    }

    func test_clearingAChipRemovesItRatherThanSendingAnEmptyString() {
        let read = OnDeviceHints(brand: "Patagonia", size: "M", confidence: 0.9)
        let cleared = TagHintParser.edited(read, brand: "  ", size: "M")
        XCTAssertNil(cleared.brand)
    }

    // MARK: - Barcodes

    func test_onlyRetailLengthsAreAccepted() {
        // UPC-E and EAN-8 are 8, UPC-A is 12, EAN-13 is 13.
        XCTAssertEqual(ProspectBarcode.accepted("01234567"), "01234567")
        XCTAssertEqual(ProspectBarcode.accepted("012345678912"), "012345678912")
        XCTAssertEqual(ProspectBarcode.accepted("0123456789012"), "0123456789012")

        // A QR payload or a thrift SKU sticker identifies no product in any
        // catalogue we can query. Sent as a gtin it returns an empty comp set,
        // which reads to the seller as a rare item rather than a bad scan.
        XCTAssertNil(ProspectBarcode.accepted("https://example.test/x"))
        XCTAssertNil(ProspectBarcode.accepted("SKU-99213"))
        XCTAssertNil(ProspectBarcode.accepted("123"))
    }

    func test_upcaIsAbsentFromTheSymbologySetOnPurpose() {
        // A UPC-A is an EAN-13 with a leading zero and Vision classifies it as
        // .ean13. A `.upca` case would be a symbology that never fires, looking
        // for all the world like coverage.
        XCTAssertTrue(ProspectBarcode.acceptedSymbologies.contains("VNBarcodeSymbologyEAN13"))
        XCTAssertTrue(ProspectBarcode.acceptedSymbologies.contains("VNBarcodeSymbologyEAN8"))
        XCTAssertTrue(ProspectBarcode.acceptedSymbologies.contains("VNBarcodeSymbologyUPCE"))
        XCTAssertFalse(
            ProspectBarcode.acceptedSymbologies.contains("VNBarcodeSymbologyCode128"),
            "Code 128 is a thrift SKU sticker, not a product id"
        )
        XCTAssertFalse(ProspectBarcode.acceptedSymbologies.contains("VNBarcodeSymbologyQR"))
    }

    func test_theStoreRefusesANonRetailScan() {
        let store = ProspectStore(service: StubProspecting())
        store.acceptBarcode("SKU-1234")
        XCTAssertNil(store.scannedBarcode, "a sticker must not become a product lookup")
        store.acceptBarcode("0123456789012")
        XCTAssertEqual(store.scannedBarcode, "0123456789012")
    }

    func test_aBarcodeOutranksTheTagReading() {
        // The two disagreeing means the label was misread, not that the
        // checksummed id was.
        let store = ProspectStore(service: StubProspecting())
        store.hints = OnDeviceHints(brand: "Patagonia", size: "M", confidence: 0.9)
        store.acceptBarcode("0123456789012")
        XCTAssertEqual(store.outgoingHints.barcode, "0123456789012")
        XCTAssertEqual(store.outgoingHints.brand, "Patagonia", "the read still rides along")
    }

    // MARK: - What the request carries

    func test_aGarmentOnlyScanSendsFrontRoleOnly() throws {
        // The role decides whether the server reads the tag or runs visual
        // search (lib/prospect-identify.ts), so an invented `tag` role on a
        // garment-only scan would spend an AI action looking for text that is
        // not in the frame.
        let request = ProspectRequest(
            images: ["data:image/jpeg;base64,AA"],
            roles: [.front],
            costCents: nil
        )
        XCTAssertEqual(request.imageRoles, ["front"])
        XCTAssertNil(request.barcode)
        XCTAssertNil(request.brandHint)
    }

    func test_hintsRideOnTheRequestWhenPresent() throws {
        let request = ProspectRequest(
            images: ["data:image/jpeg;base64,AA"],
            roles: [.front, .tag],
            costCents: 1200,
            hints: OnDeviceHints(barcode: "0123456789012", brand: "Nike", size: "10", confidence: 0.9)
        )
        XCTAssertEqual(request.imageRoles, ["front", "tag"])
        XCTAssertEqual(request.barcode, "0123456789012")
        XCTAssertEqual(request.brandHint, "Nike")
        XCTAssertEqual(request.sizeHint, "10")
        XCTAssertEqual(request.hintConfidence ?? 0, 0.9, accuracy: 0.001)
    }

    func test_aRepullCarriesNoHints() {
        // A re-pull sends no photos, so there is nothing the phone read.
        let request = ProspectRequest.repull(
            title: "Patagonia Better Sweater",
            brand: "Patagonia",
            gradeValue: 8,
            gradeTier: "excellent",
            costCents: nil
        )
        XCTAssertNil(request.barcode)
        XCTAssertNil(request.brandHint)
        XCTAssertNil(request.hintConfidence)
    }

    // MARK: - Helpers

    private func line(_ text: String, _ confidence: Float) -> RecognizedLine {
        RecognizedLine(text: text, confidence: confidence, boundingBox: .zero)
    }
}

/// A do-nothing service. This file tests what the phone READ and what it puts
/// on the request; nothing here reaches the network, and a fake that could
/// would make these tests about something else.
private struct StubProspecting: Prospecting {
    func prospect(_ request: ProspectRequest) async throws -> ProspectResponse {
        throw EdgeAPIError.network("not used in these tests")
    }

    func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse {
        throw EdgeAPIError.network("not used in these tests")
    }
}
