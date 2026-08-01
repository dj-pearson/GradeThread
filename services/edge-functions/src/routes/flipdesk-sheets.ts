import { Hono } from "hono";
import { googleFetch } from "../lib/google-fetch.ts";

// Google Sheets "connection" without OAuth. The user pastes a share link to
// a sheet that's viewable by "Anyone with the link"; we fetch its CSV export
// server-side (browser fetch would be blocked by Google's missing CORS
// headers) and hand the raw CSV back to the existing import flow.
//
// SECURITY: we NEVER fetch the user-supplied URL directly — that would be an
// SSRF hole. We extract the spreadsheet ID from a strictly-validated
// docs.google.com URL and rebuild the export URL ourselves.

type SheetsEnv = { Variables: { userId: string } };

export const flipdeskSheetsRoutes = new Hono<SheetsEnv>();

// Extracts the spreadsheet ID + optional gid from a Google Sheets URL.
// Accepts the common shapes:
//   /spreadsheets/d/{ID}/edit#gid=0
//   /spreadsheets/d/{ID}/edit?gid=123
//   /spreadsheets/d/{ID}/view?usp=sharing
//   /spreadsheets/d/e/{PUB_ID}/pubhtml   (published-to-web)
function parseSheetUrl(
  raw: string,
): { spreadsheetId: string; gid: string | null; published: boolean } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Strict host allowlist — prevents SSRF to internal services.
  if (url.hostname !== "docs.google.com") return null;

  // Published-to-web form: /spreadsheets/d/e/{ID}/pubhtml
  const pubMatch = url.pathname.match(
    /^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)/,
  );
  if (pubMatch) {
    return { spreadsheetId: pubMatch[1]!, gid: gidFrom(url), published: true };
  }

  // Standard form: /spreadsheets/d/{ID}/...
  const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!match) return null;
  return { spreadsheetId: match[1]!, gid: gidFrom(url), published: false };
}

function gidFrom(url: URL): string | null {
  const fromQuery = url.searchParams.get("gid");
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
  // gid often rides in the fragment: #gid=123456
  const frag = url.hash.match(/gid=(\d+)/);
  return frag ? frag[1]! : null;
}

// POST /fetch-csv  Body: { url: string }  →  { csv, gid, spreadsheet_id }
flipdeskSheetsRoutes.post("/fetch-csv", async (c) => {
  let body: { url?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.url !== "string" || !body.url.trim()) {
    return c.json({ error: "url (string) is required" }, 400);
  }

  const parsed = parseSheetUrl(body.url);
  if (!parsed) {
    return c.json(
      {
        error:
          "That doesn't look like a Google Sheets link. Copy the URL from your browser's address bar while the sheet is open.",
      },
      400,
    );
  }

  // Build the export URL ourselves — never fetch the raw user input.
  const exportUrl = parsed.published
    ? `https://docs.google.com/spreadsheets/d/e/${parsed.spreadsheetId}/pub?output=csv${parsed.gid ? `&gid=${parsed.gid}` : ""}`
    : `https://docs.google.com/spreadsheets/d/${parsed.spreadsheetId}/export?format=csv${parsed.gid ? `&gid=${parsed.gid}` : ""}`;

  let res: Response;
  try {
    res = await googleFetch(exportUrl, {
      redirect: "follow",
      headers: { Accept: "text/csv,text/plain,*/*" },
    });
  } catch (err) {
    console.error("[flipdesk-sheets] fetch failed:", err);
    return c.json({ error: "Could not reach Google Sheets." }, 502);
  }

  // Google returns a 302 → login page (HTML) when the sheet isn't publicly
  // viewable. After redirect-follow we detect that by content-type.
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return c.json(
        {
          error:
            "Couldn't read that sheet. Open it → Share → General access → set to \"Anyone with the link\" (Viewer), then try again.",
        },
        403,
      );
    }
    return c.json(
      { error: `Google returned ${res.status} fetching the sheet.` },
      502,
    );
  }
  if (contentType.includes("text/html")) {
    return c.json(
      {
        error:
          "That sheet isn't shared publicly. Open it → Share → General access → \"Anyone with the link\" (Viewer), then retry.",
      },
      403,
    );
  }

  const csv = await res.text();
  // Soft cap — keep parity with the CSV-paste path's practical limits.
  if (csv.length > 10 * 1024 * 1024) {
    return c.json({ error: "Sheet is too large (>10MB of CSV)." }, 413);
  }

  return c.json({
    csv,
    gid: parsed.gid,
    spreadsheet_id: parsed.spreadsheetId,
  });
});
