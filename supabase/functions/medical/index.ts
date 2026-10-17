// medical — medication administration log + non-emergency triage clinic (first responder: Luqman Amla).
// Triage slots 17:30–18:20 (10-min), clinic 5:30–6:30pm. Access: admins + boarding team.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const BOARD_TEAM = ["gulfam khan", "zubair patel", "yasin patel", "ihsaanul haque", "omar sher"];
const SLOTS = ["17:30", "17:40", "17:50", "18:00", "18:10", "18:20"];
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
    const action = body.action || "med_list";

    async function pupilMap(ids: string[]) {
      const u = [...new Set(ids.filter(Boolean))]; const m: Record<string, any> = {};
      if (u.length) { const { data } = await svc.from("pupils").select("id,first_name,last_name,academic_year").in("id", u); (data ?? []).forEach((p: any) => (m[p.id] = p)); }
      return m;
    }
    async function nameMap(ids: string[]) {
      const u = [...new Set(ids.filter(Boolean))]; const m: Record<string, string> = {};
      if (u.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", u); (data ?? []).forEach((p: any) => (m[p.id] = p.full_name)); }
      return m;
    }

    if (action === "med_log") {
      const pupil_id = body.pupil_id, medication = (body.medication || "").trim();
      if (!pupil_id || !medication) return json({ error: "pupil and medication are required" }, 400);
      const row: any = { pupil_id, medication, dose: (body.dose || "").trim() || null, reason: (body.reason || "").trim() || null, given_by: (body.given_by || me.full_name || "").trim() || null, parent_notified: body.parent_notified === true, notes: (body.notes || "").trim() || null, logged_by: user.id };
      if (body.administered_at) row.administered_at = body.administered_at;
      const { data, error } = await svc.from("medication_log").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }
    if (action === "med_list") {
      const { data: rows } = await svc.from("medication_log").select("*").order("administered_at", { ascending: false }).limit(60);
      const pm = await pupilMap((rows ?? []).map((r: any) => r.pupil_id));
      const out = (rows ?? []).map((r: any) => ({ ...r, pupil_name: pm[r.pupil_id] ? `${pm[r.pupil_id].first_name} ${pm[r.pupil_id].last_name}` : "(unknown)", academic_year: pm[r.pupil_id]?.academic_year || "" }));
      return json({ ok: true, rows: out });
    }
    if (action === "med_export") {
      const month = (body.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
      const from = month + "-01T00:00:00"; const d = new Date(month + "-01T00:00:00Z"); const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
      const { data: rows } = await svc.from("medication_log").select("*").gte("administered_at", from).lt("administered_at", to).order("administered_at");
      const pm = await pupilMap((rows ?? []).map((r: any) => r.pupil_id));
      const out = (rows ?? []).map((r: any) => ({ ...r, pupil_name: pm[r.pupil_id] ? `${pm[r.pupil_id].first_name} ${pm[r.pupil_id].last_name}` : "" }));
      return json({ ok: true, month, rows: out });
    }

    if (action === "triage_load") {
      const date = (body.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
      const { data: rows } = await svc.from("triage_appointments").select("*").eq("appt_date", date);
      const pm = await pupilMap((rows ?? []).map((r: any) => r.pupil_id));
      const byslot: Record<string, any> = {};
      (rows ?? []).forEach((r: any) => (byslot[r.slot] = { ...r, pupil_name: r.pupil_id && pm[r.pupil_id] ? `${pm[r.pupil_id].first_name} ${pm[r.pupil_id].last_name}` : "", academic_year: r.pupil_id && pm[r.pupil_id] ? pm[r.pupil_id].academic_year : "" }));
      const slots = SLOTS.map((s) => ({ slot: s, booking: byslot[s] || null }));
      return json({ ok: true, date, slots });
    }
    if (action === "triage_book") {
      const date = (body.date || "").slice(0, 10), slot = body.slot;
      if (!date || !slot || !body.pupil_id) return json({ error: "date, slot and pupil are required" }, 400);
      const { data, error } = await svc.from("triage_appointments").upsert({ appt_date: date, slot, pupil_id: body.pupil_id, reason: (body.reason || "").trim() || null, created_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "appt_date,slot" }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id: data.id });
    }
    if (action === "triage_update") {
      if (!body.id) return json({ error: "id required" }, 400);
      const upd: any = { updated_at: new Date().toISOString() };
      if (body.taken_by !== undefined) upd.taken_by = (body.taken_by || "").trim() || null;
      if (body.outcome !== undefined) upd.outcome = (body.outcome || "").trim() || null;
      if (body.parent_notified !== undefined) upd.parent_notified = body.parent_notified === true;
      if (body.seen !== undefined) upd.seen = body.seen === true;
      const { error } = await svc.from("triage_appointments").update(upd).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "triage_clear") {
      if (!body.id) return json({ error: "id required" }, 400);
      const { error } = await svc.from("triage_appointments").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
