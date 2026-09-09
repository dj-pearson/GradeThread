import SwiftUI
import WebKit

/// US-3281 — the screen the seller watches while their listing is ended.
///
/// ONE VIEW, TWO STATES, NO NESTED SHEET. The consent step is a full replacement
/// of this view's body rather than a sheet on top of a sheet: a view has one
/// presentation slot, and stacking them is the bug `Scripts/check-chained-sheets.py`
/// exists to catch. It also reads better. Consent is not an interruption of the
/// flow, it is the first screen of it.
///
/// The web view is always full size and always on top of nothing. That is a
/// requirement, not a layout choice: the case for this feature is that the
/// seller can see their own marketplace doing the thing, and a run behind a
/// spinner would be a different product with the same code.
/// See `vault/10-ops/ios-webview-delist-app-review.md` §3.
struct WebDelistView: View {

    let row: PendingDelistService.PendingDelist
    /// Called once the listing is confirmed ended, so the caller can settle the
    /// row through the edge and drop it from the list.
    let onEnded: (PendingDelistService.PendingDelist) -> Void

    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppPreferences.webDelistConsentedKey) private var consented = false

    @StateObject private var model: WebDelistModel

    init(
        row: PendingDelistService.PendingDelist,
        onEnded: @escaping (PendingDelistService.PendingDelist) -> Void
    ) {
        self.row = row
        self.onEnded = onEnded
        _model = StateObject(wrappedValue: WebDelistModel(row: row))
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
    }

    // MARK: - consent, shown once

    private var consentBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("End this listing on \(model.label), from your phone")
                    .font(.title3.weight(.semibold))

                Text("GradeThread will open \(model.label)'s website here and end this listing while you watch. You stay in control the whole time.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 12) {
                    consentPoint("You sign in to \(model.label) yourself, on \(model.label)'s own page. GradeThread never sees your password and never stores it.")
                    consentPoint("Nothing runs unless you tap. There is no background job, and nothing happens while this app is closed.")
                    consentPoint("If \(model.label) asks you to prove you are a person, GradeThread stops and hands you the screen. It will never answer that for you.")
                    // The SAME sentence the web and the Marketplaces screen show.
                    // A phone disclosure gentler than the web one is the thing
                    // that costs most if anyone ever lines them up.
                    consentPoint(WebDelistModel.riskDisclosure(label: model.label))
                }

                Text("GradeThread is not affiliated with \(model.label).")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    consented = true
                } label: {
                    Text("Open \(model.label) and end it")
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
                WebDelistWebView(runner: runner)
                    .overlay(alignment: .center) { takeOverCatcher }
            }
        }
        .onAppear { model.begin() }
        .onChange(of: model.phase) { _, phase in
            if phase == .succeeded { onEnded(row) }
        }
        .alert(
            "\(model.label) is asking",
            isPresented: Binding(
                get: { model.confirmMessage != nil },
                set: { if !$0 { model.answerConfirm(false) } }
            )
        ) {
            Button("Yes, end it") { model.answerConfirm(true) }
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

            if model.phase == .succeeded {
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
    /// hand-over, then gets out of the way for good.
    ///
    /// It exists only while the app is driving. The moment the seller takes
    /// over, or the run stops for any reason, the page is theirs and every
    /// touch goes straight to it.
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
            if let url = model.listingLink {
                Link("Open \(model.label)", destination: url)
                    .font(.subheadline.weight(.semibold))
            }
            Button("Close") { dismiss() }
                .font(.subheadline)
        }
        .padding(24)
    }
}

/// The web view itself. Deliberately the plainest possible representable: the
/// runner owns the `WKWebView`, so nothing here recreates or reconfigures one.
///
/// No `dismiss()` from inside a representable (`Scripts/no-uikit-self-dismiss.py`):
/// SwiftUI owns presentation, and this view only ever draws.
struct WebDelistWebView: UIViewRepresentable {
    let runner: WebDelistRunner

    func makeUIView(context: Context) -> WKWebView {
        runner.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
