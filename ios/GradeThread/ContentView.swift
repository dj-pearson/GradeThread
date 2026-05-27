import SwiftData
import SwiftUI
import UIKit

/// Root view. Owns the ``AuthStore`` for the app lifetime and gates the
/// rest of the UI on auth state via ``ProtectedRouteShell``. Also owns the
/// long-lived ``SyncEngine`` + supporting observables (NetworkMonitor +
/// SyncStatusStore) so they keep working across tab switches.
struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

    @State private var authStore = AuthStore()
    @State private var networkMonitor = NetworkMonitor()
    @State private var syncStatus = SyncStatusStore()
    @State private var syncEngine: SyncEngine?

    var body: some View {
        ProtectedRouteShell()
            .environment(authStore)
            .environment(networkMonitor)
            .environment(syncStatus)
            .task {
                authStore.start()
                networkMonitor.start()
                startSyncEngineIfNeeded()
            }
            .onChange(of: authStore.phase) { _, newPhase in
                // Boot the sync engine the moment the user signs in;
                // pause it when they sign out so the offline queue doesn't
                // try to push the previous user's mutations.
                switch newPhase {
                case .signedIn:
                    startSyncEngineIfNeeded()
                case .signedOut:
                    Task { await syncEngine?.stop() }
                    syncEngine = nil
                case .loading:
                    break
                }
            }
            .onChange(of: scenePhase) { _, newValue in
                if newValue == .active {
                    Task { await syncEngine?.sync() }
                }
            }
    }

    private func startSyncEngineIfNeeded() {
        guard syncEngine == nil, case .signedIn = authStore.phase else { return }
        let engine = SyncEngine(
            container: modelContext.container,
            statusStore: syncStatus,
            networkMonitor: networkMonitor
        )
        syncEngine = engine
        Task {
            await engine.start()
            await engine.sync()
        }
    }
}

/// Switches between the login surface and the main shell based on the
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
            MainShell()
        }
    }
}

// MARK: - Main shell (TabView ↔ NavigationSplitView)

/// The five-section app surface. On compact horizontal width (iPhone, iPad
/// in Slide Over / Split View on the narrow side) it renders as a TabView;
/// at regular width (iPad full-screen) it switches to a NavigationSplitView
/// with a sidebar. The section model is shared so deep links + selection
/// state survive the layout switch.
struct MainShell: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var router = AppRouter()

    var body: some View {
        // Shadowing-binding pattern: `@State` owns the Observable, then a
        // local `@Bindable` exposes write-bindings to its properties for
        // SwiftUI sheets / popovers.
        @Bindable var router = router
        VStack(spacing: 0) {
            SyncStatusBar()
                .animation(.easeInOut(duration: 0.2), value: router.selection)
            Group {
                if horizontalSizeClass == .regular {
                    SidebarSplitView(router: router)
                } else {
                    TabBarShell(router: router)
                }
            }
        }
        .confirmationDialog(
            "Add an item",
            isPresented: $router.showingAddSheet,
            titleVisibility: .visible
        ) {
            Button("Photo-first (Snap & Catalog)") {
                router.startIntake(.photoFirst)
            }
            Button("Details-first (manual form)") {
                router.startIntake(.detailsFirst)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Where would you like to start?")
        }
    }
}

// MARK: - iPhone / compact layout

private struct TabBarShell: View {
    @Bindable var router: AppRouter

    var body: some View {
        TabView(selection: router.tabSelectionBinding) {
            NavigationStack(path: $router.inventoryPath) {
                InventoryPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
            }
            .tabItem { Label("Inventory", systemImage: "shippingbox") }
            .tag(AppSection.inventory)

            // The Add tab is intercepted in tabSelectionBinding — tapping it
            // shows the confirmation dialog and reverts selection instead of
            // navigating. The placeholder view is never actually rendered.
            Color.clear
                .tabItem {
                    Label("Add", systemImage: "plus.circle.fill")
                }
                .tag(AppSection.add)

            NavigationStack(path: $router.salesPath) {
                SalesPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
            }
            .tabItem { Label("Sales", systemImage: "dollarsign.circle") }
            .tag(AppSection.sales)

            NavigationStack(path: $router.marketplacesPath) {
                MarketplacesPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
            }
            .tabItem { Label("Marketplaces", systemImage: "antenna.radiowaves.left.and.right") }
            .tag(AppSection.marketplaces)

            NavigationStack(path: $router.settingsPath) {
                SettingsPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
            }
            .tabItem { Label("Settings", systemImage: "gear") }
            .tag(AppSection.settings)
        }
        .tint(Color.brandNavy)
    }

    @ViewBuilder
    private func intakeDestination(_ route: IntakeRoute) -> some View {
        IntakePlaceholder(route: route)
    }
}

// MARK: - iPad / regular layout

private struct SidebarSplitView: View {
    @Bindable var router: AppRouter

