// praise-finalise — work out a month's praise results from the entered scores.
//   compute : preview only (returns the full table + per-teacher matrix, writes nothing)
//   publish : replace parent_hub.praise_results for the period with the computed table
// Rules:
//   • A score of 0 means "I don't teach this boy" — LEFT OUT of his average (shown as "–").
//   • Each kept score is /10. Attendance for the month is added as one more /10 (present or late = attended).
//   • Behaviour C-codes come off the TOTAL POINTS (not the %): Final Total = Positive Total − deductions.
//     C1 0 · C2 −2 · C3 −5 · C4 −10 · C5 policy (0 pts). Percentage = Final Total ÷ Max × 100.
//   • Max = number of kept components × 10. Award: Gold 95+, Silver 90+, Bronze 85+.
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
    const useAttendance = body.attendance !== false;
    const from = period + "-01";
    const d = new Date(from + "T00:00:00Z");
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

    // eligible active pupils
    const { data: pupils } = await svc.from("pupils").select("id,first_name,last_name,academic_year,morning_class,start_date").eq("is_active", true);
    const pmap: Record<string, any> = {};
    (pupils ?? []).forEach((p: any) => {
      if (!EX_YEARS.includes(p.academic_year) && (!p.start_date || String(p.start_date).slice(0, 7) <= period)) pmap[p.id] = p;
    });

    // praise columns -> one spreadsheet column per (teacher, context)
    const { data: asg } = await svc.from("praise_assignments").select("id,teacher_id,context").eq("active", true);
    const asgMap: Record<string, { teacher_id: string; context: string }> = {};
    (asg ?? []).forEach((a: any) => (asgMap[a.id] = { teacher_id: a.teacher_id, context: a.context }));
    const tIds = [...new Set((asg ?? []).map((a: any) => a.teacher_id))];
    const { data: tprofs } = tIds.length ? await svc.from("profiles").select("id,full_name").in("id", tIds) : { data: [] };
    const tname: Record<string, string> = {}; (tprofs ?? []).forEach((t: any) => (tname[t.id] = t.full_name || "?"));
    const colKey = (tid: string, ctx: string) => tid + "|" + ctx;
    const colsMap: Record<string, any> = {};
    (asg ?? []).forEach((a: any) => {
      const k = colKey(a.teacher_id, a.context);
      if (!colsMap[k]) colsMap[k] = { key: k, teacher: tname[a.teacher_id] || "?", context: a.context, label: `${tname[a.teacher_id] || "?"} — ${a.context === "school" ? "School" : "Madrasah"}` };
    });
    const columns = Object.values(colsMap).sort((a: any, b: any) => a.teacher.localeCompare(b.teacher) || (a.context < b.context ? -1 : 1));

    // scores this month -> cells[pupil][colKey] = points (incl 0)
    const { data: pts } = await svc.from("praise_points").select("pupil_id,points,assignment_id").eq("period", period);
    const cells: Record<string, Record<string, number>> = {};
    (pts ?? []).forEach((r: any) => {
      if (!pmap[r.pupil_id] || !asgMap[r.assignment_id]) return;
      const k = colKey(asgMap[r.assignment_id].teacher_id, asgMap[r.assignment_id].context);
      (cells[r.pupil_id] = cells[r.pupil_id] || {})[k] = Number(r.points);
    });

    // attendance -> /10
    const att: Record<string, number | null> = {};
    if (useAttendance) {
      const { data: arows } = await svc.from("attendance").select("pupil_id,status").gte("on_date", from).lt("on_date", next);
      const tally: Record<string, { ok: number; total: number }> = {};
      (arows ?? []).forEach((a: any) => { if (!pmap[a.pupil_id]) return; const e = (tally[a.pupil_id] = tally[a.pupil_id] || { ok: 0, total: 0 }); e.total++; if (a.status === "present" || a.status === "late") e.ok++; });
      Object.keys(tally).forEach((pid) => { const e = tally[pid]; att[pid] = e.total ? r1((e.ok / e.total) * 10) : null; });
    }

    // behaviour deductions (confirmed this month) -> points off the total
    const { data: bInc } = await svc.from("behaviour_incidents").select("pupil_id,code").eq("status", "confirmed").gte("created_at", from).lt("created_at", next);
    const { data: bcodes } = await svc.from("behaviour_codes").select("code,deduction_points");
    const ptsOf: Record<string, number> = {}; (bcodes ?? []).forEach((c: any) => (ptsOf[c.code] = Number(c.deduction_points || 0)));
    const ded: Record<string, number> = {}; (bInc ?? []).forEach((r: any) => { if (!r.pupil_id) return; ded[r.pupil_id] = (ded[r.pupil_id] || 0) + (ptsOf[r.code] || 0); });

    // one row per pupil who has at least one kept (>0) teacher score
    const rows: any[] = [];
    for (const pid of Object.keys(cells)) {
      const p = pmap[pid];
      const kept = Object.values(cells[pid]).filter((v) => Number(v) > 0);
      const comps = kept.slice();
      const a = useAttendance ? (att[pid] ?? null) : null;
      if (a !== null && a !== undefined) comps.push(a);
      if (!comps.length) continue;
      const positive = r1(comps.reduce((s, x) => s + x, 0));
      const max = comps.length * 10;
      const dd = ded[pid] || 0;
      const final = r1(positive - dd);
      const pct = r1((final / max) * 100);
      rows.push({
        period, pupil_id: pid, student_name: `${p.first_name} ${p.last_name}`.trim(),
        year: p.academic_year || "", group_name: p.morning_class || "",
        attendance: a, positive_total: positive, deductions: dd, final_total: final,
        max_points: max, pct, award: award(pct), cells: cells[pid],
      });
    }
    rows.sort((x, y) => y.pct - x.pct || x.student_name.localeCompare(y.student_name));
    let lastPct: number | null = null, lastRank = 0;
    rows.forEach((row, i) => { if (lastPct === null || row.pct !== lastPct) { lastRank = i + 1; lastPct = row.pct; } row.rank = lastRank; });

    const summary = {
      pupils: rows.length,
      gold: rows.filter((r) => r.award === "Gold").length,
      silver: rows.filter((r) => r.award === "Silver").length,
      bronze: rows.filter((r) => r.award === "Bronze").length,
      attendance: useAttendance, with_deductions: rows.filter((r) => r.deductions > 0).length,
    };

    if (action === "compute") return json({ ok: true, period, columns, rows, summary });

    if (action === "publish") {
      await svc.from("praise_results").delete().eq("period", period);
      const toInsert = rows.map((r) => ({
        period: r.period, rank: r.rank, student_name: r.student_name, year: r.year, group_name: r.group_name,
        attendance: r.attendance, positive_total: r.positive_total, deductions: r.deductions,
        final_total: r.final_total, max_points: r.max_points, pct: r.pct, award: r.award, pupil_id: r.pupil_id,
      }));
      if (toInsert.length) { const { error } = await svc.from("praise_results").insert(toInsert); if (error) return json({ error: error.message }, 500); }
      return json({ ok: true, period, published: toInsert.length, summary });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
