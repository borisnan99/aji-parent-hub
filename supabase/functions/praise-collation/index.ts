// praise-collation — month-on-month results for the Head of Islamic Studies (Imteyaz) + admins.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const LEAD = "imteyaz.omarji@boltondarululoom.org.uk";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,email").eq("id", user.id).single();
    const allowed = me && (me.role === "admin" || (me.email || "").toLowerCase() === LEAD);
    if (!allowed) return json({ error: "not permitted" }, 403);

    const { data: periods } = await svc.from("praise_results").select("period").order("period", { ascending: false });
    const uniq = [...new Set((periods ?? []).map((p: any) => p.period))];
    const body = await req.json().catch(() => ({}));
    const period = body.period || uniq[0];
    if (!period) return json({ ok: true, periods: [], period: null, rows: [], summary: null });

    const { data: rows } = await svc.from("praise_results").select("*").eq("period", period).order("rank", { ascending: true });
    const awarded = (rows ?? []).filter((r: any) => ["Gold", "Silver", "Bronze"].includes(r.award));
    const n = (rows ?? []).length;
    const avg = n ? ((rows ?? []).reduce((s: number, r: any) => s + Number(r.pct || 0), 0) / n) : 0;
    const byGroup: Record<string, { sum: number; n: number }> = {};
    (rows ?? []).forEach((r: any) => { const g = r.group_name || "—"; (byGroup[g] = byGroup[g] || { sum: 0, n: 0 }); byGroup[g].sum += Number(r.pct || 0); byGroup[g].n++; });
    const groups = Object.entries(byGroup).map(([g, v]) => ({ group: g, avg: +(v.sum / v.n).toFixed(1), n: v.n })).sort((a, b) => b.avg - a.avg);
    // previous period avg for trend
    const idx = uniq.indexOf(period); const prev = idx >= 0 && idx < uniq.length - 1 ? uniq[idx + 1] : null;
    let prevAvg = null;
    if (prev) { const { data: pr } = await svc.from("praise_results").select("pct").eq("period", prev); if (pr && pr.length) prevAvg = +(pr.reduce((s: number, r: any) => s + Number(r.pct || 0), 0) / pr.length).toFixed(1); }
    const summary = {
      total: n, awarded: awarded.length,
      gold: awarded.filter((r: any) => r.award === "Gold").length,
      silver: awarded.filter((r: any) => r.award === "Silver").length,
      bronze: awarded.filter((r: any) => r.award === "Bronze").length,
      avg_pct: +avg.toFixed(1), prev_period: prev, prev_avg: prevAvg, groups,
    };
    return json({ ok: true, periods: uniq, period, rows: rows ?? [], summary });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
