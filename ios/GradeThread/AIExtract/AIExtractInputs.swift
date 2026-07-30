import Foundation

/// What the item ALREADY holds, shaped into the two non-photo inputs the extract
/// endpoint accepts: `known_fields` and `text` (US-2268).
///
/// Why both matter:
///
///   * `known_fields` — the extract route DELETES every known key from its
///     suggestions before returning (`for (const key of Object.keys(knownFields))
///     delete result.suggestions[key]` in flipdesk-ai.ts). Sending them is what
///     stops the AI proposing a brand the seller already typed, and stops that
///     proposal reaching the auto-apply path at all.
///   * `text` — the prompt treats text as the WINNING source for condition notes
///     ("Photos win for brand, size, and material; text wins for
///     condition_notes"), so a description the seller wrote is not just context,
///     it changes the answer.
///
/// iOS sent NEITHER on the capture path. That mattered even for a brand-new item:
/// the extract runs for up to ~40s after the user has been handed off to the item,
/// so anything they type in the meantime was invisible to it.
///
/// One shaper for both entry points (post-capture and the US-2266 re-run) so the
/// two can't drift on which fields count as "known" or what goes into the text
/// blob. Pure and value-typed, so the rules are unit-testable.
struct AIExtractInputs: Equatable {
    // Free-text fields — these go into `text`, never `known_fields`. The AI is
    // meant to READ them, not be told to leave them alone.
    var title: String?
    var itemDescription: String?
    var conditionNotes: String?

    // Structured columns — these go into `known_fields`. Mirrors the ENRICHABLE
    // set in src/pages/flipdesk/composer.tsx.
    var brand: String?
    var style: String?
    var size: String?
    var color: String?
    var material: String?
    var itemCategory: String?
    var garmentType: String?
    var garmentCategory: String?

    init(
        title: String? = nil,
        itemDescription: String? = nil,
        conditionNotes: String? = nil,
        brand: String? = nil,
        style: String? = nil,
        size: String? = nil,
        color: String? = nil,
        material: String? = nil,
        itemCategory: String? = nil,
        garmentType: String? = nil,
        garmentCategory: String? = nil
    ) {
        self.title = title
        self.itemDescription = itemDescription
        self.conditionNotes = conditionNotes
        self.brand = brand
        self.style = style
        self.size = size
        self.color = color
        self.material = material
        self.itemCategory = itemCategory
        self.garmentType = garmentType
        self.garmentCategory = garmentCategory
    }

    /// From the server row as it stands. Used by the post-capture path, which
    /// reads it immediately before the extract call — so a value the seller typed
    /// during the upload gate is included rather than contradicted.
    init(snapshot: AIItemFieldWriter.Snapshot) {
        self.init(
            title: snapshot.title,
            itemDescription: snapshot.description,
            conditionNotes: snapshot.conditionNotes,
            brand: snapshot.brand,
            style: snapshot.style,
            size: snapshot.size,
            color: snapshot.color,
            material: snapshot.material,
            itemCategory: snapshot.itemCategory,
            garmentType: snapshot.garmentType,
            garmentCategory: snapshot.garmentCategory
        )
    }

    /// Server column name → value, for every structured field that holds
    /// something. nil (not an empty dictionary) when none do, so the request omits
    /// the key entirely.
    var knownFields: [String: KnownFieldValue]? {
        var out: [String: KnownFieldValue] = [:]
        for (key, value) in [
            ("brand", brand),
            ("style", style),
            ("size", size),
            ("color", color),
            ("material", material),
            ("item_category", itemCategory),
            ("garment_type", garmentType),
            ("garment_category", garmentCategory),
        ] {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmed.isEmpty else { continue }
            out[key] = .string(trimmed)
        }
        return out.isEmpty ? nil : out
    }

    /// The free-text blob, or nil when there's nothing worth sending.
    ///
    /// The placeholder title a photo-first capture creates the row with is
    /// EXCLUDED: "Untitled item" is not something the seller wrote, and feeding it
    /// back as text is noise the model would try to reconcile.
    var text: String? {
        let parts = [title, itemDescription, conditionNotes]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0 != AIItemFieldWriter.placeholderTitle }
        return parts.isEmpty ? nil : parts.joined(separator: "\n")
    }

    /// True when there is nothing here for the AI to read — the caller then relies
    /// on photos alone (or bails, on the re-run path).
    var isEmpty: Bool { knownFields == nil && text == nil }
}
