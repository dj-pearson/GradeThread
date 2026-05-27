import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            Text("Inventory")
                .tabItem { Label("Inventory", systemImage: "tray.full") }

            Text("Add")
                .tabItem { Label("Add", systemImage: "plus.circle.fill") }

            Text("Sales")
                .tabItem { Label("Sales", systemImage: "chart.line.uptrend.xyaxis") }

            Text("Settings")
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(Color.brandNavy)
    }
}

extension Color {
    // Brand palette mirrors the web app (src/index.css).
    static let brandNavy = Color(red: 15 / 255, green: 52 / 255, blue: 96 / 255)
    static let brandRed = Color(red: 233 / 255, green: 69 / 255, blue: 96 / 255)
}

#Preview {
    ContentView()
}
