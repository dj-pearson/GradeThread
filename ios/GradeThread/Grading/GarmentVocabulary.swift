import Foundation

/// US-2815: the garment vocabulary the grade route VALIDATES against.
///
/// `routes/grade.ts:445` rejects a submission whose `garment_category` is not in
/// `GARMENT_CATEGORIES`, and the same for `garment_type`. A client that invents a
/// value gets a 400 after the photos have gone up, so the picker has to offer
/// the real list rather than a friendly approximation of it.
///
/// VENDORED, NOT GUESSED. `src/test/ios-garment-vocabulary-parity.test.ts` reads
/// this file and `src/lib/constants.ts` and fails on any difference, the way
/// `buyer-ios-capability-parity.test.ts` already does for the buyer capability
/// table. Adding a category on the web without adding it here reddens there.
enum GarmentVocabulary {

    /// `GARMENT_TYPES` — the broad group, six values.
    static let types = [
        "tops",
        "bottoms",
        "outerwear",
        "dresses",
        "footwear",
        "accessories",
    ]

    /// `GARMENT_CATEGORIES` — the specific garment, twenty-two values.
    ///
    /// `neckwear` rather than `tie` is deliberate on the web side and the reason
    /// is worth carrying: one rubric grades a bow tie, an ascot and a cravat, and
    /// a value named for one of them invites `other` for the rest.
    static let categories = [
        "t-shirt",
        "shirt",
        "blouse",
        "sweater",
        "hoodie",
        "jacket",
        "coat",
        "jeans",
        "pants",
        "shorts",
        "skirt",
        "dress",
        "sneakers",
        "boots",
        "sandals",
        "hat",
        "bag",
        "belt",
        "scarf",
        "neckwear",
        "gloves",
        "other",
    ]

    /// Title-cased for a picker row. `t-shirt` reads as `T-shirt`, not `T-Shirt`.
    static func label(_ raw: String) -> String {
        guard let first = raw.first else { return raw }
        return String(first).uppercased() + raw.dropFirst()
    }
}
