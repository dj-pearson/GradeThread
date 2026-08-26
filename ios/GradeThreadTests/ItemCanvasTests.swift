import XCTest
import SwiftData
@testable import GradeThread

@MainActor
final class ItemCanvasTests: XCTestCase {

    // MARK: - ItemDraft

    func test_draft_initFromItem_capturesEveryField() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = LocalInventoryItem(
            id: "i1", userId: "u",
            title: "Linen blazer", status: "cataloged",
            createdAt: .now, updatedAt: .now
        )
        item.brand = "Patagonia"
        item.sku = "S-12"
        item.size = "M"
        item.color = "navy"
        item.material = "linen"
        item.conditionNotes = "Light wear"
        item.targetPrice = 35.0
        item.acquiredPrice = 4.50
        context.insert(item)

        let draft = ItemDraft(from: item)
        XCTAssertEqual(draft.title, "Linen blazer")
        XCTAssertEqual(draft.brand, "Patagonia")
        XCTAssertEqual(draft.sku, "S-12")
        XCTAssertEqual(draft.size, "M")
        XCTAssertEqual(draft.color, "navy")
        XCTAssertEqual(draft.material, "linen")
        XCTAssertEqual(draft.conditionNotes, "Light wear")
        XCTAssertEqual(draft.status, "cataloged")
        XCTAssertEqual(draft.targetPriceText, "35")
        XCTAssertEqual(draft.acquiredPriceText, "4.5")
    }

    func test_draft_equatable_detectsAnyFieldChange() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)
        let base = ItemDraft(from: item)

        var b = base
        b.title = "Different"
        XCTAssertNotEqual(b, base)

        var c = base
        c.targetPriceText = "9.99"
        XCTAssertNotEqual(c, base)

        var d = base
        XCTAssertEqual(d, base, "same fields should equal")
        d.notesAndMore()
        XCTAssertNotEqual(d, base)
    }

    // MARK: - StatusGuard

    func test_statusGuard_allowsForwardTransitions() {
        XCTAssertTrue(StatusGuard.allows(from: "cataloged", to: "drafted"))
        XCTAssertTrue(StatusGuard.allows(from: "drafted", to: "listed"))
        XCTAssertTrue(StatusGuard.allows(from: "listed", to: "sold"))
        XCTAssertTrue(StatusGuard.allows(from: "sold", to: "shipped"))
        XCTAssertTrue(StatusGuard.allows(from: "shipped", to: "completed"))
    }

    func test_statusGuard_blocksRegressionFromTerminal() {
        XCTAssertFalse(StatusGuard.allows(from: "sold", to: "cataloged"))
        XCTAssertFalse(StatusGuard.allows(from: "shipped", to: "drafted"))
        XCTAssertFalse(StatusGuard.allows(from: "completed", to: "listed"))
        XCTAssertFalse(StatusGuard.allows(from: "returned", to: "cataloged"))
        XCTAssertFalse(StatusGuard.allows(from: "archived", to: "cataloged"))
    }

    func test_statusGuard_allowsTerminalToTerminal() {
        // Sold → returned (returned-after-sale) is valid; shipped →
        // completed is the common path. Terminal-to-terminal stays open.
        XCTAssertTrue(StatusGuard.allows(from: "sold", to: "returned"))
        XCTAssertTrue(StatusGuard.allows(from: "shipped", to: "completed"))
    }

    func test_statusGuard_sameStatusAlwaysAllowed() {
        for status in StatusGuard.terminalStates {
            XCTAssertTrue(StatusGuard.allows(from: status, to: status))
        }
    }

    func test_statusGuard_isPreSale_classifies() {
        XCTAssertTrue(StatusGuard.isPreSale("cataloged"))
        XCTAssertTrue(StatusGuard.isPreSale("drafted"))
        XCTAssertTrue(StatusGuard.isPreSale("listed"))
        XCTAssertFalse(StatusGuard.isPreSale("sold"))
        XCTAssertFalse(StatusGuard.isPreSale("shipped"))
    }

    // MARK: - ItemCanvasState

    func test_canvasState_initialNotDirty_andSavable() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)

        let state = ItemCanvasState(item: item)
        XCTAssertFalse(state.isDirty)
        XCTAssertTrue(state.isSavable, "default title 'Item' is non-empty")
    }

    func test_canvasState_titleEdit_isDirty() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)
        let state = ItemCanvasState(item: item)

        state.draft.title = "Edited"
        XCTAssertTrue(state.isDirty)
    }

    func test_canvasState_emptyTitle_blocksSave() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)
        let state = ItemCanvasState(item: item)

        state.draft.title = "   "
        XCTAssertTrue(state.isDirty)
        XCTAssertFalse(state.isSavable, "whitespace title shouldn't satisfy savable")
    }

    func test_canvasState_acceptDraftAsOriginal_resetsDirty() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)
        let state = ItemCanvasState(item: item)

        state.draft.brand = "Brand X"
        XCTAssertTrue(state.isDirty)

        state.acceptDraftAsOriginal()
        XCTAssertFalse(state.isDirty)
        XCTAssertEqual(state.savePhase, .idle)
    }

    func test_canvasState_discardChanges_resetsDraft() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)
        let state = ItemCanvasState(item: item)

        state.draft.title = "Edited"
        state.draft.brand = "Other"
        XCTAssertTrue(state.isDirty)

        state.discardChanges()
        XCTAssertFalse(state.isDirty)
        XCTAssertEqual(state.draft, state.original)
    }

    func test_canvasState_canTransition_routesThroughStatusGuard() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let soldItem = makeItem(id: "i-sold", status: "sold", context: context)
        let state = ItemCanvasState(item: soldItem)

        XCTAssertFalse(state.canTransition(to: "cataloged"))
        XCTAssertTrue(state.canTransition(to: "shipped"))
        XCTAssertTrue(state.canTransition(to: "sold"))
    }

    func test_canvasState_parsedPrices_roundTripsThroughText() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)
        let state = ItemCanvasState(item: item)

        state.draft.targetPriceText = "12.50"
        state.draft.acquiredPriceText = ""
        let (target, cost) = state.parsedPrices()
        XCTAssertEqual(target, 12.5)
        XCTAssertNil(cost, "empty string should parse to nil, not 0")
    }

    // MARK: - refreshFromItem (US-682 post-intake sync into open canvas)

    func test_canvasState_refreshFromItem_foldsInSyncedFields_whenClean() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        // Simulate the post-intake row: created as "Untitled item" with no
        // AI fields yet, canvas opened against it.
        let item = LocalInventoryItem(
            id: "i1", userId: "u",
            title: "Untitled item", status: "cataloged",
            createdAt: .now, updatedAt: .now
        )
        context.insert(item)
        let state = ItemCanvasState(item: item)
        XCTAssertFalse(state.isDirty)

        // Sync pull lands the AI-extracted fields onto the row.
        item.title = "Patagonia fleece"
        item.brand = "Patagonia"
        item.size = "M"

        let didRefresh = state.refreshFromItem(item)
        XCTAssertTrue(didRefresh)
        XCTAssertEqual(state.draft.title, "Patagonia fleece")
        XCTAssertEqual(state.draft.brand, "Patagonia")
        XCTAssertEqual(state.draft.size, "M")
        XCTAssertFalse(state.isDirty, "refreshed values become the new clean baseline")
    }

    func test_canvasState_refreshFromItem_doesNotClobberUserEdits_whenDirty() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)
        let state = ItemCanvasState(item: item)

        // User starts typing before the sync pull lands.
        state.draft.title = "My title"
        XCTAssertTrue(state.isDirty)

        // A sync pull updates the underlying row in the background.
        item.title = "Server title"
        item.brand = "Server brand"

        let didRefresh = state.refreshFromItem(item)
        XCTAssertFalse(didRefresh, "should no-op while the user has pending edits")
        XCTAssertEqual(state.draft.title, "My title", "user edit preserved")
        XCTAssertEqual(state.draft.brand, "", "no server value folded in while dirty")
    }

    func test_canvasState_refreshFromItem_noChange_isNoOp() throws {
        let container = try makeContainer()
        let context = ModelContext(container)
        let item = makeItem(id: "i1", context: context)
        let state = ItemCanvasState(item: item)

        let didRefresh = state.refreshFromItem(item)
        XCTAssertFalse(didRefresh, "identical snapshot shouldn't report a refresh")
        XCTAssertFalse(state.isDirty)
    }

    // MARK: - Helpers

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([
            LocalInventoryItem.self,
            LocalItemPhoto.self,
            LocalListing.self,
            LocalSale.self,
            LocalSource.self,
            LocalSourcer.self,
            LocalPendingMutation.self,
        ])
        let config = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(for: schema, configurations: config)
    }

    private func makeItem(
        id: String,
        status: String = "cataloged",
        context: ModelContext
    ) -> LocalInventoryItem {
        let item = LocalInventoryItem(
            id: id, userId: "u",
            title: "Item",
            status: status,
            createdAt: .now,
            updatedAt: .now
        )
        context.insert(item)
        return item
    }
}

private extension ItemDraft {
    /// Throw-away mutator used by the equatable test. Touches a different
    /// field than the other inequality tests to broaden coverage.
    mutating func notesAndMore() {
        conditionNotes = "Modified"
        size = "L"
    }
}
