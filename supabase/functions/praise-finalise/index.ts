// praise-finalise — work out a month's praise results from the entered scores.
//   compute : preview only (returns the table, writes nothing)
//   publish : replace parent_hub.praise_results for the period with the computed table
// Rules:
//   • A score of 0 means "I don't teach this boy" — it is LEFT OUT of his average (not a real zero).
//   • Each kept score is out of 10. Attendance for the month is added as one more score out of 10.
//   • pct = sum of kept scores ÷ (number of kept scores × 10). Behaviour deductions are applied later
//     by praise-collation (so results store the positive side only, like the imported September data).
// Access: admins and the praise lead (Imteyaz).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const LEAD = "imteyaz.omarji@boltondarululoom.org.uk";
const EX_YEARS = ["Post-16", "Over-18"];
const award = (pct: number) => pct >= 95 ? "Gold" : pct >= 90 ? "Silver" : pct >= 85 ? "Bronze" : "";
const r1 = (n: number) => Math.round(n * 10) / 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,email").eq("id", user.id).single();
    if (!me || !(me.role === "admin" || (me.email || "").toLowerCase() === LEAD)) return json({ error: "not permitted" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "compute";
    const period = (body.period || new Date().toISOString().slice(0, 7)).slice(0, 7);
    const useAttendance = body.attendance !== false; // default on
    const from = period + "-01";
    const d = new Date(from + "T00:00:00Z");
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

    // pupils (active), with eligibility by age-group and start month
    const { data: pupils } = await svc.from("pupils").select("id,first_name,last_name,academic_year,morning_class,start_date").eq("is_active", true);
    const pmap: Record<string, any> = {};
    (pupils ?? []).forEach((p: any) => {
      const okYear = !EX_YEARS.includes(p.academic_year);
      const okStart = !p.start_date || String(p.start_date).slice(0, 7) <= period;
      if (okYear && okStart) pmap[p.id] = p;
    });

    // praise scores this month, grouped per pupil (keep only > 0 — a 0 means "not taught")
    const { data: pts } = await svc.from("praise_points").select("pupil_id,points").eq("period", period);
    const scores: Record<string, number[]> = {};
    (pts ?? []).forEach((r: any) => {
      if (!pmap[r.pupil_id]) return;
      const v = Number(r.points);
      if (!isNaN(v) && v > 0) (scores[r.pupil_id] = scores[r.pupil_id] || []).push(v);
    });

    // attendance this month -> a mark out of 10 (present or late counts as attended)
    const att: Record<string, number | null> = {};
    if (useAttendance) {
      const { data: arows } = await svc.from("attendance").select("pupil_id,status").gte("on_date", from).lt("on_date", next);
      const tally: Record<string, { ok: number; total: number }> = {};
      (arows ?? []).forEach((a: any) => {
        if (!pmap[a.pupil_id]) return;
        const e = (tally[a.pupil_id] = tally[a.pupil_id] || { ok: 0, total: 0 });
        e.total++;
        if (a.status === "present" || a.status === "late") e.ok++;
      });
      Object.keys(tally).forEach((pid) => { const e = tally[pid]; att[pid] = e.total ? r1((e.ok / e.total) * 10) : null; });
    }

    // build one row per pupil who has at least one kept praise score
    const rows: any[] = [];
    for (const pid of Object.keys(scores)) {
      const p = pmap[pid];
      const comps = scores[pid].slice();
      const a = useAttendance ? (att[pid] ?? null) : null;
      if (a !== null && a !== undefined) comps.push(a);
      if (!comps.length) continue;
      const positive = r1(comps.reduce((s, x) => s + x, 0));
      const max = comps.length * 10;
      const pct = r1((positive / max) * 100);
      rows.push({
        period, pupil_id: pid,
        student_name: `${p.first_name} ${p.last_name}`.trim(),
        year: p.academic_year || "", group_name: p.morning_class || "",
        attendance: a, positive_total: positive, deductions: 0,
        final_total: positive, max_points: max, pct, award: award(pct),
      });
    }
    // rank by pct desc (standard competition ranking: 1,2,2,4…)
    rows.sort((x, y) => y.pct - x.pct || x.student_name.localeCompare(y.student_name));
    let lastPct: number | null = null, lastRank = 0;
    rows.forEach((row, i) => { if (lastPct === null || row.pct !== lastPct) { lastRank = i + 1; lastPct = row.pct; } row.rank = lastRank; });

    const summary = {
      pupils: rows.length,
      gold: rows.filter((r) => r.award === "Gold").length,
      silver: rows.filter((r) => r.award === "Silver").length,
      bronze: rows.filter((r) => r.award === "Bronze").length,
      attendance: useAttendance,
    };

    if (action === "compute") return json({ ok: true, period, rows, summary });

    if (action === "publish") {
      await svc.from("praise_results").delete().eq("period", period);
      if (rows.length) {
        const { error } = await svc.from("praise_results").insert(rows);
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true, period, published: rows.length, summary });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
