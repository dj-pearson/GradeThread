import XCTest
@testable import GradeThread

/// US-674 — listing templates: wire decode, the editor's specifics-collapse,
/// and the store's load / save (create + update + single-default) / delete logic
/// via a faked service.
final class TemplatesTests: XCTestCase {

    // MARK: - Decode (model declares explicit snake_case keys; supabase-swift's
    // default decoder applies no key conversion, so the free-form item_specifics
    // map keys survive intact — the whole reason CRUD goes direct, not via EdgeAPI).

    private func snakeDecoder() -> JSONDecoder {
        JSONDecoder()
    }

    func test_decode_fullRow() throws {
        let json = """
        {
          "id": "t1", "name": "Default kit",
          "description_template": "Ships fast.", "ebay_condition": "USED_GOOD",
          "condition_description": "light wear",
          "item_specifics": { "Brand": "Nike", "Department": "Men" },
          "ebay_category_id": "57988", "return_policy_id": "rp",
          "shipping_policy_id": "sp", "payment_policy_id": "pp",
          "is_default": true, "sort_order": 2
        }
        """.data(using: .utf8)!
        let t = try snakeDecoder().decode(ListingTemplate.self, from: json)
        XCTAssertEqual(t.id, "t1")
        XCTAssertEqual(t.name, "Default kit")
        XCTAssertEqual(t.descriptionTemplate, "Ships fast.")
        XCTAssertEqual(t.ebayCondition, "USED_GOOD")
        XCTAssertEqual(t.itemSpecifics["Brand"], "Nike")
        XCTAssertEqual(t.shippingPolicyId, "sp")
        XCTAssertTrue(t.isDefault)
        XCTAssertEqual(t.sortOrder, 2)
    }

    func test_decode_absentItemSpecificsDefaultsEmpty() throws {
        let json = """
        { "id": "t2", "name": "Minimal", "is_default": false, "sort_order": 0 }
        """.data(using: .utf8)!
        let t = try snakeDecoder().decode(ListingTemplate.self, from: json)
        XCTAssertEqual(t.itemSpecifics, [:])
        XCTAssertNil(t.descriptionTemplate)
        XCTAssertFalse(t.isDefault)
    }

    // MARK: - Draft round-trip + collapse

    func test_draftFromTemplate_roundTrips() {
        let t = ListingTemplate(
            id: "t", name: "T", descriptionTemplate: "boiler",
            ebayCondition: "USED_GOOD", itemSpecifics: ["A": "1"], isDefault: true
        )
        let d = TemplateDraft(from: t)
        XCTAssertEqual(d.name, "T")
        XCTAssertEqual(d.descriptionTemplate, "boiler")
        XCTAssertEqual(d.ebayCondition, "USED_GOOD")
        XCTAssertEqual(d.itemSpecifics, ["A": "1"])
        XCTAssertTrue(d.isDefault)
        XCTAssertTrue(d.isValid)
    }

    func test_collapse_trimsAndDropsBlankRows() {
        let pairs = [
            SpecificPair(name: "  Brand ", value: " Nike "),
            SpecificPair(name: "", value: "x"),         // blank name dropped
            SpecificPair(name: "Size", value: "   "),   // blank value dropped
            SpecificPair(name: "Color", value: "Blue"),
        ]
        XCTAssertEqual(
            TemplateEditorSheet.collapse(pairs),
            ["Brand": "Nike", "Color": "Blue"]
        )
    }

    func test_draft_isInvalidWithBlankName() {
        var d = TemplateDraft()
        d.name = "   "
        XCTAssertFalse(d.isValid)
    }

    // MARK: - Store

    final class FakeService: TemplateProviding {
        var items: [ListingTemplate]
        var listError: Error?
        var saveError: Error?
        var deleteError: Error?
        private(set) var deleted: [String] = []
        private var seq = 0

        init(items: [ListingTemplate] = []) { self.items = items }

        func list() async throws -> [ListingTemplate] {
            if let listError { throw listError }
            return items
        }
        func create(_ draft: TemplateDraft) async throws -> ListingTemplate {
            if let saveError { throw saveError }
            seq += 1
            return materialize(id: "new-\(seq)", draft)
        }
        func update(id: String, _ draft: TemplateDraft) async throws -> ListingTemplate {
            if let saveError { throw saveError }
            return materialize(id: id, draft)
        }
        func delete(id: String) async throws {
            if let deleteError { throw deleteError }
            deleted.append(id)
            items.removeAll { $0.id == id }
        }

