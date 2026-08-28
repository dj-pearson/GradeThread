import Foundation

/// US-2964 - the mobile half of the description block list.
///
/// The RENDERER is edge-only (decision 6 of the modular-description design), so
/// nothing in this file turns blocks into a description. What lives here is the
/// part a client owns: what a row is called, whether it can be dragged, whether
/// it can be edited in place, and the array operations the list performs. All
/// pure and Foundation-only, so it is built and tested on Linux by the Core
/// package lane rather than needing a Mac.
///
/// The web equivalents are `src/lib/description-blocks.ts` (labels, array ops,
/// `applyWholeText`) and `src/types/database.ts` (the block shape). Keep them in
/// lockstep - a block array written by one client is read by the other.

// MARK: - The block

/// Which kind of description block a ``DescriptionBlock`` is.
///
/// The kind decides who owns the content. `intro`/`features`/`condition` are
/// written by the AI and edited by the seller; `attributes`/`measurements`/
/// `grade`/`disclosure`/`credentials`/`facts` are DERIVED at render time and
/// store no text, which is what makes them impossible to drift from the fields
/// they show; `snippet` points at a `listing_snippets` row; `text` is one-off
/// typing (and is what a legacy description parses into).
public enum DescriptionBlockKey: String, Codable, CaseIterable, Sendable {
    case intro
    case features
    case condition
    case attributes
    case measurements
    case grade
    case disclosure
    case credentials
    case facts
    case snippet
    case text
}

/// Who owns a block's content.
public enum DescriptionBlockSource: String, Codable, Sendable {
    case ai
    case item
    case grade
    case seller
    case system
    case account
    case user
}

/// One entry of `listings.description_blocks` (migration 00678).
///
/// Array order is render order, with one exception the renderer enforces: the
/// `facts` block is always emitted last, because US-2682 needs it at a fixed
/// position for revise-in-place to replace it rather than accumulate a copy.
public struct DescriptionBlock: Codable, Equatable, Sendable {
    public var key: DescriptionBlockKey
    /// Off blocks keep their position so toggling back on restores the order.
    public var on: Bool
    public var src: DescriptionBlockSource
    /// Free-form content. Absent on derived blocks; on `snippet` it overrides
    /// the referenced body.
    public var text: String?
    /// `attributes` only: which item columns to show, in order.
    public var fields: [String]?
    /// `measurements` only: the length unit to render (US-648).
    public var unit: String?
    /// `snippet` only: the `listing_snippets.id` this block renders.
    public var ref: String?
    /// US-2957: the exact bytes that precede this block in the rendered output.
    /// Defaults to "\n\n" server-side. A legacy parse records what was really
    /// there, which is what lets convert-on-open reproduce a live description
    /// byte for byte instead of silently renormalising its whitespace.
    ///
    /// LOAD-BEARING. Round-trip it untouched; dropping it on a save rewrites the
    /// buyer-facing whitespace of every converted listing.
    public var sep: String?

    public init(
        key: DescriptionBlockKey,
        on: Bool = true,
        src: DescriptionBlockSource = .user,
        text: String? = nil,
        fields: [String]? = nil,
        unit: String? = nil,
        ref: String? = nil,
        sep: String? = nil
    ) {
        self.key = key
        self.on = on
        self.src = src
        self.text = text
        self.fields = fields
        self.unit = unit
        self.ref = ref
        self.sep = sep
    }

    private enum CodingKeys: String, CodingKey {
        case key, on, src, text, fields, unit, ref, sep
    }

