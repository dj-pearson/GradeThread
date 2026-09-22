import SwiftUI
import WebKit

/// US-3455 -- the screen the seller watches while their listing form is filled.
///
/// ONE VIEW, TWO STATES, NO NESTED SHEET. The consent step is a full
/// replacement of this view's body rather than a sheet on top of a sheet
/// (`Scripts/check-chained-sheets.py`). It is the delist consent with "end"
/// replaced by "list", plus the one sentence that is new: photos are chosen
/// in the marketplace's own picker.
///
/// The web view is always full size and always on top of nothing. That is a
/// requirement, not a layout choice (`vault/10-ops/ios-webview-delist-app-review.md` §3).
struct WebListView: View {

    let platform: String
    let fill: WebListFill
    /// Called once the web view lands on a live listing URL, so the caller
    /// can record it through the edge. Called at most once.
    let onListed: (URL) -> Void

    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppPreferences.webListConsentedKey) private var consentRecord = ""

    @StateObject private var model: WebListModel
    @State private var reported = false

    init(platform: String, fill: WebListFill, onListed: @escaping (URL) -> Void) {
        self.platform = platform
        self.fill = fill
        self.onListed = onListed
        _model = StateObject(wrappedValue: WebListModel(platform: platform, fill: fill))
    }

    private var consented: Bool {
        WebListModel.hasConsented(consentRecord, platform: platform, version: model.version)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let reason = model.refusal {
                    refusedBody(reason)
                } else if consented {
                    runBody
                } else {
                    consentBody
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .onDisappear { model.stop() }
    }

    // MARK: - consent, shown once per marketplace and selector version

    private var consentBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("List this on \(model.label), from your phone")
                    .font(.title3.weight(.semibold))

                Text("GradeThread will open \(model.label)'s website here and fill in the listing form while you watch. You add the photos, check it over and post it yourself. You stay in control the whole time.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 12) {
                    consentPoint("You sign in to \(model.label) yourself, on \(model.label)'s own page. GradeThread never sees your password and never stores it.")
                    consentPoint("Nothing runs unless you tap. There is no background job, and nothing happens while this app is closed.")
                    consentPoint("Photos are chosen in \(model.label)'s own picker, from your camera roll. GradeThread never posts the listing: you tap \(model.label)'s Post button.")
                    consentPoint("If \(model.label) asks you to prove you are a person, GradeThread stops and hands you the screen. It will never answer that for you.")
                    // The SAME sentence the web, the Marketplaces screen and
                    // the delist consent show. A phone disclosure gentler than
                    // the web one is the thing that costs most if anyone ever
                    // lines them up.
                    consentPoint(WebDelistModel.riskDisclosure(label: model.label))
                }

                Text("GradeThread is not affiliated with \(model.label).")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    consentRecord = WebListModel.recordingConsent(
                        consentRecord,
                        platform: platform,
                        version: model.version
                    )
                } label: {
                    Text("Open \(model.label) and fill it in")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)

                Button("Not now") { dismiss() }
                    .font(.subheadline)
                    .frame(maxWidth: .infinity)
            }
            .padding(20)
        }
    }

    private func consentPoint(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.circle")
                .font(.body)
                .foregroundStyle(Color.brandNavy)
            Text(text)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - the run

    @ViewBuilder
    private var runBody: some View {
        VStack(spacing: 0) {
            statusBar
            if let runner = model.runnerOrNil {
                WebListWebView(runner: runner)
                    .overlay(alignment: .center) { takeOverCatcher }
            }
        }
        .onAppear { model.begin() }
        .onChange(of: model.phase) { _, phase in
            if case .listed(let url) = phase, !reported {
                reported = true
                onListed(url)
            }
        }
        .alert(
            "\(model.label) is asking",
            isPresented: Binding(
                get: { model.confirmMessage != nil },
                set: { if !$0 { model.answerConfirm(false) } }
            )
        ) {
            Button("Yes") { model.answerConfirm(true) }
            Button("Cancel", role: .cancel) { model.answerConfirm(false) }
        } message: {
            Text(model.confirmMessage ?? "")
        }
    }

    /// The line that has to be true: what it is doing, and how to stop it.
    @ViewBuilder
    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.statusLine)
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity, alignment: .leading)

            if model.needsSeller {
                Button("Continue") { model.sellerSaysContinue() }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

            if model.listedURL != nil {
                Button("Done") { dismiss() }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
    }

    /// A transparent layer over the page that turns the first touch into a
    /// hand-over, then gets out of the way for good. It exists only while the
    /// app is typing; from the hand-off on, every touch goes to the page.
    @ViewBuilder
    private var takeOverCatcher: some View {
        if model.isDriving {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { model.handOver() }
                .accessibilityLabel("Take over from GradeThread")
                .accessibilityHint("Stops GradeThread and gives you the page")
        }
    }

    // MARK: - refused

    private func refusedBody(_ reason: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(reason)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Close") { dismiss() }
                .font(.subheadline)
        }
        .padding(24)
    }
}

/// The web view itself. The runner owns the `WKWebView`; nothing here
/// recreates or reconfigures one, and nothing here dismisses anything
/// (`Scripts/no-uikit-self-dismiss.py`).
struct WebListWebView: UIViewRepresentable {
    let runner: WebListRunner

    func makeUIView(context: Context) -> WKWebView {
        runner.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
