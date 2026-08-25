import Foundation

/// US-2864 AC6, landed by US-2876: the words GradeThread invented, defined.
///
/// FlipDesk, AutoLister, Snap to Value, MeasureCard, Scout, Prospect, Sourcing,
/// Reconcile, Comp, Passport, Verified. Every one is a word a new seller has to
/// learn, and until US-2864 every one was taught by being clicked. The web got
/// a definition popover; the phone got nothing, which is where most first-time
/// sellers meet these words.
///
/// The table below is GENERATED from `src/lib/product-terms.ts` by
/// `scripts/generate-swift-mirrors.mjs`. Do not hand-edit it; edit the
/// TypeScript and re-run the generator. `npm run verify` fails when this file
/// and that one disagree.
///
/// A SECOND GLOSSARY IS THE THING THIS AVOIDS. Two hand-written definition
/// lists do not stay identical, and the way they fail is quiet: the phone and
/// the laptop teach the same seller two different meanings for one word, and
/// nothing is red anywhere.
struct ProductTerm: Identifiable, Hashable {
    /// Exactly as the product spells it.
    let term: String
    /// One plain sentence. What it is -- not what it is for.
    let definition: String

    var id: String { term }
}

extension ProductTerm {
    static let all: [ProductTerm] = [
    // BEGIN GENERATED TABLE (scripts/generate-swift-mirrors.mjs, from src/lib/product-terms.ts)
        ProductTerm(
            term: "FlipDesk",
            definition: "The part of GradeThread you run your reselling from: what you own, what is listed, and what you made."
        ),
        ProductTerm(
            term: "Grade",
            definition: "A score from 1.0 to 10.0 for how worn a garment is. Five things are scored and weighed into that one number."
        ),
        ProductTerm(
            term: "Certificate",
            definition: "The shareable page that proves a grade is real. It has its own number, and anyone can look it up."
        ),
        ProductTerm(
            term: "Passport",
            definition: "A public history page for one garment: its grade, its photos, and who has owned it."
        ),
        ProductTerm(
            term: "AutoLister",
            definition: "A batch tool. Give it photos of a pile of garments and it writes a draft listing for each one."
        ),
        ProductTerm(
            term: "Snap to Value",
            definition: "A quick photo check that tells you roughly what a garment is worth, without paying for a full grade."
        ),
        ProductTerm(
            term: "MeasureCard",
            definition: "A printed card you lay next to a garment in a photo, so the AI can tell how big things are."
        ),
        ProductTerm(
            term: "Scout",
            definition: "Searches eBay for listings priced below what they are worth, so you can buy them and flip them."
        ),
        ProductTerm(
            term: "Prospect",
            definition: "Photograph a garment while you are still in the shop and get prices for it straight away. Phone app only."
        ),
        ProductTerm(
            term: "Sourcing",
            definition: "Deciding what to buy, and where to buy it from."
        ),
        ProductTerm(
            term: "Source",
            definition: "The shop, sale or lot an item came from. Tracking it shows you which ones actually make you money."
        ),
        ProductTerm(
            term: "Comp",
            definition: "A garment like yours that already sold. Comps are how you work out what yours is worth."
        ),
        ProductTerm(
            term: "Reconcile",
            definition: "Matching the money that actually landed in your account against the sales you recorded."
        ),
        ProductTerm(
            term: "Verified",
            definition: "A public profile and badge for sellers whose grades back up what they claim about condition."
        ),
        ProductTerm(
            term: "Trust Score",
            definition: "A number saying how often a seller's condition claims turn out to match the grade."
        ),
        ProductTerm(
            term: "Finds",
            definition: "A public feed of graded garments that people have listed for sale."
        ),
        ProductTerm(
            term: "Rewards",
            definition: "Points you earn for grading. They raise your level and turn into credit you can spend."
        ),
        ProductTerm(
            term: "Thrift Radar",
            definition: "Anonymous data sellers share about which shops are worth a visit right now."
        ),
        ProductTerm(
            term: "Consignment",
            definition: "Selling a garment that belongs to someone else, and splitting the money with them."
        ),
        ProductTerm(
            term: "Drop",
            definition: "A group of listings set to go live at the same time, usually when buyers are looking."
        ),
        ProductTerm(
            term: "Item specifics",
            definition: "eBay's name for the details it wants on a listing: brand, size, colour, material. Some are required before it will publish."
        ),
        ProductTerm(
            term: "SKU",
            definition: "Your own short code for one item, so you can find it on a shelf and in the app without reading the whole title."
        ),
        ProductTerm(
            term: "Provenance",
            definition: "Where a piece of information came from, and how sure we are of it: your typing, a photo, eBay, or a guess by the AI."
        ),
        ProductTerm(
            term: "Taxonomy",
            definition: "eBay's tree of categories. Picking the right branch decides which details it asks you for and who sees the listing."
        ),
    // END GENERATED TABLE
    ]

    /// Case-insensitive lookup, because copy capitalizes mid-sentence.
    static func named(_ term: String) -> ProductTerm? {
        let wanted = term.lowercased()
        return all.first { $0.term.lowercased() == wanted }
    }
}
