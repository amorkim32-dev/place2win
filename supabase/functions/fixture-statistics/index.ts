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
  if (!allowedOrigins.has(origin)) {
    return new Response("Origin not allowed", { status: 403 });
  }

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

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, origin);
  }

  const params = new URL(request.url).searchParams;
  const fixtureId = params.get("fixture") ?? "";
  const homeTeamId = params.get("homeTeam") ?? "";
  const awayTeamId = params.get("awayTeam") ?? "";
  if (!/^\d{1,12}$/.test(fixtureId) || Number(fixtureId) < 1) {
    return jsonResponse({ error: "A valid fixture ID is required." }, 400, origin);
  }
  const validTeamId = (id: string) => /^\d{1,12}$/.test(id) && Number(id) > 0;
  const includeHistory = validTeamId(homeTeamId) && validTeamId(awayTeamId);
  const fixtureStatus = params.get("status") ?? "";
  const includeEvents = ["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "FT", "AET", "PEN"].includes(fixtureStatus);

  const address = request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? origin;
  const now = Date.now();
  const limit = rateLimits.get(address);
  if (limit && limit.expiresAt > now && limit.count >= 40) {
    return jsonResponse({ error: "Too many statistics requests. Please try again shortly." }, 429, origin);
  }
  if (!limit || limit.expiresAt <= now) {
    rateLimits.set(address, { expiresAt: now + 60_000, count: 1 });
  } else {
    limit.count += 1;
  }

  const cacheKey = `${fixtureId}:${includeHistory ? `${homeTeamId}-${awayTeamId}` : "no-history"}:${includeEvents ? "events" : "no-events"}`;
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return jsonResponse(cached.payload, 200, origin);
  }

  const apiKey = Deno.env.get("API_FOOTBALL_KEY") ??
    Deno.env.get("APISPORTS_FOOTBALL_KEY") ??
    Deno.env.get("APISPORTS_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "Football statistics are not configured yet." }, 503, origin);
  }

  try {
    const providerHeaders = { "x-apisports-key": apiKey, "Accept": "application/json" };
    const getProviderData = async (path: string): Promise<any[]> => {
      const response = await fetch(`https://v3.football.api-sports.io/${path}`, { headers: providerHeaders });
      if (!response.ok) return [];
      const data = await response.json();
      if (data.errors && Object.keys(data.errors).length) return [];
      return Array.isArray(data.response) ? data.response : [];
    };
    const historyRequests = includeHistory
      ? [
        getProviderData(`fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}&last=5&status=FT-AET-PEN`),
        getProviderData(`fixtures?team=${homeTeamId}&last=5&status=FT-AET-PEN`),
        getProviderData(`fixtures?team=${awayTeamId}&last=5&status=FT-AET-PEN`),
      ]
      : [];
    const [statsResult, eventsResult, ...historyResults] = await Promise.allSettled([
      getProviderData(`fixtures/statistics?fixture=${fixtureId}`),
      includeEvents ? getProviderData(`fixtures/events?fixture=${fixtureId}`) : Promise.resolve([]),
      ...historyRequests,
    ]);
    const historyValue = (index: number) => {
      const result = historyResults[index];
      return result?.status === "fulfilled" ? result.value : [];
    };
    const payload = {
      response: statsResult.status === "fulfilled" ? statsResult.value : [],
      events: eventsResult.status === "fulfilled" ? eventsResult.value : [],
      headToHead: includeHistory ? historyValue(0) : [],
      lastFive: includeHistory ? { home: historyValue(1), away: historyValue(2) } : { home: [], away: [] },
    };
    const hasProviderStats = payload.response.some((team: { statistics?: Array<{ value?: unknown }> }) =>
      Array.isArray(team.statistics) && team.statistics.some((stat) => stat.value != null)
    );
    const cacheTtl = hasProviderStats ? 60_000 : 30_000;
    responseCache.set(cacheKey, { expiresAt: Date.now() + cacheTtl, payload });
    return jsonResponse(payload, 200, origin);
  } catch {
    return jsonResponse({ error: "Could not reach the football stats provider." }, 502, origin);
  }
});
