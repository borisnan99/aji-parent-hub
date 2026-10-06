// praise-entry — a teacher fills their own praise columns. my_columns / load / save. Teacher owns their columns; admin may fill any.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    const isAdmin = me?.role === "admin";
    const body = await req.json().catch(() => ({}));
    const action = body.action || "my_columns";
    const period = (body.period || new Date().toISOString().slice(0, 7)).slice(0, 7);

    async function pupilsFor(a: any): Promise<any[]> {
      if (a.group_kind === "academic_year") {
        const { data } = await svc.from("pupils").select("id,first_name,last_name").eq("is_active", true).eq("academic_year", a.group_value).order("last_name");
        return data ?? [];
      }
      const { data: cls } = await svc.from("classes").select("id").eq("phase", "morning").eq("name", a.group_value).maybeSingle();
      if (!cls) return [];
      const { data: en } = await svc.from("class_enrolments").select("pupil_id").eq("class_id", cls.id);
      const ids = (en ?? []).map((e: any) => e.pupil_id);
      if (!ids.length) return [];
      const { data } = await svc.from("pupils").select("id,first_name,last_name").eq("is_active", true).in("id", ids).order("last_name");
      return data ?? [];
    }
    const nm = (p: any) => (p.first_name + " " + p.last_name).trim();

    if (action === "my_columns") {
      let q = svc.from("praise_assignments").select("id,context,group_kind,group_value,label,teacher_id").eq("active", true);
      if (!isAdmin) q = q.eq("teacher_id", user.id);
      else if (body.teacher_id) q = q.eq("teacher_id", body.teacher_id);
      else q = q.eq("teacher_id", user.id);
      const { data: cols } = await q.order("context").order("group_value");
      const out = [];
      for (const c of cols ?? []) {
        const pus = await pupilsFor(c);
        const { count } = await svc.from("praise_points").select("id", { count: "exact", head: true }).eq("period", period).eq("assignment_id", c.id);
        out.push({ ...c, total: pus.length, filled: count ?? 0 });
      }
      return json({ ok: true, columns: out, period });
    }

    const { data: a } = await svc.from("praise_assignments").select("*").eq("id", body.assignment_id).single();
    if (!a) return json({ error: "column not found" }, 404);
    if (!isAdmin && a.teacher_id !== user.id) return json({ error: "not your column" }, 403);
    const { data: per } = await svc.from("praise_periods").select("status").eq("period", period).maybeSingle();
    const finalised = per?.status === "finalised";

    if (action === "load") {
      const pus = await pupilsFor(a);
      const { data: pts } = await svc.from("praise_points").select("pupil_id,points").eq("period", period).eq("assignment_id", a.id);
      const existing: Record<string, number> = {}; (pts ?? []).forEach((p: any) => (existing[p.pupil_id] = Number(p.points)));
      return json({ ok: true, label: a.label, context: a.context, period, finalised, pupils: pus.map((p) => ({ id: p.id, name: nm(p) })), existing });
    }
    if (action === "save") {
      if (finalised) return json({ error: "month is finalised — locked" }, 400);
      const scores = Array.isArray(body.scores) ? body.scores : [];
      let saved = 0;
      for (const s of scores) {
        const pts = Number(s.points);
        if (isNaN(pts) || pts < 0 || pts > 10) continue;
        const { error } = await svc.from("praise_points").upsert({ period, assignment_id: a.id, pupil_id: s.pupil_id, points: pts, entered_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "period,assignment_id,pupil_id" });
        if (!error) saved++;
      }
      return json({ ok: true, saved });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
