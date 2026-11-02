const allowedOrigins = new Set(["https://amorkim32-dev.github.io", "http://localhost:3000", "http://127.0.0.1:3000"]);
function json(body: unknown, status: number, origin: string) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type":"application/json; charset=utf-8", "Access-Control-Allow-Origin":origin, "Access-Control-Allow-Headers":"apikey, authorization, content-type", "Access-Control-Allow-Methods":"POST, OPTIONS", "Cache-Control":"no-store", Vary:"Origin" } }); }
function keys() {
  let service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", publishable = Deno.env.get("SUPABASE_ANON_KEY") || "";
  try { const x=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}"); service ||= x.default || Object.values(x).find(v=>typeof v==="string") as string || ""; } catch {}
  try { const x=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}"); publishable ||= x.default || Object.values(x).find(v=>typeof v==="string") as string || ""; } catch {}
  return {service,publishable};
}
function authHeaders(service: string) { return { apikey:service, ...(!service.startsWith("sb_secret_") ? { Authorization:`Bearer ${service}` } : {}) }; }
Deno.serve(async request => {
  const origin=request.headers.get("origin")||"";
  if(!allowedOrigins.has(origin)) return new Response("Origin not allowed",{status:403});
  if(request.method==="OPTIONS") return new Response("ok",{headers:{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"apikey, authorization, content-type","Access-Control-Allow-Methods":"POST, OPTIONS",Vary:"Origin"}});
  if(request.method!=="POST") return json({error:"Method not allowed."},405,origin);
  const token=request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supabaseUrl=Deno.env.get("SUPABASE_URL"),{service,publishable}=keys();
  if(!token||!supabaseUrl||!service||!publishable) return json({error:"Admin service is not configured."},503,origin);
  try {
    const userResponse=await fetch(`${supabaseUrl}/auth/v1/user`,{headers:{apikey:publishable,Authorization:`Bearer ${token}`}});
    if(!userResponse.ok) return json({error:"Sign in is required."},401,origin);
    const user=await userResponse.json();
    const adminUrl=new URL(`${supabaseUrl}/rest/v1/admin_users`);adminUrl.searchParams.set("select","user_id");adminUrl.searchParams.set("user_id",`eq.${user.id}`);adminUrl.searchParams.set("limit","1");
    const adminResponse=await fetch(adminUrl,{headers:authHeaders(service)});
    if(!adminResponse.ok) throw new Error("Could not verify administrator access.");
    if(!(await adminResponse.json()).length) return json({error:"Administrator access required."},403,origin);
    let body:{action?:string;userId?:string;banDuration?:string};try{body=await request.json()}catch{return json({error:"A JSON action is required."},400,origin)}
    if(body.action==="users") {
      const list=await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=100`,{headers:authHeaders(service)});
      if(!list.ok) throw new Error("Could not read the Auth user list.");
      const payload=await list.json(),users=(payload.users||[]).map((x:any)=>({id:x.id,email:x.email,created_at:x.created_at,last_sign_in_at:x.last_sign_in_at,banned_until:x.banned_until}));
      return json({users,total:payload.total||users.length},200,origin);
    }
    if(body.action==="set_ban") {
      if(!body.userId||!/^[0-9a-f-]{36}$/i.test(body.userId)) return json({error:"Valid user ID is required."},400,origin);
      if(!["none","24h"].includes(String(body.banDuration))) return json({error:"Choose a 24-hour suspension or restore access."},400,origin);
      const result=await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(body.userId)}`,{method:"PUT",headers:{...authHeaders(service),"Content-Type":"application/json"},body:JSON.stringify({ban_duration:body.banDuration})});
      if(!result.ok){const err=await result.text();console.error("Auth user update failed",result.status,err);throw new Error("Could not update that user.");}
      return json({ok:true},200,origin);
    }
    return json({error:"Unknown admin action."},400,origin);
  } catch(error) {
    console.error("football-admin error:",error instanceof Error?error.message:"unknown error");
    return json({error:error instanceof Error?error.message:"Admin action failed."},502,origin);
  }
});

