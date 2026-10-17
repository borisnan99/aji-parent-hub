// praise-collation — month-on-month praise results + live behaviour-code (C-code) deductions.
// For the Head of Islamic Studies (Imteyaz) + admins.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const LEAD = "imteyaz.omarji@boltondarululoom.org.uk";
const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
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

    const { data: praisePeriods } = await svc.from("praise_results").select("period");
    const uniq = [...new Set((praisePeriods ?? []).map((p: any) => p.period))].sort((a: string, b: string) => a < b ? 1 : -1);
    const { data: bAll } = await svc.from("behaviour_incidents").select("created_at").eq("status", "confirmed");
    const bMonths = [...new Set((bAll ?? []).map((r: any) => String(r.created_at).slice(0, 7)))];
    const allPeriods = [...new Set([...uniq, ...bMonths])].sort((a, b) => a < b ? 1 : -1);
    const body = await req.json().catch(() => ({}));
    const period = body.period || allPeriods[0];
    if (!period) return json({ ok: true, periods: [], period: null, rows: [], summary: null, behaviour: [], behaviour_total: 0 });

    const { data: rows } = await svc.from("praise_results").select("*").eq("period", period).order("rank", { ascending: true });

    // Behaviour-code deductions for the month (confirmed incidents only).
    const from = period + "-01";
    const dd = new Date(from + "T00:00:00Z");
    const next = new Date(Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const { data: bRows } = await svc.from("behaviour_incidents").select("pupil_id,code").eq("status", "confirmed").gte("created_at", from).lt("created_at", next);
    const { data: bcodes } = await svc.from("behaviour_codes").select("code,deduction_points");
    const ptsOf: Record<string, number> = {}; (bcodes ?? []).forEach((c: any) => (ptsOf[c.code] = Number(c.deduction_points || 0)));
    const perPupil: Record<string, { points: number; codes: Record<string, number> }> = {};
    (bRows ?? []).forEach((r: any) => { if (!r.pupil_id) return; const e = (perPupil[r.pupil_id] = perPupil[r.pupil_id] || { points: 0, codes: {} }); e.points += ptsOf[r.code] || 0; e.codes[r.code] = (e.codes[r.code] || 0) + 1; });
    const pids = Object.keys(perPupil);
    const pmap: Record<string, any> = {};
    if (pids.length) { const { data: ps } = await svc.from("pupils").select("id,first_name,last_name,academic_year").in("id", pids); (ps ?? []).forEach((p: any) => (pmap[p.id] = p)); }
    const nameToPid: Record<string, string> = {};
    pids.forEach((id) => { const p = pmap[id]; if (p) nameToPid[norm(`${p.first_name} ${p.last_name}`)] = id; });

    const rows2 = (rows ?? []).map((r: any) => {
      const pid = r.pupil_id || nameToPid[norm(r.student_name)] || null;
      const b = pid ? perPupil[pid] : null; const bpts = b ? b.points : 0;
      const finalNet = Number(r.final_total || 0) - bpts;
      const net_pct = r.max_points ? +((finalNet / Number(r.max_points)) * 100).toFixed(1) : Number(r.pct || 0);
      return { ...r, behaviour_points: bpts, net_pct };
    });

    const awarded = rows2.filter((r: any) => ["Gold", "Silver", "Bronze"].includes(r.award));
    const n = rows2.length;
    const avg = n ? (rows2.reduce((s: number, r: any) => s + Number(r.pct || 0), 0) / n) : 0;
    const byGroup: Record<string, { sum: number; n: number }> = {};
    rows2.forEach((r: any) => { const g = r.group_name || "—"; (byGroup[g] = byGroup[g] || { sum: 0, n: 0 }); byGroup[g].sum += Number(r.pct || 0); byGroup[g].n++; });
    const groups = Object.entries(byGroup).map(([g, v]) => ({ group: g, avg: +(v.sum / v.n).toFixed(1), n: v.n })).sort((a, b) => b.avg - a.avg);
    const pidx = uniq.indexOf(period); const prev = pidx >= 0 && pidx < uniq.length - 1 ? uniq[pidx + 1] : null;
    let prevAvg = null;
    if (prev) { const { data: pr } = await svc.from("praise_results").select("pct").eq("period", prev); if (pr && pr.length) prevAvg = +(pr.reduce((s: number, r: any) => s + Number(r.pct || 0), 0) / pr.length).toFixed(1); }
    const summary = {
      total: n, awarded: awarded.length,
      gold: awarded.filter((r: any) => r.award === "Gold").length,
      silver: awarded.filter((r: any) => r.award === "Silver").length,
      bronze: awarded.filter((r: any) => r.award === "Bronze").length,
      avg_pct: +avg.toFixed(1), prev_period: prev, prev_avg: prevAvg, groups,
    };

    const behaviour = pids.map((id) => {
      const p = pmap[id]; const e = perPupil[id];
      const codes = Object.entries(e.codes).sort().map(([c, cnt]) => (cnt > 1 ? `${c}×${cnt}` : c)).join(", ");
      return { pupil_name: p ? `${p.first_name} ${p.last_name}` : "(unknown)", year: p?.academic_year || "", points: e.points, codes };
    }).sort((a, b) => b.points - a.points || a.pupil_name.localeCompare(b.pupil_name));
    const behaviour_total = behaviour.reduce((s, x) => s + x.points, 0);

    return json({ ok: true, periods: allPeriods, period, rows: rows2, summary, behaviour, behaviour_total });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
