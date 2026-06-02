// CSP violation sink (US-264). Receives browser CSP reports (both the legacy
// `report-uri` `application/csp-report` shape and the Reporting-API
// `report-to` batch shape) and logs them so a missed origin surfaces in the
// Cloudflare Pages real-time logs after the policy was flipped from
// report-only to ENFORCING. It never affects the page — always returns 204.
//
// Routed at /csp-report (referenced by the CSP `report-uri` + `report-to`
// directives and the `Reporting-Endpoints` header in public/_headers).

export const onRequestPost: PagesFunction = async ({ request }) => {
  try {
    const body = await request.text();
    if (body) {
      // Trim so a flood of identical reports doesn't blow the log line up.
      console.warn("[csp-report]", body.slice(0, 2000));
    }
  } catch {
    // Never let report parsing fail the endpoint.
  }
  return new Response(null, { status: 204 });
};

// Some browsers preflight the Reporting-API endpoint.
export const onRequestOptions: PagesFunction = () =>
  new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Methods": "POST, OPTIONS" },
  });
