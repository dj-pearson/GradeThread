import Foundation

/// US-3099 — what the phone read off the tag before it uploaded anything.
///
/// `Vision/TagTextRecognizer.swift` has run `VNRecognizeTextRequest` on care
/// tags since US-177, on-device, for free, offline, in the time the shutter
/// takes. Prospect threw that reading away and paid a metered AI action to have
/// Claude read the same tag from a JPEG that had to be uploaded first.
///
/// So the phone reports what it read, and the SERVER decides what to do with it
/// (`services/edge-functions/src/lib/prospect-onboard-hints.ts`). The split is
/// deliberate: a client that decided for itself when it was confident enough
/// would be a second copy of a rule that has to match, and the one that matters
/// is the one holding the money.
struct OnDeviceHints: Equatable {
    /// A scanned retail barcode. Checksummed, so the server trusts it outright.
    var barcode: String?
    /// Brand read off the tag.
    var brand: String?
    /// Size read off the tag.
    var size: String?
    /// Vision's own confidence in `brand` and `size`, 0..1.
    var confidence: Double?

    static let none = OnDeviceHints()

    var isEmpty: Bool {
        barcode == nil && brand == nil && size == nil
    }
}

/// Turns Vision's recognized lines into the two chips the seller sees.
///
/// PURE, and separate from the recognizer, because what makes this correct is
/// not the OCR — it is which of a dozen lines on a care label is the brand.
enum TagHintParser {

    /// The floor the SERVER applies (`ONDEVICE_HINT_CONFIDENCE_FLOOR`).
    ///
    /// Mirrored here for one purpose only: telling the seller whether the chips
    /// will actually save a step. The phone never withholds a reading on this
    /// basis — it reports, and the server decides.
    static let serverTrustFloor: Double = 0.8

    /// Build hints from what Vision returned.
    ///
    /// Confidence is the MINIMUM across the lines the two values came from, not
    /// the mean. A brand read at 0.95 next to a size read at 0.3 is not an 0.62
    /// reading of anything: it is one thing we know and one we do not, and
    /// averaging them would let the weak half ride in on the strong one.
    static func hints(from lines: [RecognizedLine]) -> OnDeviceHints {
        guard !lines.isEmpty else { return .none }

        let texts = lines.map(\.text)
        let inferred = SizeTagInference.infer(lines: texts)

        var confidences: [Float] = []
        if let brand = inferred.brand,
           let line = lines.first(where: { $0.text.localizedCaseInsensitiveContains(brand) }) {
            confidences.append(line.confidence)
        }
        if let size = inferred.size,
           let line = lines.first(where: { $0.text.localizedCaseInsensitiveContains(size) }) {
            confidences.append(line.confidence)
        }

        return OnDeviceHints(
            barcode: nil,
            brand: inferred.brand,
            size: inferred.size,
            confidence: confidences.isEmpty ? nil : Double(confidences.min() ?? 0)
        )
    }

    /// Whether the chips as they stand will spare an AI call.
    ///
    /// Used only for the line under them. A seller who corrects a chip by hand
    /// has given us something better than any reading, so an EDITED chip is
    /// sent at full confidence — that is the seller's own answer, which is the
    /// same thing a title correction already is.
    static func willSkipServerIdentify(_ hints: OnDeviceHints) -> Bool {
        if hints.barcode != nil { return true }
        guard hints.brand != nil else { return false }
        return (hints.confidence ?? 0) >= serverTrustFloor
    }

    /// The hints to send once the seller has touched a chip.
    ///
    /// A hand-corrected brand is not a reading at all; it is the seller telling
    /// us what the garment is. Reporting it at OCR confidence would throw away
    /// the best evidence in the request.
    static func edited(_ hints: OnDeviceHints, brand: String?, size: String?) -> OnDeviceHints {
        let cleanedBrand = brand?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedSize = size?.trimmingCharacters(in: .whitespacesAndNewlines)
        let brandChanged = cleanedBrand != hints.brand
        let sizeChanged = cleanedSize != hints.size
        return OnDeviceHints(
            barcode: hints.barcode,
            brand: (cleanedBrand?.isEmpty ?? true) ? nil : cleanedBrand,
            size: (cleanedSize?.isEmpty ?? true) ? nil : cleanedSize,
            confidence: (brandChanged || sizeChanged) ? 1.0 : hints.confidence
        )
    }
}

/// The barcode symbologies Prospect reacts to.
///
/// A NARROWER set than `BarcodeScanner.symbologies`, and deliberately so. That
/// scanner also reads Code 128 and QR, which are what thrift-store SKU stickers
/// and seller batch tags use — neither identifies a product in any catalogue we
/// can query, and sending one as a `gtin` returns an empty comp set that reads
/// to the seller as a rare item rather than as a bad scan. The server refuses
/// them too (`normalizeBarcode`); this stops them at the source.
///
/// **UPC-A is absent because Vision never reports it.** A UPC-A is an EAN-13
/// with a leading zero, and `VNDetectBarcodesRequest` classifies it as
/// `.ean13`. Adding a `.upca` case would be a symbology that never fires,
/// looking for all the world like coverage.
enum ProspectBarcode {
    static let acceptedSymbologies: Set<String> = ["VNBarcodeSymbologyEAN13", "VNBarcodeSymbologyEAN8", "VNBarcodeSymbologyUPCE"]

    /// The retail barcode lengths: UPC-E and EAN-8 are 8, UPC-A is 12,
    /// EAN-13 is 13. Mirrors the server's `normalizeBarcode`.
    static func accepted(_ payload: String) -> String? {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.allSatisfy(\.isNumber) else { return nil }
        return [8, 12, 13].contains(trimmed.count) ? trimmed : nil
    }
}
