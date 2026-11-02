const allowedOrigins = new Set([
  "https://amorkim32-dev.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);
const feedUrl = "https://newsrss.bbc.co.uk/rss/sportonline_uk_edition/football/rss.xml";
function response(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "public, max-age=300",
    "Vary": "Origin",
  }});
}
function decode(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ").trim();
}
function field(xml: string, name: string) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decode(match[1]) : "";
}
Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (request.method === "OPTIONS") return new Response("ok", { headers: {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  }});
  if (request.method !== "GET") return response({ error: "Method not allowed." }, 405, origin);
  try {
    const feed = await fetch(feedUrl, { headers: { Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(9000) });
    if (!feed.ok) return response({ error: "The BBC Sport news feed is temporarily unavailable." }, 502, origin);
    const xml = await feed.text();
    const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 12).flatMap(([_, item]) => {
      const title = field(item, "title"), rawLink = field(item, "link"), link = rawLink ? new URL(rawLink) : null;
      if (!title || !link || !["bbc.co.uk", "bbc.com"].some(host => link.hostname === host || link.hostname.endsWith(`.${host}`))) return [];
      const description = field(item, "description");
      return [{ title, url: link.toString(), summary: description.slice(0, 280), published: field(item, "pubDate") || null, source: "BBC Sport" }];
    });
    return response({ items, source: "BBC Sport", updatedAt: new Date().toISOString() }, 200, origin);
  } catch (error) {
    console.error("BBC Sport RSS unavailable:", error instanceof Error ? error.message : "unknown error");
    return response({ error: "Could not reach the BBC Sport football feed." }, 502, origin);
  }
});

