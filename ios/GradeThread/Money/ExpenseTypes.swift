import Foundation

/// Operating-expense categories — mirrors the `expense_category` enum in
/// migration 00019. Raw values match the server strings exactly.
enum ExpenseCategory: String, CaseIterable, Identifiable, Codable {
    case shippingSupplies = "shipping_supplies"
    case mileage
    case subscriptions
    case platformFees = "platform_fees"
    case sourcingTravel = "sourcing_travel"
    case equipment
    case storage
    case other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .shippingSupplies: return "Shipping & supplies"
        case .mileage:          return "Mileage"
        case .subscriptions:    return "Subscriptions"
        case .platformFees:     return "Platform fees"
        case .sourcingTravel:   return "Sourcing travel"
        case .equipment:        return "Equipment"
        case .storage:          return "Storage"
        case .other:            return "Other"
        }
    }

    var systemImage: String {
        switch self {
        case .shippingSupplies: return "shippingbox"
        case .mileage:          return "car"
        case .subscriptions:    return "creditcard"
        case .platformFees:     return "percent"
        case .sourcingTravel:   return "map"
        case .equipment:        return "wrench.and.screwdriver"
        case .storage:          return "archivebox"
        case .other:            return "ellipsis.circle"
        }
    }
}

/// Wire shape for a `flipdesk_expenses` row. `amount` (a Postgres decimal)
/// can arrive as a JSON number or a numeric string, so it decodes leniently
/// — the same lesson as `RemoteSale`.
struct RemoteExpense: Decodable, Identifiable, Equatable {
    let id: String
    let category: String
    let description: String?
    let amount: Double
    /// Raw `spent_on` (a date, `YYYY-MM-DD`).
    let spentOn: String

    var categoryValue: ExpenseCategory { ExpenseCategory(rawValue: category) ?? .other }

    /// Parsed `spent_on`. Date-only first (what the column is), with an ISO
    /// fallback in case the server ever returns a timestamp.
    var date: Date {
        let dateOnly = DateFormatter()
        dateOnly.locale = Locale(identifier: "en_US_POSIX")
        dateOnly.timeZone = TimeZone(identifier: "UTC")
        dateOnly.dateFormat = "yyyy-MM-dd"
        if let d = dateOnly.date(from: spentOn) { return d }
        return ISO8601DateFormatter().date(from: spentOn) ?? .distantPast
    }

    private enum CodingKeys: String, CodingKey {
        case id, category, description, amount
        case spentOn = "spent_on"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        category = (try? c.decode(String.self, forKey: .category)) ?? "other"
        description = try c.decodeIfPresent(String.self, forKey: .description)
        if let d = try? c.decode(Double.self, forKey: .amount) {
            amount = d
        } else if let s = try? c.decode(String.self, forKey: .amount), let d = Double(s) {
            amount = d
        } else {
            amount = 0
        }
        spentOn = (try? c.decode(String.self, forKey: .spentOn)) ?? ""
    }

    /// Memberwise init for tests / previews.
    init(id: String, category: String, description: String?, amount: Double, spentOn: String) {
        self.id = id
        self.category = category
        self.description = description
        self.amount = amount
        self.spentOn = spentOn
    }
}
