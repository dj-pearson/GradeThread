import XCTest
import SwiftData
@testable import GradeThread

/// Covers the advanced faceted filtering added on top of the stage/search/
/// sort pipeline: `InventoryFilterCriteria`, `InventoryFilter.matches`,
/// `InventoryFacets.derive`, and `SavedFilterStore`.
@MainActor
final class AdvancedInventoryFilterTests: XCTestCase {

    // MARK: - Criteria activeness

    func test_emptyCriteria_isInactive() {
        XCTAssertFalse(InventoryFilterCriteria.empty.isActive)
        XCTAssertEqual(InventoryFilterCriteria.empty.activeCount, 0)
    }

    func test_activeCount_countsEachFacetOnce() {
        var c = InventoryFilterCriteria()
        c.brands = ["Nike", "Patagonia"]   // multi-select still counts once
        c.minPrice = 10
        c.maxPrice = 50                     // both bounds → one facet
        c.dateAdded = .last30
        XCTAssertTrue(c.isActive)
        XCTAssertEqual(c.activeCount, 3)
    }

    func test_minGrade_countsAsGradeFacet() {
        var c = InventoryFilterCriteria()
        c.minGrade = 8.0
        XCTAssertEqual(c.activeCount, 1)
    }

    // MARK: - matches: attribute facets

    func test_matches_brandMultiSelect_isOR() throws {
        let ctx = ModelContext(try makeContainer())
        let nike = makeItem(id: "n", brand: "Nike", context: ctx)
        let levis = makeItem(id: "l", brand: "Levi's", context: ctx)
        let other = makeItem(id: "o", brand: "Gap", context: ctx)

        var c = InventoryFilterCriteria()
        c.brands = ["Nike", "Levi's"]
        XCTAssertTrue(InventoryFilter.matches(nike, c))
        XCTAssertTrue(InventoryFilter.matches(levis, c))
        XCTAssertFalse(InventoryFilter.matches(other, c))
    }

