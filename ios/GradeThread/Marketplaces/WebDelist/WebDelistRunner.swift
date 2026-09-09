import Foundation
import WebKit

/// US-3281 — ending one listing on a marketplace with no API, in a web view the
/// seller is signed into and looking at.
///
/// WHAT THIS IS, IN ONE SENTENCE THE COPY ALSO HAS TO BE TRUE OF: the seller
/// taps one listing, a `WKWebView` opens that listing's page on the marketplace's
/// own site, and this object clicks through the marketplace's own end-listing
/// flow while the seller watches and can take over at any point.
///
/// WHAT IT IS NOT, and each of these is enforced below rather than promised:
///
///  * **It is not a background job.** `start()` is reachable only from a tap.
///    Nothing schedules it, and iOS suspends `WKWebView` JavaScript the moment
///    the app backgrounds anyway, so a scheduled version could not work even if
///    someone wanted one. `ios/Scripts/check-web-delist.py` fails the build if
///    the runner is referenced from the background-refresh path.
///  * **It never answers a human check.** If the marketplace asks whether a
///    person is here, the run stops and the seller gets the screen. They are
///    already looking at it, which makes this the one place the answer is easy.
///    That is the ADR §3.2 line
///    (`vault/60-decisions/adr-no-server-side-marketplace-automation.md`).
///  * **It never leaves the marketplace.** Every navigation is checked against
///    the flow's own host list, and a redirect anywhere else stops the run
///    rather than following it.
///  * **It never handles a credential.** The seller signs in on the
///    marketplace's own page inside the view. There is no field in this app for
///    a marketplace password and no code here that types one.
///  * **It downloads no script.** Every string it evaluates is in this file, in
///    the binary. See `DelistFlows.generated.swift` for why that matters.
///
/// The step machine is deliberately dumb: wait for a selector, click it, move
/// on. A marketplace redesign makes a selector miss, and a miss must read as
/// "could not do it, here is the tab" rather than as a silent success. That is
/// US-2165 applied to a second runtime.
@MainActor
final class WebDelistRunner: NSObject, ObservableObject {

    /// What the seller is told, and what the view renders.
    enum Phase: Equatable {
        case idle
        /// Loading the listing page.
        case loading
        /// The marketplace wants a sign-in first. The run stops here; the seller
        /// signs in, in this view, and taps Continue.
        case signInNeeded
        /// Running, with the step in the seller's words.
        case working(String)
        /// The marketplace asked whether a person is here. GradeThread never
        /// answers one; the seller does, then taps Continue.
        case humanCheck
        /// The marketplace asked for a confirmation through a native browser
        /// dialog. Surfaced as a real alert the seller taps, never auto-answered.
        case confirm(String)
        /// Ended, and verified as ended rather than assumed.
        case succeeded
        /// Stopped, with a reason the seller can act on.
        case failed(String)
        /// The seller tapped the page. It is theirs now; nothing else runs.
        case handedOver
    }

    @Published private(set) var phase: Phase = .idle

    let flow: DelistFlows.Flow
    let listingURL: URL
    let webView: WKWebView

    /// Set when a native `confirm()` dialog is waiting on the seller's answer.
    private var pendingConfirm: ((Bool) -> Void)?
    private var navigationContinuation: CheckedContinuation<Void, Never>?
    private var runTask: Task<Void, Never>?

    /// How long a selector may take to appear before the step gives up.
    /// Marketplace SPAs render late; ten seconds is generous for a control that
    /// is on screen and short enough that a broken selector is not mistaken for
    /// a slow one.
    private static let selectorTimeout: TimeInterval = 10

    /// Why a platform or a URL is refused, before anything is loaded.
    static func refusalReason(platform: String, listingURL: String?) -> String? {
        guard let flow = DelistFlows.flow(for: platform) else {
            return "GradeThread does not know how to end a listing on \(platform)."
        }
        guard flow.enabled else {
            return "Nobody has checked \(flow.label)'s end-listing form recently enough "
                + "for GradeThread to click through it for you. Open \(flow.label) and end it there."
        }
        guard WebDelistDataStore.isKnown(platform) else {
            return "GradeThread has nowhere to keep your \(flow.label) sign-in on this device."
        }
        guard let raw = listingURL, let url = URL(string: raw), Self.hostAllowed(url, flow: flow) else {
            return "The saved link for this listing does not point at \(flow.label), so "
                + "GradeThread will not open it."
        }
        return nil
    }

