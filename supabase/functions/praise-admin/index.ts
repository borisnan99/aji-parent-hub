// praise-admin — manage praise-point columns (assignments) + period progress.
// Access: admins AND the Head of Islamic Studies (Imteyaz). Actions: list / add / remove / progress.
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
    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "add") {
      const { teacher_id, context, group_kind, group_value } = body;
      if (!teacher_id || !["school", "madrasah"].includes(context) || !["academic_year", "morning_class"].includes(group_kind) || !group_value) return json({ error: "missing fields" }, 400);
      const label = group_value + " · " + (context === "school" ? "School" : "Madrasah");
      const { data, error } = await svc.from("praise_assignments").insert({ teacher_id, context, group_kind, group_value, label }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, assignment: data });
    }
    if (action === "remove") {
      if (!body.id) return json({ error: "id required" }, 400);
      const { error } = await svc.from("praise_assignments").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "progress") {
      // How many pupils each column should cover, vs how many have a score this period.
      const period = (body.period || new Date().toISOString().slice(0, 7)).slice(0, 7);
      const { data: asg } = await svc.from("praise_assignments").select("id,teacher_id,context,group_kind,group_value,label").eq("active", true);
      const { data: staff } = await svc.from("profiles").select("id,full_name").in("role", ["staff", "admin"]);
      const tmap: Record<string, string> = {}; (staff ?? []).forEach((s: any) => (tmap[s.id] = s.full_name));
      async function totalFor(a: any): Promise<number> {
        if (a.group_kind === "academic_year") {
          const { count } = await svc.from("pupils").select("id", { count: "exact", head: true }).eq("is_active", true).eq("academic_year", a.group_value);
          return count ?? 0;
        }
        const { data: cls } = await svc.from("classes").select("id").eq("phase", "morning").eq("name", a.group_value).maybeSingle();
        if (!cls) return 0;
        const { count } = await svc.from("class_enrolments").select("pupil_id", { count: "exact", head: true }).eq("class_id", cls.id);
        return count ?? 0;
      }
      const cols: any[] = [];
      for (const a of asg ?? []) {
        const total = await totalFor(a);
        const { count: filled } = await svc.from("praise_points").select("id", { count: "exact", head: true }).eq("period", period).eq("assignment_id", a.id);
        cols.push({ assignment_id: a.id, teacher_id: a.teacher_id, teacher_name: tmap[a.teacher_id] || "?", context: a.context, group_value: a.group_value, total, filled: filled ?? 0, done: total > 0 && (filled ?? 0) >= total });
      }
      const byT: Record<string, any> = {};
      cols.forEach((c) => { (byT[c.teacher_id] = byT[c.teacher_id] || { teacher_id: c.teacher_id, teacher_name: c.teacher_name, columns: [] }).columns.push(c); });
      const rank = (st: string) => st === "not_started" ? 0 : st === "partial" ? 1 : 2;
      const teachers = Object.values(byT).map((t: any) => {
        const total_columns = t.columns.length;
        const done_columns = t.columns.filter((c: any) => c.done).length;
        const anyStarted = t.columns.some((c: any) => c.filled > 0);
        const status = done_columns === total_columns && total_columns > 0 ? "done" : anyStarted ? "partial" : "not_started";
        return { ...t, total_columns, done_columns, status };
      }).sort((a: any, b: any) => rank(a.status) - rank(b.status) || a.teacher_name.localeCompare(b.teacher_name));
      const { data: per } = await svc.from("praise_periods").select("status").eq("period", period).maybeSingle();
      // periods available: any with points, plus the current month
      const { data: pp } = await svc.from("praise_points").select("period");
      const periods = [...new Set([...(pp ?? []).map((r: any) => r.period), new Date().toISOString().slice(0, 7)])].sort().reverse();
      const summary = {
        teachers: teachers.length,
        done: teachers.filter((t: any) => t.status === "done").length,
        partial: teachers.filter((t: any) => t.status === "partial").length,
        not_started: teachers.filter((t: any) => t.status === "not_started").length,
      };
      return json({ ok: true, period, period_status: per?.status || "open", teachers, summary, periods });
    }

    // list
    const { data: asg } = await svc.from("praise_assignments").select("id,teacher_id,context,group_kind,group_value,label,active").order("context").order("group_value");
    const { data: staff } = await svc.from("profiles").select("id,full_name,email").in("role", ["staff", "admin"]).order("full_name");
    const { data: cls } = await svc.from("classes").select("name").eq("phase", "morning").order("name");
    const { data: pus } = await svc.from("pupils").select("academic_year").eq("is_active", true);
    const years = [...new Set((pus ?? []).map((p: any) => p.academic_year).filter(Boolean))].sort();
    const tmap: Record<string, string> = {}; (staff ?? []).forEach((s: any) => (tmap[s.id] = s.full_name));
    const assignments = (asg ?? []).map((a: any) => ({ ...a, teacher_name: tmap[a.teacher_id] || "?" }));
    return json({ ok: true, assignments, teachers: staff ?? [], classes: (cls ?? []).map((c: any) => c.name), years });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
