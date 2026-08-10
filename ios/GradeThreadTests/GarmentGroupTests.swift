import XCTest
@testable import GradeThread

/// US-2468: `GarmentGroup.from` is a Swift mirror of `measurementGroupFor`
/// (src/lib/measurement-templates.ts). It has to be duplicated rather than
/// fetched — the profile table is cached for offline use, so picking a key
/// cannot be a network dependency — and a duplicated regex with no test is a
/// drift bug waiting to happen.
///
/// These are deliberately the SAME cases `src/test/measurement-template-parity.test.ts`
/// asserts, so a change on one side that is not mirrored fails on the other.
final class GarmentGroupTests: XCTestCase {

    func test_dressIsAModifierMoreOftenThanANoun() {
        // The bug that opened the epic: the dress branch is tested before both
        // bottom and top, so every "dress <noun>" compound was measured as a
        // dress. A seller listing dress pants was asked for a bust and never
        // once for an inseam.
        for c in ["dress pants", "dress trousers", "dress slacks", "dress shorts"] {
            XCTAssertEqual(GarmentGroup.from(c), .bottom, c)
        }
        for c in ["dress shirt", "Dress Shirts", "dress blouse"] {
            XCTAssertEqual(GarmentGroup.from(c), .top, c)
        }
    }

    func test_anActualDressIsStillADress() {
        // Why the fix is a compound guard and not a branch reorder: these are
        // genuine dresses whose names contain another garment's noun, and any
        // reorder that fixed "dress shirt" would have broken them.
        for c in ["dress", "sundress", "shirtdress", "maxi dress", "romper", "jumpsuit"] {
            XCTAssertEqual(GarmentGroup.from(c), .dress, c)
        }
    }

    func test_compoundsAnEarlierBranchAlreadyOwned() {
        XCTAssertEqual(GarmentGroup.from("dress shoes"), .shoes)
        XCTAssertEqual(GarmentGroup.from("dress belt"), .accessory)
        XCTAssertEqual(GarmentGroup.from("dress coat"), .outerwear)
    }

    func test_suitSetsAreMeasuredAsATopAndABottom() {
        for c in ["suit", "Suit Set", "two piece suit", "three-piece suit", "tuxedo",
                  "pantsuit", "coveralls", "overalls", "tracksuit", "sweatsuit",
                  "pajamas", "scrubs"] {
            XCTAssertEqual(GarmentGroup.from(c), .suit, c)
        }
    }

    func test_wordsThatMerelyContainSuitAreNotSuitSets() {
        // A swimsuit and a bodysuit are single garments; a jumpsuit is measured
        // like a dress. Tracksuits and sweatsuits are NOT excluded — they are
        // two pieces and a buyer needs both sets of numbers.
        XCTAssertEqual(GarmentGroup.from("swimsuit"), .dress)
        XCTAssertEqual(GarmentGroup.from("jumpsuit"), .dress)
        XCTAssertEqual(GarmentGroup.from("wetsuit"), .generic)
    }

    func test_aSingleNamedPieceWinsOverTheSet() {
        // A standalone suit jacket is outerwear and suit pants are a bottom.
        // Only the set gets both halves.
        XCTAssertEqual(GarmentGroup.from("suit jacket"), .outerwear)
        XCTAssertEqual(GarmentGroup.from("suit pants"), .bottom)
        XCTAssertEqual(GarmentGroup.from("tuxedo trousers"), .bottom)
    }

    func test_theGarmentsThatUsedToFallToGeneric() {
        XCTAssertEqual(GarmentGroup.from("bikini"), .dress)
        XCTAssertEqual(GarmentGroup.from("swim trunks"), .bottom)
        XCTAssertEqual(GarmentGroup.from("board shorts"), .bottom)
        XCTAssertEqual(GarmentGroup.from("bathrobe"), .outerwear)
        XCTAssertEqual(GarmentGroup.from("kimono"), .outerwear)
        XCTAssertEqual(GarmentGroup.from("poncho"), .outerwear)
    }

    func test_theCoarseGarmentTypeValuesResolve() {
        // iOS stores GARMENT_TYPES in `garmentType` and falls back to it when
        // `garmentCategory` is empty, so these six have to land somewhere real
        // rather than in `generic`.
        XCTAssertEqual(GarmentGroup.from("tops"), .top)
        XCTAssertEqual(GarmentGroup.from("bottoms"), .bottom)
        XCTAssertEqual(GarmentGroup.from("dresses"), .dress)
        XCTAssertEqual(GarmentGroup.from("outerwear"), .outerwear)
        XCTAssertEqual(GarmentGroup.from("footwear"), .shoes)
        XCTAssertEqual(GarmentGroup.from("accessories"), .accessory)
    }

    func test_bagsWinTheNoun() {
        // The noun that matters is the LAST one. Routing these to the shoe
        // template would ask the seller for an insole length.
        XCTAssertEqual(GarmentGroup.from("boot bag"), .bag)
        XCTAssertEqual(GarmentGroup.from("shoe bag"), .bag)
        XCTAssertEqual(GarmentGroup.from("tie bag"), .bag)
    }

    func test_emptyAndUnknownFallToGeneric() {
        XCTAssertEqual(GarmentGroup.from(nil), .generic)
        XCTAssertEqual(GarmentGroup.from(""), .generic)
        XCTAssertEqual(GarmentGroup.from("socks"), .generic)
    }

    func test_profileKeysJoinTheTwoTaxonomies() {
        // Measurement groups and item_category are different taxonomies that
        // overlap; a group with its own category profile must resolve to it.
        XCTAssertEqual(GarmentGroup.shoes.itemCategoryProfileKey, "shoes")
        XCTAssertEqual(GarmentGroup.watch.itemCategoryProfileKey, "watches")
        XCTAssertEqual(GarmentGroup.bag.itemCategoryProfileKey, "bags")
        XCTAssertEqual(GarmentGroup.accessory.itemCategoryProfileKey, "accessories")
        XCTAssertEqual(GarmentGroup.headwear.itemCategoryProfileKey, "headwear")
        // The clothing groups have none — they use the clothing:<group> key.
        XCTAssertNil(GarmentGroup.top.itemCategoryProfileKey)
        XCTAssertNil(GarmentGroup.suit.itemCategoryProfileKey)
        XCTAssertEqual(GarmentGroup.suit.clothingProfileKey, "clothing:suit")
    }
}
