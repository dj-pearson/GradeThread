import XCTest
@testable import GradeThread

/// US-1135 — general FlipDesk Automations: wire decode (mirrors EdgeAPI's
/// convertFromSnakeCase, including the nested trigger/action/scope jsonb), the
/// editor draft → input conversion, and the store (load / save / delete /
/// toggle / run) via a faked service.
final class AutomationsTests: XCTestCase {

    private func snakeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    // MARK: - Decode

    func test_decode_rule_withNestedJsonb() throws {
        let json = """
        {"id":"r1","name":"Stale markdown","is_active":true,
         "trigger_json":{"type":"days_listed_gt","days":30,"cooldown_days":7},
         "action_json":{"type":"price_drop_pct","pct":10,"margin_floor_pct":15},
         "scope_json":{"type":"filter","combinator":"and",
                       "rules":[{"field":"brand","op":"eq","value":"Nike"}]},
         "last_run_at":"2024-01-20T00:00:00Z","created_at":"2024-01-01T00:00:00Z",
         "updated_at":"2024-01-02T00:00:00Z"}
        """.data(using: .utf8)!
        let r = try snakeDecoder().decode(AutomationRule.self, from: json)
        XCTAssertEqual(r.triggerJson.type, "days_listed_gt")
        XCTAssertEqual(r.triggerJson.cooldownDays, 7)
        XCTAssertNil(r.triggerJson.watchers)
        XCTAssertEqual(r.actionJson.marginFloorPct, 15)
        XCTAssertEqual(r.scopeJson.rules?.first?.field, "brand")
        XCTAssertEqual(r.actionLabel, "Price drop")
        XCTAssertEqual(r.scopeSummary, "Filtered (1)")
        XCTAssertTrue(r.triggerSummary.contains("30 days"))
        XCTAssertNotNil(r.lastRun)
    }

    func test_decode_watcherTrigger_and_allScope() throws {
        let json = """
        {"id":"r2","name":"Quiet","is_active":false,
         "trigger_json":{"type":"watchers_lt_after_days","watchers":2,"days":14,"cooldown_days":7},
         "action_json":{"type":"end_listing"},
         "scope_json":{"type":"all"},
         "created_at":"2024-01-01T00:00:00Z"}
        """.data(using: .utf8)!
        let r = try snakeDecoder().decode(AutomationRule.self, from: json)
        XCTAssertEqual(r.triggerJson.watchers, 2)
        XCTAssertNil(r.actionJson.pct)
        XCTAssertEqual(r.scopeSummary, "All active listings")
        XCTAssertEqual(r.actionSummary, "end the listing")
    }

    func test_decode_runResult_normalAndDisabled() throws {
        let normal = """
        {"ok":true,"rules_evaluated":2,"listings_scanned":10,"applied":3,"errors":0}
        """.data(using: .utf8)!
        let r = try snakeDecoder().decode(AutomationRunResult.self, from: normal)
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.appliedCount, 3)
        XCTAssertEqual(r.scannedCount, 10)

