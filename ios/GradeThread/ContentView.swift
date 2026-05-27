import SwiftUI

/// Root view. Owns the ``AuthStore`` for the app lifetime and gates the
/// rest of the UI on auth state via ``ProtectedRouteShell``.
struct ContentView: View {
    @State private var authStore = AuthStore()

    var body: some View {
        ProtectedRouteShell()
            .environment(authStore)
            .task {
                authStore.start()
            }
    }
}

/// Switches between the login surface and the main tab bar based on the
/// observable auth phase. A `.loading` splash covers the brief window
/// before the SDK emits the initial session event on first launch.
struct ProtectedRouteShell: View {
    @Environment(AuthStore.self) private var authStore

    var body: some View {
        switch authStore.phase {
        case .loading:
            VStack(spacing: 16) {
                ProgressView().tint(Color.brandNavy)
                Text("GradeThread")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemBackground))
        case .signedOut:
            LoginView()
        case .signedIn:
            MainTabView()
        }
    }
}

/// Main app surface. Tab structure mirrors the user-flow buckets called out
/// in US-171: triage (Inventory), capture (Add), revenue (Sales), eBay state
/// (Marketplaces), account (Settings). Each tab gets its own
/// `NavigationStack` so deep navigation doesn't leak between tabs.
struct MainTabView: View {
    var body: some View {
        TabView {
            NavigationStack { InventoryPlaceholder() }
                .tabItem { Label("Inventory", systemImage: "shippingbox") }

            NavigationStack { AddPlaceholder() }
                .tabItem { Label("Add", systemImage: "plus.circle.fill") }

            NavigationStack { SalesPlaceholder() }
                .tabItem { Label("Sales", systemImage: "dollarsign.circle") }

            NavigationStack { MarketplacesPlaceholder() }
                .tabItem { Label("Marketplaces", systemImage: "antenna.radiowaves.left.and.right") }

            NavigationStack { SettingsPlaceholder() }
                .tabItem { Label("Settings", systemImage: "gear") }
        }
        .tint(Color.brandNavy)
    }
}

// MARK: - Tab placeholders

/// Each tab gets a stub until its dedicated story lands. They're real
/// `View`s, not text labels, so the surrounding NavigationStack + toolbar
/// patterns are exercised in CI immediately.

private struct InventoryPlaceholder: View {
    var body: some View {
        TabPlaceholder(
            title: "Inventory",
            subtitle: "Your kanban + listings live here once US-180 lands.",
            systemImage: "shippingbox"
        )
    }
}

private struct AddPlaceholder: View {
    var body: some View {
        TabPlaceholder(
            title: "Add an item",
            subtitle: "Photo-first or details-first capture wires in via US-173/US-178.",
            systemImage: "plus.circle.fill"
        )
    }
}

private struct SalesPlaceholder: View {
    var body: some View {
        TabPlaceholder(
            title: "Sales",
            subtitle: "Order + payout views land in US-184.",
            systemImage: "dollarsign.circle"
        )
    }
}

private struct MarketplacesPlaceholder: View {
    var body: some View {
        TabPlaceholder(
            title: "Marketplaces",
            subtitle: "eBay connection + reconciliation in US-183 / US-186.",
            systemImage: "antenna.radiowaves.left.and.right"
        )
    }
}

private struct SettingsPlaceholder: View {
    @Environment(AuthStore.self) private var authStore

    var body: some View {
        List {
            Section("Account") {
                if case let .signedIn(user) = authStore.phase {
                    LabeledContent("Email", value: user.email ?? "—")
                }
                Button(role: .destructive) {
                    Task { await authStore.signOut() }
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            Section {
                Text("Full settings UI ships in US-194.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
    }
}

private struct TabPlaceholder: View {
    let title: String
    let subtitle: String
    let systemImage: String

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: systemImage)
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Color.brandNavy)
            Text(title).font(.title2.weight(.semibold))
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Brand colors

extension Color {
    /// Brand palette mirrors the web app (src/index.css).
    static let brandNavy = Color(red: 15 / 255, green: 52 / 255, blue: 96 / 255)
    static let brandRed = Color(red: 233 / 255, green: 69 / 255, blue: 96 / 255)
}

#Preview {
    ContentView()
}
