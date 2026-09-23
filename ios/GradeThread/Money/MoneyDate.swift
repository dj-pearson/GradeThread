import Foundation
import GradeThreadCore
import SwiftUI

// `MoneyDate` itself lives in GradeThreadCore (ios/Packages/GradeThreadCore),
// where `swift test` runs its zone rules on Linux. Only the SwiftUI Binding
// adapter stays here, because the package may not import SwiftUI.
extension MoneyDate {

    /// Binding adapter for a `DatePicker` over a date-only column: reads as
    /// local midnight so the picker shows the stored day, writes back the
    /// UTC-anchored value the column wants.
    ///
    ///     DatePicker("Date", selection: MoneyDate.dayPicker($spentOn), displayedComponents: .date)
    ///
    /// Without it the day on screen and the day on the wire disagree by one for
    /// most of the world for part of every day.
    static func dayPicker(
        _ stored: Binding<Date>,
        localCalendar: Calendar = .current
    ) -> Binding<Date> {
        Binding(
            get: { localMidnight(of: stored.wrappedValue, localCalendar: localCalendar) },
            set: { stored.wrappedValue = anchor(localDayOf: $0, localCalendar: localCalendar) }
        )
    }
}
