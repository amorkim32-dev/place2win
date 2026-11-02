const allowedOrigins = new Set([
  "https://amorkim32-dev.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const responseCache = new Map<string, { expiresAt: number; payload: unknown }>();
const rateLimits = new Map<string, { expiresAt: number; count: number }>();
const freeStatisticTypes = new Set(["Ball Possession", "Total Shots", "Shots on Goal", "Shots on Target", "Shots off Goal", "Blocked Shots", "Corner Kicks", "Fouls", "Offsides", "Yellow Cards", "Red Cards", "Goalkeeper Saves"]);
function serviceKey() {
  try { const values = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); if (typeof values.default === "string") return values.default; const key = Object.values(values).find(value => typeof value === "string"); if (key) return key as string; } catch {}
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
function publishableKey() {
  if (Deno.env.get("SUPABASE_ANON_KEY")) return Deno.env.get("SUPABASE_ANON_KEY")!;
  try { const values = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}"); if (typeof values.default === "string") return values.default; const key = Object.values(values).find(value => typeof value === "string"); if (key) return key as string; } catch {}
  return "";
}
async function hasPlusAccess(request: Request, base: string) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const service = serviceKey(), pub = publishableKey();
  if (!token || !service || !pub) return false;
  const svcHeaders = { apikey: service, ...(!service.startsWith("sb_secret_") ? { Authorization: `Bearer ${service}` } : {}) };
  try {
    const userResponse = await fetch(`${base}/auth/v1/user`, { headers: { apikey: pub, Authorization: `Bearer ${token}` } });
    if (!userResponse.ok) return false;
    const user = await userResponse.json(); if (!user?.id) return false;
    const adminUrl = new URL(`${base}/rest/v1/admin_users`); adminUrl.searchParams.set("select", "user_id"); adminUrl.searchParams.set("user_id", `eq.${user.id}`); adminUrl.searchParams.set("limit", "1");
    const adminResponse = await fetch(adminUrl, { headers: svcHeaders });
    if (adminResponse.ok && (await adminResponse.json()).length) return true;
    const paymentsUrl = new URL(`${base}/rest/v1/vip_payments`); paymentsUrl.searchParams.set("select", "plan,submitted_at,approved_at"); paymentsUrl.searchParams.set("user_id", `eq.${user.id}`); paymentsUrl.searchParams.set("status", "eq.approved");
    const paymentResponse = await fetch(paymentsUrl, { headers: svcHeaders }); if (!paymentResponse.ok) return false;
    const days: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };
    return (await paymentResponse.json()).some((payment: { plan: string; submitted_at?: string; approved_at?: string }) => { const start = Date.parse(payment.approved_at || payment.submitted_at || ""); return days[payment.plan] && Number.isFinite(start) && start + days[payment.plan] * 86_400_000 > Date.now(); });
  } catch { return false; }
}

function jsonResponse(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "apikey, authorization, content-type",
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
        "Access-Control-Allow-Headers": "apikey, authorization, content-type",
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
  const projectUrl = Deno.env.get("SUPABASE_URL") || "https://wlbwzfxxjfbzpgemuind.supabase.co";
  const hasPlus = await hasPlusAccess(request, projectUrl);
  const includeInjuries = hasPlus && ["NS", "TBD"].includes(fixtureStatus);

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

  const cacheKey = `${fixtureId}:${includeHistory ? `${homeTeamId}-${awayTeamId}` : "no-history"}:${includeEvents ? "events" : "no-events"}:${includeInjuries ? "injuries" : "no-injuries"}:${hasPlus ? "plus" : "free"}`;
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
        getProviderData(`fixtures?team=${homeTeamId}&last=10&status=FT-AET-PEN`),
        getProviderData(`fixtures?team=${awayTeamId}&last=10&status=FT-AET-PEN`),
      ]
      : [];
    const [statsResult, eventsResult, injuriesResult, ...historyResults] = await Promise.allSettled([
      getProviderData(`fixtures/statistics?fixture=${fixtureId}`),
      includeEvents ? getProviderData(`fixtures/events?fixture=${fixtureId}`) : Promise.resolve([]),
      includeInjuries ? getProviderData(`injuries?fixture=${fixtureId}`) : Promise.resolve([]),
      ...historyRequests,
    ]);
    const historyValue = (index: number) => {
      const result = historyResults[index];
      return result?.status === "fulfilled" ? result.value : [];
    };
    const rawStats = statsResult.status === "fulfilled" ? statsResult.value : [];
    const payload = {
      response: hasPlus ? rawStats : rawStats.map((team: { statistics?: Array<{ type: string }> }) => ({ ...team, statistics: (team.statistics || []).filter(stat => freeStatisticTypes.has(stat.type)) })),
      events: eventsResult.status === "fulfilled" ? eventsResult.value : [],
      injuries: hasPlus && injuriesResult.status === "fulfilled" ? injuriesResult.value : [],
      headToHead: includeHistory ? historyValue(0).slice(0, 5) : [],
      lastFive: includeHistory ? { home: historyValue(1).slice(0, 5), away: historyValue(2).slice(0, 5) } : { home: [], away: [] },
      lastTen: hasPlus && includeHistory ? { home: historyValue(1).slice(0, 10), away: historyValue(2).slice(0, 10) } : null,
      access: hasPlus ? "plus" : "free",
      upgradeRequired: !hasPlus,
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

