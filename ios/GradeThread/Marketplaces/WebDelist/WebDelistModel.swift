import Combine
import Foundation

/// US-3281 — everything the delist screen says, in one testable place.
///
/// The view draws; this decides. That split is the only reason any of the copy
/// below can be asserted by a test, and the copy is the part of this feature
/// most likely to be edited by someone who has not read
/// `vault/10-ops/ios-webview-delist-app-review.md`. In particular
/// ``riskDisclosure(label:)`` must stay byte-identical to the web's
/// `MECHANISM_DISCLOSURE.extension` first fact: a phone that softens the risk
/// while the website states it is a worse problem than either sentence alone.
@MainActor
final class WebDelistModel: ObservableObject {

    /// Nil when the runner could be built. Otherwise the reason, in words the
    /// seller can act on, and no run happens at all.
    let refusal: String?
    let label: String
    let listingLink: URL?

    @Published private(set) var phase: WebDelistRunner.Phase = .idle

    /// Built only when the platform and the URL both pass. A refused row has no
    /// runner and therefore no web view, which is stronger than a runner that
    /// declines to start.
    /// Optional all the way to the view, which renders the refusal when it is
    /// nil rather than reaching for a stand-in. There is no inert runner to
    /// fall back to, on purpose: a screen with a web view on it should mean a
    /// row that passed every check.
    private(set) var runnerOrNil: WebDelistRunner?
    private var cancellable: AnyCancellable?
    private var started = false

    init(row: PendingDelistService.PendingDelist) {
        let flow = DelistFlows.flow(for: row.platform)
        self.label = flow?.label ?? row.platform.capitalized
        self.listingLink = row.listingUrl.flatMap { URL(string: $0) }
        self.refusal = WebDelistRunner.refusalReason(
            platform: row.platform,
            listingURL: row.listingUrl
        )
        if refusal == nil {
            let built = WebDelistRunner(platform: row.platform, listingURL: row.listingUrl)
            self.runnerOrNil = built
            self.cancellable = built?.$phase.sink { [weak self] next in
                self?.phase = next
            }
        }
    }

    /// Load the page and start clicking. Called from `onAppear` of the run
    /// body, which is reachable only after the seller tapped "End it now" and
    /// accepted the consent screen. Nothing else calls it, and
    /// `ios/Scripts/check-web-delist.py` fails the build if anything scheduled
    /// ever does.
    func begin() {
        guard let runner = runnerOrNil, !started else { return }
        started = true
        runner.load()
        runner.start()
    }

    func handOver() {
        runnerOrNil?.handOver()
    }

    func sellerSaysContinue() {
        runnerOrNil?.sellerSaysContinue()
    }

    func answerConfirm(_ accepted: Bool) {
        runnerOrNil?.answerConfirm(accepted)
    }

    /// True while GradeThread is the one clicking. Drives the take-over layer,
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
        if case .confirm(let message) = phase { return message }
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
        case .confirm:
            return "\(label) is asking you to confirm."
        case .succeeded:
            return "Ended on \(label). Nothing else is live for this item there."
        case .failed(let reason):
            return reason
        case .handedOver:
            return "It is yours. GradeThread has stopped, and this page is just a browser now."
        }
    }

    /// The risk sentence, shared with the web and the Marketplaces screen.
    ///
    /// DO NOT REWRITE THIS FOR THE PHONE. It is the first fact of
    /// `MECHANISM_DISCLOSURE.extension` in `src/lib/marketplace-disclosure.ts`,
    /// already mirrored in `MarketplacesView`, and
    /// `WebDelistCopyTests` asserts the three copies match.
    static func riskDisclosure(label: String) -> String {
        "\(label)'s terms restrict third-party automation. Plenty of sellers use tools like "
            + "this one, and \(label) can still limit an account it decides is automated."
    }
}
