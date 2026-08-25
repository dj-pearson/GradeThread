import AppIntents
import Foundation

/// US-1134: Siri / Shortcuts / Spotlight entry points for the highest-value
/// reseller actions. Three intents:
///
/// - ``SnapToValueIntent`` — "Snap to value": opens the app straight into the
///   photo-first capture-and-grade flow.
/// - ``AddItemIntent`` — "Add Item": opens the add-method chooser.
/// - ``WhatSoldTodayIntent`` — "What sold today": a foreground-free, value-
///   returning intent that speaks today's sales + pending payout, read from the
///   same App Group rollup the home-screen widget renders.
///
/// The two navigation intents reuse the existing ``DeepLinkRouter`` bus (the
/// same path push notifications + the widget take), so there's one routing
/// surface. They open the app and let `ContentView` apply the route once the
/// signed-in shell is mounted; signed-out simply lands on login.
///
/// No secrets, tokens, or network access live here — navigation posts a local
/// notification and the summary intent only reads the local snapshot file.

// MARK: - Snap to value

struct SnapToValueIntent: AppIntent {
    static var title: LocalizedStringResource = "Snap to Value"
    static var description = IntentDescription(
        "Open GradeThread's camera to snap a garment and get its grade and value."
    )
    /// Navigation intent — hand control to the app's capture flow.
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        // Post for the warm path; persist for the cold-launch path (US-1410) —
        // on a cold launch `post` fires before ContentView subscribes, so the
        // app drains the persisted route on startup and replays it.
        DeepLinkRouter.post(.captureItem)
        DeepLinkRouter.persistPending(.captureItem)
        return .result()
    }
}

// MARK: - Add item

struct AddItemIntent: AppIntent {
    // US-2860: the product's verb is "Add item", so the action name a user
    // sees in the Shortcuts app is too.
    static var title: LocalizedStringResource = "Add Item"
    static var description = IntentDescription(
        "Open GradeThread to add a new item to your inventory."
    )
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        DeepLinkRouter.post(.addItem)
        DeepLinkRouter.persistPending(.addItem)  // cold-launch replay (US-1410)
        return .result()
    }
}

// MARK: - What sold today

struct WhatSoldTodayIntent: AppIntent {
    static var title: LocalizedStringResource = "What Sold Today"
    static var description = IntentDescription(
        "Hear how many items sold today and how much payout is waiting."
    )
    /// Answers in place (Siri speaks the result) — no need to foreground the app.
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = SoldTodaySummary.dialog(from: WidgetSnapshotStore.read())
        return .result(dialog: IntentDialog(stringLiteral: summary))
    }
}

// MARK: - Shortcuts / Siri / Spotlight exposure

/// Surfaces the intents in the Shortcuts app, Spotlight, and Siri without the
/// user wiring anything up. Phrases must reference `\(.applicationName)` so Siri
/// can disambiguate the app.
struct GradeThreadAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SnapToValueIntent(),
            phrases: [
                "Snap to value with \(.applicationName)",
                "\(.applicationName) snap to value",
                "Grade an item with \(.applicationName)",
            ],
            shortTitle: "Snap to Value",
            systemImageName: "camera.viewfinder"
        )
        AppShortcut(
            intent: AddItemIntent(),
            // US-2860 DELIBERATELY LEAVES THE SPOKEN PHRASES ALONE, and adds
            // rather than replaces. Speech is a different register: nobody says
            // "add item to GradeThread" out loud, and a phrase that is removed
            // stops matching the shortcuts people have already saved. "New item
            // in ..." stays for the same reason -- it is a retired LABEL, but it
            // is also a phrase somebody's Siri shortcut may depend on.
            phrases: [
                "Add an item to \(.applicationName)",
                "Add an item with \(.applicationName)",
                "Add item to \(.applicationName)",
                "New item in \(.applicationName)",
            ],
            shortTitle: "Add Item",
            systemImageName: "plus.square.on.square"
        )
        AppShortcut(
            intent: WhatSoldTodayIntent(),
            phrases: [
                "What sold today in \(.applicationName)",
                "What did I sell today with \(.applicationName)",
                "\(.applicationName) sales today",
            ],
            shortTitle: "What Sold Today",
            systemImageName: "dollarsign.circle"
        )
    }
}
