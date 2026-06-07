import SwiftUI

/// Manage multiple connected eBay accounts (US-671). Add, label, select-active,
/// and disconnect individual stores. Reached from the Marketplaces tab.
struct EbayAccountsView: View {
    let userId: String
    @State private var store: EbayAccountsStore
    @State private var renaming: RemoteMarketplaceConnection?
    @State private var renameText = ""

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
        HStack(spacing: 12) {
            Image(systemName: conn.isPrimary ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(conn.isPrimary ? Color.green : Color.secondary)
                .accessibilityLabel(conn.isPrimary ? "Selected" : "Not selected")

            VStack(alignment: .leading, spacing: 2) {
                Text(conn.displayName).font(.body.weight(.medium))
                HStack(spacing: 6) {
                    if conn.label != nil, let handle = conn.accountHandle {
                        Text(handle)
                    }
                    if !conn.isActive {
                        Text("· Disconnected").foregroundStyle(.orange)
                    } else if conn.refreshError != nil {
                        Text("· Reconnect needed").foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if conn.isActive { Task { await store.makePrimary(conn) } }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await store.disconnect(conn) }
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
                    Task { await store.makePrimary(conn) }
                } label: {
                    Label("Select", systemImage: "checkmark.circle")
                }
                .tint(.green)
            }
        }
    }
}