    /// A URL is only ever opened when its host matches the flow's own list.
    /// The listing URL is stored server-side, which makes it exactly as trusted
    /// as a message from a page: it says WHICH listing, it does not say the
    /// destination is safe. Same rule as `lister-guard.js` on desktop.
    static func hostAllowed(_ url: URL, flow: DelistFlows.Flow) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return flow.hosts.contains { allowed in
            host == allowed || host.hasSuffix("." + allowed)
        }
    }

    init?(platform: String, listingURL: String?) {
        guard let flow = DelistFlows.flow(for: platform), flow.enabled else { return nil }
        guard let raw = listingURL, let url = URL(string: raw), Self.hostAllowed(url, flow: flow) else {
            return nil
        }
        self.flow = flow
        self.listingURL = url

        let config = WKWebViewConfiguration()
        // The seller's own session for this marketplace, on this device, in its
        // own jar. See WebDelistDataStore for why it is per marketplace.
        config.websiteDataStore = WebDelistDataStore.store(for: platform)
        // The marketplaces render their seller pages as desktop-first SPAs and
        // the delist controls differ on the mobile tree. Ask for the desktop
        // site, which is the same tree the verified selectors were checked
        // against. Nothing here spoofs a different browser: WebKit is WebKit,
        // and this is the same switch Safari offers a person.
        config.defaultWebpagePreferences.preferredContentMode = .desktop
        self.webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
        // Not offscreen, not zero-height, not hidden behind anything. The seller
        // watching the page is the feature, not a courtesy.
        self.webView.isInspectable = false
    }

    // MARK: - the run

    /// Load the listing. Called from the view's `onAppear`, which is reachable
    /// only from the seller tapping this listing's "End it now".
    func load() {
        phase = .loading
        webView.load(URLRequest(url: listingURL))
    }

    /// Start clicking, after the seller has confirmed on the consent sheet.
    func start() {
        guard runTask == nil else { return }
        runTask = Task { [weak self] in
            await self?.run()
            self?.runTask = nil
        }
    }

    /// The seller touched the page. Stop, permanently, and say so.
    ///
    /// A run that could be resumed by a second tap would make "tap anywhere to
    /// take over" a lie the first time somebody scrolled.
    func handOver() {
        runTask?.cancel()
        runTask = nil
        phase = .handedOver
    }

    /// The seller says they dealt with the sign-in or the human check.
    /// The ONLY way a stopped run continues. Nothing here is on a timer.
    func sellerSaysContinue() {
        switch phase {
        case .signInNeeded, .humanCheck:
            phase = .idle
            start()
        default:
            break
        }
    }

    /// The seller answered a native browser dialog.
    func answerConfirm(_ accepted: Bool) {
        let resume = pendingConfirm
        pendingConfirm = nil
        resume?(accepted)
        if accepted {
            phase = .working("Confirming")
        } else {
            phase = .handedOver
        }
    }

    private func run() async {
        if await pageWantsSignIn() {
            phase = .signInNeeded
            return
        }
        if await pageWantsHuman() {
            phase = .humanCheck
            return
        }

        // 1. The menu or edit control that exposes the delete.
        phase = .working("Opening the listing's menu")
        guard let menu = flow.menu, await click(menu) else {
            phase = .failed(cannotFind("the listing's menu"))
            return
        }

        // Poshmark's delete lives on the edit page rather than in a panel, so
        // clicking the control loads a page and the rest of the run happens
        // there. Waiting for that navigation is the difference between a run
        // that continues and one that clicks into a page that is unloading.
        if let navigatesTo = flow.navigatesTo {
            await waitForNavigation()
            let landed = await currentURL()
            guard let landed, matches(pattern: navigatesTo, landed) else {
                phase = .failed(
                    "\(flow.label) did not open the page GradeThread expected. Nothing was "
                        + "changed. Finish it here and tap Done."
                )
                return
            }
        }

        if await pageWantsHuman() {
            phase = .humanCheck
            return
        }

        // 2. The delete control.
        phase = .working("Finding the end-listing button")
        guard let remove = flow.remove, await click(remove) else {
            phase = .failed(cannotFind("the end-listing button"))
            return
        }

        // 3. The confirmation. A native browser dialog goes through
        //    WKUIDelegate below and is answered by the seller, not by this code.
        phase = .working("Confirming")
        if let confirm = flow.confirm {
            _ = await click(confirm)
        }

        // 4. Verify, rather than trust the click. A click that landed on
        //    nothing looks exactly like one that worked.
        phase = .working("Checking it actually ended")
        let ended = await verifyEnded()
        if ended {
            phase = .succeeded
        } else {
            phase = .failed(
                "GradeThread clicked through, but could not confirm \(flow.label) actually "
                    + "ended the listing. Check it here before you mark it done."
            )
        }
    }

    private func cannotFind(_ what: String) -> String {
        "GradeThread could not find \(what) on this \(flow.label) page. The site has probably "
            + "changed. Nothing was changed on your listing. You can finish it here."
    }

    // MARK: - page reads
    //
    // Every string evaluated below is in this file. Nothing is fetched, built
    // from a server value, or interpolated from anything but a selector that
    // came out of the compiled-in flow table.

    private func evaluateBool(_ script: String) async -> Bool {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { value, _ in
                continuation.resume(returning: (value as? Bool) ?? false)
            }
        }
    }

    /// A password field is the universal tell for a login page, on the URL or
    /// rendered in place by an SPA. Same detector as `lister/common.js`.
    private func pageWantsSignIn() async -> Bool {
        await evaluateBool("!!document.querySelector('input[type=\"password\"]')")
    }

    /// A human check. Deliberately generous: a false positive costs the seller
    /// one tap on Continue, and a false negative is this app clicking at a
    /// challenge, which is the thing that must never happen.
    private func pageWantsHuman() async -> Bool {
        let script = """
        (function () {
          var sel = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="challenge"],'
            + ' div#px-captcha, div[class*="captcha"], div[id*="captcha"], iframe[src*="arkoselabs"]';
          if (document.querySelector(sel)) return true;
          var t = (document.body && document.body.innerText || '').toLowerCase();
          return t.indexOf('press and hold') > -1 || t.indexOf('verify you are human') > -1
            || t.indexOf('are you a robot') > -1;
        })()
        """
        return await evaluateBool(script)
    }

    /// Wait for a selector, then click it. False means it never appeared, which
    /// is a stop, never a shrug.
    private func click(_ selector: String) async -> Bool {
        let literal = Self.jsStringLiteral(selector)
        let deadline = Date().addingTimeInterval(Self.selectorTimeout)
        while Date() < deadline {
            if Task.isCancelled { return false }
            let clicked = await evaluateBool("""
            (function () {
              var el = document.querySelector(\(literal));
              if (!el) return false;
              el.click();
              return true;
            })()
            """)
            if clicked { return true }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return false
    }

    /// The listing is gone when the control that only exists on a live listing
    /// is gone, or the page navigated away from the listing URL.
    private func verifyEnded() async -> Bool {
        let deadline = Date().addingTimeInterval(Self.selectorTimeout)
        while Date() < deadline {
            if Task.isCancelled { return false }
            if let gone = flow.goneWhenEnded {
                let stillThere = await evaluateBool(
                    "!!document.querySelector(\(Self.jsStringLiteral(gone)))"
                )
                if !stillThere { return true }
            }
            if let now = await currentURL(), let pattern = flow.liveListingUrlPattern,
               !matches(pattern: pattern, now) {
                return true
            }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        return false
    }

    private func currentURL() async -> String? {
        webView.url?.absoluteString
    }

    private func matches(pattern: String, _ value: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.firstMatch(in: value, options: [], range: range) != nil
    }

    private func waitForNavigation() async {
        await withCheckedContinuation { continuation in
            navigationContinuation = continuation
        }
    }

    /// A CSS selector as a JavaScript string literal.
    ///
    /// The selectors are compiled in, so this is not a trust boundary, but the
    /// escaping is real: every one of them contains double quotes, and a
    /// concatenated `'...'` would end the literal in the middle of
    /// `[data-test="listing-menu"]` and evaluate whatever followed.
    static func jsStringLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"" + escaped + "\""
    }
}

