import XCTest
@testable import GradeThread

/// US-672 — repricing automation: wire decode (mirrors EdgeAPI's
/// convertFromSnakeCase), the editor draft helpers, and the store
/// (load / save / delete / toggle / run) via a faked service.
final class RepricingRulesTests: XCTestCase {

    private func snakeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    // MARK: - Decode

    func test_decode_rule() throws {
        let json = """
        {"id":"r1","name":"Markdown","enabled":true,"inventory_item_id":null,
         "filter_brand":"Nike","filter_category_id":"11450","min_age_days":14,
         "drop_pct":10,"interval_days":7,"floor_price_cents":999,
         "auto_accept_confidence":0.8,"last_run_at":"2024-01-20T00:00:00Z",
         "created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-02T00:00:00Z"}
        """.data(using: .utf8)!
        let r = try snakeDecoder().decode(RepricingRule.self, from: json)
        XCTAssertEqual(r.filterBrand, "Nike")
        XCTAssertEqual(r.minAgeDays, 14)
        XCTAssertEqual(r.dropPct, 10, accuracy: 0.001)
        XCTAssertEqual(r.floorPriceCents, 999)
        XCTAssertEqual(r.autoAcceptConfidence ?? 0, 0.8, accuracy: 0.001)
        XCTAssertNotNil(r.lastRun)
        XCTAssertTrue(r.actionSummary.contains("Drop 10%"))
        XCTAssertEqual(r.scopeSummary, "Nike · cat 11450 · 14d+ old")
    }

    func test_decode_action() throws {
        let json = """
        {"id":"a1","rule_id":"r1","listing_id":"l1","inventory_item_id":"i1",
         "old_price_cents":1000,"new_price_cents":900,"reason":"scheduled_markdown",
         "ebay_synced":true,"created_at":"2024-01-20T00:00:00Z",
         "inventory_items":{"title":"Wool coat","brand":"Nike"}}
        """.data(using: .utf8)!
        let a = try snakeDecoder().decode(RepricingAction.self, from: json)
        XCTAssertEqual(a.oldPriceCents, 1000)
        XCTAssertEqual(a.newDollars, 9.0, accuracy: 0.001)
        XCTAssertEqual(a.title, "Wool coat")
        XCTAssertEqual(a.reasonLabel, "Scheduled markdown")
        XCTAssertTrue(a.ebaySynced)
    }

    func test_decode_runResult_normalAndDisabled() throws {
        let normal = """
        {"ok":true,"applied":3,"listings_scanned":10,"rules_evaluated":2,"skipped":7,"errors":0}
        """.data(using: .utf8)!
        let r = try snakeDecoder().decode(RuleRunResult.self, from: normal)
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.appliedCount, 3)
        XCTAssertEqual(r.scannedCount, 10)

