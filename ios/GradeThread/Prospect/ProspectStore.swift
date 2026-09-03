import Observation
import SwiftUI

/// View-model for Item Prospecting (US-1107). Holds up to two captured photos
/// (front + tag) and an optional "what would you pay?" amount, calls
/// ``ProspectService``, and exposes the result/error for the view. Images are
/// compressed (and EXIF-stripped) off the main actor via ``PhotoCompressor``
/// before upload — the same path Snap-to-Value uses.
///
/// US-1180: migrated to `@Observable` (was `ObservableObject`) for consistency
/// with the rest of the app's stores and finer-grained view invalidation.
/// A filled photo slot: the image and what the seller said it shows.
///
/// A named struct rather than a labelled tuple so the pairing survives being
/// passed around. The role is the whole point — losing it, or letting it drift
/// away from its image, is how a care-label macro gets sent to eBay visual
/// search as though it were a garment.
struct ProspectSlot {
    let role: ProspectPhotoRole
    let image: UIImage
}

@MainActor
@Observable
final class ProspectStore {

    /// The two source photos, held in NAMED slots rather than an array.
    ///
    /// US-2923: the server decides who identifies the item purely from what each
    /// photo shows, so the role has to be something the seller stated, not
    /// something the app inferred from ordering. A `[UIImage]` plus "index 0 is
    /// the front" would label a lone care-label shot as a garment photo and send
    /// it to visual search, which US-2758 measured returning a midi dress,
    /// joggers and a mini skirt for exactly that input.
    var itemPhoto: UIImage?
    var tagPhoto: UIImage?

    // ── US-3099: what the phone read before uploading ────────────────────────
    //
    // Vision has read these tags on-device since US-177. Prospect threw the
    // reading away and paid Claude to re-read the same tag from a JPEG that had
    // to be uploaded first. Now it is reported, and the server decides whether
    // it is good enough to skip that call.
    /// The chips under the tag slot. Editable — a corrected chip is the
    /// seller's own answer, which beats any reading.
    var hints: OnDeviceHints = .none
    /// A scanned retail barcode, which needs no tag photo at all.
    var scannedBarcode: String?
    /// True while the on-device read is running, so the chips can appear rather
    /// than pop.
    var isReadingTag = false
    /// Optional cost entry, in dollars, that unlocks the ROI verdict.
    var costText: String = ""
    var isLoading = false
    var result: ProspectResponse?
    var errorMessage: String?

    /// US-2923: the seller's corrected title while they are editing it. Nil when
    /// the correction field is closed.
    var titleDraft: String?
    /// True only while a re-pull is in flight, so the main spinner and the
    /// correction spinner cannot both claim the screen.
    var isRepulling = false

    /// Set once the user commits the prospect into inventory, so the view can
    /// confirm + offer a jump to the inventory tab.
    var isAdding = false
    var addedItemId: String?
    /// US-1225: separate from `errorMessage` so an add-to-inventory failure
    /// renders its OWN retry (which re-calls `addToInventory()`) instead of the
    /// top error card whose "Try again" re-runs the billable identify+comp pipeline.
    var addError: String?

    static let maxPhotos = ProspectPhotoRole.allCases.count

    private let service: Prospecting

    /// US-1861: the Thrift Radar contribution consent, and the only thing that
    /// decides whether this flow asks iOS for a position at all. Injectable so
    /// the store stays testable with no CoreLocation.
    private let radarConsent: RadarConsent
    private let radarLocation: RadarLocationProvider?

    // Constructed in the init BODY (main-actor-isolated) rather than as a default
    // argument, which would evaluate in a nonisolated context.
    init(
        service: Prospecting? = nil,
        radarConsent: RadarConsent? = nil,
        radarLocation: RadarLocationProvider? = nil
    ) {
        self.service = service ?? ProspectService()
        self.radarConsent = radarConsent ?? RadarConsent.shared
        self.radarLocation = radarLocation ?? RadarLocationProvider.shared
    }

    /// The coarse fix to send with this scan, or nil.
    ///
    /// Reads consent FIRST and returns before touching CoreLocation when it is
    /// off, so an opted-out scan never asks the operating system where it is.
    /// Everything below that is best-effort: a denied, absent or slow fix simply
    /// means this scan contributes nothing, and the scan itself is unaffected
    /// (`currentFix` is hard-bounded and never throws).
    ///
    /// Internal rather than private so the consent gate is directly testable —
    /// "an opted-out scan sends no fix" is the acceptance criterion, and
    /// asserting it through `run()` would need a real image pipeline and could
    /// pass vacuously if compression failed first.
    func radarFix() async -> RadarFix? {
        guard radarConsent.isContributing else { return nil }
        guard let radarLocation, radarLocation.isAuthorized else { return nil }
        return await radarLocation.currentFix()
    }

    /// The filled slots, in role order, which is the order the server reads.
    ///
    /// The FRONT comes first because /prospect documents its first image as the
    /// front and grades from it. A tag-only scan therefore sends one photo whose
    /// role is `tag`, and the server reads the tag rather than treating a label
    /// macro as a garment shot.
    var photos: [ProspectSlot] {
        ProspectPhotoRole.allCases.compactMap { role -> ProspectSlot? in
            guard let img = image(for: role) else { return nil }
            return ProspectSlot(role: role, image: img)
        }
    }

