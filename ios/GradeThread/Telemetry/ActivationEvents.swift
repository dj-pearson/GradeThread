import Foundation

/// US-2884: the activation funnel's event names, as the web declares them.
///
/// `Telemetry.event(_:props:)` takes a raw `String`, so until this file the
/// only thing stopping iOS emitting `activation_first_grade` as
/// `activation_firstGrade` was somebody remembering. One typo does not fail
/// anything: the event is captured, PostHog accepts it, and the funnel simply
/// shows iOS dropping to zero at that step. That failure is invisible for as
/// long as nobody is looking at the chart, which is most of the time.
///
/// The table below is GENERATED from `src/lib/activation-analytics.ts` by
/// `scripts/generate-swift-mirrors.mjs`. Do not hand-edit it; edit the
/// TypeScript and re-run the generator. `npm run verify` fails when this file
/// and that one disagree.
///
/// PRIVACY: the same rule as the web. These events carry a persona, a
/// platform, a step key, a funnel index and — at most — an opaque row id.
/// Never a title, a brand, a price or an email.
enum ActivationEvent: String, CaseIterable {
    // BEGIN GENERATED TABLE (scripts/generate-swift-mirrors.mjs, from src/lib/activation-analytics.ts)
    case firstSession = "activation_first_session"
    case tourFinished = "activation_tour_finished"
    case tourSkipped = "activation_tour_skipped"
    case personaChosen = "activation_persona_chosen"
    case stepCompleted = "activation_step_completed"
    case firstGrade = "activation_first_grade"
    case firstItem = "activation_first_item"
    case marketplaceConnected = "activation_marketplace_connected"
    case listingPublished = "activation_listing_published"
    case saleReconciled = "activation_sale_reconciled"
    case checklistDismissed = "activation_checklist_dismissed"
    // END GENERATED TABLE

    /// Zero-based position in the ordered funnel; -1 for an exit.
    var index: Int {
        Self.ordered.firstIndex(of: self) ?? -1
    }

    /// The ordered steps. Exits are deliberately absent: including one would
    /// make a drop-off chart count giving up as progress.
    static let ordered: [ActivationEvent] = allCases.filter { $0 != .checklistDismissed }
}

extension Telemetry {
    /// Emit one funnel step with the shared property shape.
    ///
    /// `platform` is fixed to "ios" here rather than passed, because a caller
    /// that could set it is a caller that could set it wrong, and the split by
    /// platform is the whole reason the property exists.
    static func activation(
        _ step: ActivationEvent,
        persona: String?,
        stepKey: String? = nil,
        id: String? = nil
    ) {
        var props: [String: Any] = [
            "platform": "ios",
            "index": step.index,
        ]
        if let persona { props["persona"] = persona }
        if let stepKey { props["step"] = stepKey }
        if let id { props["id"] = id }
        event(step.rawValue, props: props)
    }
}
