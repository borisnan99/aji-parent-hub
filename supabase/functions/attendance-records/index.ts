// attendance-records — monthly attendance roll of honour + persistent-absence follow-up.
//   month : 100% attendance roll (all staff) + persistent-absence list (<threshold) with saved
//           follow-up records (admins / attendance leads only).
//   save  : upsert a pupil's follow-up record (parents notified, reason, outcome, review).
//   clear : remove a pupil's follow-up record.
// Attendance basis mirrors the League: a day is "attended" if the pupil was present OR late in
// ANY morning/afternoon session that day. % = days attended ÷ days with a register.
// Persistent absence = below 90% (DfE statutory); severe = below 50%.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const YEAR_ORDER = ["Year 7", "Year 8", "Year 9", "Year 10", "Year 11", "Post-16", "Over-18"];
const MIN_DAYS = 5; // ignore pupils with too few registers to judge

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    const { data: acc } = await svc.from("staff_access").select("is_full").eq("user_id", user.id).maybeSingle();
    const privileged = me?.role === "admin" || acc?.is_full === true;

    const body = await req.json().catch(() => ({}));
    const action = body.action || "month";
    const period = (body.period || new Date().toISOString().slice(0, 7)).slice(0, 7);

    if (action === "save" || action === "clear") {
      if (!privileged) return json({ error: "not permitted" }, 403);
      if (!body.pupil_id) return json({ error: "pupil_id required" }, 400);
      if (action === "clear") {
        const { error } = await svc.from("attendance_interventions").delete().eq("pupil_id", body.pupil_id).eq("period", period);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }
      const row: any = {
        pupil_id: body.pupil_id, period,
        notified_on: body.notified_on || null,
        contact_method: body.contact_method || null,
        parent_reason: body.parent_reason || null,
        outcome: body.outcome || null,
        review_date: body.review_date || null,
        status: body.status || null,
        notes: body.notes || null,
        recorded_by: user.id,
        updated_at: new Date().toISOString(),
      };
      if (body.stats) { row.attendance_pct = body.stats.pct; row.present_days = body.stats.present; row.total_days = body.stats.total; row.authorised_days = body.stats.authorised; row.unauthorised_days = body.stats.unauthorised; row.lates = body.stats.lates; }
      const { error } = await svc.from("attendance_interventions").upsert(row, { onConflict: "pupil_id,period" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ---- compute month ----
    const threshold = Number(body.threshold) || 90;
    const from = period + "-01";
    const d = new Date(from + "T00:00:00Z");
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

    const { data: pupils } = await svc.from("pupils").select("id,first_name,last_name,academic_year,morning_class").eq("is_active", true);
    const pmap: Record<string, any> = {}; (pupils ?? []).forEach((p: any) => (pmap[p.id] = p));

    // page through the month's morning/afternoon marks
    let rows: any[] = []; let off = 0;
    while (true) {
      const { data, error } = await svc.from("attendance").select("pupil_id,status,on_date,phase").in("phase", ["morning", "afternoon"]).gte("on_date", from).lt("on_date", next).range(off, off + 999);
      if (error || !data || !data.length) break;
      rows = rows.concat(data); if (data.length < 1000) break; off += 1000;
    }

    // per pupil per day: attended if present/late in any session
    const day: Record<string, { att: boolean; exc: boolean }> = {};
    const lateCount: Record<string, number> = {};
    rows.forEach((a: any) => {
      if (!pmap[a.pupil_id]) return;
      const k = a.pupil_id + "|" + a.on_date;
      const e = (day[k] = day[k] || { att: false, exc: false });
      if (a.status === "present" || a.status === "late") e.att = true;
      if (a.status === "excused") e.exc = true;
      if (a.status === "late") lateCount[a.pupil_id] = (lateCount[a.pupil_id] || 0) + 1;
    });
    const agg: Record<string, { present: number; total: number; auth: number; unauth: number }> = {};
    Object.keys(day).forEach((k) => {
      const pid = k.split("|")[0]; const e = day[k];
      const g = (agg[pid] = agg[pid] || { present: 0, total: 0, auth: 0, unauth: 0 });
      g.total++;
      if (e.att) g.present++; else if (e.exc) g.auth++; else g.unauth++;
    });

    const yIdx = (y: string) => { const i = YEAR_ORDER.indexOf(y); return i < 0 ? 99 : i; };
    const nm = (p: any) => `${p.first_name} ${p.last_name}`.trim();

    // 100% roll — attended every registered day (lates still count as present)
    const honour = Object.keys(agg).filter((pid) => agg[pid].total > 0 && agg[pid].present === agg[pid].total)
      .map((pid) => { const p = pmap[pid]; const lates = lateCount[pid] || 0; return { pupil_id: pid, name: nm(p), year: p.academic_year || "", class: p.morning_class || "", days: agg[pid].total, lates, perfect: lates === 0 }; })
      .sort((a, b) => yIdx(a.year) - yIdx(b.year) || a.name.localeCompare(b.name));

    const out: any = { ok: true, period, threshold, min_days: MIN_DAYS, privileged, honour, honour_count: honour.length };

    if (privileged) {
      const persistentRaw = Object.keys(agg).filter((pid) => agg[pid].total >= MIN_DAYS && (agg[pid].present / agg[pid].total) * 100 < threshold)
        .map((pid) => { const g = agg[pid]; const p = pmap[pid]; const pct = Math.round((g.present / g.total) * 1000) / 10;
          return { pupil_id: pid, name: nm(p), year: p.academic_year || "", class: p.morning_class || "", pct, present: g.present, total: g.total, authorised: g.auth, unauthorised: g.unauth, lates: lateCount[pid] || 0, severe: pct < 50 }; })
        .sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));
      const pids = persistentRaw.map((r) => r.pupil_id);
      const recs: Record<string, any> = {};
      if (pids.length) { const { data: iv } = await svc.from("attendance_interventions").select("*").eq("period", period).in("pupil_id", pids); (iv ?? []).forEach((r: any) => (recs[r.pupil_id] = r)); }
      out.persistent = persistentRaw.map((r) => ({ ...r, record: recs[r.pupil_id] || null }));
    }
    return json(out);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
