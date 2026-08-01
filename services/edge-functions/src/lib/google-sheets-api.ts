// Thin Google Sheets v4 client (US-147).
//
// One instance per (user, spreadsheet, sync run). Every call goes through a
// token-bucket throttle: the Sheets API allows 300 requests/min/user, so we cap
// ourselves at 200/min (sleep until a slot frees) — a single sync run can then
// never exhaust the user's quota even on huge sheets, and concurrent surfaces
// (the user's own Apps Script, etc.) keep headroom.

import { googleFetch } from "./google-fetch.ts";
import { isRetryableError, withRetry } from "./retry.ts";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_REQUESTS_PER_MINUTE = 200;

// US-2321: the 429 path used to self-recurse with a flat 2s sleep, no attempt
// counter, no growth and no ceiling — the comment said "one retry" and the code
// said forever. Under project-level quota exhaustion (which does not clear in
// 2s) that hammers Google every 2 seconds per in-flight request per replica,
// indefinitely. That is how a project gets rate-limit banned rather than merely
// throttled. Bounded exponential backoff via lib/retry.ts instead, which also
// honors Retry-After when Google sends one.
const SHEETS_MAX_ATTEMPTS = 3;

export interface SheetTabMeta {
  sheetId: number;
  title: string;
}

export class SheetsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SheetsApiError";
  }
}

export class SheetsClient {
  private requestTimes: number[] = [];

  constructor(
    private readonly token: string,
    private readonly spreadsheetId: string,
    /** Injectable for tests. */
    // US-2321: a bare `fetch` default meant every SheetsClient in the codebase
    // ran with no deadline, because all four construction sites take the
    // default. The deadline has to be the default or it is not a deadline.
    private readonly fetchFn: typeof fetch = googleFetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async throttle(): Promise<void> {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter((t) => now - t < 60_000);
    if (this.requestTimes.length >= MAX_REQUESTS_PER_MINUTE) {
      const waitMs = 60_000 - (now - this.requestTimes[0]!) + 50;
      await this.sleep(waitMs);
    }
    this.requestTimes.push(Date.now());
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    // The throttle is inside the retried body on purpose: a retry is another
    // request against the same per-minute quota, so it must take a slot.
    return await withRetry(
      async () => {
        await this.throttle();
        const res = await this.fetchFn(
          `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}${path}`,
          {
            ...init,
            headers: {
              Authorization: `Bearer ${this.token}`,
              ...(init?.body ? { "Content-Type": "application/json" } : {}),
              ...(init?.headers ?? {}),
            },
          },
        );
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300);
          const err = new SheetsApiError(
            res.status,
            `Sheets API ${res.status}: ${detail}`,
          );
          // Surface Retry-After so withRetry can honor Google's own number
          // instead of guessing — it caps it (maxRetryAfterMs), so a hostile or
          // misconfigured header cannot stall a sync. Seconds on the wire, ms
          // on the error, which is the shape retryAfterMs() reads.
          const after = Number(res.headers.get("retry-after"));
          if (Number.isFinite(after) && after > 0) {
            (err as { retryAfterMs?: number }).retryAfterMs = after * 1000;
          }
          throw err;
        }
        return (await res.json()) as T;
      },
      {
        maxAttempts: SHEETS_MAX_ATTEMPTS,
        baseDelayMs: 2_000,
        sleep: this.sleep,
        // SheetsApiError carries `status`, which isRetryableError already reads
        // — so 429 and 5xx retry and a 403 quota-denied or a 404 does not.
        isRetryable: isRetryableError,
      },
    );
  }

  /** Tab list (id + title) — the cheap structure probe each sync starts with. */
  async getTabs(): Promise<SheetTabMeta[]> {
    const data = await this.request<{
      sheets?: { properties?: { sheetId?: number; title?: string } }[];
    }>("?fields=sheets(properties(sheetId,title))");
    return (data.sheets ?? [])
      .map((s) => s.properties)
      .filter((p): p is { sheetId: number; title: string } =>
        typeof p?.sheetId === "number" && typeof p?.title === "string"
      );
  }

  /** values.batchGet with unformatted values (numbers stay numbers). */
  async batchGetValues(ranges: string[]): Promise<Map<string, unknown[][]>> {
    if (ranges.length === 0) return new Map();
    const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
    const data = await this.request<{
      valueRanges?: { range?: string; values?: unknown[][] }[];
    }>(`/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`);
    const out = new Map<string, unknown[][]>();
    (data.valueRanges ?? []).forEach((vr, i) => {
      // Google echoes the resolved range; key by the requested one (positional).
      out.set(ranges[i]!, vr.values ?? []);
    });
    return out;
  }

  /** values.batchUpdate, RAW so strings round-trip byte-for-byte. */
  async batchUpdateValues(
    data: { range: string; values: (string | number)[][] }[],
  ): Promise<void> {
    if (data.length === 0) return;
    await this.request("/values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    });
  }

  /** values.append (INSERT_ROWS) under the given tab. */
  async appendValues(tab: string, values: (string | number)[][]): Promise<void> {
    if (values.length === 0) return;
    await this.request(
      `/values/${encodeURIComponent(`'${tab}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values }) },
    );
  }

  /** spreadsheets.batchUpdate (structure: addSheet, formats, validation, …). */
  async batchUpdateSpreadsheet(
    requests: Record<string, unknown>[],
  ): Promise<{ replies?: Record<string, unknown>[] }> {
    if (requests.length === 0) return {};
    return await this.request(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
  }
}
