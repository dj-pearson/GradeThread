import Foundation
import WebKit

/// US-3455 -- filling a marketplace's create-listing form, in a web view the
/// seller is signed into and looking at, and then stopping.
///
/// WHAT THIS IS, IN ONE SENTENCE THE COPY ALSO HAS TO BE TRUE OF: the seller
/// taps one garment, a `WKWebView` opens the marketplace's own create form,
/// this object types the title, description, price and brand into it while
/// the seller watches, and then it stops with the marketplace's own Post
/// button on screen. The seller adds the photos, sets the pickers and posts.
///
/// It is the sibling of `WebDelistRunner` and holds the same five lines,
/// each enforced below rather than promised:
///
///  * **It never submits.** There is no code path that clicks `submit`. The
///    selector is carried so the run can PROBE that it is on the real form,
///    and for nothing else. A listing goes live because the seller pressed
///    the marketplace's button, which is the difference between help in a
///    browser and a bot.
///  * **It is not a background job.** `start` is reachable only from a tap,
///    and iOS suspends `WKWebView` JavaScript the moment the app backgrounds.
///    `ios/Scripts/check-web-delist.py` fails the build if this directory
///    references a scheduler or the background path references it.
///  * **It never answers a human check.** A challenge stops the run and hands
///    the seller the screen (ADR §3.2,
///    `vault/60-decisions/adr-no-server-side-marketplace-automation.md`).
///  * **It never leaves the marketplace.** Every navigation is checked against
///    the flow's own host list.
///  * **It never handles a credential and downloads no script.** The seller
///    signs in on the marketplace's own page; every string evaluated here is
///    in this file or in `ListFlows.generated.swift`, in the binary.
///
/// NEVER A HALF FILL. Every `required` selector is probed before any field is
/// touched. A marketplace redesign that moves one field must read as "could
/// not do it, here is the form, this is the selector version" and not as a
/// listing with a title and no description (US-2165 applied to a third
/// runtime).
@MainActor
final class WebListRunner: NSObject, ObservableObject {

    /// What the seller is told, and what the view renders.
    enum Phase: Equatable {
        case idle
        /// Loading the create form.
        case loading
        /// The marketplace wants a sign-in first. The seller signs in, in this
        /// view, and taps Continue.
        case signInNeeded
        /// Filling, with the step in the seller's words.
        case working(String)
        /// The marketplace asked whether a person is here. GradeThread never
        /// answers one; the seller does, then taps Continue.
        case humanCheck
        /// A native browser dialog is waiting on the seller's answer.
        case nativeConfirm(String)
        /// Filled what it could. The page is the seller's now: photos, the
        /// pickers and the Post button are theirs. The string says which.
        case readyToPost(String)
        /// The seller posted: the web view landed on a live listing URL.
        case listed(URL)
        /// Stopped, with a reason the seller can act on.
        case failed(String)
        /// The seller tapped the page while GradeThread was typing. It is
        /// theirs now; nothing else is filled.
        case handedOver
    }

    @Published private(set) var phase: Phase = .idle

    let flow: ListFlows.Flow
    let webView: WKWebView

    private var pendingConfirm: ((Bool) -> Void)?
    private var navigationContinuation: CheckedContinuation<Void, Never>?
    private var runTask: Task<Void, Never>?
    /// Watches for the live-listing URL after the hand-off. Separate from the
    /// run so a seller who took over and finished by hand still gets the
    /// listing recorded.
    private var watchTask: Task<Void, Never>?

    /// How long a selector may take to appear before the probe gives up.
    /// Marketplace SPAs render late; ten seconds is generous for a control that
    /// is on screen and short enough that a broken selector is not mistaken
    /// for a slow one.
    private static let selectorTimeout: TimeInterval = 10

