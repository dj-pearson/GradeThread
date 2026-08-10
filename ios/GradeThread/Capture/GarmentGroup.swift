import Foundation

/// US-2468: the Swift mirror of `measurementGroupFor` in
/// src/lib/measurement-templates.ts (and its byte-identical edge copy).
///
/// The photo profile for CLOTHING is chosen by garment group, not by
/// `item_category`: the category enum says "clothing" for a t-shirt and for a
/// suit alike, which is how a t-shirt ended up being offered an inseam slot and
/// a blazer was never offered a shoulder. The group comes from the free-text
/// `inventory_items.category` the seller typed.
///
/// WHY THIS IS DUPLICATED RATHER THAN FETCHED. The profile table is cached for
/// offline use, so the client has to be able to pick a key with no network. The
/// alternative — asking the edge to resolve it per item — would make the
/// capture flow's slot list a network dependency, which is the one thing it
/// cannot be. `GarmentGroupTests` pins the cases that matter against the same
/// expectations the web suite asserts.
public enum GarmentGroup: String, CaseIterable, Sendable {
    case top, bottom, dress, outerwear, suit, shoes, watch, bag, accessory, headwear, generic

    /// Garment groups that have their own `item_category` photo profile. The
    /// measurement groups and the item_category enum are two taxonomies that
    /// overlap here; this is the join, mirroring GROUP_TO_CATEGORY on the edge.
    public var itemCategoryProfileKey: String? {
        switch self {
        case .shoes:     return "shoes"
        case .watch:     return "watches"
        case .bag:       return "bags"
        case .accessory: return "accessories"
        case .headwear:  return "headwear"
        default:         return nil
        }
    }

    /// The profile-table key for this group, e.g. "clothing:suit".
    public var clothingProfileKey: String { "clothing:\(rawValue)" }
}

private func matches(_ pattern: String, _ s: String) -> Bool {
    s.range(of: pattern, options: [.regularExpression]) != nil
}

public extension GarmentGroup {
    /// Maps a free-form category/garment string to a group. The branch ORDER is
    /// load-bearing and mirrors the TypeScript exactly — bags first because the
    /// noun that matters is the last one ("boot bag" is a bag, not a boot).
    static func from(_ category: String?) -> GarmentGroup {
        let c = (category ?? "").lowercased()
        if c.isEmpty { return .generic }

        if matches("(bag|purse|tote|clutch|satchel|crossbody|backpack|rucksack|duffel|duffle|handbag|hobo|pouch|wallet|briefcase)", c) { return .bag }
        if matches("(hat|cap|beanie|snapback|fitted|trucker|visor|fedora|beret|bucket.?hat|headwear|balaclava)", c) { return .headwear }
        if matches("(tie|necktie|bow.?tie|belt|scarf|scarves|glove|mitten|shawl|pocket.?square|cravat|ascot|suspender|accessor)", c) { return .accessory }
        if matches("(shoe|sneaker|boot|sandal|footwear|loafer|mule|clog|slipper)", c) { return .shoes }
        if matches("watch", c) { return .watch }

        // "dress" is a modifier more often than a noun in resale. Matching the
        // compound and REFUSING the dress branch is what keeps "sundress" and
        // "shirtdress" correct — any reorder that fixed "dress shirt" would
        // have broken those.
        let dressModifier = matches(
            "dress\\s*-?\\s*(shirt|blouse|pant|trouser|slack|short|skirt|sock|shoe|boot|belt|tie|watch|coat|jacket|blazer|vest|suit|uniform)", c
        )
        if !dressModifier,
           matches("(dress|romper|jumpsuit|maxi|mini|midi|swimsuit|bikini|tankini|monokini|one.?piece)", c) { return .dress }

        if matches("(jacket|coat|outerwear|blazer|parka|windbreaker|overcoat|anorak|bomber|vest|gilet|fleece|cardigan|robe|kimono|poncho|cape)", c) { return .outerwear }

        // AFTER outerwear so a standalone "suit jacket" stays outerwear, and
        // BEFORE bottom so "pantsuit" is not claimed by the `pant` keyword.
        let notASuitSet = matches("(swim|jump|body|cat|snow|wet|rain|play)suit", c)
        let suitSingleBottom = matches("(suit|tuxedo|tux)\\s*-?\\s*(pant|trouser|slack|short|skirt)", c)
        if matches("(pant.?suit|suit|tuxedo|\\btux\\b|two.?piece|three.?piece|coverall|overall|scrub|pajama|pyjama)", c),
           !notASuitSet, !suitSingleBottom { return .suit }

        if matches("(pant|jean|short|skirt|trouser|chino|jogger|legging|sweatpant|cargo|trunk|slack|bottom)", c) { return .bottom }
        if matches("(shirt|tee|t-shirt|top|blouse|sweater|hoodie|sweatshirt|tank|polo|jersey|henley|pullover|crewneck|longsleeve|long.sleeve|rugby|button.down|button.up|oxford|flannel|thermal)", c) { return .top }
        return .generic
    }
}
