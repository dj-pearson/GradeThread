import SwiftUI

/// Temporary diagnostics surface for the empty-data / failed-upload issue.
/// Runs ``ConnectionDiagnostics`` and shows the raw result so it can be
/// copied and shared. Safe to remove once the connection issue is resolved.
struct DiagnosticsSection: View {
    @State private var output = ""
    @State private var running = false

    var body: some View {
        Section {
            Button {
                Task {
                    running = true
                    output = await ConnectionDiagnostics().run()
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