    /// Decoding mirrors the edge's `parseBlocks`: `on` is true unless it is
    /// literally false, `src` falls back to `user`, and an UNKNOWN `key` throws
    /// rather than being dropped. A key this build does not recognise is version
    /// skew, and silently discarding the block would delete a section of the
    /// seller's description without telling anyone.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(DescriptionBlockKey.self, forKey: .key)
        on = try c.decodeIfPresent(Bool.self, forKey: .on) ?? true
        src = try c.decodeIfPresent(DescriptionBlockSource.self, forKey: .src) ?? .user
        text = try c.decodeIfPresent(String.self, forKey: .text)
        fields = try c.decodeIfPresent([String].self, forKey: .fields)
        unit = try c.decodeIfPresent(String.self, forKey: .unit)
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        sep = try c.decodeIfPresent(String.self, forKey: .sep)
    }

    /// Absent stays absent. `sep` is the reason this is hand-written: encoding a
    /// null where the server sent nothing changes the rendered whitespace.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        try c.encode(on, forKey: .on)
        try c.encode(src, forKey: .src)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(fields, forKey: .fields)
        try c.encodeIfPresent(unit, forKey: .unit)
        try c.encodeIfPresent(ref, forKey: .ref)
        try c.encodeIfPresent(sep, forKey: .sep)
    }
}

// MARK: - Row metadata and array operations

public enum DescriptionBlocks {

    /// Row heading per block type. Mirrors the web `BLOCK_LABELS`.
    public static func label(for key: DescriptionBlockKey) -> String {
        switch key {
        case .intro: return "Intro"
        case .features: return "Features"
        case .condition: return "Condition"
        case .attributes: return "Attributes"
        case .measurements: return "Measurements"
        case .grade: return "Grade badge"
        case .disclosure: return "Grade disclosure"
        case .credentials: return "Verified seller"
        case .facts: return "Item facts"
        case .snippet: return "Saved snippet"
        case .text: return "Custom text"
        }
    }

    /// The small plain-text tag that says who owns a row's content.
    public static func label(for src: DescriptionBlockSource) -> String {
        switch src {
        case .ai: return "AI"
        case .item: return "Item"
        case .grade: return "Grade"
        case .seller: return "Seller"
        case .system: return "System"
        case .account: return "Account"
        case .user: return "You"
        }
    }

    /// Rows that hold their position and carry no drag handle.
    ///
    /// `facts` is pinned because US-2682 needs it last so a revise on a live
    /// listing REPLACES it rather than accumulating a second copy - the renderer
    /// moves it last regardless, and a draggable row that silently snaps back is
    /// worse than one that never moved. `credentials` is server-gated: the
    /// seller cannot edit its content, and its position next to the facts block
    /// is what the credentials-refresh cron expects to find.
    public static let pinnedKeys: [DescriptionBlockKey] = [.credentials, .facts]

    public static func isPinned(_ key: DescriptionBlockKey) -> Bool {
        pinnedKeys.contains(key)
    }

    /// Blocks whose text the seller types. Everything else is derived.
    public static let editableKeys: [DescriptionBlockKey] = [
        .intro, .features, .condition, .snippet, .text,
    ]

    public static func isEditable(_ key: DescriptionBlockKey) -> Bool {
        editableKeys.contains(key)
    }

    /// The three blocks the AI writes, and the only ones /regenerate will touch.
    public static let regenerableKeys: [DescriptionBlockKey] = [
        .intro, .features, .condition,
    ]

    public static func isRegenerable(_ key: DescriptionBlockKey) -> Bool {
        regenerableKeys.contains(key)
    }

    /// Rows the seller ADDED, and so the only ones a delete is offered on. The
    /// nine standard sections are switched off instead, which keeps their
    /// position so toggling back on restores it.
    public static func isRemovable(_ key: DescriptionBlockKey) -> Bool {
        key == .snippet || key == .text
    }

    /// Where a derived row sends the seller.
    ///
    /// A derived block has nothing of its own to edit - the fix is the field it
    /// reads. The names mirror the web `BLOCK_ANCHORS`; each client maps them
    /// onto its own scroll targets.
    public enum FieldAnchor: String, Sendable {
        case attributes
        case measurements
        case grade
    }

    public static func anchor(for key: DescriptionBlockKey) -> FieldAnchor? {
        switch key {
        case .attributes: return .attributes
        case .measurements: return .measurements
        case .grade, .disclosure: return .grade
        default: return nil
        }
    }

