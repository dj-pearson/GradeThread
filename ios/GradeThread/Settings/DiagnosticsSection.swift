import SwiftData
import SwiftUI

/// Temporary diagnostics surface for the empty-data / failed-upload issue.
/// Runs ``ConnectionDiagnostics`` and shows the raw result so it can be
/// copied and shared. Safe to remove once the connection issue is resolved.
///
/// Security (audit 2026-06-24): this dumps raw session/table/storage state to a
/// copyable view. It's an internal field-support tool, NOT a production feature,
/// so it renders ONLY in DEBUG and TestFlight (sandbox-receipt) builds — an App
/// Store production build never surfaces session details. PII (email) is also
/// dropped from the probe output itself (see ``ConnectionDiagnostics``) so even
/// an internal build can't leak it.
struct DiagnosticsSection: View {
    // US-1520: the probe only needs a COUNT — the previous unfiltered @Query
    // materialized (and live-observed) the entire items table just for `.count`
    // whenever Settings rendered. fetchCount at tap time instead.
    @Environment(\.modelContext) private var modelContext
    @State private var output = ""
    @State private var running = false

    /// True for DEBUG builds and TestFlight betas (App Store receipts are named
    /// `receipt`; sandbox/TestFlight receipts are `sandboxReceipt`). False for
    /// App Store production, where the diagnostics surface stays hidden.
    static var isInternalBuild: Bool {
        #if DEBUG
        return true
        #else
        return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
        #endif
    }

    var body: some View {
        if Self.isInternalBuild {
            diagnosticsSection
        }
    }

    private var diagnosticsSection: some View {
        Section {
            Button {
                Task {
                    running = true
                    let count = (try? modelContext.fetchCount(
                        FetchDescriptor<LocalInventoryItem>()
                    )) ?? 0
                    output = await ConnectionDiagnostics().run(localItemCount: count)
                    running = false
                }
            } label: {
                HStack {
                    Label("Run connection test", systemImage: "stethoscope")
                    if running {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(running)

            if !output.isEmpty {
                Text(output)
                    .font(.system(.caption2, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } header: {
            Text("Diagnostics")
        } footer: {
            Text("Probes your Supabase connection. Tap, wait, then long-press the result to copy it and paste it back to support.")
                .font(.footnote)
        }
    }
}
