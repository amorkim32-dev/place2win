const allowedOrigins = new Set([
  "https://amorkim32-dev.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "null",
]);

const callsByAddress = new Map<string, { expiresAt: number; count: number }>();

function jsonResponse(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "apikey, authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
    },
  });
}

function getApiFootballKey() {
  return Deno.env.get("API_FOOTBALL_KEY") ??
    Deno.env.get("APISPORTS_FOOTBALL_KEY") ??
    Deno.env.get("APISPORTS_KEY");
}

function getSupabaseServiceKey() {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return legacyKey;
  try {
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (typeof secretKeys.default === "string" && secretKeys.default) return secretKeys.default;
    return Object.values(secretKeys).find((value) => typeof value === "string" && value) as string | undefined;
  } catch {
    return undefined;
  }
}

function getSupabasePublishableKey() {
  const legacyKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacyKey) return legacyKey;
  try {
    const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    if (typeof publishableKeys.default === "string" && publishableKeys.default) return publishableKeys.default;
    return Object.values(publishableKeys).find((value) => typeof value === "string" && value) as string | undefined;
  } catch {
    return undefined;
  }
}
Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "apikey, authorization, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
      },
    });
  }
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, origin);

  const address = request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? origin;
  const now = Date.now();
  const rate = callsByAddress.get(address);
  if (rate && rate.expiresAt > now && rate.count >= 3) {
    return jsonResponse({ error: "AI prediction limit reached. Try again later." }, 429, origin);
  }
  if (!rate || rate.expiresAt <= now) callsByAddress.set(address, { expiresAt: now + 3_600_000, count: 1 });
  else rate.count += 1;

  let body: { fixtures?: Array<{ id?: unknown }> };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "A JSON fixture list is required." }, 400, origin);
  }
  const fixtureIds = [...new Set((Array.isArray(body.fixtures) ? body.fixtures : [])
    .map((fixture) => Number(fixture?.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!fixtureIds.length || fixtureIds.length > 20) {
    return jsonResponse({ error: "Send between 1 and 20 valid fixture IDs." }, 400, origin);
  }

  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  const footballKey = getApiFootballKey();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getSupabaseServiceKey();
  if (!openAiKey || !footballKey || !supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "AI predictions are not configured yet." }, 503, origin);
  }

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const normalizeTeam = (value: unknown) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  // Determine VIP fixtures from the protected saved tips. Fail closed if the
  // lookup fails, so an infrastructure issue cannot turn VIP picks public.
  const vipMatchesUrl = new URL(`${supabaseUrl}/rest/v1/matches`);
  vipMatchesUrl.searchParams.set("is_vip", "eq.true");
  vipMatchesUrl.searchParams.set("select", "home_team,away_team");
  let vipMatchKeys: Set<string>;
  try {
    const vipMatchesResponse = await fetch(vipMatchesUrl, { headers: restHeaders });
    if (!vipMatchesResponse.ok) throw new Error("Could not verify VIP fixture access.");
    const vipMatches = await vipMatchesResponse.json();
    vipMatchKeys = new Set<string>(vipMatches.map((match: { home_team: string; away_team: string }) => {
      const pair = [normalizeTeam(match.home_team), normalizeTeam(match.away_team)].sort();
      return pair.join("|");
    }));
  } catch (error) {
    console.error("VIP fixture access check failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "Prediction access could not be verified. Please try again." }, 503, origin);
  }

  let vipActive = false;
  const bearerToken = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearerToken) {
    try {
      const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: getSupabasePublishableKey() ?? serviceKey, Authorization: `Bearer ${bearerToken}` },
      });
      if (userResponse.ok) {
        const user = await userResponse.json();
        if (user?.id) {
          const paymentsUrl = new URL(`${supabaseUrl}/rest/v1/vip_payments`);
          paymentsUrl.searchParams.set("user_id", `eq.${user.id}`);
          paymentsUrl.searchParams.set("status", "eq.approved");
          paymentsUrl.searchParams.set("select", "plan,submitted_at,approved_at");
          const paymentsResponse = await fetch(paymentsUrl, { headers: restHeaders });
          if (!paymentsResponse.ok) throw new Error("Could not verify the subscription status.");
          const payments = await paymentsResponse.json();
          const now = Date.now();
          vipActive = payments.some((payment: { plan: string; submitted_at?: string; approved_at?: string }) => {
            const days = payment.plan === "daily" ? 1 : payment.plan === "weekly" ? 7 : payment.plan === "monthly" ? 30 : 0;
            const start = Date.parse(payment.approved_at || payment.submitted_at || "");
            return days > 0 && Number.isFinite(start) && start + days * 86_400_000 > now;
          });
        }
      }
    } catch (error) {
      console.warn("VIP subscription check failed; serving free predictions only:", error instanceof Error ? error.message : "unknown error");
    }
  }

  const existingUrl = new URL(`${supabaseUrl}/rest/v1/ai_match_predictions`);
  existingUrl.searchParams.set("fixture_id", `in.(${fixtureIds.join(",")})`);
  existingUrl.searchParams.set("select", "fixture_id,home_team,away_team,competition,kickoff_at,prediction,pick_outcome,confidence,rationale,probabilities,model,admin_overridden");
  try {
    const existingResponse = await fetch(existingUrl, { headers: restHeaders });
    if (!existingResponse.ok) throw new Error("Could not load saved AI predictions.");
    const existingRows = await existingResponse.json();
    const existingById = new Map<number, Record<string, unknown>>(
      existingRows.map((row: Record<string, unknown>) => [Number(row.fixture_id), row]),
    );
    const missingIds = fixtureIds.filter((id) => {
      const existing = existingById.get(id);
      return !existing || (!existing.pick_outcome && !existing.admin_overridden);
    });

    if (missingIds.length) {
      const footballResults: Array<Record<string, unknown>> = [];
      for (let index = 0; index < missingIds.length; index += 5) {
        const batch = missingIds.slice(index, index + 5);
        const batchResults = await Promise.all(batch.map(async (id) => {
          const response = await fetch(
            `https://v3.football.api-sports.io/predictions?fixture=${id}`,
            { headers: { "x-apisports-key": footballKey, "Accept": "application/json" } },
          );
          const payload = await response.json();
          if (!response.ok || (payload.errors && Object.keys(payload.errors).length)) {
            throw new Error("Football analysis could not be loaded.");
          }
          const item = payload.response?.[0];
          const fixture = item?.fixture;
          if (!item) return null;
          return {
            fixture_id: id,
            home_team: item.teams?.home?.name || "Home team",
            away_team: item.teams?.away?.name || "Away team",
            competition: item.league?.name || "Football",
            kickoff_at: fixture?.date || new Date().toISOString(),
            prediction: item.predictions?.advice || "",
            winner: item.predictions?.winner?.name || null,
            under_over: item.predictions?.under_over || null,
            goals: item.predictions?.goals || null,
            probabilities: item.predictions?.percent || {},
            comparison: item.comparison || {},
            teams: item.teams || {},
          };
        }));
        footballResults.push(...batchResults.filter((item): item is Record<string, unknown> => Boolean(item)));
      }

      if (footballResults.length) {
        const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openAiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
            temperature: 0.2,
            max_tokens: 2500,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "football_match_predictions",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["predictions"],
                  properties: {
                    predictions: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["fixture_id", "prediction", "pick_outcome", "confidence", "rationale", "probabilities"],
                        properties: {
                          fixture_id: { type: "integer" },
                          prediction: { type: "string" },
                          pick_outcome: { type: "string", enum: ["home", "draw", "away"] },
                          confidence: { type: "integer" },
                          rationale: { type: "string" },
                          probabilities: {
                            type: "object",
                            additionalProperties: false,
                            required: ["home", "draw", "away"],
                            properties: {
                              home: { type: "number" },
                              draw: { type: "number" },
                              away: { type: "number" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            messages: [
              {
                role: "system",
                content: "You are a cautious football forecasting assistant. Use only the supplied fixture, form, comparison, and provider forecast data. Never invent injuries, lineups, odds, or facts. Choose exactly one 1X2 outcome: home team win, draw, or away team win. Set pick_outcome to home, draw, or away and make the prediction text describe that same selection. Explain briefly using the evidence. Probabilities must be percentages from 0 to 100 and sum to 100. Confidence is a separate 1-100 estimate of forecast confidence, not a guarantee. If evidence is weak, say so and keep confidence low. This is an uncertain forecast, never a promise.",
              },
              { role: "user", content: JSON.stringify(footballResults) },
            ],
          }),
        });
        const completion = await openAiResponse.json();
        if (!openAiResponse.ok) {
          console.error("OpenAI prediction request failed:", completion.error?.type || openAiResponse.status);
          throw new Error("The AI model could not generate predictions.");
        }
        const content = completion.choices?.[0]?.message?.content;
        if (!content) throw new Error("The AI model returned no predictions.");
        const generated = JSON.parse(content).predictions as Array<Record<string, unknown>>;
        const providerById = new Map(footballResults.map((item) => [Number(item.fixture_id), item]));
        const rows = generated.flatMap((prediction) => {
          const id = Number(prediction.fixture_id);
          const base = providerById.get(id);
          if (!base || !missingIds.includes(id)) return [];
          const confidence = Math.min(100, Math.max(1, Math.round(Number(prediction.confidence))));
          const probabilities = prediction.probabilities as Record<string, number>;
          const rawOutcome = String(prediction.pick_outcome || "").toLowerCase();
          const pickOutcome = ["home", "draw", "away"].includes(rawOutcome)
            ? rawOutcome
            : Object.entries(probabilities).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
          if (!pickOutcome || !["home", "draw", "away"].includes(pickOutcome)) return [];
          return [{
            fixture_id: id,
            home_team: base.home_team,
            away_team: base.away_team,
            competition: base.competition,
            kickoff_at: base.kickoff_at,
            prediction: String(prediction.prediction).slice(0, 240),
            pick_outcome: pickOutcome,
            confidence,
            rationale: String(prediction.rationale).slice(0, 600),
            probabilities,
            model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
            generated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }];
        });

        if (rows.length) {
          const saveResponse = await fetch(`${supabaseUrl}/rest/v1/ai_match_predictions?on_conflict=fixture_id`, {
            method: "POST",
            headers: {
              ...restHeaders,
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates,return=representation",
            },
            body: JSON.stringify(rows),
          });
          if (!saveResponse.ok) throw new Error("Could not save generated predictions.");
        }
      }
    }

    const finalResponse = await fetch(existingUrl, { headers: restHeaders });
    if (!finalResponse.ok) throw new Error("Could not load saved AI predictions.");
    const allRows = await finalResponse.json();
    const originSet = new Set(fixtureIds);
    const predictions = allRows.filter((row: { fixture_id: number; home_team: string; away_team: string }) => {
      if (!originSet.has(Number(row.fixture_id))) return false;
      const pair = [normalizeTeam(row.home_team), normalizeTeam(row.away_team)].sort().join("|");
      return vipActive || !vipMatchKeys.has(pair);
    });
    return jsonResponse({ predictions }, 200, origin);
  } catch (error) {
    console.error("AI match predictions failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: error instanceof Error ? error.message : "AI predictions could not be generated." }, 502, origin);
  }
});

