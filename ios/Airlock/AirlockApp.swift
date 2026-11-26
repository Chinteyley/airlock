import SwiftUI

@main
struct AirlockApp: App {
  init() { Firebase.configure() }

  var body: some Scene {
    WindowGroup { RootView().preferredColorScheme(.dark) }
  }
}

struct RootView: View {
  @State private var device = deviceState()
  @State private var policy: Policy?

  var body: some View {
    TabView {
      Tab("Draft", systemImage: "lock.doc") { screen("Airlock") { DraftScreen(device: device, policy: policy) } }
      Tab("Audit", systemImage: "checkmark.shield") { screen("Audit") { AuditScreen(device: device) } }
      Tab("History", systemImage: "clock") { screen("History") { HistoryScreen() } }
    }
    .tint(Theme.held)
    .task { policy = await loadPolicy() }
  }

  private func screen<V: View>(_ title: String, @ViewBuilder _ content: () -> V) -> some View {
    NavigationStack {
      content()
        .navigationTitle(title)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 6) {
              Circle().fill(device == .ready ? Theme.held : Theme.warn).frame(width: 8, height: 8)
              Text(device == .ready ? "On-device ready" : "Sealed").font(.caption).foregroundStyle(Theme.text2)
            }
          }
        }
        .toolbarBackground(Theme.ground, for: .navigationBar)
    }
  }
}
