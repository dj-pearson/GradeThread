import Foundation

/// US-2535 AC3: persist the onboarding answer to `users.use_case`, the column
/// the web dashboard already reads.
///
/// THE BUG. iOS asked the question, stored the answer in UserDefaults, sent it
/// to telemetry, and never wrote it anywhere the product could read. So an iOS
/// user's `use_case` stayed NULL for ever, and `activation-checklist.tsx` —
/// which branches on `useCase === "seller"` explicitly — skipped them.
///
/// THE MAPPING IS NOT A JUDGEMENT MADE HERE. `src/lib/use-case-taxonomy.ts` is
/// the spec, and the owner's decision (2026-08-14) is that all three iOS
/// answers map to `seller`: `reseller` vs `grader` is a VOLUME distinction and
/// `store` is a CHANNEL one, and neither changes which dashboard, checklist or
/// first action fits. The three answers stay as telemetry, where the volume
/// distinction is actually useful. A guard test compares this file's mapping
/// against that module, so the two cannot drift.
///
/// ⚠ ONLY EVER WRITE A VALUE THE DB CHECK ALLOWS. Migration 00022 constrains
/// the column to seller | buyer | consignment | developer. Sending an iOS raw
/// value (`reseller`) would be rejected by Postgres AFTER onboarding has already
/// told the user it succeeded — which is why the mapping produces a canonical
/// string and this file never passes `useCase.rawValue` through.
enum UseCaseSync {

    /// Marks the answer as already pushed, so a signed-in launch does not
    /// re-write the column on every cold start. Versioned like the other
    /// onboarding keys so a redesign can force a re-sync.
    static let syncedKey = "com.gradethread.app.onboarding.useCaseSynced.v1"

    /// The canonical `users.use_case` value for an onboarding answer.
    ///
    /// Exhaustive over the enum rather than a dictionary with a default: adding
    /// a fourth iOS option becomes a compile error here instead of an answer
    /// that silently writes nothing — the exact shape of the bug this closes.
    static func canonicalUseCase(for answer: OnboardingUseCase?) -> String? {
        guard let answer else { return nil }
        switch answer {
        case .reseller, .grader, .store: return "seller"
        }
    }

    /// Write the stored answer if there is one, a session exists, and it has not
    /// been written already.
    ///
    /// Safe to call on every sign-in and after onboarding finishes. Both are
    /// needed and neither is redundant: onboarding can complete BEFORE the user
    /// signs in (that is why `pendingFirstAction` exists at all), and in that
    /// order there is no session to write against when the answer is captured.
    static func pushIfNeeded(defaults: UserDefaults = .standard) async {
        guard !defaults.bool(forKey: syncedKey) else { return }
        guard let value = canonicalUseCase(for: OnboardingState(defaults: defaults).selectedUseCase)
        else { return }
        // `try?` here is deliberate and is NOT the US-2337 mistake. There, a
        // swallowed session failure let a query run UNFILTERED and prune the
        // local database. Here the only consequence of nil is that we return
        // without writing and without marking synced, so the next sign-in
        // retries. Nothing downstream treats the absence as an answer.
        //
        // ⚠ KEEP THIS ON ONE LINE. Written as a wrapped chain —
        // `try? await SupabaseShared.client` then `.auth.session…` on the next
        // line — the `await` binds to `SupabaseShared.client` alone, which is
        // synchronous, and the async `.session` access ends up outside it. That
        // compiles nowhere and fails with "Expression is 'async' but is not
        // marked with 'await'", naming this file and nothing about the cause.
        // Every other call site in the app writes it flat for the same reason
        // (ContentView.swift, ConsignorService.swift, PublishDialog.swift).
        guard let sessionUserId = try? await SupabaseShared.client.auth.session.user.id.uuidString
        else { return }
        // Lowercased AFTER the await rather than chained onto it, so the
        // one-line rule above stays easy to see and hard to undo.
        let userId = sessionUserId.lowercased()

        struct Update: Encodable { let use_case: String }
        do {
            try await SupabaseShared.client
                .from("users")
                .update(Update(use_case: value))
                .eq("id", value: userId)
                .execute()
            defaults.set(true, forKey: syncedKey)
        } catch {
            // Deliberately silent to the user and NOT marked synced, so the next
            // sign-in retries. Nothing on screen depends on this landing right
            // now — the personalisation it unlocks is on the web dashboard — so
            // an alert here would interrupt a first run to report something the
            // user cannot act on and did not ask for.
            // `backgroundBreadcrumb`, not `breadcrumb`: this function is
            // nonisolated async, and `Telemetry.breadcrumb` is @MainActor —
            // calling it from here is "main actor-isolated static method cannot
            // be called from outside of the actor", which only the macOS build
            // reports. The nonisolated entry point exists for exactly this
            // shape (the sync actor and the offline mutation queue use it), and
            // it logs at .warning, which a failure path should anyway.
            Telemetry.backgroundBreadcrumb(
                "use_case sync failed: \(FriendlyErrorCopy.rawDetail(for: error))",
                category: "onboarding"
            )
        }
    }
}
