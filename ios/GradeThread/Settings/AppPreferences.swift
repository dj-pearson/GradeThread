import Foundation

/// US-648 — user preferences that were previously hardcoded (measurement unit
/// for the measurements grid; currency for ``CurrencyFormatter``). Backed by
/// UserDefaults; read at the point of display.
enum MeasurementUnit: String, CaseIterable, Identifiable {
    case inches
    case centimeters

    var id: String { rawValue }
    var label: String {
        switch self {
        case .inches: return "Inches (in)"
        case .centimeters: return "Centimeters (cm)"
        }
    }
    var shortLabel: String {
        switch self {
        case .inches: return "in"
        case .centimeters: return "cm"
        }
    }
}

enum AppPreferences {
    private static let unitKey = "com.gradethread.app.pref.measurementUnit"
    private static let currencyKey = "com.gradethread.app.pref.currencyCode"
    private static let budgetKey = "com.gradethread.app.pref.sourcingBudget"
    private static let usageThresholdKey = "com.gradethread.app.pref.usageAlertThreshold"

    /// US-805: at what cap-usage percentage the soft warning banner appears
    /// (mirrors web US-209: 50 / 80 / 95). The edge only emits the warning header
    /// at ≥80%, so this can only make the banner stricter, never looser. Default 80%.
    static var usageAlertThreshold: UsageAlertThreshold {
        get {
            let raw = UserDefaults.standard.object(forKey: usageThresholdKey) as? Int
            return raw.flatMap(UsageAlertThreshold.init(rawValue:)) ?? .eighty
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: usageThresholdKey) }
    }

    static var measurementUnit: MeasurementUnit {
        get { MeasurementUnit(rawValue: UserDefaults.standard.string(forKey: unitKey) ?? "") ?? .inches }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: unitKey) }
    }

    /// Currency override (ISO 4217). `nil` means "follow the device locale" —
    /// the previous hardcoded behavior.
    static var currencyCode: String? {
        get { UserDefaults.standard.string(forKey: currencyKey) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: currencyKey)
            } else {
                UserDefaults.standard.removeObject(forKey: currencyKey)
            }
        }
    }

    /// Common reseller currencies surfaced in the picker. "Device default" maps
    /// to `currencyCode == nil`.
    static let currencyOptions = ["USD", "CAD", "GBP", "EUR", "AUD"]

    /// Monthly sourcing budget (US-677). `nil`/`<= 0` means "no budget set" —
    /// the Analytics budget card stays hidden until the user sets one.
    static var sourcingBudget: Double? {
        get {
            let v = UserDefaults.standard.double(forKey: budgetKey)
            return v > 0 ? v : nil
        }
        set {
            if let newValue, newValue > 0 {
                UserDefaults.standard.set(newValue, forKey: budgetKey)
            } else {
                UserDefaults.standard.removeObject(forKey: budgetKey)
            }
        }
    }
}