    /// Flip one row on or off.
    ///
    /// The block keeps its index. That is the whole contract: a seller who
    /// switches measurements off, reorders nothing, and switches it back on gets
    /// it back where it was rather than at the bottom.
    public static func toggle(
        _ blocks: [DescriptionBlock],
        at index: Int
    ) -> [DescriptionBlock] {
        guard blocks.indices.contains(index) else { return blocks }
        var out = blocks
        out[index].on.toggle()
        return out
    }

    /// Set the stored text of one row, leaving every other entry alone.
    public static func setText(
        _ blocks: [DescriptionBlock],
        at index: Int,
        to text: String
    ) -> [DescriptionBlock] {
        guard blocks.indices.contains(index) else { return blocks }
        var out = blocks
        out[index].text = text
        return out
    }

    /// Reorder, with the pinned rows nailed to the indices they hold.
    ///
    /// A plain move would slide a pinned row up by one whenever a drag crossed
    /// it, which is exactly the accumulate-a-second-facts-block failure US-2682
    /// fixed. So the movable rows are lifted out, moved among themselves, and
    /// the pinned ones are put back at their original indices. A move that
    /// starts or ends on a pinned row is refused outright.
    public static func move(
        _ blocks: [DescriptionBlock],
        from: Int,
        to: Int
    ) -> [DescriptionBlock] {
        guard from != to else { return blocks }
        guard blocks.indices.contains(from), blocks.indices.contains(to) else {
            return blocks
        }
        let source = blocks[from]
        let target = blocks[to]
        guard !isPinned(source.key), !isPinned(target.key) else { return blocks }

        var pinned: [(Int, DescriptionBlock)] = []
        var movable: [DescriptionBlock] = []
        for (i, b) in blocks.enumerated() {
            if isPinned(b.key) { pinned.append((i, b)) } else { movable.append(b) }
        }
        // Index by POSITION, not by value: two empty `text` rows are equal, and
        // searching by value would move whichever came first.
        let movableIndices = blocks.indices.filter { !isPinned(blocks[$0].key) }
        guard
            let mFrom = movableIndices.firstIndex(of: from),
            let mTo = movableIndices.firstIndex(of: to)
        else { return blocks }

        let taken = movable.remove(at: mFrom)
        movable.insert(taken, at: mTo)
        var out = movable
        for (i, b) in pinned { out.insert(b, at: i) }
        return out
    }

    /// SwiftUI's `onMove` hands over a source set and a destination that is the
    /// index the row lands ABOVE, so a downward drag arrives one past the slot
    /// it means. Normalised here rather than at the call site, so the same rule
    /// is tested once.
    public static func move(
        _ blocks: [DescriptionBlock],
        fromOffsets source: IndexSet,
        toOffset destination: Int
    ) -> [DescriptionBlock] {
        guard let from = source.first, source.count == 1 else { return blocks }
        let to = destination > from ? destination - 1 : destination
        return move(blocks, from: from, to: to)
    }

    /// Put a snippet block into the array, above the pinned rows.
    ///
    /// Above them because `credentials` and `facts` close the description and
    /// stay where they are; a new section dropped after `facts` would be moved
    /// back by the renderer anyway, and the row would appear to land somewhere
    /// it did not.
    ///
    /// The block stores ONLY the ref. That is the whole point of snippets: the
    /// body lives on the account, so editing it there changes every listing
    /// pointing at it, with no write to any listing row.
    public static func addSnippet(
        _ blocks: [DescriptionBlock],
        ref: String
    ) -> [DescriptionBlock] {
        let block = DescriptionBlock(key: .snippet, on: true, src: .account, ref: ref)
        var out = blocks
        if let firstPinned = blocks.firstIndex(where: { isPinned($0.key) }) {
            out.insert(block, at: firstPinned)
        } else {
            out.append(block)
        }
        return out
    }

