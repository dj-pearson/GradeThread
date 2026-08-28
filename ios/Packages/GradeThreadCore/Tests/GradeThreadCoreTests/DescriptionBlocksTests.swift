import XCTest
@testable import GradeThreadCore

/// US-2964: the mobile block list's pure half. Mirrors
/// src/lib/__tests__/description-blocks.test.ts, because a block array written
/// on a phone is read by the web composer and the two have to agree about what
/// a move, a toggle and a whole-string apply mean.
final class DescriptionBlocksTests: XCTestCase {

    private func sample() -> [DescriptionBlock] { DescriptionBlocks.defaults }

    // MARK: - Wire shape

    func test_decode_defaultsOnToTrueAndSrcToUser() throws {
        let json = #"[{"key":"intro","text":"Hi"}]"#.data(using: .utf8)!
        let blocks = try JSONDecoder().decode([DescriptionBlock].self, from: json)
        XCTAssertEqual(blocks.count, 1)
        XCTAssertTrue(blocks[0].on)
        XCTAssertEqual(blocks[0].src, .user)
        XCTAssertEqual(blocks[0].text, "Hi")
    }

    /// Version skew is a hard failure, not a silent drop. Quietly discarding a
    /// key this build does not know would delete a section of the seller's
    /// description without telling anyone - the edge `parseBlocks` rejects the
    /// same payload for the same reason.
    func test_decode_rejectsAnUnknownBlockKey() {
        let json = #"[{"key":"shipping","on":true,"src":"user"}]"#.data(using: .utf8)!
        XCTAssertThrowsError(
            try JSONDecoder().decode([DescriptionBlock].self, from: json)
        )
    }

    /// `sep` is the bytes that precede the block in the rendered output, so an
    /// absent one must stay absent - encoding a null would renormalise the
    /// whitespace of every converted listing on its first save.
    func test_encode_omitsAbsentOptionals_andRoundTripsSep() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        let bare = DescriptionBlock(key: .facts, on: true, src: .system)
        let bareJSON = String(data: try encoder.encode(bare), encoding: .utf8) ?? ""
        XCTAssertEqual(bareJSON, #"{"key":"facts","on":true,"src":"system"}"#)

        let kept = DescriptionBlock(key: .text, on: true, src: .user, text: "x", sep: "\n")
        let round = try JSONDecoder().decode(
            DescriptionBlock.self, from: try encoder.encode(kept)
        )
        XCTAssertEqual(round.sep, "\n")
    }

    // MARK: - Array operations

    func test_toggle_keepsTheBlockAtItsIndex() {
        let blocks = sample()
        let index = 4 // measurements
        let off = DescriptionBlocks.toggle(blocks, at: index)
        XCTAssertFalse(off[index].on)
        XCTAssertEqual(off[index].key, .measurements)

        let backOn = DescriptionBlocks.toggle(off, at: index)
        XCTAssertEqual(backOn, blocks)
    }

    func test_toggle_ignoresAnOutOfRangeIndex() {
        let blocks = sample()
        XCTAssertEqual(DescriptionBlocks.toggle(blocks, at: 99), blocks)
        XCTAssertEqual(DescriptionBlocks.toggle(blocks, at: -1), blocks)
    }

    func test_setText_touchesOnlyThatRow() {
        let blocks = sample()
        let out = DescriptionBlocks.setText(blocks, at: 0, to: "Fresh intro")
        XCTAssertEqual(out[0].text, "Fresh intro")
        XCTAssertEqual(Array(out.dropFirst()), Array(blocks.dropFirst()))
    }

    /// The pinned rows hold their indices whatever the drag does, which is what
    /// stops a revise-in-place accumulating a second facts block (US-2682).
    func test_move_keepsPinnedRowsAtTheirIndices() {
        let blocks = sample()
        let out = DescriptionBlocks.move(blocks, from: 0, to: 3)
        XCTAssertEqual(out.count, blocks.count)
        XCTAssertEqual(out[7].key, .credentials)
        XCTAssertEqual(out[8].key, .facts)
        XCTAssertEqual(out[3].key, .intro)
        XCTAssertEqual(out[0].key, .features)
    }

    func test_move_refusesADragOntoOrFromAPinnedRow() {
        let blocks = sample()
        XCTAssertEqual(DescriptionBlocks.move(blocks, from: 0, to: 8), blocks)
        XCTAssertEqual(DescriptionBlocks.move(blocks, from: 8, to: 0), blocks)
    }

    /// SwiftUI hands over the index the row lands ABOVE, so a downward drag
    /// arrives one past the slot it means.
    func test_move_normalisesTheSwiftUIDestination() {
        let blocks = sample()
        let dragged = DescriptionBlocks.move(
            blocks, fromOffsets: IndexSet(integer: 0), toOffset: 4
        )
        XCTAssertEqual(dragged, DescriptionBlocks.move(blocks, from: 0, to: 3))
    }

    func test_addSnippet_landsAboveThePinnedRows() {
        let out = DescriptionBlocks.addSnippet(sample(), ref: "snip-1")
        XCTAssertEqual(out[7].key, .snippet)
        XCTAssertEqual(out[7].ref, "snip-1")
        XCTAssertEqual(out[8].key, .credentials)
        XCTAssertEqual(out[9].key, .facts)
        // The body lives on the account; the block carries the ref and nothing
        // else, so editing the snippet changes every listing pointing at it.
        XCTAssertNil(out[7].text)
    }