    var body: some View {
        NavigationSplitView {
            List(selection: router.sidebarSelectionBinding) {
                Section("Workspace") {
                    Label("Inventory", systemImage: "shippingbox").tag(AppSection.inventory)
                    Label("Sales", systemImage: "dollarsign.circle").tag(AppSection.sales)
                    Label("Marketplaces", systemImage: "antenna.radiowaves.left.and.right").tag(AppSection.marketplaces)
                }
                Section("Account") {
                    Label("Settings", systemImage: "gear").tag(AppSection.settings)
                }
            }
            .navigationTitle("GradeThread")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        AppRouter.haptic()
                        router.showingAddSheet = true
                    } label: {
                        Label("Add", systemImage: "plus.circle.fill")
                    }
                }
            }
        } detail: {
            detailColumn
        }
    }

    @ViewBuilder
    private var detailColumn: some View {
        switch router.selection {
        case .inventory:
            NavigationStack(path: $router.inventoryPath) {
                InventoryPlaceholder()
                    .navigationDestination(for: IntakeRoute.self) { IntakePlaceholder(route: $0) }
            }
        case .sales:
            NavigationStack(path: $router.salesPath) {
                SalesPlaceholder()
                    .navigationDestination(for: IntakeRoute.self) { IntakePlaceholder(route: $0) }
            }
        case .marketplaces:
            NavigationStack(path: $router.marketplacesPath) {
                MarketplacesPlaceholder()
                    .navigationDestination(for: IntakeRoute.self) { IntakePlaceholder(route: $0) }
            }
        case .settings:
            NavigationStack(path: $router.settingsPath) {
                SettingsPlaceholder()
                    .navigationDestination(for: IntakeRoute.self) { IntakePlaceholder(route: $0) }
            }
        case .add:
            EmptyView() // Never the resting selection — see AppRouter.
        }
    }
}

// MARK: - Routing

/// One of the four main sections, plus a pseudo-section for the Add tab.
/// Add is never the resting selection — tapping it triggers the action
/// sheet and the previous selection is restored synchronously.
enum AppSection: Hashable {
    case inventory, add, sales, marketplaces, settings
}

/// Intake destinations pushed onto the active tab's NavigationStack after
/// the user picks Photo-first or Details-first from the Add sheet.
enum IntakeRoute: Hashable {
    case photoFirst
    case detailsFirst
}

/// State and selection logic for the main shell. Holds one `NavigationPath`
/// per tab so deep navigation doesn't leak across tabs (US-171 AC), the
/// resting selection, and the Add-sheet trigger.
@Observable
final class AppRouter {
    var selection: AppSection = .inventory
    var showingAddSheet = false

    var inventoryPath = NavigationPath()
    var salesPath = NavigationPath()
    var marketplacesPath = NavigationPath()
    var settingsPath = NavigationPath()

    /// Binding wrapper used by `TabView(selection:)` that intercepts the
    /// `.add` selection, fires haptic feedback on every real change, and
    /// keeps the resting selection on the previous tab when Add is tapped.
    var tabSelectionBinding: Binding<AppSection> {
        Binding(
            get: { self.selection },
            set: { newValue in
                Self.haptic()
                if newValue == .add {
                    // Don't change `selection`: that snaps the tab bar back
                    // visually after the brief tap state.
                    self.showingAddSheet = true
                    return
                }
                self.selection = newValue
            }
        )
    }

    /// Same idea for the iPad sidebar List(selection:). The selection
    /// binding's value type is Optional because List allows clearing.
    var sidebarSelectionBinding: Binding<AppSection?> {
        Binding(
            get: { self.selection },
            set: { newValue in
                guard let newValue else { return }
                Self.haptic()
                if newValue == .add {
                    self.showingAddSheet = true
                    return
                }
                self.selection = newValue
            }
        )
    }

    /// Appends the picked intake route to whichever tab is currently
    /// active. The view layer handles the actual destination via
    /// `navigationDestination(for: IntakeRoute.self)`.
    func startIntake(_ route: IntakeRoute) {
        switch selection {
        case .inventory:    inventoryPath.append(route)
        case .sales:        salesPath.append(route)
        case .marketplaces: marketplacesPath.append(route)
        case .settings:     settingsPath.append(route)
        case .add:          inventoryPath.append(route) // shouldn't happen
        }
    }

    /// Light-impact haptic on tab change. Lazily instantiated and prepared
    /// each time so the OS can hint the haptics engine — Apple HIG calls
    /// this out specifically for tab switches.
    static func haptic() {
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.prepare()
        generator.impactOccurred()
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

private struct IntakePlaceholder: View {
    let route: IntakeRoute

    var body: some View {
        TabPlaceholder(
            title: route == .photoFirst ? "Snap & Catalog" : "New item",
            subtitle: route == .photoFirst
                ? "Photo-first capture flow lands in US-173 / US-176."
                : "Details-first form lands in US-178.",
            systemImage: route == .photoFirst ? "camera" : "square.and.pencil"
        )
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
