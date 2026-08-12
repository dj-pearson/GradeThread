import SwiftUI

/// US-2017 AC2: the iOS re-acceptance gate.
///
/// The web has had `src/components/auth/legal-gate.tsx` since US-377/US-904.
/// iOS had nothing: it recorded a HARDCODED version at signup and never called
/// `/api/legal` again, so publishing a new ToS left every existing iOS user
/// attested to a document they had not been shown, with no way to be asked.
/// `AuthStore.legalTosVersion` being kept in sync by a parity guard does not fix
/// that — the constants agreeing is not the same as the user agreeing.
///
/// The SERVER decides, deliberately. `needsAcceptance` comes from
/// `GET /api/legal/status`, which compares the user's recorded versions against
/// the DB-backed current ones. Nothing here compares version strings: an
/// operator publishing a re-acceptance can reach an installed build with no App
/// Store release, which is the whole point of the endpoint existing.
@MainActor
@Observable
public final class LegalGateStore {

    public struct Status: Decodable, Sendable {
        public struct Current: Decodable, Sendable {
            public let tos: String?
            public let privacy: String?
        }
        public struct Accepted: Decodable, Sendable {
            public let tosVersion: String?
            public let privacyVersion: String?
        }
        public let needsAcceptance: Bool
        public let current: Current
        public let accepted: Accepted
    }

    private struct AcceptBody: Encodable { let method: String }
    private struct AcceptResponse: Decodable { let ok: Bool? }

    public private(set) var needsAcceptance = false
    public private(set) var submitting = false
    public private(set) var errorMessage: String?

    /// True the first time this account has ever been asked, which changes the
    /// wording: "we updated these" is wrong for someone who never accepted.
    public private(set) var isReacceptance = false

    private let api: EdgeAPI

    public init(api: EdgeAPI = .shared) {
        self.api = api
    }

    /// Ask the server whether this user owes an acceptance.
    ///
    /// FAILS OPEN. A network blip, a 500, an expired token mid-refresh — none of
    /// those are evidence that the user has not accepted, and locking a paying
    /// seller out of their inventory to protest an unreachable endpoint is a
    /// worse outcome than showing the gate one launch later. Matches the web
    /// gate's reasoning at `legal-gate.tsx`.
    public func refresh() async {
        do {
            let status: Status = try await api.getJSON("/api/legal/status")
            needsAcceptance = status.needsAcceptance
            isReacceptance =
                status.accepted.tosVersion != nil || status.accepted.privacyVersion != nil
        } catch {
            needsAcceptance = false
        }
    }

    /// Record acceptance of the CURRENT versions.
    ///
    /// `method: "reacceptance"` is what the route defaults to, and it is the
    /// honest label for this surface. Deliberately NOT `signup_clickwrap`: that
    /// path stamps versions off the trigger's own row for a signup, and reusing
    /// it here would record acceptance of a document this user may never have
    /// been shown. The route's own comment spells that out.
    public func accept() async {
        guard !submitting else { return }
        submitting = true
        errorMessage = nil
        do {
            let _: AcceptResponse = try await api.postJSON(
                "/api/legal/accept",
                body: AcceptBody(method: "reacceptance")
            )
            needsAcceptance = false
        } catch {
            // The gate STAYS UP on failure. Dismissing it would leave the user
            // inside the app with nothing recorded, which is the state this
            // exists to prevent.
            errorMessage = "We couldn't record that. Check your connection and try again."
        }
        submitting = false
    }
}

/// Wraps the authenticated app and blocks it while an acceptance is owed.
///
/// Non-dismissable on purpose: there is no cancel, no swipe-down, and no way to
/// reach the app behind it. A gate a seller can dismiss records nothing and
/// leaves us asserting an acceptance that never happened.
public struct LegalGate<Content: View>: View {
    @State private var store = LegalGateStore()
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .task { await store.refresh() }
            .sheet(isPresented: .constant(store.needsAcceptance)) {
                LegalGateSheet(store: store)
                    .interactiveDismissDisabled(true)
            }
    }
}

private struct LegalGateSheet: View {
    let store: LegalGateStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(store.isReacceptance ? "We've updated our terms" : "Before you continue")
                .font(.title2.weight(.semibold))

            Text(
                store.isReacceptance
                    ? "Our Terms of Service and Privacy Policy have changed. Please review and accept them to keep using GradeThread."
                    : "Please review and accept our Terms of Service and Privacy Policy to continue."
            )
            .foregroundStyle(.secondary)

            // Real links, not a checkbox next to the words. Someone accepting a
            // document has to be able to read it first.
            Link("Terms of Service", destination: URL(string: "https://gradethread.com/terms")!)
            Link("Privacy Policy", destination: URL(string: "https://gradethread.com/privacy")!)

            if let message = store.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.red)
            }

            Button {
                Task { await store.accept() }
            } label: {
                if store.submitting {
                    ProgressView()
                } else {
                    Text("I accept")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(store.submitting)

            Spacer()
        }
        .padding(24)
    }
}