    /// Why a platform is refused, before anything is loaded.
    static func refusalReason(platform: String) -> String? {
        guard let flow = ListFlows.flow(for: platform) else {
            return "GradeThread does not know \(platform)'s listing form. Queue it for your desktop instead."
        }
        guard flow.enabled else {
            return "Nobody has checked \(flow.label)'s listing form recently enough for "
                + "GradeThread to fill it for you. Queue it for your desktop instead."
        }
        guard WebDelistDataStore.isKnown(platform) else {
            return "GradeThread has nowhere to keep your \(flow.label) sign-in on this device."
        }
        guard let url = URL(string: flow.newListingUrl), hostAllowed(url, flow: flow) else {
            return "GradeThread's copy of \(flow.label)'s listing page address is wrong, so it will not open it."
        }
        return nil
    }

    /// A URL is only ever loaded when its host matches the flow's own list.
    static func hostAllowed(_ url: URL, flow: ListFlows.Flow) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return flow.hosts.contains { allowed in
            host == allowed || host.hasSuffix("." + allowed)
        }
    }

    init?(platform: String) {
        guard let flow = ListFlows.flow(for: platform), flow.enabled else { return nil }
        guard let url = URL(string: flow.newListingUrl), Self.hostAllowed(url, flow: flow) else { return nil }
        self.flow = flow

        let config = WKWebViewConfiguration()
        // The seller's own session for this marketplace, on this device, in
        // its own jar: the same store the delist uses, so one sign-in serves
        // both. See WebDelistDataStore for why it is per marketplace.
        config.websiteDataStore = WebDelistDataStore.store(for: platform)
        // The desktop form, which is the tree the verified selectors were
        // checked against. WebKit is WebKit; this is Safari's own switch.
        config.defaultWebpagePreferences.preferredContentMode = .desktop
        self.webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
        self.webView.isInspectable = false
    }

    // MARK: - the run

    /// Load the create form. Reachable only from the seller tapping "List now
    /// on your phone" and accepting the consent screen.
    func load() {
        phase = .loading
        if let url = URL(string: flow.newListingUrl) {
            webView.load(URLRequest(url: url))
        }
    }

    /// Start filling, after the seller has confirmed on the consent sheet.
    func start(fill: WebListFill) {
        guard runTask == nil else { return }
        runTask = Task { [weak self] in
            await self?.run(fill: fill)
            self?.runTask = nil
        }
    }

    /// The seller touched the page while GradeThread was typing. Stop,
    /// permanently, and say so. The live-URL watch keeps going: a seller who
    /// finishes by hand still posted.
    func handOver() {
        runTask?.cancel()
        runTask = nil
        if case .listed = phase { return }
        phase = .handedOver
        startWatchingForListing()
    }

    /// The seller says they dealt with the sign-in or the human check. The
    /// ONLY way a stopped run continues. Nothing here is on a timer.
    ///
    /// A sign-in usually lands somewhere other than the create form, so the
    /// form is loaded again rather than filled where the seller happens to be.
    func sellerSaysContinue(fill: WebListFill) {
        switch phase {
        case .signInNeeded:
            phase = .idle
            load()
            start(fill: fill)
        case .humanCheck:
            phase = .idle
            start(fill: fill)
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
            phase = .working("Continuing")
        } else {
            handOver()
        }
    }

    /// The sheet is closing. Stop everything; nothing runs off screen.
    func stop() {
        runTask?.cancel()
        runTask = nil
        watchTask?.cancel()
        watchTask = nil
    }

    private func run(fill: WebListFill) async {
        if case .loading = phase {
            await waitForNavigation()
        }
        if Task.isCancelled { return }

        if await pageWantsSignIn() {
            phase = .signInNeeded
            return
        }
        if await pageWantsHuman() {
            phase = .humanCheck
            return
        }

        // 1. Probe EVERY required control before touching any field.
        phase = .working("Checking \(flow.label)'s form")
        for name in flow.required {
            guard let selector = flow.selector(named: name) else {
                phase = .failed(cannotFind(name))
                return
            }
            guard await waitForSelector(selector) else {
                phase = .failed(cannotFind(name))
                return
            }
            if Task.isCancelled { return }
        }

        // 2. Fill the text fields. Each is best-effort ONCE the probe passed:
        //    an optional field a marketplace hid (Poshmark's brand box, say) is
        //    reported as left for the seller, not treated as a failure.
        var filled: [String] = []
        var left: [String] = []

        phase = .working("Typing the title")
        if let title = flow.title, !fill.title.isEmpty, await setValue(title, fill.title) {
            filled.append("title")
        } else {
            left.append("title")
        }
        if Task.isCancelled { return }

        phase = .working("Typing the description")
        if let description = flow.description, !fill.description.isEmpty,
           await setValue(description, fill.description) {
            filled.append("description")
        } else {
            left.append("description")
        }
        if Task.isCancelled { return }

        if let brand = flow.brand, !fill.brand.isEmpty {
            phase = .working("Typing the brand")
            if await setValue(brand, fill.brand) {
                filled.append("brand")
            } else {
                left.append("brand")
            }
        }
        if Task.isCancelled { return }

        phase = .working("Typing the price")
        if fill.price.isEmpty {
            left.append("price")
        } else if let price = flow.price, await setValue(price, fill.price) {
            filled.append("price")
        } else if let open = flow.priceDialogOpen, let dialogPrice = flow.priceDialogPrice,
                  await click(open), await setValue(dialogPrice, fill.price) {
            // Poshmark keeps the price behind a dialog. It is left open: the
            // seller reads the number and closes it, which is one more thing
            // they see rather than one more thing done for them.
            filled.append("price")
        } else {
            left.append("price")
        }
        if Task.isCancelled { return }

        // 3. Stop. The page is the seller's from here.
        phase = .readyToPost(Self.handOffSummary(
            label: flow.label,
            filled: filled,
            left: left,
            photoCount: fill.photoCount,
            pickers: flow.manualFields
        ))
        startWatchingForListing()
    }

    /// The one sentence the seller reads when GradeThread stops typing.
    /// Static and pure so `WebListTests` can pin it.
    static func handOffSummary(
        label: String,
        filled: [String],
        left: [String],
        photoCount: Int,
        pickers: [String]
    ) -> String {
        var parts: [String] = []
        if filled.isEmpty {
            parts.append("Nothing was filled.")
        } else {
            parts.append("Filled the \(joined(filled)).")
        }
        if !left.isEmpty {
            parts.append("Type the \(joined(left)) yourself.")
        }
        if photoCount > 0 {
            parts.append("Add your \(photoCount) photo\(photoCount == 1 ? "" : "s") with \(label)'s own picker.")
        } else {
            parts.append("Add photos with \(label)'s own picker.")
        }
        if !pickers.isEmpty {
            parts.append("Pick the \(joined(pickers.map(pickerWord))).")
        }
        parts.append("Then tap \(label)'s Post button. GradeThread never taps it.")
        return parts.joined(separator: " ")
    }

    private static func pickerWord(_ field: String) -> String {
        switch field {
        case "nwt": return "new-with-tags toggle"
        case "color": return "color"
        default: return field
        }
    }

    private static func joined(_ words: [String]) -> String {
        switch words.count {
        case 0: return ""
        case 1: return words[0]
        case 2: return "\(words[0]) and \(words[1])"
        default: return words.dropLast().joined(separator: ", ") + " and " + (words.last ?? "")
        }
    }

    private func cannotFind(_ what: String) -> String {
        "GradeThread could not find the \(what) field on \(flow.label)'s listing form "
            + "(selector set \(flow.version)). The site has probably changed. Nothing was "
            + "filled. List it yourself here, or queue it for your desktop."
    }

    // MARK: - the listing URL watch

    /// After the hand-off, the only thing left to learn is whether the seller
    /// posted. A live listing URL is the one signal; nothing else records a
    /// listing. Reads `webView.url` on a loop rather than relying on
    /// navigation callbacks because the marketplaces are SPAs that move to
    /// the new listing with `pushState`, which fires no delegate call.
    private func startWatchingForListing() {
        guard watchTask == nil, let pattern = flow.liveListingUrlPattern else { return }
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if let now = self.webView.url, self.matches(pattern: pattern, now.absoluteString),
                   Self.hostAllowed(now, flow: self.flow) {
                    self.phase = .listed(now)
                    self.watchTask = nil
                    return
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    // MARK: - page reads
    //
    // Every string evaluated below is in this file. Nothing is fetched, built
    // from a server value, or interpolated from anything but a selector out of
    // the compiled-in flow table and the fill text, which goes in as a
    // JavaScript string literal and nothing else.

    private func evaluateBool(_ script: String) async -> Bool {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { value, _ in
                continuation.resume(returning: (value as? Bool) ?? false)
            }
        }
    }

    /// A password field, or a URL the flow names as its sign-in page.
    private func pageWantsSignIn() async -> Bool {
        if let pattern = flow.loginUrlPattern, let now = webView.url,
           matches(pattern: pattern, now.absoluteString) {
            return true
        }
        return await evaluateBool("!!document.querySelector('input[type=\"password\"]')")
    }

    /// A human check. Deliberately generous: a false positive costs the seller
    /// one tap on Continue, and a false negative is this app typing at a
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

    /// Wait for a selector to exist. False means it never appeared.
    private func waitForSelector(_ selector: String) async -> Bool {
        let literal = Self.jsStringLiteral(selector)
        let deadline = Date().addingTimeInterval(Self.selectorTimeout)
        while Date() < deadline {
            if Task.isCancelled { return false }
            if await evaluateBool("!!document.querySelector(\(literal))") { return true }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return false
    }

    /// Set a field the way `lister/common.js` `GT.setValue` does: through the
    /// element's native value setter, then `input` and `change`, so a React
    /// or Vue form notices. A plain `el.value = x` is ignored by both.
    private func setValue(_ selector: String, _ value: String) async -> Bool {
        let literal = Self.jsStringLiteral(selector)
        let text = Self.jsStringLiteral(value)
        return await evaluateBool("""
        (function () {
          var el = document.querySelector(\(literal));
          if (!el) return false;
          var proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var d = Object.getOwnPropertyDescriptor(proto, 'value');
          if (d && d.set) { d.set.call(el, \(text)); } else { el.value = \(text); }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
        """)
    }

    /// Click a control that OPENS something (Poshmark's price dialog). Not
    /// used for `submit`, which has no caller in this file by design.
    private func click(_ selector: String) async -> Bool {
        guard await waitForSelector(selector) else { return false }
        let literal = Self.jsStringLiteral(selector)
        return await evaluateBool("""
        (function () {
          var el = document.querySelector(\(literal));
          if (!el) return false;
          el.click();
          return true;
        })()
        """)
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

    /// A string as a JavaScript string literal. The selectors are compiled
    /// in, but the fill text is the seller's own title and description, which
    /// can hold quotes, backslashes and newlines, and a concatenated `'...'`
    /// would end the literal in the middle of one and evaluate the rest.
    static func jsStringLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "\"" + escaped + "\""
    }
}

// MARK: - navigation

extension WebListRunner: WKNavigationDelegate {

    /// The run never leaves the marketplace. A redirect elsewhere is allowed
    /// to LOAD, so the seller can see it, and stops the run.
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
                self.runTask?.cancel()
                self.runTask = nil
                if case .working = self.phase {
                    self.phase = .failed(
                        "\(self.flow.label) sent this page somewhere else, so GradeThread "
                            + "stopped. Nothing was posted."
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
            if case .listed = self.phase { return }
            self.phase = .failed(
                "\(self.flow.label)'s listing page did not load. Check your connection and try again."
            )
        }
    }
}

// MARK: - native dialogs

extension WebListRunner: WKUIDelegate {

    /// A native `confirm()` is surfaced to the seller and answered by them.
    nonisolated func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        Task { @MainActor in
            self.pendingConfirm = completionHandler
            self.phase = .nativeConfirm(message)
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