    func test_remove_dropsOnlyThatRow() {
        let blocks = DescriptionBlocks.addSnippet(sample(), ref: "snip-1")
        let out = DescriptionBlocks.remove(blocks, at: 7)
        XCTAssertEqual(out.count, blocks.count - 1)
        XCTAssertFalse(out.contains { $0.key == .snippet })
    }

    // MARK: - Whole-string writers

    func test_stripRenderedBlocks_removesMarkedSectionsAndTheOpenOnlyTail() {
        let text = """
        Great tee.

        <!--gradethread-measurements-->Chest: 42 in<!--/gradethread-measurements-->

        More prose.

        <!--gradethread-seller-credentials--><div>Verified</div>
        """
        let out = DescriptionBlocks.stripRenderedBlocks(text)
        XCTAssertFalse(out.contains("gradethread"))
        XCTAssertFalse(out.contains("Chest: 42 in"))
        XCTAssertFalse(out.contains("Verified"))
        XCTAssertTrue(out.hasPrefix("Great tee."))
        XCTAssertTrue(out.contains("More prose."))
    }

    func test_applyWholeText_fillsIntroAndClearsTheOtherProseRows() {
        var blocks = sample()
        blocks[1].text = "Old features"
        blocks[3].text = "Old condition"

        let out = DescriptionBlocks.applyWholeText(blocks, text: "A brand new description.")
        XCTAssertEqual(out[0].key, .intro)
        XCTAssertEqual(out[0].text, "A brand new description.")
        XCTAssertTrue(out[0].on)
        XCTAssertEqual(out[1].text, "")
        XCTAssertEqual(out[3].text, "")
        // Derived rows are untouched - that is the point of the split.
        XCTAssertEqual(out[4], blocks[4])
        XCTAssertEqual(out[8], blocks[8])
    }

    func test_applyWholeText_stripsTheRenderedMarkersOutOfTheString() {
        let text = "Body copy.\n\n<!--gradethread-seller-credentials--><div>V</div>"
        let out = DescriptionBlocks.applyWholeText(sample(), text: text)
        XCTAssertEqual(out[0].text, "Body copy.")
    }

    func test_applyWholeText_insertsAnIntroWhenTheArrayHasNone() {
        let blocks = [DescriptionBlock(key: .facts, on: true, src: .system)]
        let out = DescriptionBlocks.applyWholeText(blocks, text: "Prose.")
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].key, .intro)
        XCTAssertEqual(out[0].src, .ai)
        XCTAssertEqual(out[0].text, "Prose.")
    }

    // MARK: - Row summaries

    func test_describe_derivedRowsSayWhatTheyWillShow() {
        var ctx = DescriptionBlocks.RowContext(
            attributes: ["brand": "Patagonia", "size": " ", "color": "Navy"],
            measurementCount: 1,
            unit: "in",
            gradeValue: 8.5
        )
        let blocks = sample()
        XCTAssertEqual(
            DescriptionBlocks.describe(blocks[2], context: ctx), "Brand, Color"
        )
        XCTAssertEqual(
            DescriptionBlocks.describe(blocks[4], context: ctx), "1 value, inches"
        )
        XCTAssertEqual(DescriptionBlocks.describe(blocks[5], context: ctx), "8.5 / 10")

        ctx.measurementCount = 3
        ctx.unit = "cm"
        XCTAssertEqual(
            DescriptionBlocks.describe(blocks[4], context: ctx), "3 values, centimetres"
        )

        ctx.gradeValue = nil
        XCTAssertEqual(DescriptionBlocks.describe(blocks[5], context: ctx), "Not graded yet")
    }

    /// A ref missing from a list that has not loaded is not a deleted snippet,
    /// and saying so would libel a perfectly good section for as long as the
    /// request takes.
    func test_describe_snippetWaitsForTheNameListBeforeCallingItDeleted() {
        let block = DescriptionBlock(key: .snippet, on: true, src: .account, ref: "gone")
        var ctx = DescriptionBlocks.RowContext()
        XCTAssertEqual(DescriptionBlocks.describe(block, context: ctx), "Saved snippet")

        ctx.snippetsLoaded = true
        XCTAssertEqual(
            DescriptionBlocks.describe(block, context: ctx),
            "Deleted snippet, so this section shows nothing"
        )

        ctx.snippetNames = ["gone": "Returns policy"]
        XCTAssertEqual(DescriptionBlocks.describe(block, context: ctx), "Returns policy")
    }

    func test_describe_aPerListingOverrideBeatsTheSnippetName() {
        let block = DescriptionBlock(
            key: .snippet, on: true, src: .account, text: "My own words", ref: "s1"
        )
        let ctx = DescriptionBlocks.RowContext(
            snippetNames: ["s1": "Returns policy"], snippetsLoaded: true
        )
        XCTAssertEqual(DescriptionBlocks.describe(block, context: ctx), "My own words")
    }

    // MARK: - Row metadata

    func test_pinnedEditableAndRegenerableSetsMatchTheWeb() {
        XCTAssertEqual(DescriptionBlocks.pinnedKeys, [.credentials, .facts])
        XCTAssertEqual(
            DescriptionBlocks.editableKeys, [.intro, .features, .condition, .snippet, .text]
        )
        XCTAssertEqual(DescriptionBlocks.regenerableKeys, [.intro, .features, .condition])
        XCTAssertEqual(DescriptionBlocks.anchor(for: .disclosure), .grade)
        XCTAssertNil(DescriptionBlocks.anchor(for: .intro))
        XCTAssertTrue(DescriptionBlocks.isRemovable(.text))
        XCTAssertFalse(DescriptionBlocks.isRemovable(.measurements))
    }
}
