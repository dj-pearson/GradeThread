import Combine
import Foundation

/// US-3455 -- the words GradeThread types into a marketplace's create form.
///
/// Built OUTSIDE this directory (`WebListService`, from the edge's
/// `POST /api/flipdesk/extension-queue/fill`, the same hydration a queued
/// desktop job gets) and handed in. Nothing in `Marketplaces/WebList` may
/// fetch: `ios/Scripts/check-web-delist.py` fails the build if it does, because
/// "the app downloads nothing at runtime" has to stay true of the code that
/// drives the page. Words are data; the fill is data.
struct WebListFill: Equatable, Sendable {
    let title: String
    let description: String
    /// Already in the marketplace's own units (whole dollars on Poshmark).
    let price: String
    let brand: String
    /// How many photos the item has in GradeThread, so the hand-off can say
    /// "add your 6 photos". The photos themselves go through the
    /// marketplace's own picker; nothing here uploads one.
    let photoCount: Int
}

/// US-3455 -- everything the listing screen says, in one testable place.
///
/// The view draws; this decides. Same split as `WebDelistModel`, for the same
/// reason: the copy is the part of this feature most likely to be edited by
/// someone who has not read `vault/10-ops/ios-webview-delist-app-review.md`,
/// and a test can only hold a sentence that lives in a model.
@MainActor
final class WebListModel: ObservableObject {

    /// Nil when the runner could be built. Otherwise the reason, in words the
    /// seller can act on, and no run happens at all.
    let refusal: String?
    let label: String
    let platform: String
    let fill: WebListFill
    /// The selector-set version the consent is recorded against.
    let version: String

    @Published private(set) var phase: WebListRunner.Phase = .idle

    /// Built only when the platform passes. A refused platform has no runner
    /// and therefore no web view, which is stronger than a runner that
    /// declines to start.
    private(set) var runnerOrNil: WebListRunner?
    private var cancellable: AnyCancellable?
    private var started = false

    init(platform: String, fill: WebListFill) {
        let flow = ListFlows.flow(for: platform)
        self.platform = platform
        self.label = flow?.label ?? platform.capitalized
        self.version = flow?.version ?? "none"
        self.fill = fill
        self.refusal = WebListRunner.refusalReason(platform: platform)
        if refusal == nil {
            let built = WebListRunner(platform: platform)
            self.runnerOrNil = built
            self.cancellable = built?.$phase.sink { [weak self] next in
                self?.phase = next
            }
        }
    }

    /// Load the form and start typing. Called from `onAppear` of the run body,
    /// reachable only after the seller tapped "List now on your phone" and
    /// accepted the consent screen for this marketplace and selector version.
    func begin() {
        guard let runner = runnerOrNil, !started else { return }
        started = true
        runner.load()
        runner.start(fill: fill)
    }

    func handOver() {
        runnerOrNil?.handOver()
    }

    func sellerSaysContinue() {
        runnerOrNil?.sellerSaysContinue(fill: fill)
    }

    func answerConfirm(_ accepted: Bool) {
        runnerOrNil?.answerConfirm(accepted)
    }

    func stop() {
        runnerOrNil?.stop()
    }

    /// True while GradeThread is the one typing. Drives the take-over layer,
    /// so it must be false the instant anything stops.
    var isDriving: Bool {
        if case .working = phase { return true }
        return phase == .loading
    }

    /// True when the run is stopped and only the seller can restart it.
    var needsSeller: Bool {
        phase == .signInNeeded || phase == .humanCheck
    }

    var confirmMessage: String? {
        if case .nativeConfirm(let message) = phase { return message }
        return nil
    }

    var listedURL: URL? {
        if case .listed(let url) = phase { return url }
        return nil
    }

    /// One line, always true, never a spinner's worth of nothing.
    var statusLine: String {
        switch phase {
        case .idle:
            return "Ready."
        case .loading:
            return "Opening \(label). Tap anywhere to take over."
        case .working:
            return "GradeThread is filling this in. Tap anywhere to take over."
        case .signInNeeded:
            return "\(label) is asking you to sign in. Finish it here and tap Continue. "
                + "GradeThread will never answer that for you."
        case .humanCheck:
            return "\(label) is asking you to prove you are a person. Finish it here and tap "
                + "Continue. GradeThread will never answer that for you."
        case .nativeConfirm:
            return "\(label) is asking you to confirm."
        case .readyToPost(let summary):
            return summary
        case .listed:
            return "Listed on \(label). GradeThread has recorded the link."
        case .failed(let reason):
            return reason
        case .handedOver:
            return "It is yours. GradeThread has stopped typing, and this page is just a browser now. "
                + "If you post it here, GradeThread will still record the link."
        }
    }

    // MARK: - consent, once per marketplace and selector version

    /// The consent record is a space-separated list of `platform@version`.
    /// Versioned on purpose: a new selector set means the form GradeThread
    /// fills has changed, and the seller reads the screen again.
    static func hasConsented(_ stored: String, platform: String, version: String) -> Bool {
        stored.split(separator: " ").contains { $0 == "\(platform)@\(version)" }
    }

    static func recordingConsent(_ stored: String, platform: String, version: String) -> String {
        var entries = stored.split(separator: " ").map(String.init)
            .filter { !$0.hasPrefix("\(platform)@") }
        entries.append("\(platform)@\(version)")
        return entries.joined(separator: " ")
    }
}
