const allowedOrigins = new Set([
  "https://amorkim32-dev.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "null",
]);

const responseCache = new Map<string, { expiresAt: number; payload: unknown }>();
const rateLimits = new Map<string, { expiresAt: number; count: number }>();

function jsonResponse(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "apikey, content-type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) return new Response("Origin not allowed", { status: 403 });

  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "apikey, content-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Vary": "Origin",
      },
    });
  }
  if (request.method !== "GET") return jsonResponse({ error: "Method not allowed." }, 405, origin);

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    return jsonResponse({ error: "Choose a valid match date (YYYY-MM-DD)." }, 400, origin);
  }

  const cached = responseCache.get(date);
  if (cached && cached.expiresAt > Date.now()) return jsonResponse(cached.payload, 200, origin);

  const address = request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? origin;
  const now = Date.now();
  const limit = rateLimits.get(address);
  if (limit && limit.expiresAt > now && limit.count >= 20) {
    return jsonResponse({ error: "Too many fixture requests. Please wait a minute and try again." }, 429, origin);
  }
  if (!limit || limit.expiresAt <= now) rateLimits.set(address, { expiresAt: now + 60_000, count: 1 });
  else limit.count += 1;

  const apiKey = Deno.env.get("API_FOOTBALL_KEY") ??
    Deno.env.get("APISPORTS_FOOTBALL_KEY") ??
    Deno.env.get("APISPORTS_KEY");
  if (!apiKey) return jsonResponse({ error: "Football fixtures are not configured yet." }, 503, origin);

  try {
    const fixtures: unknown[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const providerUrl = new URL("https://v3.football.api-sports.io/fixtures");
      providerUrl.searchParams.set("date", date);
      providerUrl.searchParams.set("timezone", "Africa/Nairobi");
      providerUrl.searchParams.set("page", String(page));
      const providerResponse = await fetch(providerUrl, {
        headers: { "x-apisports-key": apiKey, Accept: "application/json" },
      });
      const payload = await providerResponse.json();
      if (!providerResponse.ok || (payload.errors && Object.keys(payload.errors).length)) {
        return jsonResponse({ error: "The fixtures provider could not load this date." }, 502, origin);
      }

      if (Array.isArray(payload.response)) fixtures.push(...payload.response);
      totalPages = Math.max(1, Number(payload.paging?.total) || 1);
      page += 1;
    } while (page <= totalPages);

    const result = { response: fixtures };
    responseCache.set(date, { expiresAt: Date.now() + 60_000, payload: result });
    return jsonResponse(result, 200, origin);
  } catch {
    return jsonResponse({ error: "Could not reach the football fixtures provider." }, 502, origin);
  }
});
