// fire-drill — log morning/night fire drills. Access: admins + boarding team.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const BOARD_TEAM = ["gulfam khan", "zubair patel", "yasin patel", "ihsaanul haque", "omar sher"];
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,full_name").eq("id", user.id).single();
    const nm = (me?.full_name || "").trim().toLowerCase();
    if (!me || !(me.role === "admin" || BOARD_TEAM.includes(nm))) return json({ error: "not permitted" }, 403);
    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    async function withNames(rows: any[]) {
      const ids = [...new Set(rows.map((r) => r.logged_by).filter(Boolean))];
      const m: Record<string, string> = {};
      if (ids.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", ids); (data ?? []).forEach((u: any) => (m[u.id] = u.full_name)); }
      return rows.map((r) => ({ ...r, logged_by_name: m[r.logged_by] || "" }));
    }

    if (action === "save") {
      const row = { drill_date: (body.drill_date || new Date().toISOString().slice(0, 10)).slice(0, 10), period: body.period || null, conducted_by: (body.conducted_by || "").trim() || null, evacuation_time: (body.evacuation_time || "").trim() || null, roll_call_complete: body.roll_call_complete === true, notes: (body.notes || "").trim() || null, logged_by: user.id };
      if (!row.period) return json({ error: "choose morning or night" }, 400);
      const { data, error } = await svc.from("fire_drills").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }
    if (action === "list") {
      const { data } = await svc.from("fire_drills").select("*").order("drill_date", { ascending: false }).limit(60);
      return json({ ok: true, rows: await withNames(data ?? []) });
    }
    if (action === "export") {
      const month = (body.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
      const from = month + "-01"; const d = new Date(from + "T00:00:00Z"); const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const { data } = await svc.from("fire_drills").select("*").gte("drill_date", from).lte("drill_date", to).order("drill_date");
      return json({ ok: true, month, rows: await withNames(data ?? []) });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