        let disabled = """
        {"ok":false,"skipped":true,"reason":"feature_disabled"}
        """.data(using: .utf8)!
        let d = try snakeDecoder().decode(RuleRunResult.self, from: disabled)
        XCTAssertFalse(d.ok)
        XCTAssertEqual(d.appliedCount, 0)
        XCTAssertEqual(d.reason, "feature_disabled")
    }

    // MARK: - Draft

    func test_draft_floorPriceCentsAndValidity() {
        var d = RuleDraft()
        d.name = "R"
        d.floorPrice = "9.99"
        XCTAssertEqual(d.floorPriceCents, 999)
        XCTAssertTrue(d.isValid)   // dropPct defaults to 10

        d.dropPct = 0
        d.autoAcceptEnabled = false
        XCTAssertFalse(d.isValid)  // no effect

        d.autoAcceptEnabled = true
        XCTAssertTrue(d.isValid)

        d.floorPrice = "   "
        XCTAssertNil(d.floorPriceCents)
    }

    // MARK: - Fake

    final class FakeService: RepricingRulesProviding {
        var rules: [RepricingRule]
        var actionsList: [RepricingAction]
        var runResult: RuleRunResult
        var listError: Error?
        var saveError: Error?
        var deleteError: Error?
        var runError: Error?
        private(set) var deleted: [String] = []
        private var seq = 0

        init(
            rules: [RepricingRule] = [],
            actions: [RepricingAction] = [],
            runResult: RuleRunResult = RuleRunResult(
                ok: true, applied: 2, listingsScanned: 5, rulesEvaluated: 1, skipped: 3, reason: nil
            )
        ) {
            self.rules = rules
            self.actionsList = actions
            self.runResult = runResult
        }

        func list() async throws -> [RepricingRule] {
            if let listError { throw listError }
            return rules
        }
        func create(_ draft: RuleDraft) async throws -> RepricingRule {
            if let saveError { throw saveError }
            seq += 1
            return materialize("new-\(seq)", draft)
        }
        func update(id: String, _ draft: RuleDraft) async throws -> RepricingRule {
            if let saveError { throw saveError }
            return materialize(id, draft)
        }
        func delete(id: String) async throws {
            if let deleteError { throw deleteError }
            deleted.append(id)
            rules.removeAll { $0.id == id }
        }
        func run() async throws -> RuleRunResult {
            if let runError { throw runError }
            return runResult
        }
        func actions() async throws -> [RepricingAction] { actionsList }

        private func materialize(_ id: String, _ d: RuleDraft) -> RepricingRule {
            RepricingRule(
                id: id, name: d.name, enabled: d.enabled,
                inventoryItemId: d.inventoryItemId,
                filterBrand: d.filterBrand.isEmpty ? nil : d.filterBrand,
                filterCategoryId: d.filterCategoryId.isEmpty ? nil : d.filterCategoryId,
                minAgeDays: d.minAgeDays, dropPct: d.dropPct, intervalDays: d.intervalDays,
                floorPriceCents: d.floorPriceCents,
                autoAcceptConfidence: d.autoAcceptEnabled ? d.autoAcceptConfidence : nil,
                lastRunAt: nil
            )
        }
    }

    private func rule(_ id: String, name: String = "R", enabled: Bool = true) -> RepricingRule {
        RepricingRule(
            id: id, name: name, enabled: enabled, inventoryItemId: nil,
            filterBrand: nil, filterCategoryId: nil, minAgeDays: 0, dropPct: 10,
            intervalDays: 7, floorPriceCents: nil, autoAcceptConfidence: nil, lastRunAt: nil
        )
    }

    // MARK: - Store

    @MainActor
    func test_load_populatesRulesAndActions() async {
        let fake = FakeService(rules: [rule("a")], actions: [])
        let store = RepricingRulesStore(service: fake)
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.rules.map(\.id), ["a"])
    }

    @MainActor
    func test_save_createAppends_updateReplaces() async {
        let fake = FakeService(rules: [rule("a")])
        let store = RepricingRulesStore(service: fake)
        await store.load()

        var draft = RuleDraft()
        draft.name = "New rule"
        let didCreate = await store.save(draft, editingId: nil)
        XCTAssertTrue(didCreate)
        XCTAssertEqual(store.rules.count, 2)

        var edit = RuleDraft(from: store.rules[0])
        edit.name = "Renamed"
        let didEdit = await store.save(edit, editingId: "a")
        XCTAssertTrue(didEdit)
        XCTAssertEqual(store.rules.first { $0.id == "a" }?.name, "Renamed")
    }

    @MainActor
    func test_delete_optimisticAndRecords() async {
        let fake = FakeService(rules: [rule("a")])
        let store = RepricingRulesStore(service: fake)
        await store.load()
        await store.delete(store.rules[0])
        XCTAssertTrue(store.rules.isEmpty)
        XCTAssertEqual(fake.deleted, ["a"])
    }

    @MainActor
    func test_delete_failureReloads() async {
        let fake = FakeService(rules: [rule("a")])
        fake.deleteError = EdgeAPIError.rateLimited
        let store = RepricingRulesStore(service: fake)
        await store.load()
        await store.delete(store.rules[0])
        XCTAssertEqual(store.rules.map(\.id), ["a"])   // restored
        XCTAssertNotNil(store.actionError)
    }

    @MainActor
    func test_toggleEnabled_flipsFlag() async {
        let fake = FakeService(rules: [rule("a", enabled: true)])
        let store = RepricingRulesStore(service: fake)
        await store.load()
        await store.toggleEnabled(store.rules[0])
        XCTAssertEqual(store.rules.first?.enabled, false)
    }

    @MainActor
    func test_runNow_setsBannerFromApplied() async {
        let fake = FakeService(
            rules: [rule("a")],
            runResult: RuleRunResult(ok: true, applied: 2, listingsScanned: 5, rulesEvaluated: 1, skipped: 3, reason: nil)
        )
        let store = RepricingRulesStore(service: fake)
        await store.load()
        await store.runNow()
        XCTAssertEqual(store.banner, "Repriced 2 listings.")
    }

    @MainActor
    func test_runNow_disabledShowsOffBanner() async {
        let fake = FakeService(
            rules: [rule("a")],
            runResult: RuleRunResult(ok: false, applied: nil, listingsScanned: nil, rulesEvaluated: nil, skipped: nil, reason: "feature_disabled")
        )
        let store = RepricingRulesStore(service: fake)
        await store.load()
        await store.runNow()
        XCTAssertEqual(store.banner, "Repricing automation is currently turned off.")
    }
}