        private func materialize(id: String, _ d: TemplateDraft) -> ListingTemplate {
            ListingTemplate(
                id: id, name: d.name,
                descriptionTemplate: d.descriptionTemplate.isEmpty ? nil : d.descriptionTemplate,
                ebayCondition: d.ebayCondition.isEmpty ? nil : d.ebayCondition,
                itemSpecifics: d.itemSpecifics, isDefault: d.isDefault, sortOrder: d.sortOrder
            )
        }
    }

    @MainActor
    func test_load_sortsBySortOrderThenName() async {
        let fake = FakeService(items: [
            ListingTemplate(id: "b", name: "Zed", sortOrder: 0),
            ListingTemplate(id: "a", name: "Alpha", sortOrder: 0),
            ListingTemplate(id: "c", name: "First", sortOrder: -1),
        ])
        let store = TemplateStore(service: fake)
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.templates.map(\.id), ["c", "a", "b"])
    }

    @MainActor
    func test_save_createAppendsTemplate() async {
        let fake = FakeService()
        let store = TemplateStore(service: fake)
        await store.load()
        var draft = TemplateDraft()
        draft.name = "New"
        let ok = await store.save(draft, editingId: nil)
        XCTAssertTrue(ok)
        XCTAssertEqual(store.templates.count, 1)
        XCTAssertEqual(store.templates.first?.name, "New")
    }

    @MainActor
    func test_save_settingDefaultClearsOthers() async {
        let fake = FakeService(items: [
            ListingTemplate(id: "a", name: "A", isDefault: true),
            ListingTemplate(id: "b", name: "B", isDefault: false),
        ])
        let store = TemplateStore(service: fake)
        await store.load()
        var draft = TemplateDraft(from: store.templates.first { $0.id == "b" }!)
        draft.isDefault = true
        _ = await store.save(draft, editingId: "b")
        XCTAssertEqual(store.defaultTemplate?.id, "b")
        XCTAssertEqual(store.templates.filter(\.isDefault).count, 1)
    }

    @MainActor
    func test_save_failureLeavesPreviousDefaultIntact() async {
        // US-1265: promoting "b" to default that fails to persist must NOT wipe
        // the existing default ("a"). The store never mutates on a failed save,
        // and the service now clears+writes atomically server-side, so there's
        // no window of zero defaults.
        let fake = FakeService(items: [
            ListingTemplate(id: "a", name: "A", isDefault: true),
            ListingTemplate(id: "b", name: "B", isDefault: false),
        ])
        fake.saveError = EdgeAPIError.badRequest(detail: "write failed")
        let store = TemplateStore(service: fake)
        await store.load()
        var draft = TemplateDraft(from: store.templates.first { $0.id == "b" }!)
        draft.isDefault = true
        let ok = await store.save(draft, editingId: "b")
        XCTAssertFalse(ok)
        XCTAssertEqual(store.defaultTemplate?.id, "a")
        XCTAssertEqual(store.templates.filter(\.isDefault).count, 1)
        XCTAssertNotNil(store.actionError)
    }

    @MainActor
    func test_save_failureSurfacesError() async {
        let fake = FakeService()
        fake.saveError = EdgeAPIError.badRequest(detail: "dup name")
        let store = TemplateStore(service: fake)
        await store.load()
        var draft = TemplateDraft()
        draft.name = "X"
        let ok = await store.save(draft, editingId: nil)
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.actionError)
    }

    @MainActor
    func test_delete_optimisticRemoveAndRecordsCall() async {
        let fake = FakeService(items: [ListingTemplate(id: "a", name: "A")])
        let store = TemplateStore(service: fake)
        await store.load()
        await store.delete(store.templates[0])
        XCTAssertTrue(store.templates.isEmpty)
        XCTAssertEqual(fake.deleted, ["a"])
    }

    @MainActor
    func test_delete_failureRestoresFromReload() async {
        let fake = FakeService(items: [ListingTemplate(id: "a", name: "A")])
        fake.deleteError = EdgeAPIError.rateLimited
        let store = TemplateStore(service: fake)
        await store.load()
        await store.delete(store.templates[0])
        // delete threw before mutating fake.items, so reload restores the row.
        XCTAssertEqual(store.templates.map(\.id), ["a"])
        XCTAssertNotNil(store.actionError)
    }

    // MARK: - Composer apply (US-1264): applying a template in the publish
    // composer must set the FULL field set (item specifics, category, business
    // policies) into composer state, not just description/condition — matching
    // AutoLister, which overlays the same fields server-side.

    /// Start from an empty composer (no prior edits).
    private func emptyApply(_ template: ListingTemplate) -> ComposerTemplateApply {
        ComposerTemplateApply.apply(
            template: template,
            description: "",
            condition: .usedExcellent,
            conditionDescription: "",
            itemSpecifics: [:],
            ebayCategoryId: nil,
            returnPolicyId: nil,
            shippingPolicyId: nil,
            paymentPolicyId: nil
        )
    }

    func test_composerApply_setsCategoryPoliciesAndSpecifics() {
        let template = ListingTemplate(
            id: "t", name: "Full kit",
            descriptionTemplate: "Ships in 1 business day.",
            ebayCondition: "USED_GOOD",
            conditionDescription: "light wear at cuffs",
            itemSpecifics: ["Brand": "Levi's", "Department": "Men"],
            ebayCategoryId: "57988",
            returnPolicyId: "rp-1",
            shippingPolicyId: "sp-1",
            paymentPolicyId: "pp-1"
        )
        let applied = emptyApply(template)

        // Description + condition + note (existing behavior).
        XCTAssertEqual(applied.description, "Ships in 1 business day.")
        XCTAssertEqual(applied.condition, .usedGood)
        XCTAssertEqual(applied.conditionDescription, "light wear at cuffs")
        // US-1264: the previously-dropped fields are now applied.
        XCTAssertEqual(applied.itemSpecifics, ["Brand": "Levi's", "Department": "Men"])
        XCTAssertEqual(applied.ebayCategoryId, "57988")
        XCTAssertEqual(applied.returnPolicyId, "rp-1")
        XCTAssertEqual(applied.shippingPolicyId, "sp-1")
        XCTAssertEqual(applied.paymentPolicyId, "pp-1")
    }

    /// The applied state flows into ComposerEdits, which saveDraft persists onto
    /// the listing draft where the server-side publish context reads them.
    func test_composerApply_flowsIntoComposerEdits() {
        let template = ListingTemplate(
            id: "t", name: "Kit",
            itemSpecifics: ["Brand": "Nike"],
            ebayCategoryId: "11450",
            returnPolicyId: "rp", shippingPolicyId: "sp", paymentPolicyId: "pp"
        )
        let applied = emptyApply(template)
        let edits = ComposerEdits(
            title: "Nike tee",
            condition: applied.condition,
            conditionDescription: applied.conditionDescription,
            description: applied.description,
            itemSpecifics: applied.itemSpecifics,
            ebayCategoryId: applied.ebayCategoryId,
            returnPolicyId: applied.returnPolicyId,
            shippingPolicyId: applied.shippingPolicyId,
            paymentPolicyId: applied.paymentPolicyId
        )
        XCTAssertEqual(edits.itemSpecifics, ["Brand": "Nike"])
        XCTAssertEqual(edits.ebayCategoryId, "11450")
        XCTAssertEqual(edits.shippingPolicyId, "sp")
        XCTAssertEqual(edits.paymentPolicyId, "pp")
        XCTAssertEqual(edits.returnPolicyId, "rp")
    }

    /// A sparse template only sets what it provides — unset category/policies/
    /// specifics leave the composer's existing values untouched (no clobber).
    func test_composerApply_sparseTemplateLeavesExistingValuesIntact() {
        let sparse = ListingTemplate(
            id: "t", name: "Note only",
            conditionDescription: "minor pilling"
        )
        let applied = ComposerTemplateApply.apply(
            template: sparse,
            description: "Original copy.",
            condition: .likeNew,
            conditionDescription: "",
            itemSpecifics: ["Brand": "Existing"],
            ebayCategoryId: "existing-cat",
            returnPolicyId: "existing-rp",
            shippingPolicyId: "existing-sp",
            paymentPolicyId: "existing-pp"
        )
        // Note overwrote (provided); everything else stayed put.
        XCTAssertEqual(applied.conditionDescription, "minor pilling")
        XCTAssertEqual(applied.description, "Original copy.")
        XCTAssertEqual(applied.condition, .likeNew)
        XCTAssertEqual(applied.itemSpecifics, ["Brand": "Existing"])
        XCTAssertEqual(applied.ebayCategoryId, "existing-cat")
        XCTAssertEqual(applied.returnPolicyId, "existing-rp")
        XCTAssertEqual(applied.shippingPolicyId, "existing-sp")
        XCTAssertEqual(applied.paymentPolicyId, "existing-pp")
    }
}