// MARK: - navigation

extension WebDelistRunner: WKNavigationDelegate {

    /// The run never leaves the marketplace.
    ///
    /// A redirect to a payment page, an ad network or an OAuth provider is not
    /// somewhere GradeThread should be driving clicks, and following one would
    /// mean this object is scripting a page nobody vetted. Refusing it stops
    /// the run and leaves the seller on a page they can read.
    nonisolated func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        Task { @MainActor in
            if Self.hostAllowed(url, flow: self.flow) {
                decisionHandler(.allow)
            } else {
                // Allowed to LOAD is not the same as allowed to be scripted, and
                // a sign-in that bounces through an identity provider is a real
                // case. So: let the seller see it, and stop the run.
                self.runTask?.cancel()
                self.runTask = nil
                if case .working = self.phase {
                    self.phase = .failed(
                        "\(self.flow.label) sent this page somewhere else, so GradeThread "
                            + "stopped. Nothing was changed."
                    )
                }
                decisionHandler(.allow)
            }
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        Task { @MainActor in
            let continuation = self.navigationContinuation
            self.navigationContinuation = nil
            continuation?.resume()
            if case .loading = self.phase {
                self.phase = .idle
            }
        }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation?,
        withError error: Error
    ) {
        Task { @MainActor in
            let continuation = self.navigationContinuation
            self.navigationContinuation = nil
            continuation?.resume()
            self.phase = .failed(
                "This \(self.flow.label) page did not load. Check your connection and try again."
            )
        }
    }
}

// MARK: - native dialogs

extension WebDelistRunner: WKUIDelegate {

    /// Grailed and friends confirm a delete with a native browser dialog.
    ///
    /// THIS IS THE ONE THING iOS CAN DO THAT THE DESKTOP EXTENSION STRUCTURALLY
    /// CANNOT: nothing running inside a page can answer `window.confirm`, which
    /// is why `marketplace-disclosure.ts` tells Grailed sellers their listings
    /// have to be ended by hand. Here the app owns the `WKUIDelegate`, so the
    /// dialog is reachable.
    ///
    /// It is still not answered automatically. The seller sees the
    /// marketplace's own question, in their own words, and taps. A dialog is not
    /// a CAPTCHA and answering one would not be circumventing anything, but
    /// "GradeThread clicked Yes on a confirmation you never saw" is not a
    /// sentence this feature can afford either.
    nonisolated func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Task { @MainActor in
            self.pendingConfirm = completionHandler
            self.phase = .confirm(message)
        }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in
            completionHandler()
        }
    }
}
