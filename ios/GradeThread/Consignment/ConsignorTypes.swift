import Foundation

/// A consignor — someone whose items the reseller sells on their behalf
/// (US-676). Owner-scoped `consignors` row, read/written directly via
/// supabase-swift under RLS.
struct Consignor: Decodable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let contactEmail: String?
    let contactPhone: String?
    /// Default share of NET sale proceeds (0..100) owed to this consignor when
    /// an item has no per-item split override.
    let defaultSplitPct: Double
    let notes: String?

    private enum CodingKeys: String, CodingKey {
        case id, name
        case contactEmail = "contact_email"
        case contactPhone = "contact_phone"
        case defaultSplitPct = "default_split_pct"
        case notes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        contactEmail = try c.decodeIfPresent(String.self, forKey: .contactEmail)
        contactPhone = try c.decodeIfPresent(String.self, forKey: .contactPhone)
        // numeric(5,2) may arrive as a JSON number or (defensively) a string.
        if let d = try? c.decodeIfPresent(Double.self, forKey: .defaultSplitPct) {
            defaultSplitPct = d ?? 50
        } else if let s = try? c.decodeIfPresent(String.self, forKey: .defaultSplitPct),
                  let d = Double(s ?? "") {
            defaultSplitPct = d
        } else {
            defaultSplitPct = 50
        }
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
    }

    /// Test/preview initializer.
    init(
        id: String,
        name: String,
        contactEmail: String? = nil,
        contactPhone: String? = nil,
        defaultSplitPct: Double = 50,
        notes: String? = nil
    ) {
        self.id = id
        self.name = name
        self.contactEmail = contactEmail
        self.contactPhone = contactPhone
        self.defaultSplitPct = defaultSplitPct
        self.notes = notes
    }
}

/// Editable draft backing the create/edit consignor sheet.
struct ConsignorDraft: Equatable {
    var name: String = ""
    var contactEmail: String = ""
    var contactPhone: String = ""
    var defaultSplitPct: Double = 50
    var notes: String = ""

    init() {}

    init(_ c: Consignor) {
        name = c.name
        contactEmail = c.contactEmail ?? ""
        contactPhone = c.contactPhone ?? ""
        defaultSplitPct = c.defaultSplitPct
        notes = c.notes ?? ""
    }

    /// Name required; split clamped to 0...100.
    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && defaultSplitPct >= 0 && defaultSplitPct <= 100
    }
}