        let disabled = """
        {"ok":false,"skipped":true,"reason":"feature_disabled"}
        """.data(using: .utf8)!
        let d = try snakeDecoder().decode(AutomationRunResult.self, from: disabled)
        XCTAssertFalse(d.ok)
        XCTAssertEqual(d.appliedCount, 0)
        XCTAssertEqual(d.reason, "feature_disabled")
    }

    func test_decode_dryRunMatch() throws {
        let json = """
        {"listings_scanned":5,
         "affected":[{"listing_id":"l1","title":"Wool coat","action_type":"price_drop_pct",
                      "current_price_cents":2000,"new_price_cents":1800,
                      "current_promo_rate_pct":null,"new_promo_rate_pct":null,"floored":false}]}
        """.data(using: .utf8)!
        let res = try snakeDecoder().decode(AutomationDryRunResult.self, from: json)
        XCTAssertEqual(res.scanned, 5)
        XCTAssertEqual(res.matches.first?.currentPriceCents, 2000)
        XCTAssertEqual(res.matches.first?.newPriceCents, 1800)
        XCTAssertEqual(res.matches.first?.displayTitle, "Wool coat")
    }

    // MARK: - Draft → input

    func test_draft_buildInput_defaults() {
        var d = AutomationDraft()
        d.name = "R"
        let input = d.buildInput()
        XCTAssertEqual(input.triggerJson.type, "days_listed_gt")
        XCTAssertNil(input.triggerJson.watchers)
        XCTAssertEqual(input.actionJson.type, "price_drop_pct")
        XCTAssertEqual(input.actionJson.marginFloorPct, 10)
        XCTAssertEqual(input.scopeJson.type, "all")
        XCTAssertTrue(d.isValid)
    }

    func test_draft_watcherTrigger_and_endListing() {
        var d = AutomationDraft()
        d.name = "R"
        d.triggerType = "watchers_lt_after_days"
        d.triggerWatchers = 3
        XCTAssertEqual(d.buildInput().triggerJson.watchers, 3)

        d.actionType = "end_listing"
        XCTAssertNil(d.buildInput().actionJson.pct)
        XCTAssertTrue(d.isValid)   // end_listing needs no percent
    }

    func test_draft_filterScope_dropsEmptyValues() {
        var d = AutomationDraft()
        d.name = "R"
        d.scopeMode = "filter"
        d.scopeRules = [ScopeRuleDraft(field: "brand", op: "eq", value: "   ")]
        // Empty value → clause dropped → no rules → falls back to "all".
        XCTAssertEqual(d.buildInput().scopeJson.type, "all")

        d.scopeRules = [ScopeRuleDraft(field: "brand", op: "eq", value: "Nike")]
        let scope = d.buildInput().scopeJson
        XCTAssertEqual(scope.type, "filter")
        XCTAssertEqual(scope.rules?.count, 1)
        XCTAssertEqual(scope.combinator, "and")
    }

    func test_draft_invalidWhenNameBlank() {
        var d = AutomationDraft()
        d.name = "   "
        XCTAssertFalse(d.isValid)
    }

    func test_draft_roundTripFromRule() {
        let rule = AutomationRule(
            id: "r1", name: "Markdown",
            triggerJson: AutomationTrigger(type: "no_views_in_days", days: 21, cooldownDays: 5, watchers: nil),
            actionJson: AutomationAction(type: "set_promo_rate_pct", pct: 8, marginFloorPct: nil),
            scopeJson: AutomationScope(type: "all", combinator: nil, rules: nil),
            isActive: true, lastRunAt: nil, createdAt: nil
        )
        let d = AutomationDraft(from: rule)
        XCTAssertEqual(d.triggerType, "no_views_in_days")
        XCTAssertEqual(d.triggerDays, 21)
        XCTAssertEqual(d.actionType, "set_promo_rate_pct")
        XCTAssertEqual(d.actionPct, 8, accuracy: 0.001)
        XCTAssertEqual(d.scopeMode, "all")
    }

    // MARK: - Fake

    final class FakeService: AutomationsProviding {
        var rules: [AutomationRule]
        var runResult: AutomationRunResult
        var dryRunResult: AutomationDryRunResult
        var actionsList: [AutomationActionRow]
        var listError: Error?
        var saveError: Error?
        var deleteError: Error?
        var runError: Error?
        var setActiveError: Error?
        /// US-1267: server-managed fields the minimal PATCH must preserve.
        var setActiveLastRunAt: String?
        private(set) var deleted: [String] = []
        /// US-1267: (id, isActive) the store sent through the minimal PATCH.
        private(set) var setActiveCalls: [(id: String, isActive: Bool)] = []
        private var seq = 0

        init(
            rules: [AutomationRule] = [],
            runResult: AutomationRunResult = AutomationRunResult(
                ok: true, applied: 2, listingsScanned: 5, errors: 0, skipped: nil, reason: nil
            ),
            dryRunResult: AutomationDryRunResult = AutomationDryRunResult(listingsScanned: 0, affected: []),
            actions: [AutomationActionRow] = []
        ) {
            self.rules = rules
            self.runResult = runResult
            self.dryRunResult = dryRunResult
            self.actionsList = actions
        }

        func list() async throws -> [AutomationRule] {
            if let listError { throw listError }
            return rules
        }
        func create(_ input: AutomationRuleInput) async throws -> AutomationRule {
            if let saveError { throw saveError }
            seq += 1
            return materialize("new-\(seq)", input)
        }
        func update(id: String, _ input: AutomationRuleInput) async throws -> AutomationRule {
            if let saveError { throw saveError }
            return materialize(id, input)
        }
        func setActive(id: String, isActive: Bool) async throws -> AutomationRule {
            setActiveCalls.append((id, isActive))
            if let setActiveError { throw setActiveError }
            guard let existing = rules.first(where: { $0.id == id }) else {
                throw EdgeAPIError.badRequest(detail: "Rule not found")
            }
            // Server returns the full row: only is_active changed; server-managed
            // last_run_at (and every other field) is preserved.
            return AutomationRule(
                id: existing.id, name: existing.name,
                triggerJson: existing.triggerJson, actionJson: existing.actionJson,
                scopeJson: existing.scopeJson, isActive: isActive,
                lastRunAt: setActiveLastRunAt ?? existing.lastRunAt,
                createdAt: existing.createdAt
            )
        }
        func delete(id: String) async throws {
            if let deleteError { throw deleteError }
            deleted.append(id)
            rules.removeAll { $0.id == id }
        }
        func run() async throws -> AutomationRunResult {
            if let runError { throw runError }
            return runResult
        }
        func dryRun(id: String) async throws -> AutomationDryRunResult { dryRunResult }
        func actions(id: String) async throws -> [AutomationActionRow] { actionsList }

        private func materialize(_ id: String, _ input: AutomationRuleInput) -> AutomationRule {
            AutomationRule(
                id: id, name: input.name,
                triggerJson: input.triggerJson, actionJson: input.actionJson,
                scopeJson: input.scopeJson, isActive: input.isActive,
                lastRunAt: nil, createdAt: nil
            )
        }
    }

    private func rule(_ id: String, name: String = "R", active: Bool = true) -> AutomationRule {
        AutomationRule(
            id: id, name: name,
            triggerJson: AutomationTrigger(type: "days_listed_gt", days: 30, cooldownDays: 7, watchers: nil),
            actionJson: AutomationAction(type: "price_drop_pct", pct: 10, marginFloorPct: 10),
            scopeJson: AutomationScope(type: "all", combinator: nil, rules: nil),
            isActive: active, lastRunAt: nil, createdAt: nil
        )
    }

    // MARK: - Store

    @MainActor
    func test_load_populatesRules() async {
        let store = AutomationsStore(service: FakeService(rules: [rule("a")]))
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.rules.map(\.id), ["a"])
    }

    @MainActor
    func test_load_failureSetsPhase() async {
        let fake = FakeService()
        fake.listError = EdgeAPIError.rateLimited
        let store = AutomationsStore(service: fake)
        await store.load()
        if case .failed = store.phase {} else { XCTFail("expected failed phase") }
    }

    @MainActor
    func test_save_createAppends_updateReplaces() async {
        let fake = FakeService(rules: [rule("a")])
        let store = AutomationsStore(service: fake)
        await store.load()

        var draft = AutomationDraft()
        draft.name = "New rule"
        let created = await store.save(draft, editingId: nil)
        XCTAssertTrue(created)
        XCTAssertEqual(store.rules.count, 2)

        var edit = AutomationDraft(from: store.rules[0])
        edit.name = "Renamed"
        let updated = await store.save(edit, editingId: "a")
        XCTAssertTrue(updated)
        XCTAssertEqual(store.rules.first { $0.id == "a" }?.name, "Renamed")
    }

    @MainActor
    func test_delete_optimisticAndRecords() async {
        let fake = FakeService(rules: [rule("a")])
        let store = AutomationsStore(service: fake)
        await store.load()
        await store.delete(store.rules[0])
        XCTAssertTrue(store.rules.isEmpty)
        XCTAssertEqual(fake.deleted, ["a"])
    }

    @MainActor
    func test_delete_failureReloads() async {
        let fake = FakeService(rules: [rule("a")])
        fake.deleteError = EdgeAPIError.rateLimited
        let store = AutomationsStore(service: fake)
        await store.load()
        await store.delete(store.rules[0])
        XCTAssertEqual(store.rules.map(\.id), ["a"])   // restored
        XCTAssertNotNil(store.actionError)
    }

    @MainActor
    func test_toggleActive_flipsFlag() async {
        let store = AutomationsStore(service: FakeService(rules: [rule("a", active: true)]))
        await store.load()
        await store.toggleActive(store.rules[0])
        XCTAssertEqual(store.rules.first?.isActive, false)
    }

    // US-1267: the toggle sends a minimal {isActive} PATCH, not a full-replace
    // PUT rebuilt from the pre-toggle snapshot.
    @MainActor
    func test_toggleActive_sendsMinimalPatch() async {
        let fake = FakeService(rules: [rule("a", active: true)])
        let store = AutomationsStore(service: fake)
        await store.load()
        await store.toggleActive(store.rules[0])
        XCTAssertEqual(fake.setActiveCalls.count, 1)
        XCTAssertEqual(fake.setActiveCalls.first?.id, "a")
        XCTAssertEqual(fake.setActiveCalls.first?.isActive, false)
    }

    // US-1267: server-managed fields (last_run_at) come back on the PATCH'd row
    // and the store re-syncs to that server truth.
    @MainActor
    func test_toggleActive_preservesServerManagedFields() async {
        let fake = FakeService(rules: [rule("a", active: true)])
        fake.setActiveLastRunAt = "2024-02-01T00:00:00Z"
        let store = AutomationsStore(service: fake)
        await store.load()
        await store.toggleActive(store.rules[0])
        XCTAssertEqual(store.rules.first?.isActive, false)
        XCTAssertEqual(store.rules.first?.lastRunAt, "2024-02-01T00:00:00Z")
    }

    // US-1267: a failed PATCH reverts the optimistic flip back to server truth.
    @MainActor
    func test_toggleActive_failureReverts() async {
        let fake = FakeService(rules: [rule("a", active: true)])
        fake.setActiveError = EdgeAPIError.rateLimited
        let store = AutomationsStore(service: fake)
        await store.load()
        await store.toggleActive(store.rules[0])
        XCTAssertEqual(store.rules.first?.isActive, true)   // reverted
        XCTAssertNotNil(store.actionError)
    }

    @MainActor
    func test_runNow_setsBannerFromApplied() async {
        let fake = FakeService(
            rules: [rule("a")],
            runResult: AutomationRunResult(ok: true, applied: 2, listingsScanned: 5, errors: 0, skipped: nil, reason: nil)
        )
        let store = AutomationsStore(service: fake)
        await store.load()
        await store.runNow()
        XCTAssertEqual(store.banner, "Applied 2 changes across 5 listings.")
    }

    @MainActor
    func test_runNow_disabledShowsOffBanner() async {
        let fake = FakeService(
            rules: [rule("a")],
            runResult: AutomationRunResult(ok: false, applied: nil, listingsScanned: nil, errors: nil, skipped: true, reason: "feature_disabled")
        )
        let store = AutomationsStore(service: fake)
        await store.load()
        await store.runNow()
        XCTAssertEqual(store.banner, "Automations are currently turned off.")
    }
}