    func image(for role: ProspectPhotoRole) -> UIImage? {
        switch role {
        case .front: return itemPhoto
        case .tag: return tagPhoto
        }
    }

    var canAddPhoto: Bool { photos.count < Self.maxPhotos }
    var canRun: Bool { !photos.isEmpty && !isLoading && !isRepulling }

    func setImage(_ img: UIImage, for role: ProspectPhotoRole) {
        switch role {
        case .front: itemPhoto = img
        case .tag: tagPhoto = img
        }
        clearResult()
        errorMessage = nil
        addError = nil
        // US-3099: read the tag the moment it arrives, not at submit. The
        // reading takes about as long as the shutter animation, so doing it
        // here puts the chips on screen while the seller is still looking at
        // the photo they just took — and the upload, when it starts, already
        // carries them.
        if role == .tag {
            Task { await readTagOnDevice(img) }
        }
    }

    func removeImage(for role: ProspectPhotoRole) {
        switch role {
        case .front: itemPhoto = nil
        case .tag:
            tagPhoto = nil
            // US-3099: the chips described THAT tag. Keeping them would send a
            // brand read off a photo the seller has removed, which is the same
            // class of staleness `clearResult` exists to prevent one level up.
            hints = OnDeviceHints(barcode: hints.barcode, brand: nil, size: nil, confidence: nil)
        }
        clearResult()
    }

    /// A new or removed photo invalidates everything derived from the old ones —
    /// including a title the seller corrected for a garment that is no longer
    /// the one on screen.
    private func clearResult() {
        result = nil
        addedItemId = nil
        titleDraft = nil
    }

    /// Parsed cost in integer cents, or nil when the field is empty/invalid.
    private var costCents: Int? {
        // US-1491: locale-aware parse. A raw comma-strip + Double() read "24,99"
        // as 2499.0 in comma-decimal locales — a 100× cost that poisons the ROI
        // verdict. CurrencyFormatter.parse strips the symbol/grouping and honors
        // the locale decimal separator.
        guard let dollars = CurrencyFormatter().parse(costText), dollars > 0 else { return nil }
        return Int((dollars * 100).rounded())
    }

    /// US-1225: the buy/skip verdict + ROI are computed server-side and baked into
    /// the result for the cost it was run with (`result.costCents`). Nothing
    /// watches `costText` afterwards, so entering — or changing — a cost AFTER a
    /// run produces no verdict. Since the ROI math lives on the server (not here),
    /// we can't recompute locally; instead detect the mismatch so the view can
    /// prompt a re-run with the new cost.
    var costNeedsRerun: Bool {
        guard result != nil else { return false }
        return costCents != result?.costCents
    }

