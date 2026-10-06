// praise-admin — admin-only: manage the praise-point columns (assignments). list / add / remove.
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
    if (!me || me.role !== "admin") return json({ error: "admins only" }, 403);
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
