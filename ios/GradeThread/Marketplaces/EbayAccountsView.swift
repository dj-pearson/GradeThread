import SwiftUI

/// Manage multiple connected eBay accounts (US-671). Add, label, select-active,
/// and disconnect individual stores. Reached from the Marketplaces tab.
struct EbayAccountsView: View {
    let userId: String
    @State private var store: EbayAccountsStore
    @State private var renaming: RemoteMarketplaceConnection?
    @State private var renameText = ""
    /// US-1009: account pending a confirmed disconnect.
    @State private var disconnecting: RemoteMarketplaceConnection?
    /// US-972: account pending a confirmed switch-to-primary. Selecting changes
    /// the default sync/publish target, so confirm before applying.
    @State private var makingPrimary: RemoteMarketplaceConnection?

    init(userId: String) {
        self.userId = userId
        _store = State(initialValue: EbayAccountsStore(userId: userId))
    }

    var body: some View {
        List {
            switch store.phase {
            case .loading:
                Section { ProgressView().frame(maxWidth: .infinity) }
            case .failed(let message):
                Section {
                    ContentUnavailableView(
                        "Couldn't load accounts",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                }
            case .ready:
                accountsSection
            }

            Section {
                Button {
                    Task { await store.addAccount() }
                } label: {
                    HStack {
                        Label("Add eBay account", systemImage: "plus.circle")
                        if store.isConnecting {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(store.isConnecting)
            } footer: {
                Text("Connect more than one eBay store. The selected account is the one Sync and Publish use.")
            }
        }
        .navigationTitle("eBay accounts")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load() }
        .refreshable { await store.load() }
        .alert("Rename account", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("Label", text: $renameText)
            Button("Save") {
                if let conn = renaming {
                    let text = renameText
                    Task { await store.rename(conn, to: text) }
                }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        } message: {
            Text("Give this store a name so you can tell it apart.")
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.actionError != nil },
            set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
        // US-1009: disconnect breaks publishing/sync — confirm first, naming the
        // store. Reached from both the swipe action and the VoiceOver action.
        .confirmationDialog(
            disconnecting?.disconnectConfirmationTitle ?? "Disconnect account?",
            isPresented: Binding(
                get: { disconnecting != nil },
                set: { if !$0 { disconnecting = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                if let conn = disconnecting {
                    Task { await store.disconnect(conn) }
                }
                disconnecting = nil
            }
            Button("Cancel", role: .cancel) { disconnecting = nil }
        } message: {
            Text("Disconnecting stops sync and publishing for this store. You can reconnect it later.")
        }
        // US-972: selecting a different store changes the default sync/publish
        // target — confirm the consequence, naming the store, before applying.
        .confirmationDialog(
            "Make this your primary account?",
            isPresented: Binding(
                get: { makingPrimary != nil },
                set: { if !$0 { makingPrimary = nil } }
            ),
            titleVisibility: .visible,
            presenting: makingPrimary
        ) { conn in
            Button("Make primary") {
                Task { await store.makePrimary(conn) }
                makingPrimary = nil
            }
            Button("Cancel", role: .cancel) { makingPrimary = nil }
        } message: { conn in
            Text("Sync and Publish will use \(conn.displayName) as the default eBay store.")
        }
    }

    @ViewBuilder
    private var accountsSection: some View {
        if store.connections.isEmpty {
            Section {
                ContentUnavailableView(
                    "No eBay accounts",
                    systemImage: "antenna.radiowaves.left.and.right",
                    description: Text("Add your first eBay store to start syncing and listing.")
                )
            }
        } else {
            Section("Connected stores") {
                ForEach(store.connections) { conn in
                    accountRow(conn)
                }
            }
        }
    }

    @ViewBuilder
    private func accountRow(_ conn: RemoteMarketplaceConnection) -> some View {
        // US-1009: the row is a real Button so VoiceOver/Switch Control announce
        // it as a button and a double-tap selects (makes primary) the account.
        // Per-action operations (select/rename/disconnect) used to live ONLY in
        // swipeActions, which assistive tech can't reach — they're now also
        // exposed via `.accessibilityActions` below.
        Button {
            if conn.isActive && !conn.isPrimary { makingPrimary = conn }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: conn.isPrimary ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(conn.isPrimary ? Color.brandEmerald : Color.secondary)

                VStack(alignment: .leading, spacing: 2) {
                    Text(conn.displayName).font(.body.weight(.medium))
                    HStack(spacing: 6) {
                        if conn.label != nil, let handle = conn.accountHandle {
                            Text(handle)
                        }
                        if !conn.isActive {
                            Text("· Disconnected").foregroundStyle(.brandAmber)
                        } else if conn.refreshError != nil {
                            Text("· Reconnect needed").foregroundStyle(.brandAmber)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(conn.accessibilityRowLabel)
        .accessibilityHint(conn.isActive && !conn.isPrimary ? "Selects this account for sync and publish" : "")
        .accessibilityActions {
            if conn.isActive && !conn.isPrimary {
                Button("Select for sync and publish") {
                    makingPrimary = conn
                }
            }
            Button("Rename") {
                renameText = conn.label ?? ""
                renaming = conn
            }
            Button("Disconnect") { disconnecting = conn }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                disconnecting = conn
            } label: {
                Label("Disconnect", systemImage: "minus.circle")
            }
            Button {
                renameText = conn.label ?? ""
                renaming = conn
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            .tint(.blue)
            if conn.isActive && !conn.isPrimary {
                Button {
                    makingPrimary = conn
                } label: {
                    Label("Select", systemImage: "checkmark.circle")
                }
                .tint(.brandEmerald)
            }
        }
    }
}