    func run() async {
        let slots = photos
        guard !slots.isEmpty else {
            errorMessage = "Take a photo of the item (and its tag) first."
            return
        }
        isLoading = true
        errorMessage = nil
        addError = nil
        addedItemId = nil
        titleDraft = nil
        defer { isLoading = false }

        // Compress off the main actor so the spinner stays smooth (US-636).
        //
        // A photo that fails to compress drops its ROLE with it, rather than
        // shifting the remaining roles up. Sending a tag photo under the label
        // `front` because the front shot failed to encode would be worse than
        // sending one fewer photo: the server would run visual search on a label
        // macro and answer with total confidence about the wrong garment.
        var payload: [String] = []
        var roles: [ProspectPhotoRole] = []
        for slot in slots {
            if let output = await PhotoCompressor.compressOffMain(slot.image) {
                payload.append("data:image/jpeg;base64," + output.imageData.base64EncodedString())
                roles.append(slot.role)
            }
        }
        guard !payload.isEmpty else {
            errorMessage = "Couldn't read those photos. Try again."
            return
        }

        do {
            result = try await service.prospect(
                ProspectRequest(
                    images: payload,
                    roles: roles,
                    costCents: costCents,
                    fix: await radarFix(),
                    hints: outgoingHints
                )
            )
        } catch {
            result = nil
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// The hints as they will be sent.
    ///
    /// A scanned barcode overrides whatever the tag OCR made of the label: it
    /// is a checksummed product id, not a reading, and the two disagreeing
    /// means the label was misread rather than that the barcode was.
    var outgoingHints: OnDeviceHints {
        var out = hints
        out.barcode = scannedBarcode
        return out
    }

    /// Read the tag photo on-device, before anything is uploaded.
    ///
    /// Failures are SILENT and leave the hints empty. The reading is an
    /// optimization, not a step: a Vision error must degrade to today's flow
    /// (upload, let the server identify) rather than stop a seller who is
    /// standing in a shop.
    func readTagOnDevice(_ image: UIImage) async {
        isReadingTag = true
        defer { isReadingTag = false }
        guard let lines = try? await TagTextRecognizer().recognize(image) else { return }
        let read = TagHintParser.hints(from: lines)
        // Keep a scanned barcode: it outranks anything the label says.
        hints = OnDeviceHints(
            barcode: hints.barcode,
            brand: read.brand,
            size: read.size,
            confidence: read.confidence
        )
    }

    /// The seller corrected a chip. That is their own answer about the garment,
    /// so it goes up at full confidence rather than at what Vision managed.
    func editHints(brand: String?, size: String?) {
        hints = TagHintParser.edited(hints, brand: brand, size: size)
    }

    /// A barcode came off the viewfinder. Accepted only when it is a retail
    /// symbology of a retail length — see ``ProspectBarcode``.
    func acceptBarcode(_ payload: String) {
        guard let accepted = ProspectBarcode.accepted(payload) else { return }
        scannedBarcode = accepted
    }

    /// Clear everything the phone read, for a fresh scan.
    func clearHints() {
        hints = .none
        scannedBarcode = nil
    }

    // MARK: - US-2923: correcting the identification

    /// The title currently on screen, which is what the correction field opens on.
    var currentTitle: String {
        result?.item.title ?? result?.item.brand ?? ""
    }

    /// Is the draft a usable correction? Blank is not, and neither is the title
    /// the server already returned — re-pulling that spends a comp pull to be
    /// told the same thing.
    var canRepull: Bool {
        guard result?.identified == true, !isLoading, !isRepulling else { return false }
        guard let draft = titleDraft?.trimmingCharacters(in: .whitespacesAndNewlines),
              !draft.isEmpty else { return false }
        return draft != currentTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func beginTitleEdit() {
        guard titleDraft == nil else { return }
        titleDraft = currentTitle
    }

    func cancelTitleEdit() {
        titleDraft = nil
    }

    /// Re-run the comps against the seller's corrected title.
    ///
    /// The grade is CARRIED ACROSS, not recomputed: the photos did not change,
    /// so the condition did not either, and only the identification was wrong.
    /// That is also why no photos are sent — it costs no AI action and returns
    /// in about the time one eBay call takes.
    ///
    /// The brand is deliberately NOT carried across. The old brand came from the
    /// identification being corrected, so pinning it would let a wrong brand
    /// survive the correction and keep pricing the item against the wrong comps.
    /// The corrected title carries whatever brand the seller meant.
    func repull() async {
        guard canRepull,
              let draft = titleDraft?.trimmingCharacters(in: .whitespacesAndNewlines),
              let previous = result else { return }
        isRepulling = true
        errorMessage = nil
        addError = nil
        addedItemId = nil
        defer { isRepulling = false }

        do {
            result = try await service.prospect(
                ProspectRequest.repull(
                    title: draft,
                    brand: nil,
                    gradeValue: previous.grade?.value,
                    gradeTier: previous.grade?.tier,
                    // The CURRENT cost, not the one the previous run used. The
                    // verdict is recomputed server-side either way, so a re-pull
                    // is the cheapest moment to also apply a cost the seller
                    // edited after the scan — and carrying the stale one would
                    // leave `costNeedsRerun` true after a successful re-pull.
                    costCents: costCents
                )
            )
            titleDraft = nil
        } catch {
            // The previous result STAYS on screen. A failed correction that
            // blanked the card would cost the seller the numbers they already
            // had, standing in a shop, for a network blip.
            result = previous
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Commit the current result into inventory at `sourced` via the existing
    /// Scout buy endpoint. Prefills cost/grade/target from what we just learned.
    func addToInventory() async {
        guard let result, result.identified, let title = result.item.title, !title.isEmpty else {
            addError = "Nothing to add — identify an item first."
            return
        }
        isAdding = true
        addError = nil
        defer { isAdding = false }

        // US-1170: don't discard the AI's read on commit. The keywords + resolved
        // category are folded into notes so the catalog step starts from the AI's
        // read instead of a blank item.
        //
        // US-3026: size and colour used to be sent as nil, because the response
        // carried only brand/title/keywords. It carries fields now, so the two
        // things the seller would otherwise re-type off the same tag we just
        // read are filled in.
        let request = ProspectBuyRequest(
            title: title,
            brand: result.item.brand,
            size: result.item.size,
            color: result.item.color,
            // US-1275: commit the cost the run was computed with (result.costCents),
            // not the current field — if the user edited cost after the run
            // (costNeedsRerun), targetCents/grade below come from the prior run, so
            // persisting the edited cost would store a verdict the comps never used.
            costCents: result.costCents,
            targetCents: result.stats?.medianCents,
            gradeValue: result.grade?.value,
            gradeLabel: result.grade?.tier,
            conditionNotes: prospectNotes(result)
        )
        do {
            let response = try await service.buy(request)
            addedItemId = response.id
        } catch {
            addError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// US-1170: distill the AI's read (keywords + resolved category) into a
    /// notes string so it carries into the new inventory item. Returns nil when
    /// there's nothing useful to record.
    private func prospectNotes(_ result: ProspectResponse) -> String? {
        var parts: [String] = []
        if !result.item.keywords.isEmpty {
            parts.append(result.item.keywords.joined(separator: ", "))
        }
        if let path = result.category?.path, !path.isEmpty {
            parts.append("Category: \(path)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
