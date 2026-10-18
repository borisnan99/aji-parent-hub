// data-admin — data-protection tools for leadership/DPO: retention report, guarded manual purge, audit-log view.
// Admin only. Purge affects ONLY routine operational records and never runs without explicit confirm.
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
    const { data: me } = await svc.from("profiles").select("role,full_name").eq("id", user.id).single();
    if (!me || me.role !== "admin") return json({ error: "admin only" }, 403);
    const body = await req.json().catch(() => ({}));
    const action = body.action || "retention_report";

    if (action === "retention_report") {
      const { data, error } = await svc.rpc("retention_report");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, report: data });
    }

    if (action === "retention_purge") {
      if (body.confirm !== true) return json({ error: "confirmation required" }, 400);
      const today = new Date();
      const iso = (y: number) => new Date(today.getFullYear() - y, today.getMonth(), today.getDate()).toISOString().slice(0, 10);
      const d3 = iso(3), d2 = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate()).toISOString();
      const counts: Record<string, number> = {};
      const del = async (table: string, col: string, cutoff: string, key: string) => {
        const { data, error } = await svc.from(table).delete().lt(col, cutoff).select("id");
        counts[key] = error ? 0 : (data?.length ?? 0);
      };
      await del("attendance", "on_date", d3, "attendance");
      await del("boarding_checks", "check_date", d3, "boarding_checks");
      await del("supervisor_checklists", "check_date", d3, "supervisor_checklists");
      if (body.include_messages === true) await del("messages", "created_at", d2, "messages");
      await svc.from("audit_log").insert({ actor_id: user.id, action: "retention.purge", entity_type: "retention", metadata: { ...counts, at: new Date().toISOString() } });
      return json({ ok: true, purged: counts });
    }

    if (action === "audit_recent") {
      const { data: rows } = await svc.from("audit_log").select("*").order("created_at", { ascending: false }).limit(150);
      const ids = [...new Set((rows ?? []).map((r: any) => r.actor_id).filter(Boolean))];
      const um: Record<string, string> = {};
      if (ids.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", ids); (data ?? []).forEach((u: any) => (um[u.id] = u.full_name)); }
      return json({ ok: true, rows: (rows ?? []).map((r: any) => ({ ...r, actor_name: um[r.actor_id] || "—" })) });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
