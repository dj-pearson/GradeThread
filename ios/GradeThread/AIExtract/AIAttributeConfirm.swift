import Foundation

/// US-826: the high-value listing attributes eBay almost always REQUIRES but AI
/// can only infer — Department, Size Type, Vintage, and a condition tier. The AI
/// review screen surfaces them as one-tap confirm chips pre-selected from the
/// AI's guess (US-821 `attributes`); the user's choice persists to
/// `inventory_items.attributes` with `ai_field_sources` provenance.
enum AIAttributeConfirm {
    /// One confirmable attribute: its canonical column key (the same key the
    /// server writes into `inventory_items.attributes`), a display label, and
    /// the chip options the user can pick from.
    struct Field: Identifiable, Equatable {
        let key: String
        let label: String
        let options: [String]
        var id: String { key }
    }

    /// The user's final decision for one field after the confirm step.
    /// `value == nil` means the field was left unselected / cleared — recorded
    /// `accepted = false` so the model knows the AI guess (if any) was rejected.
    struct Result: Equatable {
        let key: String
        let value: String?
        let source: String
        let confidence: Double
        var accepted: Bool { value != nil }
    }

    /// The four high-value fields. Options mirror the server's
    /// `CANONICAL_ATTRIBUTES` catalog (ai-extract.ts) so an AI pre-selection
    /// always lines up with a chip; the condition tier mirrors the grading
    /// tiers (CLAUDE.md grading system).
    static let fields: [Field] = [
        Field(
            key: "department",
            label: "Department",
            options: ["Men", "Women", "Unisex Adult", "Boys", "Girls", "Baby"]
        ),
        Field(
            key: "size_type",
            label: "Size Type",
            options: ["Regular", "Petite", "Tall", "Plus", "Big & Tall", "Juniors", "Maternity"]
        ),
        Field(
            key: "vintage",
            label: "Vintage",
            options: ["No", "Yes"]
        ),
        Field(
            key: "condition_tier",
            label: "Condition",
            options: ["NWT", "NWOT", "Excellent", "Very Good", "Good", "Fair", "Poor"]
        ),
    ]

    /// Canonical keys this confirm step owns — used to decide whether the AI
    /// produced anything worth confirming.
    static let keys: [String] = fields.map(\.key)
}
