import Foundation
import GradeThreadCore
import Observation

/// US-2964 - the item canvas's description blocks, loaded from and saved to the
/// edge. The iOS half of `src/hooks/use-description-blocks.ts`.
///
/// The renderer lives on the edge service only, so this store holds the block
/// ARRAY locally and asks functions.gradethread.com for every string it shows.
/// Nothing here builds a description; ``preview`` is always bytes the server
/// produced, which is what makes a listing edited on a phone and opened on the
/// web show the same thing.
@MainActor
@Observable
final class DescriptionBlocksStore {

    // MARK: - State

    /// The rows on screen. Starts as the local default order so the section can
    /// draw before there is a listing id to ask about.
    private(set) var blocks: [DescriptionBlock] = DescriptionBlocks.defaults
    /// The exact string eBay will receive, or "" while it has never been
    /// rendered.
    private(set) var preview = ""
    private(set) var previewPending = false
    private(set) var loading = false
    /// True when the rows shown came from parsing a legacy description.
    private(set) var converted = false
    /// True once this listing's real blocks have arrived.
    private(set) var hydrated = false
    private(set) var regenerating: DescriptionBlockKey?
    private(set) var snippets: [DescriptionBlocksService.ListingSnippet] = []
    private(set) var snippetsLoaded = false
    /// The last user-facing failure, shown once rather than toasted per attempt.
    private(set) var message: String?
    /// The rows on screen differ from what the server holds.
    ///
    /// The canvas's own dirty flag watches the ITEM draft, and a block edit
    /// touches none of it - so without this, switching a section off and
    /// pressing Save did nothing at all, and the Save button was disabled
    /// besides.
    private(set) var dirty = false

    /// The listing whose blocks these are. Nil until the item has one.
    private(set) var listingId: String?
    private(set) var unit: MeasurementUnit = AppPreferences.measurementUnit

    /// False while the rows on screen are a local placeholder rather than this
    /// listing's real blocks. ``save()`` refuses in that state.
    ///
    /// A listing with no row yet has nothing to load, so the local default IS
    /// its starting array. A listing that HAS a row has real blocks on the
    /// server, and until the GET has handed them over the rows on screen are a
    /// placeholder - saving then would render a description out of empty prose
    /// and overwrite a real one.
    var ready: Bool { listingId == nil ? true : hydrated }

    /// The listing has a row but its blocks never arrived. Nothing will save,
    /// and the section says so rather than pretending to work.
    var unavailable: Bool { listingId != nil && !hydrated && !loading }

    // MARK: - The preview scheduler

    struct PreviewPayload: Sendable {
        let listingId: String
        let blocks: [DescriptionBlock]
        let unit: MeasurementUnit
    }

    @ObservationIgnored
    private var scheduler: DescriptionPreviewScheduler<PreviewPayload, String>?
    /// The array (and unit) the string in ``preview`` was rendered from. A
    /// server response carries BOTH the blocks and their render, so recording it
    /// here stops the next pass asking for bytes already in hand - which on the
    /// first load would replace the byte-for-byte legacy conversion with a
    /// second render of it.
    @ObservationIgnored
    private var previewedBlocks: [DescriptionBlock]?
    @ObservationIgnored
    private var previewedUnit: MeasurementUnit?
    @ObservationIgnored
    private var loadedFor: String?

    private func previewScheduler() -> DescriptionPreviewScheduler<PreviewPayload, String> {
        if let scheduler { return scheduler }
        let made = DescriptionPreviewScheduler<PreviewPayload, String>(
            fetcher: { payload in
                try await DescriptionBlocksService.preview(
                    listingId: payload.listingId,
                    blocks: payload.blocks,
                    unit: payload.unit
                )
            },
            onResult: { [weak self] value in await self?.applyPreview(value) },
            onPending: { [weak self] value in await self?.setPreviewPending(value) }
        )
        scheduler = made
        return made
    }

    private func applyPreview(_ value: String) { preview = value }
    private func setPreviewPending(_ value: Bool) { previewPending = value }

    // MARK: - Load

    /// Point the store at a listing. Safe to call on every appearance: the load
    /// runs once per listing id.
    func configure(listingId: String?, unit: MeasurementUnit) async {
        let unitChanged = unit != self.unit
        self.unit = unit
        self.listingId = listingId

        guard let listingId else { return }
        if loadedFor == listingId {
            if unitChanged { requestPreview() }
            return
        }
        loadedFor = listingId
        loading = true
        defer { loading = false }
        do {
            let response = try await DescriptionBlocksService.load(
                listingId: listingId, unit: unit
            )
            // The preview is adopted VERBATIM, not re-rendered. See the header.
            adopt(blocks: response.blocks, description: response.preview)
            converted = response.converted
            hydrated = true
            message = nil
        } catch {
            // Silent about the network, explicit about the consequence: the
            // section switches to its unavailable state, where saving is
            // refused. A toast per failed load would fire on every offline
            // reopen.
            loadedFor = nil
        }
    }

