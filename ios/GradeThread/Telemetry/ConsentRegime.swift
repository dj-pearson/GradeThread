import Foundation

/// US-2914: which consent model applies to this seller.
///
/// A PORT OF A PORT, not a new decision. `src/lib/consent-regime.ts` made this
/// call for the web (US-2513) and `ConsentRegime.kt` mirrored it for Android
/// (US-2897). Same company, same PostHog project, same privacy policy - so the
/// rules here mirror both line for line, and a change to any one of the three
/// belongs in all three.
///
/// ⚠ READ Telemetry.swift BEFORE TRUSTING ANY SUMMARY OF THIS, INCLUDING THIS
/// ONE. US-2897 was filed claiming Android sent analytics by default while iOS
/// asked first, and PLAY_STORE_SUBMISSION.md said the same. Both were wrong:
/// iOS read `UserDefaults.standard.object(forKey:) ?? true` and its own doc
/// comment said "Opt-out, on by default". The false claim survived from a
/// document into a story because nobody opened the file.
///
///  - opt-in  - GDPR / UK-GDPR / ePrivacy, and everywhere we are unsure.
///              Nothing non-essential runs until the seller actively agrees.
///  - opt-out - United States (CCPA/CPRA and the ~20 state laws). Analytics may
///              run by default, with a visible way to turn it off.
enum ConsentRegime {
    case optIn
    case optOut
}

/// The coarse location signal the regime is chosen from.
///
/// Deliberately coarse. Country and an EU flag are all the decision needs, so
/// they are all that is asked for - a finer fix would be more data held for no
/// additional purpose.
struct GeoSignal: Decodable, Equatable {
    /// ISO 3166-1 alpha-2, uppercased, or nil when unknown.
    let country: String?
    /// Subdivision where known (e.g. "CA"), else nil.
    let regionCode: String?
    /// True when the country is inside the EU.
    let isEU: Bool

    init(country: String? = nil, regionCode: String? = nil, isEU: Bool = false) {
        self.country = country
        self.regionCode = regionCode
        self.isEU = isEU
    }

    /// Used whenever geo is unknown, which drives the strict default.
    static let unknown = GeoSignal()
}

enum Consent {

    /// Countries whose law is opt-out (notice plus a right to opt out) rather
    /// than prior opt-in. A set so adding another is a one-line change - the
    /// same shape both the other clients use.
    private static let optOutCountries: Set<String> = ["US"]

    /// The regime for a signal.
    ///
    /// FAILS SAFE. A nil signal, or one with no country, resolves to `.optIn` -
    /// that covers a VPN, Tor, a lookup failure, and the window before the
    /// fetch completes. Getting this backwards would mean analytics running by
    /// default for exactly the sellers most likely to be covered by GDPR, so
    /// the strict answer has to be the default rather than the fallback.
    static func regime(for geo: GeoSignal?) -> ConsentRegime {
        guard
            let country = geo?.country?.trimmingCharacters(in: .whitespacesAndNewlines),
            !country.isEmpty
        else {
            return .optIn
        }
        return optOutCountries.contains(country.uppercased()) ? .optOut : .optIn
    }

    /// Should analytics run, given the regime and whatever the seller has said?
    ///
    /// `explicitChoice` is TRI-STATE and that is the whole mechanism:
    ///  - `true`  - they turned it on. Runs under either regime.
    ///  - `false` - they turned it off. Never runs, under either regime. An
    ///              opt-out jurisdiction does not override someone who has
    ///              already said no.
    ///  - `nil`   - they have not been asked and have not touched the toggle.
    ///              The regime decides, which is the case that used to be
    ///              hard-coded to "on".
    ///
    /// `?? true` is precisely the expression US-2914 removes. Do NOT reintroduce
    /// it as `?? false`, which is a different wrong answer: it would silently
    /// opt a US seller out of something they never objected to, and the store
    /// privacy declarations say analytics is collected there.
    static func analyticsAllowed(regime: ConsentRegime, explicitChoice: Bool?) -> Bool {
        explicitChoice ?? (regime == .optOut)
    }
}

/// The coarse country signal, fetched once per process.
///
/// Reads `https://gradethread.com/geo.json`, the SAME endpoint the web consent
/// banner and the Android client use. That endpoint is a Cloudflare Pages
/// Function reading `request.cf.country` at the edge, so no third-party
/// IP-geolocation service is involved - which would itself be a privacy problem,
/// and is why the web side built it this way.
///
/// ⚠ IT MUST BE THE PAGES SITE, never the edge service. `functions.gradethread.com`
/// runs on Coolify behind no Cloudflare edge, so `request.cf` does not exist
/// there and the endpoint could only ever answer "unknown". Pointing this at the
/// API host would fail SAFE - every seller treated as opt-in - and therefore
/// look exactly like it was working.
///
/// NOTHING IS SENT. A plain GET with no body, no identifier and no cookie; the
/// country comes from the network path the request already takes. The response
/// is held for the life of the process and never written to disk - a cached
/// country is a location on disk, and it is cheap enough to re-ask.
actor GeoService {

    static let shared = GeoService()

    /// The Pages site. See the warning above about why not the edge host.
    static let geoURL = URL(string: "https://gradethread.com/geo.json")

    /// Short on purpose.
    ///
    /// PostHog does not start until this resolves, so the timeout caps how long
    /// ANALYTICS is held back, not how long a seller waits - nothing
    /// user-facing blocks on it. Failing to unknown costs a US seller's early
    /// events, which is the right way round: the alternative is running
    /// analytics for an EU seller because a request was slow.
    static let timeout: TimeInterval = 4

    private var cached: GeoSignal?
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = GeoService.timeout
            config.timeoutIntervalForResource = GeoService.timeout
            // No cookies and no credentials on a request whose entire purpose is
            // to avoid identifying anyone.
            config.httpCookieAcceptPolicy = .never
            config.httpShouldSetCookies = false
            self.session = URLSession(configuration: config)
        }
    }

    /// The signal, or `.unknown` on any failure. Never throws: a consent
    /// decision must always have an answer, and the safe answer is unknown.
    func signal() async -> GeoSignal {
        if let cached { return cached }
        guard let url = Self.geoURL else { return .unknown }
        do {
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            guard (200..<300).contains(code) else { return .unknown }
            let signal = try JSONDecoder().decode(GeoSignal.self, from: data)
            cached = signal
            return signal
        } catch {
            // Deliberately NOT cached. A failure is not an answer, and a seller
            // who was offline at launch should get a real one on the next ask.
            return .unknown
        }
    }

    /// Test hook: forget the cached signal.
    func resetForTests() {
        cached = nil
    }
}
