import SwiftData
import SwiftUI

@main
struct GradeThreadApp: App {
    /// SwiftData store backing the offline cache. Created eagerly at app
    /// launch so views can synchronously query the cache before the first
    /// sync pass finishes.
    private let container: ModelContainer = {
        do {
            let schema = Schema([
                LocalInventoryItem.self,
                LocalItemPhoto.self,
                LocalListing.self,
                LocalSale.self,
                LocalSource.self,
                LocalPendingMutation.self,
            ])
            // Note: cloudKitDatabase is intentionally `none`; sync goes through
            // Supabase, not iCloud. Keeping CloudKit off avoids surprise
            // duplicate-account merges across iCloud users on one device.
            let configuration = ModelConfiguration(
                schema: schema,
                isStoredInMemoryOnly: false,
                cloudKitDatabase: .none
            )
            return try ModelContainer(for: schema, configurations: configuration)
        } catch {
            // SwiftData can't recover from a busted schema. Crash early
            // with the underlying message — the alternative is silent data
            // loss, which is worse than a relaunch.
            fatalError("Failed to initialize SwiftData container: \(error)")
        }
    }()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .modelContainer(container)
        }
    }
}