    func loadSnippets() async {
        snippets = await DescriptionBlocksService.snippets()
        snippetsLoaded = true
    }

    /// Adopt a server response: the blocks, the string they rendered to, and the
    /// guard that stops the next pass re-requesting it.
    private func adopt(blocks: [DescriptionBlock], description: String) {
        self.blocks = blocks
        previewedBlocks = blocks
        previewedUnit = unit
        preview = description
        dirty = false
    }

    // MARK: - Edits

    func setBlocks(_ next: [DescriptionBlock]) {
        blocks = next
        // Only a listing row can hold blocks, so with no listing there is
        // nothing to persist and nothing to be dirty about - marking it would
        // leave Save lit and the back-swipe warning armed for the rest of the
        // visit, with no write that could ever clear them.
        dirty = listingId != nil
        requestPreview()
    }

    func toggle(at index: Int) {
        setBlocks(DescriptionBlocks.toggle(blocks, at: index))
    }

    func setText(at index: Int, to text: String) {
        setBlocks(DescriptionBlocks.setText(blocks, at: index, to: text))
    }

    func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        setBlocks(
            DescriptionBlocks.move(blocks, fromOffsets: source, toOffset: destination)
        )
    }

    func addSnippet(ref: String) {
        setBlocks(DescriptionBlocks.addSnippet(blocks, ref: ref))
    }

    func remove(at index: Int) {
        setBlocks(DescriptionBlocks.remove(blocks, at: index))
    }

    /// Fold a whole-description string into the array.
    ///
    /// The garment template and the AI rewrite each hand back ONE string for the
    /// whole prose part. Blocks are the source of truth, so a string that only
    /// reached the item's description column would be rendered away by the next
    /// save.
    func applyWholeText(_ text: String) {
        setBlocks(DescriptionBlocks.applyWholeText(blocks, text: text))
    }

    /// Re-render whenever the array or the unit changes - EXCEPT when the string
    /// for that exact array is already in hand.
    private func requestPreview() {
        guard let listingId else { return }
        if previewedBlocks == blocks && previewedUnit == unit { return }
        previewedBlocks = blocks
        previewedUnit = unit
        let payload = PreviewPayload(listingId: listingId, blocks: blocks, unit: unit)
        let scheduler = previewScheduler()
        Task { await scheduler.request(payload) }
    }

    /// Drop the pending render and orphan anything in flight.
    func cancelPreview() {
        guard let scheduler else { return }
        Task { await scheduler.cancel() }
    }

    // MARK: - Save and regenerate

    /// Persist the current array. Returns the rendered description, or nil.
    @discardableResult
    func save() async -> String? {
        guard let listingId, ready else { return nil }
        do {
            let response = try await DescriptionBlocksService.save(
                listingId: listingId, blocks: blocks, unit: unit
            )
            adopt(blocks: response.blocks, description: response.description)
            converted = false
            message = nil
            return response.description
        } catch {
            message = "The description sections could not be saved."
            return nil
        }
    }

    /// Rewrite one AI block server-side.
    func regenerate(_ key: DescriptionBlockKey) async {
        guard let listingId, regenerating == nil else { return }
        regenerating = key
        defer { regenerating = nil }
        do {
            let response = try await DescriptionBlocksService.regenerate(
                listingId: listingId, block: key, unit: unit
            )
            adopt(blocks: response.blocks, description: response.description)
            message = nil
        } catch {
            message = (error as? LocalizedError)?.errorDescription
                ?? "That section could not be rewritten."
        }
    }

    /// What a row's one-line summary reads from, beyond the block itself.
    func rowContext(
        attributes: [String: String],
        measurementCount: Int,
        gradeValue: Double?
    ) -> DescriptionBlocks.RowContext {
        DescriptionBlocks.RowContext(
            attributes: attributes,
            measurementCount: measurementCount,
            unit: DescriptionBlocksService.wireUnit(unit),
            gradeValue: gradeValue,
            snippetNames: Dictionary(
                snippets.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }
            ),
            snippetsLoaded: snippetsLoaded
        )
    }
}
