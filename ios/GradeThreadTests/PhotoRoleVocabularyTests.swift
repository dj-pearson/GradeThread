import XCTest
@testable import GradeThread

/// US-2461 AC4: the retag menu hides nothing, it only demotes.
///
/// `changeTypeMenu` is a private `@ViewBuilder`, so what is pinned here is the
/// data rule it is built from. That rule is the whole feature: the "All types"
/// section used to be built from BARE types, which meant a role the item's
/// profile did not happen to suggest was unreachable on a phone and reachable
/// on web — "Hem & stitching" and "Made in / union label" did not exist on iOS
/// at all, while the menu offered a bare "Detail" that web suppresses.
final class PhotoRoleVocabularyTests: XCTestCase {

    private func keys(_ type: String, _ group: GarmentGroup) -> [String] {
        PhotoRoleVocabulary.roles(for: type, group: group).map(\.key)
    }

    func test_everyBaseRoleIsOfferedOnAPlainTop() {
        // The gap this test exists for: before US-2461 the only reachable roles
        // were the ones a profile named, and the clothing profile names two.
        XCTAssertEqual(
            keys("detail", .top),
            ["fabric", "hem", "hardware", "pocket", "print", "collar"]
        )
        XCTAssertEqual(keys("tag", .top), ["brand", "size", "care", "made_in"])
    }

    func test_groupSpecificRolesFollowTheGarment() {
        // "Handles & straps" in a t-shirt's menu is the noise the epic removed.
        XCTAssertTrue(keys("detail", .bag).contains("handles"))
        XCTAssertTrue(keys("detail", .bag).contains("base"))
        XCTAssertFalse(keys("detail", .top).contains("handles"))

        XCTAssertTrue(keys("detail", .shoes).contains("insole"))
        XCTAssertTrue(keys("detail", .accessory).contains("ends_edges"))
        XCTAssertFalse(keys("detail", .outerwear).contains("ends_edges"))
    }

    func test_onlyASuitOffersASecondSizeTag() {
        // A suit is the only garment that is genuinely two garments, so it is
        // the only one whose buyer needs two size numbers.
        XCTAssertTrue(keys("tag", .suit).contains("size_alt"))
        for group in [GarmentGroup.top, .bottom, .dress, .outerwear, .generic] {
            XCTAssertFalse(keys("tag", group).contains("size_alt"), group.rawValue)
        }
    }

    func test_measurementRolesComeFromTheProfile_notFromHere() {
        // Measurement roles are the group's measurement-template fields, which
        // only the server knows. A third copy of that table on the clients would
        // be one more thing to disagree with the measurement form about.
        XCTAssertTrue(PhotoRoleVocabulary.roles(for: "measurement", group: .suit).isEmpty)
        XCTAssertTrue(PhotoRoleVocabulary.takesRole("measurement"))
    }

    func test_typesThatTakeNoRole() {
        for type in ["front", "back", "defect", "flatlay", "internal", "sole"] {
            XCTAssertFalse(PhotoRoleVocabulary.takesRole(type), type)
            XCTAssertTrue(PhotoRoleVocabulary.roles(for: type, group: .top).isEmpty, type)
        }
    }

    func test_everyOfferedRoleHasALabel() {
        // A role offered without a label would render as its raw key.
        for group in GarmentGroup.allCases {
            for type in ["tag", "detail"] {
                for role in PhotoRoleVocabulary.roles(for: type, group: group) {
                    XCTAssertFalse(role.label.isEmpty, "\(type):\(role.key)")
                    XCTAssertEqual(
                        PhotoRoleVocabulary.label(type: type, role: role.key),
                        role.label
                    )
                }
            }
        }
    }
}