    func test_matches_acrossFacets_isAND() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "a", brand: "Nike", size: "L", context: ctx)

        var c = InventoryFilterCriteria()
        c.brands = ["Nike"]
        c.sizes = ["M"]   // mismatched size → fails the AND
        XCTAssertFalse(InventoryFilter.matches(item, c))

        c.sizes = ["L"]
        XCTAssertTrue(InventoryFilter.matches(item, c))
    }

    func test_matches_blankAttribute_failsWhenFacetActive() throws {
        let ctx = ModelContext(try makeContainer())
        let noBrand = makeItem(id: "x", brand: nil, context: ctx)
        var c = InventoryFilterCriteria()
        c.brands = ["Nike"]
        XCTAssertFalse(InventoryFilter.matches(noBrand, c))
    }

    // MARK: - matches: grade

    func test_matches_gradedOnly_dropsUngraded() throws {
        let ctx = ModelContext(try makeContainer())
        let graded = makeItem(id: "g", context: ctx); graded.gradeValue = 7.0
        let ungraded = makeItem(id: "u", context: ctx)
        var c = InventoryFilterCriteria(); c.gradedOnly = true
        XCTAssertTrue(InventoryFilter.matches(graded, c))
        XCTAssertFalse(InventoryFilter.matches(ungraded, c))
    }

    func test_matches_minGrade_appliesFloor() throws {
        let ctx = ModelContext(try makeContainer())
        let high = makeItem(id: "h", context: ctx); high.gradeValue = 9.0
        let low = makeItem(id: "l", context: ctx); low.gradeValue = 6.0
        var c = InventoryFilterCriteria(); c.minGrade = 8.0
        XCTAssertTrue(InventoryFilter.matches(high, c))
        XCTAssertFalse(InventoryFilter.matches(low, c))
    }

    // MARK: - matches: price band

    func test_matches_priceBand_usesEffectivePrice() throws {
        let ctx = ModelContext(try makeContainer())
        // No listing/target → falls back to acquired (15).
        let item = makeItem(id: "p", context: ctx)
        item.acquiredPrice = 15
        var c = InventoryFilterCriteria()
        c.minPrice = 10; c.maxPrice = 20
        XCTAssertTrue(InventoryFilter.matches(item, c))
        c.minPrice = 16
        XCTAssertFalse(InventoryFilter.matches(item, c))
    }

    // US-1247: explicit null-price semantics. A `maxPrice`-only band keeps an
    // unpriced item (the backlog stays reachable); any active `minPrice` drops
    // it (an unknown price can't be proven to clear a floor).
    func test_matches_priceBand_keepsUnpricedItemUnderMaxOnly() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "p", context: ctx)   // no prices
        var c = InventoryFilterCriteria(); c.maxPrice = 100
        XCTAssertTrue(InventoryFilter.matches(item, c))
    }

    func test_matches_priceBand_dropsUnpricedItemUnderMinBound() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "p", context: ctx)   // no prices
        var c = InventoryFilterCriteria(); c.minPrice = 10
        XCTAssertFalse(InventoryFilter.matches(item, c))
        // A min+max band still hides the unpriced item (the min governs).
        c.maxPrice = 100
        XCTAssertFalse(InventoryFilter.matches(item, c))
    }

    // MARK: - matches: photo + date

    func test_matches_photoState() throws {
        let ctx = ModelContext(try makeContainer())
        // US-994: photo presence derives from the relationship, so attach a real
        // photo row rather than setting the denormalized primaryPhotoURL.
        let withPhoto = makeItem(id: "w", context: ctx)
        let photo = LocalItemPhoto(
            id: "ph-w", inventoryItemId: "w", photoType: "front", photoURL: "https://x/y.jpg"
        )
        ctx.insert(photo)
        photo.item = withPhoto
        let without = makeItem(id: "n", context: ctx)

        var c = InventoryFilterCriteria(); c.photoState = .withPhoto
        XCTAssertTrue(InventoryFilter.matches(withPhoto, c))
        XCTAssertFalse(InventoryFilter.matches(without, c))

        c.photoState = .missingPhoto
        XCTAssertFalse(InventoryFilter.matches(withPhoto, c))
        XCTAssertTrue(InventoryFilter.matches(without, c))
    }

    /// US-1520: when the caller supplies the precomputed photo-bearing id set
    /// (one LocalItemPhoto pass), the facet consults IT — not the per-item lazy
    /// `photos` relationship. Proven by giving the set the OPPOSITE of the
    /// relationship truth: the set must win.
    func test_matches_photoState_prefersPrecomputedIdSet() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "w", context: ctx)   // no photo relationship

        var c = InventoryFilterCriteria(); c.photoState = .withPhoto
        // The set says this item HAS a photo → passes despite the empty relationship.
        XCTAssertTrue(InventoryFilter.matches(item, c, photoItemIds: ["w"]))
        // The set says it doesn't → filtered out.
        XCTAssertFalse(InventoryFilter.matches(item, c, photoItemIds: []))

        c.photoState = .missingPhoto
        XCTAssertFalse(InventoryFilter.matches(item, c, photoItemIds: ["w"]))
        XCTAssertTrue(InventoryFilter.matches(item, c, photoItemIds: []))
    }

    func test_matches_dateAdded_windowsOnCreatedAt() throws {
        let ctx = ModelContext(try makeContainer())
        let now = Date(timeIntervalSince1970: 1_000_000)
        let recent = makeItem(id: "r", createdAt: now.addingTimeInterval(-2 * 86_400), context: ctx)
        let old = makeItem(id: "o", createdAt: now.addingTimeInterval(-40 * 86_400), context: ctx)

        var c = InventoryFilterCriteria(); c.dateAdded = .last7
        XCTAssertTrue(InventoryFilter.matches(recent, c, now: now))
        XCTAssertFalse(InventoryFilter.matches(old, c, now: now))
    }

    // MARK: - apply: facets compose with stage + search

    func test_apply_criteria_composesWithStageAndSearch() throws {
        let ctx = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "a", title: "Wool blazer", brand: "Nike", status: "drafted", context: ctx),
            makeItem(id: "b", title: "Wool coat", brand: "Gap", status: "drafted", context: ctx),
            makeItem(id: "c", title: "Wool tee", brand: "Nike", status: "listed", context: ctx),
        ]
        var c = InventoryFilterCriteria(); c.brands = ["Nike"]
        let result = InventoryFilter.apply(
            items, stage: .drafts, search: "wool", sort: .newest, criteria: c
        )
        // Stage=drafts drops "c"; brand=Nike drops "b"; "wool" keeps "a".
        XCTAssertEqual(result.map(\.id), ["a"])
    }

    // MARK: - Facets derivation

    func test_facets_countsAndFrequencyOrder() throws {
        let ctx = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "1", brand: "Nike", context: ctx),
            makeItem(id: "2", brand: "Nike", context: ctx),
            makeItem(id: "3", brand: "Gap", context: ctx),
            makeItem(id: "4", brand: "  ", context: ctx),   // blank → dropped
        ]
        let facets = InventoryFacets.derive(from: items)
        XCTAssertEqual(facets.brands.map(\.value), ["Nike", "Gap"])  // freq desc
        XCTAssertEqual(facets.brands.first?.count, 2)
    }

    func test_facets_sizeOrdering_letteredBeforeNumeric() throws {
        let ctx = ModelContext(try makeContainer())
        let items = [
            makeItem(id: "1", size: "XL", context: ctx),
            makeItem(id: "2", size: "S", context: ctx),
            makeItem(id: "3", size: "M", context: ctx),
            makeItem(id: "4", size: "32", context: ctx),
        ]
        let facets = InventoryFacets.derive(from: items)
        XCTAssertEqual(facets.sizes.map(\.value), ["S", "M", "XL", "32"])
    }

    func test_facets_priceBounds() throws {
        let ctx = ModelContext(try makeContainer())
        let a = makeItem(id: "a", context: ctx); a.listingPrice = 25
        let b = makeItem(id: "b", context: ctx); b.targetPrice = 5
        let c = makeItem(id: "c", context: ctx)   // no price
        let facets = InventoryFacets.derive(from: [a, b, c])
        XCTAssertEqual(facets.priceBounds, 5...25)
    }

    func test_facets_priceBounds_nilWhenNoPrices() throws {
        let ctx = ModelContext(try makeContainer())
        let facets = InventoryFacets.derive(from: [makeItem(id: "a", context: ctx)])
        XCTAssertNil(facets.priceBounds)
    }

    // US-1247: the bounds derivation excludes unpriced items from `priceBounds`
    // (an unknown price has no slider position) but counts them so the UI can
    // explain a max-only band keeps them.
    func test_facets_unpricedCount_excludedFromBoundsButCounted() throws {
        let ctx = ModelContext(try makeContainer())
        let priced = makeItem(id: "a", context: ctx); priced.listingPrice = 25
        let unpriced1 = makeItem(id: "b", context: ctx)   // no price
        let unpriced2 = makeItem(id: "c", context: ctx)   // no price
        let facets = InventoryFacets.derive(from: [priced, unpriced1, unpriced2])
        XCTAssertEqual(facets.priceBounds, 25...26)   // single priced value, degenerate-guarded
        XCTAssertEqual(facets.unpricedCount, 2)
    }

    // MARK: - SavedFilterStore

    func test_savedFilters_saveOverwriteDelete() throws {
        let defaults = try ephemeralDefaults()
        let store = SavedFilterStore(defaults: defaults)
        XCTAssertTrue(store.filters.isEmpty)

        var c = InventoryFilterCriteria(); c.brands = ["Nike"]
        store.save(name: "Nike", criteria: c)
        XCTAssertEqual(store.filters.count, 1)

        // Same name overwrites rather than duplicating.
        var c2 = InventoryFilterCriteria(); c2.brands = ["Nike"]; c2.gradedOnly = true
        store.save(name: "nike", criteria: c2)
        XCTAssertEqual(store.filters.count, 1)
        XCTAssertEqual(store.filters.first?.criteria, c2)

        store.delete(store.filters[0])
        XCTAssertTrue(store.filters.isEmpty)
    }

    func test_savedFilters_blankNameRejected() throws {
        let store = SavedFilterStore(defaults: try ephemeralDefaults())
        XCTAssertNil(store.save(name: "   ", criteria: .empty))
        XCTAssertTrue(store.filters.isEmpty)
    }

    func test_savedFilters_persistAcrossInstances() throws {
        let defaults = try ephemeralDefaults()
        var c = InventoryFilterCriteria(); c.sizes = ["L"]
        SavedFilterStore(defaults: defaults).save(name: "Large", criteria: c)

        let reloaded = SavedFilterStore(defaults: defaults)
        XCTAssertEqual(reloaded.filters.count, 1)
        XCTAssertEqual(reloaded.matchingName(for: c), "Large")
    }

    // MARK: - US-1052: source / category facets

    func test_matches_sourceFacet_isOR() throws {
        let ctx = ModelContext(try makeContainer())
        let a = makeItem(id: "a", context: ctx); a.sourceId = "src-1"
        let b = makeItem(id: "b", context: ctx); b.sourceId = "src-2"
        let c = makeItem(id: "c", context: ctx); c.sourceId = "src-3"
        var crit = InventoryFilterCriteria(); crit.sources = ["src-1", "src-2"]
        XCTAssertTrue(InventoryFilter.matches(a, crit))
        XCTAssertTrue(InventoryFilter.matches(b, crit))
        XCTAssertFalse(InventoryFilter.matches(c, crit))
    }

    func test_matches_categoryFacet() throws {
        let ctx = ModelContext(try makeContainer())
        let shoe = makeItem(id: "s", context: ctx); shoe.itemCategory = "shoes"
        let shirt = makeItem(id: "t", context: ctx); shirt.itemCategory = "clothing"
        var crit = InventoryFilterCriteria(); crit.categories = ["shoes"]
        XCTAssertTrue(InventoryFilter.matches(shoe, crit))
        XCTAssertFalse(InventoryFilter.matches(shirt, crit))
    }

    func test_facets_sourceNames_resolveAndCategoryLabel() throws {
        let ctx = ModelContext(try makeContainer())
        let a = makeItem(id: "a", context: ctx); a.sourceId = "src-1"; a.itemCategory = "sports_cards"
        let b = makeItem(id: "b", context: ctx); b.sourceId = "src-1"; b.itemCategory = "sports_cards"
        let facets = InventoryFacets.derive(from: [a, b], sourceNames: ["src-1": "Goodwill"])
        XCTAssertEqual(facets.sources.first?.value, "src-1")     // key is the id
        XCTAssertEqual(facets.sources.first?.label, "Goodwill")  // label is the name
        XCTAssertEqual(facets.categories.first?.value, "sports_cards")
        XCTAssertEqual(facets.categories.first?.label, "Sports Cards")
    }

    // MARK: - US-1052: date-range facets

    func test_matches_purchaseDateBand_windowsCreatedAt() throws {
        let ctx = ModelContext(try makeContainer())
        let anchor = Date(timeIntervalSince1970: 1_700_000_000)
        let inWindow = makeItem(id: "in", createdAt: anchor, context: ctx)
        let before = makeItem(id: "be", createdAt: anchor.addingTimeInterval(-10 * 86_400), context: ctx)

        var crit = InventoryFilterCriteria()
        crit.purchaseDates = .init(from: anchor.addingTimeInterval(-86_400), to: anchor.addingTimeInterval(86_400))
        XCTAssertTrue(InventoryFilter.matches(inWindow, crit))
        XCTAssertFalse(InventoryFilter.matches(before, crit))
    }

    func test_matches_saleDateBand_usesResolvedSoldDates() throws {
        let ctx = ModelContext(try makeContainer())
        let sold = makeItem(id: "sold", context: ctx)
        let unsold = makeItem(id: "unsold", context: ctx)
        let soldOn = Date(timeIntervalSince1970: 1_700_000_000)

        var crit = InventoryFilterCriteria()
        crit.saleDates = .init(from: soldOn.addingTimeInterval(-86_400), to: nil)
        let map = ["sold": soldOn]
        XCTAssertTrue(InventoryFilter.matches(sold, crit, soldDates: map))
        // No sale date → can't clear an active sale-date window.
        XCTAssertFalse(InventoryFilter.matches(unsold, crit, soldDates: map))
    }

    // MARK: - US-1052: advanced AND/OR rule builder

    func test_ruleQuery_emptyMatchesEverything() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "a", brand: "Nike", context: ctx)
        XCTAssertTrue(InventoryRuleQuery.empty.matches(item, now: .now))
    }

    func test_ruleQuery_orCombinator_anyRuleHolds() throws {
        let ctx = ModelContext(try makeContainer())
        let nike = makeItem(id: "n", brand: "Nike", context: ctx)
        let gap = makeItem(id: "g", brand: "Gap", context: ctx)
        var q = InventoryRuleQuery(combinator: .or, rules: [
            .init(field: .brand, op: .eq, value: "Nike"),
            .init(field: .brand, op: .eq, value: "Patagonia"),
        ])
        XCTAssertTrue(q.matches(nike, now: .now))
        XCTAssertFalse(q.matches(gap, now: .now))
        q.combinator = .and
        XCTAssertFalse(q.matches(nike, now: .now))  // can't be both brands
    }

    func test_ruleQuery_numericGteAndAnyOf() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "a", brand: "Nike", context: ctx)
        item.targetPrice = 50
        let pass = InventoryRuleQuery(combinator: .and, rules: [
            .init(field: .targetPrice, op: .gte, value: "40"),
            .init(field: .brand, op: .anyOf, value: "nike, patagonia"),
        ])
        XCTAssertTrue(pass.matches(item, now: .now))
        let fail = InventoryRuleQuery(combinator: .and, rules: [
            .init(field: .targetPrice, op: .gte, value: "60"),
        ])
        XCTAssertFalse(fail.matches(item, now: .now))
    }

    func test_ruleQuery_blankRuleIsNoOp() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "a", brand: "Nike", context: ctx)
        // A rule whose value-requiring op has a blank value shouldn't empty
        // the list — it's treated as not-yet-specified.
        let q = InventoryRuleQuery(rules: [.init(field: .brand, op: .eq, value: "  ")])
        XCTAssertFalse(q.isActive)
        XCTAssertTrue(q.matches(item, now: .now))
    }

    func test_ruleQuery_isEmptyOperator() throws {
        let ctx = ModelContext(try makeContainer())
        let noBrand = makeItem(id: "x", brand: nil, context: ctx)
        let withBrand = makeItem(id: "y", brand: "Nike", context: ctx)
        let q = InventoryRuleQuery(rules: [.init(field: .brand, op: .isEmpty, value: "")])
        XCTAssertTrue(q.isActive)  // isEmpty needs no value
        XCTAssertTrue(q.matches(noBrand, now: .now))
        XCTAssertFalse(q.matches(withBrand, now: .now))
    }

    func test_criteria_ruleQuery_gatesMatches() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "a", brand: "Nike", context: ctx)
        var crit = InventoryFilterCriteria()
        crit.ruleQuery = .init(rules: [.init(field: .brand, op: .eq, value: "Gap")])
        XCTAssertFalse(InventoryFilter.matches(item, crit))
        crit.ruleQuery = .init(rules: [.init(field: .brand, op: .eq, value: "Nike")])
        XCTAssertTrue(InventoryFilter.matches(item, crit))
    }

    func test_activeCount_includesNewFacets() {
        var c = InventoryFilterCriteria()
        c.sources = ["s1"]
        c.categories = ["shoes"]
        c.purchaseDates = .init(from: .now, to: nil)
        c.saleDates = .init(from: .now, to: nil)
        c.ruleQuery = .init(rules: [.init(field: .brand, op: .eq, value: "Nike")])
        XCTAssertEqual(c.activeCount, 5)
        XCTAssertTrue(c.isActive)
    }

    // MARK: - US-1052: full-text (multi-token) search

    func test_filter_fts_requiresAllTokens() throws {
        let ctx = ModelContext(try makeContainer())
        let a = makeItem(id: "a", title: "Wool Blazer", brand: "Nike", context: ctx)
        let b = makeItem(id: "b", title: "Wool Coat", brand: "Gap", context: ctx)
        // Both tokens must land somewhere across the searchable fields.
        XCTAssertEqual(InventoryFilter.filter([a, b], search: "wool nike").map(\.id), ["a"])
        XCTAssertEqual(InventoryFilter.filter([a, b], search: "wool").map(\.id), ["a", "b"])
    }

    func test_filter_fts_searchesNotesAndColorAndCategory() throws {
        let ctx = ModelContext(try makeContainer())
        let a = makeItem(id: "a", context: ctx)
        a.conditionNotes = "small stain on cuff"
        a.color = "Crimson"
        a.itemCategory = "shoes"
        XCTAssertEqual(InventoryFilter.filter([a], search: "stain").map(\.id), ["a"])
        XCTAssertEqual(InventoryFilter.filter([a], search: "crimson").map(\.id), ["a"])
        XCTAssertEqual(InventoryFilter.filter([a], search: "shoes").map(\.id), ["a"])
    }

    func test_filter_serverSearchIds_unionWithLocal() throws {
        let ctx = ModelContext(try makeContainer())
        // Local text doesn't contain "vintage", but the server FTS matched it
        // (e.g. on the server-only description) → it should still surface.
        let a = makeItem(id: "a", title: "Plain Tee", context: ctx)
        XCTAssertTrue(InventoryFilter.filter([a], search: "vintage").isEmpty)
        XCTAssertEqual(
            InventoryFilter.filter([a], search: "vintage", serverSearchIds: ["a"]).map(\.id),
            ["a"]
        )
    }

    // MARK: - US-1052: saved-view interop (tolerant decode)

    func test_criteria_decodesLegacyJSON_withoutNewKeys() throws {
        // A blob shaped like a pre-US-1052 saved filter (no sources/categories/
        // purchaseDates/saleDates/ruleQuery keys) must still decode, defaulting
        // the new fields — otherwise SavedFilterStore drops every saved view.
        let legacy = """
        {"brands":["Nike"],"sizes":[],"colors":[],"locationBins":[],
         "gradedOnly":true,"photoState":"any","dateAdded":"any"}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(InventoryFilterCriteria.self, from: legacy)
        XCTAssertEqual(decoded.brands, ["Nike"])
        XCTAssertTrue(decoded.gradedOnly)
        XCTAssertTrue(decoded.sources.isEmpty)
        XCTAssertFalse(decoded.purchaseDates.isActive)
        XCTAssertFalse(decoded.ruleQuery.isActive)
    }

    func test_criteria_roundTripsThroughCodable() throws {
        var c = InventoryFilterCriteria()
        c.brands = ["Nike"]
        c.sources = ["src-1"]
        c.categories = ["shoes"]
        c.purchaseDates = .init(from: Date(timeIntervalSince1970: 1000), to: nil)
        c.ruleQuery = .init(combinator: .or, rules: [.init(field: .grade, op: .gte, value: "8")])
        let data = try JSONEncoder().encode(c)
        let back = try JSONDecoder().decode(InventoryFilterCriteria.self, from: data)
        XCTAssertEqual(back, c)
    }

    // MARK: - US-3124: who sourced the item

    func test_matches_sourcerFacet_selectsByName() throws {
        let ctx = ModelContext(try makeContainer())
        let dan = makeItem(id: "d", context: ctx); dan.sourcedBy = "Dan"
        let sam = makeItem(id: "s", context: ctx); sam.sourcedBy = "Sam"
        let nobody = makeItem(id: "n", context: ctx)

        var c = InventoryFilterCriteria()
        c.sourcers = ["Dan", "Sam"]
        XCTAssertTrue(InventoryFilter.matches(dan, c))
        XCTAssertTrue(InventoryFilter.matches(sam, c))
        // Nobody recorded matches no selection, exactly as an unbranded item
        // matches no brand.
        XCTAssertFalse(InventoryFilter.matches(nobody, c))
    }

    func test_sourcerFacet_isSeparateFromSource() throws {
        let ctx = ModelContext(try makeContainer())
        let item = makeItem(id: "i", context: ctx)
        item.sourcedBy = "Dan"
        item.sourceId = "src-1"

        var bySourcer = InventoryFilterCriteria(); bySourcer.sourcers = ["Dan"]
        var bySource = InventoryFilterCriteria(); bySource.sources = ["Dan"]
        XCTAssertTrue(InventoryFilter.matches(item, bySourcer))
        // WHERE it came from is an id, WHO bought it is a name. Selecting one
        // must never answer for the other.
        XCTAssertFalse(InventoryFilter.matches(item, bySource))
    }

    func test_facets_sourcers_countAndBlankHandling() throws {
        let ctx = ModelContext(try makeContainer())
        let a = makeItem(id: "1", context: ctx); a.sourcedBy = "Dan"
        let b = makeItem(id: "2", context: ctx); b.sourcedBy = "Dan"
        let c = makeItem(id: "3", context: ctx); c.sourcedBy = "Sam"
        let d = makeItem(id: "4", context: ctx); d.sourcedBy = "   "
        let e = makeItem(id: "5", context: ctx)

        let facets = InventoryFacets.derive(from: [a, b, c, d, e])
        XCTAssertEqual(facets.sourcers.map(\.value), ["Dan", "Sam"])
        XCTAssertEqual(facets.sourcers.first?.count, 2)
    }

    func test_ruleQuery_sourcedByField() throws {
        let ctx = ModelContext(try makeContainer())
        let dan = makeItem(id: "d", context: ctx); dan.sourcedBy = "Dan"
        let sam = makeItem(id: "s", context: ctx); sam.sourcedBy = "Sam"

        var c = InventoryFilterCriteria()
        c.ruleQuery = .init(
            combinator: .and,
            rules: [.init(field: .sourcedBy, op: .eq, value: "dan")]
        )
        XCTAssertTrue(InventoryFilter.matches(dan, c), "the rule is case-insensitive")
        XCTAssertFalse(InventoryFilter.matches(sam, c))
        XCTAssertFalse(InventoryRuleQuery.Field.sourcedBy.isNumeric)
    }

    func test_sourcerSelection_survivesASavedView() throws {
        var c = InventoryFilterCriteria()
        c.sourcers = ["Dan", "Sam"]
        let back = try JSONDecoder().decode(
            InventoryFilterCriteria.self,
            from: try JSONEncoder().encode(c)
        )
        XCTAssertEqual(back.sourcers, ["Dan", "Sam"])
        XCTAssertEqual(c.activeCount, 1)
    }

    // MARK: - Helpers

    private func ephemeralDefaults() throws -> UserDefaults {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return defaults
    }

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
        title: String = "Item",
        brand: String? = nil,
        size: String? = nil,
        status: String = "cataloged",
        createdAt: Date = .now,
        context: ModelContext
    ) -> LocalInventoryItem {
        let item = LocalInventoryItem(
            id: id, userId: "u",
            title: title, status: status,
            createdAt: createdAt, updatedAt: createdAt
        )
        item.brand = brand
        item.size = size
        context.insert(item)
        return item
    }
}
