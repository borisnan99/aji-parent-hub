// register-admin — admin-only: manage which teachers can take each morning class register (class_teachers).
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
      if (!body.class_id || !body.user_id) return json({ error: "class_id and user_id required" }, 400);
      const { data: ex } = await svc.from("class_teachers").select("class_id").eq("class_id", body.class_id).eq("user_id", body.user_id).maybeSingle();
      if (!ex) { const { error } = await svc.from("class_teachers").insert({ class_id: body.class_id, user_id: body.user_id, can_message: false }); if (error) return json({ error: error.message }, 500); }
      return json({ ok: true });
    }
    if (action === "remove") {
      if (!body.class_id || !body.user_id) return json({ error: "class_id and user_id required" }, 400);
      const { error } = await svc.from("class_teachers").delete().eq("class_id", body.class_id).eq("user_id", body.user_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    // list
    const { data: classes } = await svc.from("classes").select("id,name").eq("phase", "morning").order("name");
    const { data: staff } = await svc.from("profiles").select("id,full_name").in("role", ["staff", "admin"]).order("full_name");
    const { data: ct } = await svc.from("class_teachers").select("class_id,user_id");
    return json({ ok: true, classes: classes ?? [], teachers: staff ?? [], assignments: ct ?? [] });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