    /// Drop the row at `index`. Only ever offered on rows the seller added.
    public static func remove(
        _ blocks: [DescriptionBlock],
        at index: Int
    ) -> [DescriptionBlock] {
        guard blocks.indices.contains(index) else { return blocks }
        var out = blocks
        out.remove(at: index)
        return out
    }

    // MARK: - Whole-string writers

    /// Markers the edge renderer emits. A whole-description string that already
    /// carries one has to be stripped before it becomes block text, or the block
    /// that owns that section would print it a second time.
    private static let markerSections: [(String, String)] = [
        ("<!--gradethread-measurements-->", "<!--/gradethread-measurements-->"),
        ("<!--gradethread-facts-->", "<!--/gradethread-facts-->"),
    ]

    /// The open-only markers have no closing tag - they run to the end of the
    /// string or to the next marker - so everything from the first one onward is
    /// dropped.
    private static let openOnlyMarkers = [
        "<!--gradethread-disclosure-->",
        "<!--gradethread-seller-credentials-->",
    ]

    /// Strip every rendered block out of a whole-description string, leaving
    /// prose. Mirrors the web `stripRenderedBlocks`.
    public static func stripRenderedBlocks(_ text: String) -> String {
        var out = text
        for (start, end) in markerSections {
            while let a = out.range(of: start) {
                if let b = out.range(of: end, range: a.upperBound..<out.endIndex) {
                    out = String(out[out.startIndex..<a.lowerBound])
                        + String(out[b.upperBound..<out.endIndex])
                } else {
                    out = String(out[out.startIndex..<a.lowerBound])
                }
            }
        }
        for marker in openOnlyMarkers {
            if let at = out.range(of: marker) {
                out = String(out[out.startIndex..<at.lowerBound])
            }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Fold a whole-description string into the block array.
    ///
    /// The garment template and the AI rewrite each produce ONE string standing
    /// for the entire prose part of a description. Blocks are the source of
    /// truth now, so that string has to land in a block or the next save renders
    /// it away. It goes into `intro`, and `features` and `condition` are
    /// CLEARED: the string already says whatever those two would have, and
    /// leaving them would print the same prose twice.
    ///
    /// Derived rows are untouched - that is the point of the split. A template
    /// that restated the brand loses the restatement to `stripRenderedBlocks`
    /// plus the attributes row that owns it.
    public static func applyWholeText(
        _ blocks: [DescriptionBlock],
        text: String
    ) -> [DescriptionBlock] {
        let prose = stripRenderedBlocks(text)
        var seenIntro = false
        var out: [DescriptionBlock] = []
        out.reserveCapacity(blocks.count + 1)
        for block in blocks {
            var next = block
            if block.key == .intro && !seenIntro {
                seenIntro = true
                next.on = true
                next.text = prose
            } else if block.key == .features || block.key == .condition {
                next.text = ""
            }
            out.append(next)
        }
        if !seenIntro {
            out.insert(
                DescriptionBlock(key: .intro, on: true, src: .ai, text: prose), at: 0
            )
        }
        return out
    }

    // MARK: - Row summaries

    /// Everything a row summary reads that is not on the block itself.
    public struct RowContext: Sendable {
        /// Item columns the attributes row can show, keyed by field name.
        public var attributes: [String: String]
        /// How many measurement values the item actually holds.
        public var measurementCount: Int
        /// "in" or "cm".
        public var unit: String
        public var gradeValue: Double?
        /// `listing_snippets.id` -> name, for the snippet row's heading.
        public var snippetNames: [String: String]
        /// Whether `snippetNames` has actually been fetched.
        ///
        /// A ref missing from a list that has not loaded is NOT a deleted
        /// snippet, and saying so would put "deleted, renders nothing" under a
        /// perfectly good section for as long as the request takes.
        public var snippetsLoaded: Bool

        public init(
            attributes: [String: String] = [:],
            measurementCount: Int = 0,
            unit: String = "in",
            gradeValue: Double? = nil,
            snippetNames: [String: String] = [:],
            snippetsLoaded: Bool = false
        ) {
            self.attributes = attributes
            self.measurementCount = measurementCount
            self.unit = unit
            self.gradeValue = gradeValue
            self.snippetNames = snippetNames
            self.snippetsLoaded = snippetsLoaded
        }
    }

    private static let attributeLabels: [String: String] = [
        "brand": "Brand",
        "size": "Size",
        "color": "Color",
        "material": "Material",
        "style": "Style",
    ]

    private static func unitWord(_ unit: String) -> String {
        unit == "cm" ? "centimetres" : "inches"
    }

    /// The one-line summary shown on a row.
    ///
    /// Derived rows say what they WILL show rather than showing it, because the
    /// row is a control and the preview below is where the actual bytes live.
    /// Mirrors the web `describeBlock` string for string.
    public static func describe(
        _ block: DescriptionBlock,
        context ctx: RowContext
    ) -> String {
        switch block.key {
        case .intro, .features, .condition, .text:
            let text = (block.text ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? "Empty" : text

        case .snippet:
            // The per-listing override wins, exactly as the renderer resolves it
            // - which is why an override survives the snippet it overrides being
            // renamed, edited or deleted.
            let own = (block.text ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !own.isEmpty { return own }
            guard let ref = block.ref, !ref.isEmpty else { return "Empty" }
            if let name = ctx.snippetNames[ref] { return name }
            // Deleting a snippet leaves the block in place and renders nothing,
            // which is the safe outcome and an invisible one. The row is where
            // it gets said.
            return ctx.snippetsLoaded
                ? "Deleted snippet, so this section shows nothing"
                : "Saved snippet"

        case .attributes:
            let fields = block.fields ?? ["brand", "size", "color", "material"]
            let filled = fields.filter {
                !(ctx.attributes[$0] ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            if filled.isEmpty { return "No attributes filled in yet" }
            return filled.map { attributeLabels[$0] ?? $0 }.joined(separator: ", ")

        case .measurements:
            if ctx.measurementCount == 0 { return "No measurements yet" }
            let unit = block.unit ?? ctx.unit
            let n = ctx.measurementCount
            return "\(n) \(n == 1 ? "value" : "values"), \(unitWord(unit))"

        case .grade:
            guard let grade = ctx.gradeValue else { return "Not graded yet" }
            return String(format: "%.1f / 10", grade)

        case .disclosure:
            return ctx.gradeValue == nil
                ? "Not graded yet"
                : "Defects and grade disclosure from the report"

        case .credentials:
            // The server decides whether this seller has one and what it says,
            // so the row promises the section rather than previewing bytes it
            // cannot know.
            return "Your verified-seller stats, filled in by the server"

        case .facts:
            return "Machine-readable facts, always last"
        }
    }

    /// The starting order for a listing that has no row yet.
    ///
    /// Mirrors `defaultBlocks()` in
    /// services/edge-functions/src/lib/description-blocks.ts, which is
    /// authoritative - this copy exists only so a client can show rows before
    /// the first save, when there is no listing id to ask the server about.
    public static let defaults: [DescriptionBlock] = [
        DescriptionBlock(key: .intro, on: true, src: .ai, text: ""),
        DescriptionBlock(key: .features, on: true, src: .ai, text: ""),
        DescriptionBlock(
            key: .attributes, on: true, src: .item,
            fields: ["brand", "size", "color", "material"]
        ),
        DescriptionBlock(key: .condition, on: true, src: .ai, text: ""),
        DescriptionBlock(key: .measurements, on: true, src: .item),
        DescriptionBlock(key: .grade, on: false, src: .grade),
        DescriptionBlock(key: .disclosure, on: true, src: .grade),
        DescriptionBlock(key: .credentials, on: true, src: .seller),
        DescriptionBlock(key: .facts, on: true, src: .system),
    ]
}
