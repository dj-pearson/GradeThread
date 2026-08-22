import Supabase
import SwiftUI

/// US-194 / US-167 — the "AI Item Assistant" Settings section. Mirrors the web
/// surface: an enable/disable toggle, a monthly usage meter (actions used vs the
/// effective limit, with the reset cadence), and an optional per-user monthly
/// cap. All wired to the same `users` row the web reads/writes.
@MainActor
@Observable
final class AIAssistantStore {
    struct Info: Decodable, Equatable {
        let ai_enrichment_enabled: Bool
        let ai_action_limit: Int?
        let ai_actions_used_this_month: Int
        let ai_actions_reset_at: String?
        let flipdesk_plan: String?
    }

    enum Phase: Equatable {
        case loading
        case ready(Info)
        case failed(String)
    }

    private(set) var phase: Phase = .loading

    private static let columns =
        "ai_enrichment_enabled, ai_action_limit, ai_actions_used_this_month, ai_actions_reset_at, flipdesk_plan"

    func load() async {
        phase = .loading
        await fetch()
    }

    /// Silent refresh (no loading flicker) after a write.
    private func fetch() async {
        do {
            let rows: [Info] = try await SupabaseShared.client
                .from("users")
                .select(Self.columns)
                .limit(1)
                .execute()
                .value
            if let info = rows.first {
                phase = .ready(info)
            } else {
                phase = .failed("Couldn't find your account.")
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// US-1498: a failed toggle/cap write used to be swallowed (`try?`) — the UI
    /// showed "saved" optimistically, then silently snapped back on the next visit
    /// with no explanation. Now surfaces the error (persists past the `fetch()`
    /// revert, which only touches `phase`) and returns success so the view can
    /// revert its optimistic override.
    var actionError: String?

    @discardableResult
    func setEnabled(_ enabled: Bool, userId: String) async -> Bool {
        struct Update: Encodable { let ai_enrichment_enabled: Bool }
        do {
            try await SupabaseShared.client
                .from("users")
                .update(Update(ai_enrichment_enabled: enabled))
                .eq("id", value: userId)
                .execute()
            actionError = nil
            await fetch()
            return true
        } catch {
            actionError = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't update the AI Assistant setting. Please try again.")
            await fetch()  // revert to server truth
            return false
        }
    }

    /// `nil` clears the override → falls back to the plan default. Uses an
    /// explicit JSON null (a synthesized Optional encoder would omit the field,
    /// leaving the column unchanged).
    @discardableResult
    func setLimit(_ limit: Int?, userId: String) async -> Bool {
        let value: AnyJSON = limit.map { .integer($0) } ?? .null
        do {
            try await SupabaseShared.client
                .from("users")
                .update(["ai_action_limit": value])
                .eq("id", value: userId)
                .execute()
            actionError = nil
            await fetch()
            return true
        } catch {
            actionError = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't update the monthly cap. Please try again.")
            await fetch()  // revert to server truth
            return false
        }
    }

    /// Monthly AI-action allowance per plan (mirrors FLIPDESK_PLANS
    /// aiActionsPerMonth in src/lib/constants.ts: free 25 / starter 200 /
    /// pro 750 / business 2000). Unknown → free.
    ///
    /// US-2123: pro and business were 1000 and 5000 here, and the doc comment
    /// above asserted those were the mirrored values. They were not, on either
    /// count — measured 2026-08-22 against production's own `pricing_plans`
    /// rows (pro ai_actions_per_month = 750, business = 2000) and against
    /// src/lib/constants.ts, which agrees with production. So a Pro seller
    /// opened Settings → AI Assistant, read a 1000-action monthly cap, and hit
    /// the server's wall 250 actions early with nothing on screen explaining
    /// why. The comment claiming to mirror was what made it survive review.
    ///
    /// src/test/ios-plan-quota-parity.test.ts now fails if these drift from
    /// FLIPDESK_PLANS again. It runs in the web suite on purpose: Swift cannot
    /// be compiled on the Windows box the work is done from, and a guard that
    /// only runs on the macOS lane is one nobody sees until CI.
    static func planDefault(_ plan: String?) -> Int {
        switch plan?.lowercased() {
        case "starter": return 200
        case "pro", "professional": return 750
        case "business", "enterprise": return 2000
        default: return 25
        }
    }

    /// The user's explicit cap wins over the plan default (mirrors the edge
    /// checkQuota in US-167).
    static func effectiveLimit(_ info: Info) -> Int {
        info.ai_action_limit ?? planDefault(info.flipdesk_plan)
    }
}

struct AIAssistantSection: View {
    @Environment(AuthStore.self) private var authStore
    @State private var store = AIAssistantStore()
    // US-1178: nil = "show whatever the loaded Info says"; set only once the
    // user flips the toggle. Avoids the wrong-state flash from a @State seeded
    // to `true` before load resolves.
    @State private var enabledOverride: Bool?
    @State private var limitText = ""
    // US-1204: the numberPad cap field has no Return key, and the shared "Done"
    // toolbar only resigns first responder — it never fires `.onSubmit`. Commit
    // on focus loss so tapping Done / tapping away actually saves the cap.
    @FocusState private var capFieldFocused: Bool

    private var userId: String? {
        if case let .signedIn(user) = authStore.phase { return user.id.uuidString }
        return nil
    }

    var body: some View {
        Section {
            switch store.phase {
            case .loading:
                HStack { Text("AI Item Assistant"); Spacer(); ProgressView() }
            case .failed(let message):
                VStack(alignment: .leading, spacing: 6) {
                    Text("Couldn't load AI usage.").font(.subheadline)
                    Text(message).font(.caption).foregroundStyle(.secondary)
                    Button("Try again") { Task { await store.load() } }.font(.subheadline)
                }
            case .ready(let info):
                readyRows(info)
            }
        } header: {
            Text("AI Item Assistant")
        } footer: {
            Text("AI fills in brand, size, material, and more from your photos. Turn it off to skip AI suggestions, or set a monthly action cap to control usage.")
                .font(.footnote)
        }
        .task {
            await store.load()
            if case let .ready(info) = store.phase {
                limitText = info.ai_action_limit.map(String.init) ?? ""
            }
        }
    }

    @ViewBuilder
    private func readyRows(_ info: AIAssistantStore.Info) -> some View {
        // US-1178: drive the toggle from the loaded Info; the local override only
        // holds the user's just-made choice, so the row never shows a stale state.
        Toggle(isOn: Binding(
            get: { enabledOverride ?? info.ai_enrichment_enabled },
            set: { newValue in
                enabledOverride = newValue
                guard let userId, newValue != info.ai_enrichment_enabled else { return }
                Task {
                    // US-1498: revert the optimistic override on a failed write so
                    // the toggle snaps back to server truth AND the error shows
                    // (instead of appearing saved then silently reverting later).
                    let ok = await store.setEnabled(newValue, userId: userId)
                    if !ok { enabledOverride = nil }
                }
            }
        )) {
            Label("AI suggestions", systemImage: "sparkles")
        }
        // US-1498: surface a failed toggle/cap write.
        if let actionError = store.actionError {
            Text(actionError)
                .font(.caption)
                .foregroundStyle(Color.brandRed)
        }

        // Usage meter.
        let cap = AIAssistantStore.effectiveLimit(info)
        let used = min(info.ai_actions_used_this_month, cap)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Used this month").font(.subheadline)
                Spacer()
                Text("\(info.ai_actions_used_this_month) of \(cap)")
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
            }
            ProgressView(value: Double(used), total: Double(max(cap, 1)))
                .tint(used >= cap ? Color.brandRed : Color.brandNavy)
            Text("Resets at the start of next month.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)

        // Optional explicit monthly cap.
        HStack {
            Label("Monthly cap", systemImage: "gauge.with.dots.needle.bottom.50percent")
            Spacer()
            TextField("Plan default", text: $limitText)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 100)
                .focused($capFieldFocused)
                .onSubmit { commitLimit() }
                // US-1204: numberPad has no Return key and the shared Done
                // toolbar only resigns first responder (never fires .onSubmit),
                // so commit when focus leaves the field — that covers tapping
                // Done and tapping away, instead of silently dropping the cap.
                .onChange(of: capFieldFocused) { _, focused in
                    if !focused { commitLimit() }
                }
                // numberPad has no Return key — give it a shared Done accessory
                // (this Section lives inside the Settings list, so attach at the
                // field rather than a container we don't own here). US-969.
                .keyboardDoneToolbar()
        }
    }

    private func commitLimit() {
        guard let userId else { return }
        let trimmed = limitText.trimmingCharacters(in: .whitespaces)
        let newLimit = trimmed.isEmpty ? nil : Int(trimmed)
        Task {
            // US-1498: on a failed write, resync the field to server truth so a
            // rejected cap doesn't linger as if it saved (the error shows too).
            let ok = await store.setLimit(newLimit, userId: userId)
            if !ok, case let .ready(info) = store.phase {
                limitText = info.ai_action_limit.map(String.init) ?? ""
            }
        }
    }
}
