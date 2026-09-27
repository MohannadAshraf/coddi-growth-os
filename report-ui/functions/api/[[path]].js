const API_PREFIX = "/api";
const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);
const REPORT_API_PATHS = new Set([
  "/surface/daily",
  "/surface/weekly",
  "/surface/admin",
  "/surface/attribution-live",
  "/surface/ad-performance-live",
  "/growth/week",
  "/growth/entity",
  "/growth/drop",
  "/growth/load-orders",
  "/growth/load",
  "/growth/ad-product",
  "/growth/load-status",
  "/growth/import/yanet",
  "/growth/source-status",
  "/report",
  "/report-data",
  "/report-weeks",
  "/sync-status",
  "/sync-week",
  "/sync-retry",
  "/goals",
  "/goals/interpret",
  "/goals/approve",
  "/goals/activate",
  "/goals/archive",
  "/goal-progress",
  "/scored-actions",
  "/diagnosis",
  "/actions/regenerate",
  "/ai-report",
  "/ai-report/generate",
  "/creative-metadata",
  "/creative-metadata/refresh",
  "/ad-preview",
  "/ad-product-mappings",
  "/debug/meta-funds",
  "/debug/meta-funding-activities",
  "/meta-funds-monitor/status",
  "/meta-funds-monitor/calibrate",
  "/meta-funds-monitor/settings",
  "/meta-funds-monitor/reconciliation",
  "/meta-funds-monitor/activities",
  "/meta-funds-monitor/snapshots",
  "/meta-funds-monitor/alerts",
  "/meta-funds-monitor/runs",
  "/meta-funds-monitor/telegram-test"
]);

function errorResponse(error, status, extraHeaders = {}) {
  return Response.json(
    { ok: false, error },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...extraHeaders
      }
    }
  );
}

export async function onRequest(context) {
  const { request, env } = context;
  const incomingUrl = new URL(request.url);
  const upstreamPath = incomingUrl.pathname.slice(API_PREFIX.length) || "/";

  if (!REPORT_API_PATHS.has(upstreamPath)) {
    return errorResponse("Unknown report API endpoint.", 404);
  }

  if (!ALLOWED_METHODS.has(request.method)) {
    return errorResponse("Method not allowed.", 405, {
      Allow: [...ALLOWED_METHODS].join(", ")
    });
  }

  if (!env.REPORT_API || typeof env.REPORT_API.fetch !== "function") {
    return errorResponse("The report API service binding is unavailable.", 503);
  }

  const upstreamUrl = new URL(request.url);
  upstreamUrl.pathname = upstreamPath;

  const headers = new Headers(request.headers);
  headers.delete("Host");

  // Pages Access provides this assertion to the Function. Preserve it so the
  // Worker can verify the signature, Pages audience, and approved email.
  const accessAssertion = request.headers.get("CF-Access-Jwt-Assertion");
  if (accessAssertion) {
    headers.set("CF-Access-Jwt-Assertion", accessAssertion);
  }

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstreamResponse = await env.REPORT_API.fetch(
      new Request(upstreamUrl.toString(), init)
    );
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("Cache-Control", "private, no-store");
    responseHeaders.set("X-Content-Type-Options", "nosniff");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    console.error("Report API service binding failed", error);
    return errorResponse("The secured report service could not be reached.", 502);
  }
}
